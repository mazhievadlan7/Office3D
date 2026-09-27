import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { createAegisCore } = await import("../../server/aegis/index.js");

let dir: string;
const makeCore = (opts = {}) => createAegisCore({ dataDir: dir, ...opts });

const activeEngagement = async (core: ReturnType<typeof createAegisCore>) => {
  const eng = await core.engagements.create({ name: "e" });
  await core.engagements.addAsset(eng.id, { kind: "domain", value: "example.com", includeSubdomains: true });
  await core.engagements.addAsset(eng.id, { kind: "cidr", value: "10.0.0.0/8" });
  await core.engagements.recordAuthorization(eng.id, { letterRef: "L-1", signer: "Заказчик" });
  await core.engagements.activate(eng.id, { by: "Адлан", confirm: true });
  return eng.id;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-pf-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("AEGIS preflight gate", () => {
  it("allows in-scope targets and denies everything else, recording both", async () => {
    const core = makeCore();
    const id = await activeEngagement(core);

    expect(core.preflight.check({ engagementId: id, actor: "recon", action: "scan", target: "a.example.com" }).allowed).toBe(true);
    expect(core.preflight.check({ engagementId: id, actor: "recon", action: "scan", target: "10.1.2.3" }).allowed).toBe(true);
    expect(core.preflight.check({ engagementId: id, actor: "recon", action: "scan", target: "other.com" }).allowed).toBe(false);
    expect(core.preflight.check({ engagementId: id, actor: "recon", action: "scan", target: "11.0.0.1" }).allowed).toBe(false);

    await core.close();
    // Both allows and denies are journaled, and the chain verifies.
    const entries = core.audit.list({ engagementId: id }) as Array<{ type: string; decision: string }>;
    const decisions = entries.filter((e) => e.type === "preflight");
    expect(decisions.filter((e) => e.decision === "allow").length).toBe(2);
    expect(decisions.filter((e) => e.decision === "deny").length).toBe(2);
    expect(core.verifyAudit().ok).toBe(true);
  });

  it("denies when the engagement is not active or is unknown", async () => {
    const core = makeCore();
    expect(core.preflight.check({ engagementId: "missing", actor: "a", action: "scan", target: "example.com" }).allowed).toBe(false);

    const eng = await core.engagements.create({ name: "e" });
    await core.engagements.addAsset(eng.id, { kind: "domain", value: "example.com" });
    // still draft
    expect(core.preflight.check({ engagementId: eng.id, actor: "a", action: "scan", target: "example.com" }).allowed).toBe(false);
  });

  it("the global kill-switch denies even an in-scope target", async () => {
    const core = makeCore();
    const id = await activeEngagement(core);
    await core.engagements.setGlobalKill({ on: true, by: "Адлан", reason: "стоп" });
    const result = core.preflight.check({ engagementId: id, actor: "recon", action: "scan", target: "example.com" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("kill-switch");
  });

  it("holds destructive actions until a human authorizes them", async () => {
    const core = makeCore({ isDestructive: (action: string) => action === "exploit" });
    const id = await activeEngagement(core);
    const held = core.preflight.check({ engagementId: id, actor: "web", action: "exploit", target: "example.com" });
    expect(held.allowed).toBe(false);
    expect(held.decision).toBe("hold");
    const approved = core.preflight.check({ engagementId: id, actor: "web", action: "exploit", target: "example.com", humanApproved: true });
    expect(approved.allowed).toBe(true);
  });

  it("compiles an egress allowlist for the active engagement", async () => {
    const core = makeCore();
    const id = await activeEngagement(core);
    const allow = core.egressAllowlist(id);
    expect(allow.domains).toContain("example.com");
    expect(allow.ipv4).toContain("10.0.0.0/8");
    expect(core.renderEgressNftables(id)).toContain("policy drop");
  });
});
