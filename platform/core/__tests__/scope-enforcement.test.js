// Negative test net for the Scope Enforcement Engine (TZ §II.9, §II.4.2).
// A target outside the authorized scope must be refused by preflight AND absent
// from the egress allowlist; a domain in scope must NOT be matched by an IP
// target (no DNS resolution in the matcher — no DNS race); the global and
// per-engagement kill-switches halt actions; and destructive actions need human
// approval.

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeCore, makeActive, cleanup } = require("./helpers.js");

test.after(cleanup);

test("out-of-scope target: denied by preflight AND absent from the egress allowlist", async () => {
  const { core } = makeCore();
  const id = await makeActive(core, [
    { kind: "domain", value: "example.com", includeSubdomains: true },
    { kind: "cidr", value: "10.0.0.0/8" },
  ]);

  // In scope.
  assert.equal(core.preflight.check({ engagementId: id, actor: "recon", action: "scan", target: "a.example.com" }).allowed, true);
  assert.equal(core.preflight.check({ engagementId: id, actor: "recon", action: "scan", target: "10.1.2.3" }).allowed, true);

  // Out of scope: default-deny.
  assert.equal(core.preflight.check({ engagementId: id, actor: "recon", action: "scan", target: "evil.com" }).allowed, false);
  assert.equal(core.preflight.check({ engagementId: id, actor: "recon", action: "scan", target: "8.8.8.8" }).allowed, false);

  // Second barrier: the egress allowlist contains only the scope, never evil.com.
  const allow = core.egressAllowlist(id);
  assert.ok(allow.domains.includes("example.com"));
  assert.ok(!allow.domains.includes("evil.com"));
  assert.ok(allow.ipv4.includes("10.0.0.0/8"));
  assert.ok(!allow.ipv4.includes("8.8.8.8/32"));

  await core.close();
});

test("DNS-race safety: a domain in scope is NOT matched by an arbitrary IP target", async () => {
  const { core } = makeCore();
  // Only the domain is authorized — no IP/CIDR assets at all.
  const id = await makeActive(core, [{ kind: "domain", value: "example.com", includeSubdomains: true }]);

  // Even if this IP "really is" example.com right now, the scope matcher does
  // not resolve domains, so an IP target can never ride in on a domain asset.
  const r = core.preflight.check({ engagementId: id, actor: "recon", action: "scan", target: "93.184.216.34" });
  assert.equal(r.allowed, false);
  // The domain itself is still fine.
  assert.equal(core.preflight.check({ engagementId: id, actor: "recon", action: "scan", target: "example.com" }).allowed, true);

  await core.close();
});

test("kill-switch: global denies even an in-scope target; per-engagement stop halts just one", async () => {
  const { core } = makeCore();
  const a = await makeActive(core, [{ kind: "domain", value: "a.example.com" }]);
  const b = await makeActive(core, [{ kind: "domain", value: "b.example.com" }]);

  assert.equal(core.preflight.check({ engagementId: a, actor: "x", action: "scan", target: "a.example.com" }).allowed, true);

  // Global kill — everything denied.
  await core.engagements.setGlobalKill({ on: true, by: "Owner", reason: "стоп" });
  assert.equal(core.preflight.check({ engagementId: a, actor: "x", action: "scan", target: "a.example.com" }).allowed, false);
  assert.equal(core.preflight.check({ engagementId: b, actor: "x", action: "scan", target: "b.example.com" }).allowed, false);
  await core.engagements.setGlobalKill({ on: false, by: "Owner" });

  // Per-engagement stop — only that engagement is halted.
  await core.engagements.stop(a, { by: "Owner", reason: "пауза" });
  assert.equal(core.preflight.check({ engagementId: a, actor: "x", action: "scan", target: "a.example.com" }).allowed, false);
  assert.equal(core.preflight.check({ engagementId: b, actor: "x", action: "scan", target: "b.example.com" }).allowed, true);

  await core.close();
});

test("destructive actions are held until a human approves them", async () => {
  const { core } = makeCore({ isDestructive: (action) => action === "exploit.run" });
  const id = await makeActive(core);

  const held = core.preflight.check({ engagementId: id, actor: "web", action: "exploit.run", target: "example.com" });
  assert.equal(held.decision, "hold");
  assert.equal(held.allowed, false);

  const approved = core.preflight.check({ engagementId: id, actor: "web", action: "exploit.run", target: "example.com", humanApproved: true });
  assert.equal(approved.allowed, true);

  await core.close();
});
