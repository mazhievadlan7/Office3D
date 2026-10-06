// Group-A hardening for the AEGIS legal core:
//   1. Gate-0 canary (TZ §16.2-5)      — trips the GLOBAL kill-switch
//   2. Auto-stop on anomaly (TZ §4.2)  — deactivates after N anomalies
//   3. Authorization letter + signer   — required before activation (TZ §4.3)
//   4. Signed audit ledger (TZ §13.5)  — HMAC over the chain head
//   5. Governance single source        — rules live only in governance.js
//
// Everything new is OFF by default; these tests arm each guard explicitly and
// prove the default-off path is unchanged elsewhere.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { createAegisCore } = await import("../../server/aegis/index.js");
const { createAuditLog, stableStringify, GENESIS } = await import("../../server/aegis/audit.js");
const { RULES, composeSystemPrompt } = await import("../../server/aegis/governance.js");

const dirs: string[] = [];
const setup = (options: Record<string, unknown> = {}) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-hard-"));
  dirs.push(dataDir);
  let clock = 1_700_000_000_000;
  const core = createAegisCore({ dataDir, now: () => (clock += 1000), ...options });
  return { core, dataDir, ledger: path.join(dataDir, "aegis-audit.jsonl") };
};

const makeActive = async (
  core: ReturnType<typeof createAegisCore>,
  assets: object[] = [{ kind: "domain", value: "example.com", includeSubdomains: true }],
): Promise<string> => {
  const eng = await core.engagements.create({ name: "Own audit" });
  for (const a of assets) await core.engagements.addAsset(eng.id, a);
  await core.engagements.recordAuthorization(eng.id, { letterRef: "LOA-1", signer: "Owner" });
  await core.engagements.activate(eng.id, { by: "Owner", confirm: true });
  return eng.id;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // best effort
    }
  }
});

// --- 1. Gate-0 canary --------------------------------------------------------

describe("AEGIS Gate-0 canary (TZ §16.2-5)", () => {
  it("touching a canary denies, trips the GLOBAL kill-switch, and audits gate0_tripped", async () => {
    const { core } = setup({ gate0: { enabled: true, targets: ["canary.aegis.invalid", "10.66.66.66"] } });
    const id = await makeActive(core, [{ kind: "domain", value: "example.com", includeSubdomains: true }]);

    expect(core.engagements.getKillSwitch().global).toBe(false);
    expect(core.preflight.check({ engagementId: id, actor: "x", action: "scan", target: "example.com" }).allowed).toBe(true);

    const tripped = core.preflight.check({ engagementId: id, actor: "rogue", action: "scan", target: "canary.aegis.invalid" });
    expect(tripped.allowed).toBe(false);
    expect(tripped.reason).toMatch(/Gate-0/);

    // The global kill-switch is now engaged (synchronous in-memory effect)...
    expect(core.engagements.getKillSwitch().global).toBe(true);
    // ...so even the previously-allowed in-scope action is now denied.
    expect(core.preflight.check({ engagementId: id, actor: "x", action: "scan", target: "example.com" }).allowed).toBe(false);

    await core.close();
    const events = core.audit.list({ limit: 0 }) as Array<{ type: string }>;
    expect(events.some((e) => e.type === "gate0_tripped")).toBe(true);
    expect(core.verifyAudit().ok).toBe(true);
  });

  it("also trips on a canary IP target", async () => {
    const { core } = setup({ gate0: { enabled: true, targets: ["10.66.66.66"] } });
    const id = await makeActive(core);
    const r = core.preflight.check({ engagementId: id, actor: "rogue", action: "scan", target: "10.66.66.66" });
    expect(r.allowed).toBe(false);
    expect(core.engagements.getKillSwitch().global).toBe(true);
    await core.close();
  });

  it("is OFF by default: a non-canary core never trips", async () => {
    const { core } = setup();
    const id = await makeActive(core);
    core.preflight.check({ engagementId: id, actor: "x", action: "scan", target: "anything-else.com" });
    expect(core.engagements.getKillSwitch().global).toBe(false);
    expect(core.securityStatus().gate0).toMatchObject({ enabled: false, canaryCount: 0 });
    await core.close();
  });

  it("reads canary config from the environment (PLATFORM_GATE0 / PLATFORM_GATE0_TARGETS)", async () => {
    const prevOn = process.env.PLATFORM_GATE0;
    const prevTargets = process.env.PLATFORM_GATE0_TARGETS;
    process.env.PLATFORM_GATE0 = "true";
    process.env.PLATFORM_GATE0_TARGETS = "bait.example.invalid, 10.66.66.66";
    try {
      const { core } = setup();
      expect(core.securityStatus().gate0).toMatchObject({ enabled: true, canaryCount: 2 });
      const id = await makeActive(core);
      expect(core.preflight.check({ engagementId: id, actor: "rogue", action: "scan", target: "bait.example.invalid" }).allowed).toBe(false);
      expect(core.engagements.getKillSwitch().global).toBe(true);
      await core.close();
    } finally {
      if (prevOn === undefined) delete process.env.PLATFORM_GATE0;
      else process.env.PLATFORM_GATE0 = prevOn;
      if (prevTargets === undefined) delete process.env.PLATFORM_GATE0_TARGETS;
      else process.env.PLATFORM_GATE0_TARGETS = prevTargets;
    }
  });
});

