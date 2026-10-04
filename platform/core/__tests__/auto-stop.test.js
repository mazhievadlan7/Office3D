// Auto-stop on anomaly (TZ §II.4.2). After N anomalies within the window, the
// engagement auto-deactivates (status → stopped) and `auto_stop` is audited;
// further actions on it are then denied. Off by default (no threshold).

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeCore, makeActive, cleanup } = require("./helpers.js");

test.after(cleanup);

test("auto-stop deactivates an engagement after the anomaly threshold is crossed", async () => {
  const { core } = makeCore({ autoStop: { threshold: 3, windowMs: 60_000 } });
  const id = await makeActive(core, [{ kind: "domain", value: "example.com", includeSubdomains: true }]);

  // Three out-of-scope attempts = three anomalies.
  for (let i = 0; i < 3; i += 1) {
    const r = core.preflight.check({ engagementId: id, actor: "rogue", action: "scan", target: `evil${i}.com` });
    assert.equal(r.allowed, false);
  }

  // The engagement has been auto-deactivated (synchronous in-memory effect).
  const eng = core.engagements.get(id);
  assert.equal(eng.status, "stopped");
  assert.equal(eng.stop.auto, true);
  assert.equal(eng.stop.trigger, "out_of_scope");

  // Even an in-scope action is now denied, because the engagement is stopped.
  assert.equal(core.preflight.check({ engagementId: id, actor: "x", action: "scan", target: "example.com" }).allowed, false);

  await core.close();

  // The auto_stop event is journaled and the chain verifies.
  assert.ok(core.audit.list({ engagementId: id, limit: 0 }).some((e) => e.type === "auto_stop"));
  assert.equal(core.verifyAudit().ok, true);
});

test("auto-stop counts rate-limit breaches too", async () => {
  const { core } = makeCore({ autoStop: { threshold: 2, windowMs: 60_000 }, rateLimit: { max: 1, windowMs: 60_000 } });
  const id = await makeActive(core);

  // First in-scope action allowed (consumes the single rate-limit slot).
  assert.equal(core.preflight.check({ engagementId: id, actor: "x", action: "scan", target: "example.com" }).allowed, true);
  // Next two exceed the rate limit → two anomalies → auto-stop.
  core.preflight.check({ engagementId: id, actor: "x", action: "scan", target: "example.com" });
  core.preflight.check({ engagementId: id, actor: "x", action: "scan", target: "example.com" });

  assert.equal(core.engagements.get(id).status, "stopped");
  await core.close();
});

test("auto-stop is OFF by default: anomalies do not deactivate", async () => {
  const { core } = makeCore();
  const id = await makeActive(core);
  for (let i = 0; i < 10; i += 1) {
    core.preflight.check({ engagementId: id, actor: "x", action: "scan", target: `evil${i}.com` });
  }
  assert.equal(core.engagements.get(id).status, "active");
  await core.close();
});
