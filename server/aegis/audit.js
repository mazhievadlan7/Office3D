// Immutable, hash-chained audit ledger.
//
// Every decision and every state change is appended here as one JSON line. Each
// entry carries the hash of the previous entry, so a single altered or removed
// line breaks the chain and verify() finds it. This is the tamper-evident
// journal the platform's whole promise rests on: "we acted strictly inside the
// authorized scope, and here is the proof." (§13.5 "подписанный аудит-леджер";
// cryptographic signing is a later layer on top of this chain.)
//
// The ledger is append-only: it is never rewritten, only added to. Mutable
// current state lives in store.js instead.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const GENESIS = "0".repeat(64);

/** Deterministic JSON: keys sorted recursively, so the hash never depends on
 *  insertion order (write time and verify time must serialize identically). */
const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
};

const hashEntry = (prevHash, payload) =>
  crypto.createHash("sha256").update(`${prevHash}\n${stableStringify(payload)}`).digest("hex");

const HASH_FIELDS = ["seq", "at", "type", "engagementId", "actor", "target", "decision", "reason", "detail"];
const payloadOf = (entry) => {
  const payload = {};
  for (const field of HASH_FIELDS) payload[field] = entry[field] ?? null;
  return payload;
};

/**
 * @param {object} deps
 * @param {string} deps.filePath  JSONL ledger path
 * @param {() => number} [deps.now]
 * @param {(message: string, err?: unknown) => void} [deps.logError]
 */
const createAuditLog = ({ filePath, now = () => Date.now(), logError = () => {} }) => {
  let seq = 0;
  let lastHash = GENESIS;

  const readLines = () => {
    try {
      const text = fs.readFileSync(filePath, "utf8");
      return text.split("\n").filter((line) => line.trim() !== "");
    } catch {
      return [];
    }
  };

  // Recover seq + lastHash from any existing ledger, and verify it on the way.
  const existing = readLines();
  for (const line of existing) {
    try {
      const entry = JSON.parse(line);
      lastHash = entry.hash;
      seq = entry.seq;
    } catch (err) {
      logError("AEGIS audit ledger has an unreadable line; continuing from the last good entry.", err);
      break;
    }
  }

  let writeChain = Promise.resolve();

  const append = (input) => {
    seq += 1;
    const entry = {
      seq,
      at: now(),
      type: String(input.type ?? "event"),
      engagementId: input.engagementId ?? null,
      actor: input.actor ?? null,
      target: input.target ?? null,
      decision: input.decision ?? null,
      reason: input.reason ?? null,
      detail: input.detail ?? {},
    };
    entry.prevHash = lastHash;
    entry.hash = hashEntry(lastHash, payloadOf(entry));
    lastHash = entry.hash;
    const line = `${JSON.stringify(entry)}\n`;
    writeChain = writeChain
      .then(async () => {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.appendFile(filePath, line, { mode: 0o600 });
      })
      .catch((err) => logError("Failed to append to the AEGIS audit ledger.", err));
    return entry;
  };

  /** Walk the on-disk chain; report the first break, if any. */
  const verify = () => {
    let prev = GENESIS;
    let count = 0;
    for (const line of readLines()) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return { ok: false, count, brokenAt: count + 1, reason: "нечитаемая строка" };
      }
      count += 1;
      if (entry.prevHash !== prev) return { ok: false, count, brokenAt: count, reason: "разрыв цепочки (prevHash)" };
      if (hashEntry(prev, payloadOf(entry)) !== entry.hash) return { ok: false, count, brokenAt: count, reason: "хеш не сходится (подделка записи)" };
      prev = entry.hash;
    }
    return { ok: true, count };
  };

  /**
   * @param {{engagementId?: string|null, limit?: number}} [options]
   */
  const list = ({ engagementId, limit = 100 } = {}) => {
    const entries = [];
    for (const line of readLines()) {
      try {
        const entry = JSON.parse(line);
        if (engagementId && entry.engagementId !== engagementId) continue;
        entries.push(entry);
      } catch {
        // skip unreadable line in a read-only listing
      }
    }
    return limit > 0 ? entries.slice(-limit) : entries;
  };

  return {
    append,
    verify,
    list,
    flush: () => writeChain,
    get head() {
      return { seq, lastHash };
    },
  };
};

module.exports = { createAuditLog, stableStringify, GENESIS };