// --- 2. Auto-stop on anomaly -------------------------------------------------

describe("AEGIS auto-stop on anomaly (TZ §4.2)", () => {
  it("deactivates an engagement after the anomaly threshold is crossed", async () => {
    const { core } = setup({ autoStop: { threshold: 3, windowMs: 60_000 } });
    const id = await makeActive(core, [{ kind: "domain", value: "example.com", includeSubdomains: true }]);

    for (let i = 0; i < 3; i += 1) {
      expect(core.preflight.check({ engagementId: id, actor: "rogue", action: "scan", target: `evil${i}.com` }).allowed).toBe(false);
    }

    const eng = core.engagements.get(id) as { status: string; stop: { auto: boolean; trigger: string } };
    expect(eng.status).toBe("stopped");
    expect(eng.stop.auto).toBe(true);
    expect(eng.stop.trigger).toBe("out_of_scope");

    // An in-scope action is now denied too, because the engagement is stopped.
    expect(core.preflight.check({ engagementId: id, actor: "x", action: "scan", target: "example.com" }).allowed).toBe(false);

    await core.close();
    expect((core.audit.list({ engagementId: id, limit: 0 }) as Array<{ type: string }>).some((e) => e.type === "auto_stop")).toBe(true);
    expect(core.verifyAudit().ok).toBe(true);
  });

  it("counts rate-limit breaches toward auto-stop", async () => {
    const { core } = setup({ autoStop: { threshold: 2, windowMs: 60_000 }, rateLimit: { max: 1, windowMs: 60_000 } });
    const id = await makeActive(core);
    expect(core.preflight.check({ engagementId: id, actor: "x", action: "scan", target: "example.com" }).allowed).toBe(true);
    core.preflight.check({ engagementId: id, actor: "x", action: "scan", target: "example.com" });
    core.preflight.check({ engagementId: id, actor: "x", action: "scan", target: "example.com" });
    expect((core.engagements.get(id) as { status: string }).status).toBe("stopped");
    await core.close();
  });

  it("is OFF by default: anomalies never deactivate", async () => {
    const { core } = setup();
    const id = await makeActive(core);
    for (let i = 0; i < 10; i += 1) core.preflight.check({ engagementId: id, actor: "x", action: "scan", target: `evil${i}.com` });
    expect((core.engagements.get(id) as { status: string }).status).toBe("active");
    expect(core.securityStatus().autoStop.enabled).toBe(false);
    await core.close();
  });
});

// --- 3. Authorization letter + signer ---------------------------------------

