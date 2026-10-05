// Control-plane HTTP contract for the orchestrator: loopback-only + token-gated,
// work-item create/list/get + transitions, board, and registry — every call
// audited inside the orchestrator.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { start, stop } = require("../../control-plane/index.js");

const TOKEN = "test-token-orch";
const OFFENSE = 24;
const ENGINEERING = 14;
const REVIEW_UNIT = 23;

const boot = async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-cp-orch-"));
  const running = await start({ PLATFORM_TOKEN: TOKEN, PLATFORM_HOST: "127.0.0.1", PLATFORM_PORT: "0", PLATFORM_DATA_DIR: dataDir });
  const base = `http://127.0.0.1:${running.server.address().port}`;
  return { running, base, dataDir };
};

const shut = async ({ running, dataDir }) => {
  await stop(running);
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
};

const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const post = (base, p, body) => fetch(`${base}${p}`, { method: "POST", headers: H, body: JSON.stringify(body ?? {}) });
const get = (base, p) => fetch(`${base}${p}`, { headers: H });

test("work-items require the token", async () => {
  const ctx = await boot();
  try {
    const res = await fetch(`${ctx.base}/v1/work-items`);
    assert.equal(res.status, 401);
  } finally {
    await shut(ctx);
  }
});

test("work-item lifecycle over HTTP: create → submit → review → verdict → close, board + registry", async () => {
  const ctx = await boot();
  try {
    const created = await (await post(ctx.base, "/v1/work-items", { title: "HTTP элемент", kind: "small", originUnit: OFFENSE, targetUnit: ENGINEERING })).json();
    assert.ok(created.id);
    assert.equal(created.status, "created");

    let item = await (await post(ctx.base, `/v1/work-items/${created.id}/submit`, { by: `unit:${OFFENSE}` })).json();
    assert.equal(item.status, "in_progress");

    item = await (await post(ctx.base, `/v1/work-items/${created.id}/send-to-review`, {})).json();
    assert.equal(item.status, "review");
    assert.equal(item.currentUnit, REVIEW_UNIT);

    item = await (await post(ctx.base, `/v1/work-items/${created.id}/verdict`, { pass: true })).json();
    assert.equal(item.status, "verified");

    item = await (await post(ctx.base, `/v1/work-items/${created.id}/close`, {})).json();
    assert.equal(item.status, "closed");

    // GET one, and the board shows no OPEN items now.
    const fetched = await (await get(ctx.base, `/v1/work-items/${created.id}`)).json();
    assert.equal(fetched.status, "closed");

    const board = await (await get(ctx.base, "/v1/board")).json();
    assert.equal(board.summary.total, 1);
    assert.equal(board.items.length, 0); // open only

    // Registry read.
    const reg = await (await get(ctx.base, "/v1/registry")).json();
    assert.ok(reg.entries.length > 0);
    const capsule = await (await get(ctx.base, `/v1/registry/${ENGINEERING}/chief`)).json();
    assert.equal(capsule.unit, ENGINEERING);
    assert.equal(capsule.role, "chief");

    // The whole run is in the (verifiable) ledger.
    const verify = await (await get(ctx.base, "/v1/audit/verify")).json();
    assert.equal(verify.ok, true);
  } finally {
    await shut(ctx);
  }
});

test("an unknown transition is a 404", async () => {
  const ctx = await boot();
  try {
    const created = await (await post(ctx.base, "/v1/work-items", { title: "X", kind: "small", originUnit: OFFENSE, targetUnit: ENGINEERING })).json();
    const res = await post(ctx.base, `/v1/work-items/${created.id}/teleport`, {});
    assert.equal(res.status, 404);
  } finally {
    await shut(ctx);
  }
});
