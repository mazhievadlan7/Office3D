// Orchestrator — task-routing control plane. Same bar as core/__tests__:
// the full lifecycle, the matrix rules (AM7 sanction / review route / escalation),
// Proof-or-Silence for critical items, the rework and help loops, the Карцер hook,
// the preflight scope gate (fail-closed), and audit-append per transition.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createAegisCore } = require("../../core/index.js");
const { createOrchestrator } = require("../index.js");
const { AM7_UNIT, REVIEW_UNIT, SECURITY_UNIT } = require("../directorates");

const tmpDirs = [];

const make = (opts = {}) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-orch-"));
  tmpDirs.push(dataDir);
  let clock = 1_700_000_000_000;
  const now = () => (clock += 1000);
  const core = createAegisCore({ dataDir, now });
  const intents = [];
  const orchestrator = createOrchestrator({ core, now, onReclone: (i) => intents.push(i), ...opts });
  return { core, orchestrator, intents, dataDir };
};

const makeActive = async (core, assets = [{ kind: "domain", value: "example.com", includeSubdomains: true }]) => {
  const eng = await core.engagements.create({ name: "Own audit" });
  for (const asset of assets) await core.engagements.addAsset(eng.id, asset);
  await core.engagements.recordAuthorization(eng.id, { letterRef: "LOA-1", signer: "Owner" });
  await core.engagements.activate(eng.id, { by: "Owner", confirm: true });
  return eng.id;
};

test.after(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {}
  }
});

// Floors: Хакинг (24) finds something, Разработка (14) fixes, Кибербез/ИБ (23) reviews.
const OFFENSE = 24;
const ENGINEERING = 14;

test("full lifecycle: created → in_progress → review → verified → closed (small, direct)", async () => {
  const { orchestrator } = make();
  const created = orchestrator.createItem({ title: "Исправить находку", kind: "small", originUnit: OFFENSE, targetUnit: ENGINEERING });
  assert.equal(created.status, "created");
  assert.equal(created.currentUnit, OFFENSE);

  let item = orchestrator.transition(created.id, "submit", { by: `unit:${OFFENSE}` });
  assert.equal(item.status, "in_progress");
  assert.equal(item.currentUnit, ENGINEERING);

  item = orchestrator.transition(item.id, "send-to-review", { by: `unit:${ENGINEERING}` });
  assert.equal(item.status, "review");
  assert.equal(item.currentUnit, REVIEW_UNIT);

  item = orchestrator.transition(item.id, "verdict", { by: `unit:${REVIEW_UNIT}`, pass: true });
  assert.equal(item.status, "verified");

  item = orchestrator.transition(item.id, "close", { by: `unit:${ENGINEERING}` });
  assert.equal(item.status, "closed");

  // Routing trail is append-only and tells the full кто→кому→зачем→когда story.
  const actions = item.routingTrail.map((t) => t.action);
  assert.deepEqual(actions, ["create", "submit", "send-to-review", "verdict", "close"]);
  for (let i = 1; i < item.routingTrail.length; i += 1) {
    assert.equal(item.routingTrail[i].seq, item.routingTrail[i - 1].seq + 1);
  }

  // A closed item is terminal.
  assert.throws(() => orchestrator.transition(item.id, "submit", {}), /терминальн|CONFLICT|Отправить/);
});

test("cross-floor operation cannot start without AM7 sanction, then can", async () => {
  const { orchestrator } = make();
  const item = orchestrator.createItem({ title: "Межуправленческая операция", kind: "cross-floor", originUnit: OFFENSE, targetUnit: ENGINEERING });

  // No sanction yet → the matrix refuses to let it leave 'created'.
  assert.throws(() => orchestrator.transition(item.id, "submit", { by: `unit:${OFFENSE}` }), /санкц/i);

  // Only AM7 may sanction; a chief cannot.
  assert.throws(() => orchestrator.transition(item.id, "sanction", { by: `unit:${ENGINEERING}` }), /AM7|FORBIDDEN/);

  const sanctioned = orchestrator.transition(item.id, "sanction", { by: `unit:${AM7_UNIT}`, reason: "одобрено" });
  assert.ok(sanctioned.sanction);
  assert.equal(sanctioned.sanction.by, AM7_UNIT);

  const started = orchestrator.transition(item.id, "submit", { by: `unit:${OFFENSE}` });
  assert.equal(started.status, "in_progress");
});

