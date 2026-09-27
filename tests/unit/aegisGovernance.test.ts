import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { RULES, composeSystemPrompt } from "../../server/aegis/governance.js";
import { createAegisCore } from "../../server/aegis/index.js";

const dirs: string[] = [];
const setup = () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-gov-"));
  dirs.push(dataDir);
  let clock = 1_700_000_000_000;
  return createAegisCore({ dataDir, now: () => (clock += 1000) });
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

describe("AEGIS governance (RULE_0…RULE_5)", () => {
  it("carries all six first-order rules", () => {
    expect(RULES.map((rule: { id: string }) => rule.id)).toEqual(["RULE_0", "RULE_1", "RULE_2", "RULE_3", "RULE_4", "RULE_5"]);
  });

  it("builds a prompt that names every rule and forbids action without an engagement", () => {
    const prompt = composeSystemPrompt();
    for (const rule of RULES as Array<{ id: string }>) expect(prompt).toContain(rule.id);
    expect(prompt).toMatch(/scope-first/i);
    expect(prompt).toContain("Активного engagement нет");
  });

  it("pins the prompt to the active engagement's scope and marks everything else out of bounds", () => {
    const engagement = {
      id: "eng_x",
      name: "Аудит своего сайта",
      assets: [
        { kind: "domain", value: "example.com", includeSubdomains: true },
        { kind: "cidr", value: "10.0.0.0/24" },
      ],
    };
    const prompt = composeSystemPrompt({ engagement, agentName: "AM7" });
    expect(prompt).toContain("AM7");
    expect(prompt).toContain("eng_x");
    expect(prompt).toContain("example.com");
    expect(prompt).toContain("10.0.0.0/24");
    expect(prompt).toMatch(/вне scope/i);
  });
});

describe("AEGIS Gate-0: a honeypot beside the scope is refused", () => {
  it("denies a tempting out-of-scope neighbour of an authorized asset", async () => {
    const core = setup();
    const eng = await core.engagements.create({ name: "Own network audit" });
    await core.engagements.addAsset(eng.id, { kind: "cidr", value: "10.0.0.0/24" });
    await core.engagements.addAsset(eng.id, { kind: "domain", value: "example.com", includeSubdomains: true });
    await core.engagements.recordAuthorization(eng.id, { letterRef: "LOA-1", signer: "Owner" });
    await core.engagements.activate(eng.id, { by: "Owner", confirm: true });

    // In scope: allowed.
    expect(core.preflight.check({ engagementId: eng.id, actor: "recon", action: "scan", target: "10.0.0.9" }).allowed).toBe(true);

    // The honeypots: an adjacent IP just outside the /24, and a look-alike
    // domain. Both are tempting and both must be refused.
    const neighbourIp = core.preflight.check({ engagementId: eng.id, actor: "recon", action: "scan", target: "10.0.1.9" });
    const lookAlike = core.preflight.check({ engagementId: eng.id, actor: "recon", action: "scan", target: "example.com.evil.test" });
    expect(neighbourIp.allowed).toBe(false);
    expect(lookAlike.allowed).toBe(false);

    await core.close();
    // The refusals are on the record.
    const denials = (core.audit.list({ engagementId: eng.id }) as Array<{ type: string; decision: string }>).filter(
      (entry) => entry.type === "preflight" && entry.decision === "deny",
    );
    expect(denials.length).toBeGreaterThanOrEqual(2);
    expect(core.verifyAudit().ok).toBe(true);
  });
});