describe("AEGIS authorization letter + signer (TZ §4.3)", () => {
  it("cannot activate without a letter reference AND a signer", async () => {
    const { core } = setup();
    const eng = await core.engagements.create({ name: "Own audit" });
    await core.engagements.addAsset(eng.id, { kind: "domain", value: "example.com" });

    // Missing both, missing signer, missing letter — each rejected.
    await expect(core.engagements.recordAuthorization(eng.id, {})).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(core.engagements.recordAuthorization(eng.id, { letterRef: "LOA-1" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(core.engagements.recordAuthorization(eng.id, { signer: "Owner" })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    // Still draft, so activation is impossible.
    await expect(core.engagements.activate(eng.id, { by: "Owner", confirm: true })).rejects.toMatchObject({ code: "CONFLICT" });
    await core.close();
  });

  it("records the letter reference, signer, and optional signature on the engagement and audit", async () => {
    const { core } = setup();
    const eng = await core.engagements.create({ name: "Own audit" });
    await core.engagements.addAsset(eng.id, { kind: "domain", value: "example.com" });
    const authorized = (await core.engagements.recordAuthorization(eng.id, {
      letterRef: "LOA-2026-01",
      signer: "Адлан Ахмедович",
      signature: "sha256:deadbeef",
    })) as { authorization: { letterRef: string; signer: string; signature: string | null } };

    expect(authorized.authorization.letterRef).toBe("LOA-2026-01");
    expect(authorized.authorization.signer).toBe("Адлан Ахмедович");
    expect(authorized.authorization.signature).toBe("sha256:deadbeef");

    const active = (await core.engagements.activate(eng.id, { by: "Owner", confirm: true })) as { status: string };
    expect(active.status).toBe("active");

    await core.close();
    const authEvent = (core.audit.list({ engagementId: eng.id, limit: 0 }) as Array<{ type: string; detail: { letterRef?: string; signer?: string } }>).find(
      (e) => e.type === "engagement.authorized",
    );
    expect(authEvent?.detail.letterRef).toBe("LOA-2026-01");
    expect(authEvent?.detail.signer).toBe("Адлан Ахмедович");
  });
});

// --- 4. Signed audit ledger --------------------------------------------------

// HASH_FIELDS mirrors audit.js; recompute a forged chain the way an attacker
// with file access (but no signing key) could — valid hashes, wrong signatures.
const HASH_FIELDS = ["seq", "at", "type", "engagementId", "actor", "target", "decision", "reason", "detail"];
const payloadOf = (entry: Record<string, unknown>) => {
  const payload: Record<string, unknown> = {};
  for (const field of HASH_FIELDS) payload[field] = entry[field] ?? null;
  return payload;
};
const hashEntry = (prevHash: string, payload: unknown) =>
  crypto.createHash("sha256").update(`${prevHash}\n${stableStringify(payload)}`).digest("hex");

describe("AEGIS signed audit ledger (TZ §13.5)", () => {
  it("with no key configured, behaves exactly like the hash-chain (signed:false)", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aegis-sig-")), "audit.jsonl");
    dirs.push(path.dirname(file));
    const log = createAuditLog({ filePath: file });
    log.append({ type: "preflight", engagementId: "e1", decision: "allow", reason: "ok" });
    log.append({ type: "preflight", engagementId: "e1", decision: "deny", reason: "nope" });
    await log.flush();
    expect(log.verify()).toMatchObject({ ok: true, count: 2, signed: false });
    // No sig field is written when unsigned.
    const first = JSON.parse(fs.readFileSync(file, "utf8").split("\n").filter(Boolean)[0]);
    expect(first.sig).toBeUndefined();
  });

  it("catches a fully-recomputed forgery that the plain hash-chain would miss", async () => {
    const key = "test-audit-signing-key";
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aegis-sig-")), "audit.jsonl");
    dirs.push(path.dirname(file));

    const log = createAuditLog({ filePath: file, signingKey: key });
    log.append({ type: "preflight", engagementId: "e1", decision: "deny", reason: "out of scope" });
    log.append({ type: "preflight", engagementId: "e1", decision: "deny", reason: "out of scope" });
    log.append({ type: "preflight", engagementId: "e1", decision: "deny", reason: "out of scope" });
    await log.flush();
    expect(log.verify()).toMatchObject({ ok: true, signed: true });

    // Attacker flips a denial to an allow and RECOMPUTES the whole hash-chain
    // (prevHash + hash for every line) plus the .head checkpoint — the SHA-256
    // chain is unkeyed, so they can. They sign with a WRONG key (the real one
    // is secret).
    const wrongKey = "attacker-guess";
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    lines[0].decision = "allow";
    lines[0].reason = "forged";
    let prev = GENESIS;
    for (const entry of lines) {
      entry.prevHash = prev;
      entry.hash = hashEntry(prev, payloadOf(entry));
      entry.sig = crypto.createHmac("sha256", wrongKey).update(entry.hash).digest("hex");
      prev = entry.hash;
    }
    fs.writeFileSync(file, `${lines.map((e) => JSON.stringify(e)).join("\n")}\n`);
    const last = lines[lines.length - 1];
    fs.writeFileSync(`${file}.head`, JSON.stringify({ seq: last.seq, hash: last.hash }));

    // A keyless verifier is fooled — the chain is internally consistent.
    expect(createAuditLog({ filePath: file }).verify().ok).toBe(true);
    // The signed verifier is NOT — the HMAC does not match the secret key.
    const verdict = createAuditLog({ filePath: file, signingKey: key }).verify();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/подпис/);
  });

  it("flags a stripped signature when a key is configured", async () => {
    const key = "another-key";
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aegis-sig-")), "audit.jsonl");
    dirs.push(path.dirname(file));
    const log = createAuditLog({ filePath: file, signingKey: key });
    log.append({ type: "e", engagementId: "e1" });
    await log.flush();

    const line = JSON.parse(fs.readFileSync(file, "utf8").split("\n").filter(Boolean)[0]);
    delete line.sig; // strip the signature but keep the valid hash
    fs.writeFileSync(file, `${JSON.stringify(line)}\n`);
    fs.writeFileSync(`${file}.head`, JSON.stringify({ seq: line.seq, hash: line.hash }));

    expect(createAuditLog({ filePath: file, signingKey: key }).verify().ok).toBe(false);
  });
});

// --- 5. Governance single source ---------------------------------------------

describe("AEGIS governance is single-sourced in governance.js (TZ §16.5)", () => {
  it("the composed system prompt is built from RULES — no duplicated rule text", () => {
    const prompt = composeSystemPrompt();
    for (const rule of RULES as Array<{ id: string; title: string; text: string }>) {
      expect(prompt).toContain(rule.id);
      expect(prompt).toContain(rule.title);
      expect(prompt).toContain(rule.text);
    }
  });

  it("no sibling governance.json data file duplicates the rule text", () => {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    const aegisDir = path.resolve(here, "../../server/aegis");
    expect(fs.existsSync(path.join(aegisDir, "governance.json"))).toBe(false);
  });
});
