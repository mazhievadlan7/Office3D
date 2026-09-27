import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createAegisCore } from "../../server/aegis/index.js";

// A fresh temp data dir and a monotonic clock per core, so the ledger and store
// are deterministic and isolated. Dirs are removed after each test.
const dirs: string[] = [];
const setup = (options: Record<string, unknown> = {}) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-"));
  dirs.push(dataDir);
  let clock = 1_700_000_000_000;
  const core = createAegisCore({ dataDir, now: () => (clock += 1000), ...options });
  return { core, dataDir, ledger: path.join(dataDir, "aegis-audit.jsonl") };
};

const makeActive = async (
  core: ReturnType<typeof createAegisCore>,
  assets: object[] = [{ kind: "domain", value: "example.com", includeSubdomains: true }],
): Promise<string> => {
  const eng = await core.engagements.create({ name: "Own web audit" });
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

describe("AEGIS engagement lifecycle is deny-by-default and manually gated", () => {
  it("blocks every action until authorized AND activated, then scopes it", async () => {
    const { core } = setup();
    const eng = await core.engagements.create({ name: "Own web audit" });
    expect(eng.status).toBe("draft");

    // Nothing is allowed before activation — the whole point of Gate 0.
    expect(core.preflight.check({ engagementId: eng.id, actor: "a1", action: "http.get", target: "example.com" }).allowed).toBe(false);

    await core.engagements.addAsset(eng.id, { kind: "domain", value: "example.com", includeSubdomains: true });

    // Cannot activate a draft; cannot authorize without a letter and signer.
    await expect(core.engagements.activate(eng.id, { by: "Owner", confirm: true })).rejects.toThrow();
    await expect(core.engagements.recordAuthorization(eng.id, {})).rejects.toThrow();

    await core.engagements.recordAuthorization(eng.id, { letterRef: "LOA-1", signer: "Owner" });
    // Activation is the customer's manual act: confirm:true is required.
    await expect(core.engagements.activate(eng.id, { by: "Owner" })).rejects.toThrow();
    const active = await core.engagements.activate(eng.id, { by: "Owner", confirm: true });
    expect(active.status).toBe("active");

    expect(core.preflight.check({ engagementId: eng.id, actor: "a1", action: "http.get", target: "sub.example.com" }).allowed).toBe(true);
    expect(core.preflight.check({ engagementId: eng.id, actor: "a1", action: "http.get", target: "evil.com" }).decision).toBe("deny");
    await core.close();
  });

  it("refuses to authorize an engagement with no assets", async () => {
    const { core } = setup();
    const eng = await core.engagements.create({ name: "Empty" });
    await expect(core.engagements.recordAuthorization(eng.id, { letterRef: "LOA-1", signer: "Owner" })).rejects.toThrow();
    await core.close();
  });

  it("only edits the scope while in draft", async () => {
    const { core } = setup();
    const id = await makeActive(core);
    await expect(core.engagements.addAsset(id, { kind: "domain", value: "extra.com" })).rejects.toThrow();
    await core.close();
  });
});

describe("AEGIS kill-switch and stop halt actions instantly", () => {
  it("the global kill-switch denies everything and releases cleanly", async () => {
    const { core } = setup();
    const id = await makeActive(core);
    expect(core.preflight.check({ engagementId: id, actor: "a1", action: "http.get", target: "example.com" }).allowed).toBe(true);

    await core.engagements.setGlobalKill({ on: true, by: "Owner", reason: "стоп" });
    const killed = core.preflight.check({ engagementId: id, actor: "a1", action: "http.get", target: "example.com" });
    expect(killed.allowed).toBe(false);
    expect(killed.reason).toMatch(/kill/i);

    await core.engagements.setGlobalKill({ on: false, by: "Owner" });
    expect(core.preflight.check({ engagementId: id, actor: "a1", action: "http.get", target: "example.com" }).allowed).toBe(true);
    await core.close();
  });

  it("a per-engagement stop halts just that engagement", async () => {
    const { core } = setup();
    const id = await makeActive(core);
    await core.engagements.stop(id, { by: "Owner", reason: "пауза" });
    expect(core.preflight.check({ engagementId: id, actor: "a1", action: "http.get", target: "example.com" }).allowed).toBe(false);
    const back = await core.engagements.reactivate(id, { by: "Owner" });
    expect(back.status).toBe("active");
    expect(core.preflight.check({ engagementId: id, actor: "a1", action: "http.get", target: "example.com" }).allowed).toBe(true);
    await core.close();
  });
});

describe("AEGIS preflight holds destructive actions and fails closed", () => {
  it("holds a destructive action until a human approves it", async () => {
    const { core } = setup({ isDestructive: (action: string) => action === "exploit.run" });
    const id = await makeActive(core);
    const held = core.preflight.check({ engagementId: id, actor: "a1", action: "exploit.run", target: "example.com" });
    expect(held.decision).toBe("hold");
    expect(held.allowed).toBe(false);
    const approved = core.preflight.check({ engagementId: id, actor: "a1", action: "exploit.run", target: "example.com", humanApproved: true });
    expect(approved.allowed).toBe(true);
    await core.close();
  });

  it("records every decision and never throws on a malformed target", async () => {
    const { core } = setup();
    const id = await makeActive(core);
    core.preflight.check({ engagementId: id, actor: "a1", action: "http.get", target: "example.com" });
    core.preflight.check({ engagementId: id, actor: "a1", action: "http.get", target: "evil.com" });
    // A weird target must fail closed, not throw.
    const weird = core.preflight.check({ engagementId: id, actor: "a1", action: "http.get", target: { nonsense: true } as never });
    expect(weird.allowed).toBe(false);
    await core.close();

    const preflights = core.audit.list({ engagementId: id }).filter((e: { type: string }) => e.type === "preflight");
    expect(preflights.length).toBeGreaterThanOrEqual(3);
    expect(preflights.some((e: { decision: string }) => e.decision === "allow")).toBe(true);
    expect(preflights.some((e: { decision: string }) => e.decision === "deny")).toBe(true);
  });
});

describe("AEGIS audit ledger is tamper-evident", () => {
  it("verifies a clean ledger and catches an altered entry", async () => {
    const { core, ledger } = setup();
    await makeActive(core);
    core.preflight.check({ engagementId: "x", actor: "a1", action: "http.get", target: "example.com" });
    await core.close();
    expect(core.verifyAudit().ok).toBe(true);

    const lines = fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean);
    const middle = Math.floor(lines.length / 2);
    const entry = JSON.parse(lines[middle]);
    entry.reason = "TAMPERED";
    lines[middle] = JSON.stringify(entry);
    fs.writeFileSync(ledger, `${lines.join("\n")}\n`);
    expect(core.verifyAudit().ok).toBe(false);
  });

  it("catches a removed middle line (chain gap)", async () => {
    const { core, ledger } = setup();
    await makeActive(core);
    await core.close();
    const lines = fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean);
    lines.splice(Math.floor(lines.length / 2), 1);
    fs.writeFileSync(ledger, `${lines.join("\n")}\n`);
    expect(core.verifyAudit().ok).toBe(false);
  });

  it("catches tail truncation via the checkpoint", async () => {
    const { core, ledger } = setup();
    await makeActive(core);
    await core.close();
    const lines = fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean);
    lines.pop(); // drop the last entry, leave the .head checkpoint ahead
    fs.writeFileSync(ledger, `${lines.join("\n")}\n`);
    const result = core.verifyAudit();
    expect(result.ok).toBe(false);
  });
});