test("critical item needs a confirmed Proof-or-Silence chain before it can be verified", async () => {
  const { orchestrator } = make();
  const item = orchestrator.createItem({ title: "Критичная находка", kind: "small", critical: true, originUnit: OFFENSE, targetUnit: ENGINEERING });
  orchestrator.transition(item.id, "submit", { by: `unit:${OFFENSE}` });
  orchestrator.transition(item.id, "send-to-review", { by: `unit:${ENGINEERING}` });

  // No proof → verdict is refused.
  assert.throws(() => orchestrator.transition(item.id, "verdict", { pass: true }), /независим|Proof|confirmed/i);

  // Prover and Skeptic must be from DIFFERENT model families; a same-family skeptic is not enough.
  orchestrator.transition(item.id, "record-proof", { role: "prover", modelFamily: "llama" });
  orchestrator.transition(item.id, "record-proof", { role: "skeptic", modelFamily: "llama" });
  orchestrator.transition(item.id, "record-proof", { role: "judge", verdict: "confirmed" });
  assert.throws(() => orchestrator.transition(item.id, "verdict", { pass: true }), /независим|Proof|confirmed/i);

  // Add an independent skeptic (different family) → now the chain confirms.
  orchestrator.transition(item.id, "record-proof", { role: "skeptic", modelFamily: "qwen" });
  orchestrator.transition(item.id, "record-proof", { role: "judge", verdict: "confirmed" });
  const verified = orchestrator.transition(item.id, "verdict", { pass: true });
  assert.equal(verified.status, "verified");
});

test("rework loop: failed review returns to author, re-work, re-review, then verified", async () => {
  const { orchestrator } = make();
  const item = orchestrator.createItem({ title: "PR на проверку", kind: "small", originUnit: ENGINEERING, targetUnit: ENGINEERING });
  orchestrator.transition(item.id, "submit", { by: `unit:${ENGINEERING}` });
  orchestrator.transition(item.id, "send-to-review", { by: `unit:${ENGINEERING}` });

  let back = orchestrator.transition(item.id, "rework", { by: `unit:${REVIEW_UNIT}`, note: "остались замечания" });
  assert.equal(back.status, "rework");
  assert.equal(back.currentUnit, ENGINEERING);

  const reworking = orchestrator.transition(item.id, "start", { by: `unit:${ENGINEERING}` });
  assert.equal(reworking.status, "in_progress");

  orchestrator.transition(item.id, "send-to-review", { by: `unit:${ENGINEERING}` });
  const verified = orchestrator.transition(item.id, "verdict", { pass: true });
  assert.equal(verified.status, "verified");

  const reworks = verified.routingTrail.filter((t) => t.action === "rework").length;
  assert.equal(reworks, 1);
});

test("help-request routes to a helper and returns the item to the requester", async () => {
  const { orchestrator } = make();
  const item = orchestrator.createItem({ title: "Нужна помощь ИБ", kind: "small", originUnit: ENGINEERING, targetUnit: ENGINEERING });
  orchestrator.transition(item.id, "submit", { by: `unit:${ENGINEERING}` });

  const helping = orchestrator.transition(item.id, "help-request", { by: `unit:${ENGINEERING}`, helper: REVIEW_UNIT, reason: "устраните замечание" });
  assert.equal(helping.currentUnit, REVIEW_UNIT);
  assert.ok(helping.help);
  assert.equal(helping.help.helper, REVIEW_UNIT);

  // Cannot open a second help-request while one is open.
  assert.throws(() => orchestrator.transition(item.id, "help-request", { helper: SECURITY_UNIT }), /уже открыт|CONFLICT/);

  const returned = orchestrator.transition(item.id, "help-return", { by: `unit:${REVIEW_UNIT}` });
  assert.equal(returned.currentUnit, ENGINEERING);
  assert.equal(returned.status, "in_progress");
  assert.equal(returned.help, null);
});

test("escalation routes to AM7 and AM7 resolves it back to work", async () => {
  const { orchestrator } = make();
  const item = orchestrator.createItem({ title: "Не решается на этаже", kind: "small", originUnit: OFFENSE, targetUnit: ENGINEERING });
  orchestrator.transition(item.id, "submit", { by: `unit:${OFFENSE}` });

  const escalated = orchestrator.transition(item.id, "escalate", { by: `unit:${ENGINEERING}`, reason: "вне scope этажа" });
  assert.equal(escalated.status, "escalated");
  assert.equal(escalated.currentUnit, AM7_UNIT);

  // Only AM7 resolves an escalation.
  assert.throws(() => orchestrator.transition(item.id, "resolve-escalation", { by: `unit:${ENGINEERING}` }), /AM7|FORBIDDEN/);

  const resolved = orchestrator.transition(item.id, "resolve-escalation", { by: `unit:${AM7_UNIT}`, assignTo: ENGINEERING });
  assert.equal(resolved.status, "in_progress");
  assert.equal(resolved.currentUnit, ENGINEERING);
});

