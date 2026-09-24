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
  // A monotonic checkpoint (last seq + hash) kept beside the ledger. It is what
  // lets verify() catch TAIL truncation — deleting the last N lines leaves a
  // valid-looking chain, but the checkpoint remembers there should be more.
  const headPath = `${filePath}.head`;
  let headSeq = 0;
  let integrityAlarm = null;

  const readLines = () => {
    try {
      const text = fs.readFileSync(filePath, "utf8");
      return text.split("\n").filter((line) => line.trim() !== "");
    } catch {
      return [];
    }
  };

  const readHead = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(headPath, "utf8"));
      if (parsed && typeof parsed.seq === "number" && typeof parsed.hash === "string") return parsed;
    } catch {
      // no checkpoint yet
    }
    return null;
  };

  // Recover seq + lastHash from any existing ledger.
  for (const line of readLines()) {
    try {
      const entry = JSON.parse(line);
      lastHash = entry.hash;
      seq = entry.seq;
    } catch (err) {
      logError("AEGIS audit ledger has an unreadable line; continuing from the last good entry.", err);
      break;
    }
  }

  // Cross-check the checkpoint at load. A checkpoint ahead of the ledger means
  // the tail was truncated since we last wrote; a hash mismatch at the tail
  // means it was altered. (A ledger AHEAD of the checkpoint is benign — a crash
  // between appending a line and updating the checkpoint.)
  const bootHead = readHead();
  headSeq = bootHead?.seq ?? 0;
  if (bootHead) {
    if (bootHead.seq > seq) integrityAlarm = `леджер короче checkpoint (${seq} < ${bootHead.seq}): возможна обрезка хвоста`;
    else if (bootHead.seq === seq && bootHead.hash !== lastHash) integrityAlarm = "хвостовая запись не совпадает с checkpoint: возможна подделка";
    if (integrityAlarm) logError(`AEGIS audit integrity alarm: ${integrityAlarm}`);
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
    const advanceHead = entry.seq > headSeq;
    if (advanceHead) headSeq = entry.seq;
    writeChain = writeChain
      .then(async () => {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.appendFile(filePath, line, { mode: 0o600 });
        // Advance the checkpoint only forward, so a truncation-then-restart
        // cannot quietly lower it and erase the evidence.
        if (advanceHead) {
          const tmp = `${headPath}.${process.pid}.tmp`;
          await fs.promises.writeFile(tmp, JSON.stringify({ seq: entry.seq, hash: entry.hash }), { mode: 0o600 });
          await fs.promises.rename(tmp, headPath);
        }
      })
      .catch((err) => logError("Failed to append to the AEGIS audit ledger.", err));
    return entry;
  };

  /** Walk the on-disk chain and cross-check the checkpoint; report the first
   *  break, if any. Catches altered entries, chain gaps, mid-log removal AND
   *  tail truncation (via the checkpoint). */
  const verify = () => {
    if (integrityAlarm) return { ok: false, count: 0, reason: integrityAlarm };
    const head = readHead();
    let prev = GENESIS;
    let count = 0;
    let sawCheckpoint = false;
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
      if (head && entry.seq === head.seq) {
        sawCheckpoint = true;
        if (entry.hash !== head.hash) return { ok: false, count, brokenAt: count, reason: "хвост изменён (checkpoint hash не сходится)" };
      }
    }
    if (head && !sawCheckpoint) return { ok: false, count, reason: "обрезан хвост леджера (записи до checkpoint отсутствуют)" };
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