describe("AEGIS egress allowlist reflects only the active scope", () => {
  it("is empty until active, then compiles assets and renders default-deny nftables", async () => {
    const { core } = setup();
    const eng = await core.engagements.create({ name: "Own audit" });
    await core.engagements.addAsset(eng.id, { kind: "domain", value: "example.com" });
    await core.engagements.addAsset(eng.id, { kind: "ip", value: "10.0.0.5" });
    await core.engagements.addAsset(eng.id, { kind: "cidr", value: "192.168.0.0/16" });

    // Not active yet: no outbound is authorized.
    let allow = core.egressAllowlist(eng.id);
    expect(allow.ipv4).toEqual([]);
    expect(allow.domains).toEqual([]);

    await core.engagements.recordAuthorization(eng.id, { letterRef: "LOA-1", signer: "Owner" });
    await core.engagements.activate(eng.id, { by: "Owner", confirm: true });

    allow = core.egressAllowlist(eng.id);
    expect(allow.domains).toContain("example.com");
    expect(allow.ipv4).toContain("10.0.0.5/32");
    expect(allow.ipv4).toContain("192.168.0.0/16");

    const nft = core.renderEgressNftables(eng.id);
    expect(nft).toContain("policy drop");
    expect(nft).toContain("10.0.0.5/32");
    expect(nft).toContain("example.com");
    await core.close();
  });
});
