// Gate-0 canary tripwire (TZ §II.14) and fail-closed behaviour (TZ §II.9).
//
// A preflight request whose target matches the canary (a bait outside every
// scope) must: deny, trip the GLOBAL kill-switch, and write `gate0_tripped`.
// Separately, an internal error inside preflight must fail closed (deny), never
// throw and never allow.

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeCore, makeActive, cleanup } = require("./helpers.js");
const { createPreflight } = require("../preflight.js");

test.after(cleanup);

test("Gate-0: touching the canary denies, trips the global kill-switch, and audits gate0_tripped", async () => {
  const { core } = makeCore({ gate0: { enabled: true, targets: ["canary.aegis.invalid", "10.66.66.66"] } });
  const id = await makeActive(core, [{ kind: "domain", value: "example.com", includeSubdomains: true }]);

  // Normal in-scope action works and the kill-switch is off.
  assert.equal(core.engagements.getKillSwitch().global, false);
  assert.equal(core.preflight.check({ engagementId: id, actor: "x", action: "scan", target: "example.com" }).allowed, true);

  // Touch the canary.
  const tripped = core.preflight.check({ engagementId: id, actor: "rogue", action: "scan", target: "canary.aegis.invalid" });
  assert.equal(tripped.allowed, false);
  assert.match(tripped.reason, /Gate-0/);

  // The global kill-switch is now engaged (in-memory effect is synchronous).
  assert.equal(core.engagements.getKillSwitch().global, true);

  // And even the previously-allowed in-scope action is now denied.
  assert.equal(core.preflight.check({ engagementId: id, actor: "x", action: "scan", target: "example.com" }).allowed, false);

  await core.close();

  // A dedicated gate0_tripped event is in the ledger, and the chain still verifies.
  const events = core.audit.list({ limit: 0 });
  assert.ok(events.some((e) => e.type === "gate0_tripped"));
  assert.equal(core.verifyAudit().ok, true);
});

test("Gate-0 also trips on a canary IP target", async () => {
  const { core } = makeCore({ gate0: { enabled: true, targets: ["10.66.66.66"] } });
  const id = await makeActive(core);
  const r = core.preflight.check({ engagementId: id, actor: "rogue", action: "scan", target: "10.66.66.66" });
  assert.equal(r.allowed, false);
  assert.equal(core.engagements.getKillSwitch().global, true);
  await core.close();
});

test("Gate-0 is OFF by default: a non-canary core never trips", async () => {
  const { core } = makeCore();
  const id = await makeActive(core);
  core.preflight.check({ engagementId: id, actor: "x", action: "scan", target: "anything-else.com" });
  assert.equal(core.engagements.getKillSwitch().global, false);
  await core.close();
});

test("fail-closed: an internal error inside preflight denies, it never throws or allows", () => {
  // Inject a broken engagements manager whose actionable() throws.
  const audited = [];
  const preflight = createPreflight({
    engagements: {
      actionable() {
        throw new Error("boom");
      },
    },
    audit: { append: (e) => audited.push(e) },
  });

  const result = preflight.check({ engagementId: "x", actor: "a", action: "scan", target: "example.com" });
  assert.equal(result.allowed, false);
  assert.equal(result.decision, "deny");
  assert.match(result.reason, /внутренняя ошибка/);
  // The failure was still recorded.
  assert.equal(audited.length, 1);
  assert.equal(audited[0].decision, "deny");
});