test("Карцер hook: a failed output is quarantined, a reclone intent + audit event are emitted", async () => {
  const { orchestrator, core, intents } = make();
  const item = orchestrator.createItem({ title: "Плохой вывод агента", kind: "small", originUnit: OFFENSE, targetUnit: ENGINEERING });
  orchestrator.transition(item.id, "submit", { by: `unit:${OFFENSE}` });

  const { item: quarantined, intent } = orchestrator.quarantine(item.id, { reason: "не прошёл проверку", failedUnit: ENGINEERING, role: "chief" });
  assert.equal(quarantined.quarantine.quarantined, true);
  assert.equal(quarantined.quarantine.failedUnit, ENGINEERING);

  // A reclone intent reached the runtime hook, with a Capability Registry reference.
  assert.equal(intents.length, 1);
  assert.equal(intent.type, "reclone");
  assert.ok(intent.registryRef && intent.registryRef.unit === ENGINEERING);

  // The quarantine was audited against Внутренняя СБ.
  await core.audit.flush();
  const audited = core.audit.list({ limit: 200 }).some((e) => e.type === "orchestrator.quarantine");
  assert.equal(audited, true);
});

test("preflight scope gate denies an out-of-scope acting transition (fail-closed), allows an in-scope one", async () => {
  const { orchestrator, core } = make();
  const engagementId = await makeActive(core); // scope: example.com (+subdomains)

  // Out-of-scope target → submit is refused by preflight before the state changes.
  const bad = orchestrator.createItem({ title: "Скан вне scope", kind: "small", originUnit: OFFENSE, targetUnit: ENGINEERING, engagementId, target: "evil.com" });
  assert.throws(() => orchestrator.transition(bad.id, "submit", { by: `unit:${OFFENSE}` }), /preflight|вне.*scope|DENIED/i);
  assert.equal(orchestrator.getItem(bad.id).status, "created"); // unchanged

  // In-scope target → allowed.
  const good = orchestrator.createItem({ title: "Скан в scope", kind: "small", originUnit: OFFENSE, targetUnit: ENGINEERING, engagementId, target: "a.example.com" });
  const started = orchestrator.transition(good.id, "submit", { by: `unit:${OFFENSE}` });
  assert.equal(started.status, "in_progress");
});

test("every transition appends to the audit ledger and the chain verifies", async () => {
  const { orchestrator, core } = make();
  const before = core.audit.head.seq;
  const item = orchestrator.createItem({ title: "Аудит переходов", kind: "small", originUnit: OFFENSE, targetUnit: ENGINEERING });
  orchestrator.transition(item.id, "submit", {});
  orchestrator.transition(item.id, "send-to-review", {});
  orchestrator.transition(item.id, "verdict", { pass: true });
  orchestrator.transition(item.id, "close", {});

  const after = core.audit.head.seq;
  assert.ok(after - before >= 5);

  await core.audit.flush();
  // create + 4 transitions = 5 orchestrator.transition entries (preflight adds none here, no target).
  const orchEntries = core.audit.list({ limit: 500 }).filter((e) => e.type === "orchestrator.transition");
  assert.ok(orchEntries.length >= 5, `ожидалось >=5 записей переходов, получено ${orchEntries.length}`);
  assert.equal(core.verifyAudit().ok, true);
});

test("board lists items by unit and status", async () => {
  const { orchestrator } = make();
  const a = orchestrator.createItem({ title: "A", kind: "small", originUnit: OFFENSE, targetUnit: ENGINEERING });
  orchestrator.createItem({ title: "B", kind: "small", originUnit: 22, targetUnit: 23 });
  orchestrator.transition(a.id, "submit", {});

  const byOffense = orchestrator.listItems({ unit: OFFENSE });
  assert.equal(byOffense.length, 1);
  assert.equal(byOffense[0].title, "A");

  const inProgress = orchestrator.listItems({ status: "in_progress" });
  assert.equal(inProgress.length, 1);
  assert.equal(inProgress[0].id, a.id);

  const summary = orchestrator.summary();
  assert.equal(summary.total, 2);
});
