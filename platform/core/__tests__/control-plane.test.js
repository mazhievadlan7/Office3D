// Control-plane HTTP contract: loopback-only, token-gated, and it reuses the
// Security Core so a sample /v1/preflight against an out-of-scope target denies.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { start, stop } = require("../../control-plane/index.js");

const TOKEN = "test-token-123";

const boot = async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-cp-"));
  const running = await start({
    PLATFORM_TOKEN: TOKEN,
    PLATFORM_HOST: "127.0.0.1",
    PLATFORM_PORT: "0", // ephemeral free port
    PLATFORM_DATA_DIR: dataDir,
  });
  const port = running.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return { running, base, dataDir };
};

const shut = async ({ running, dataDir }) => {
  await stop(running);
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // best effort
  }
};

test("GET /health is unauthenticated and reports security posture", async () => {
  const ctx = await boot();
  try {
    const res = await fetch(`${ctx.base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, "aegis-control-plane");
    assert.ok(body.security && body.security.killSwitch);
  } finally {
    await shut(ctx);
  }
});

test("/v1/* requires the PLATFORM_TOKEN", async () => {
  const ctx = await boot();
  try {
    const noToken = await fetch(`${ctx.base}/v1/killswitch`);
    assert.equal(noToken.status, 401);

    const withToken = await fetch(`${ctx.base}/v1/killswitch`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(withToken.status, 200);
  } finally {
    await shut(ctx);
  }
});

test("POST /v1/preflight denies an action with no active engagement (default-deny)", async () => {
  const ctx = await boot();
  try {
    const res = await fetch(`${ctx.base}/v1/preflight`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ engagementId: "missing", actor: "exec-plane", action: "scan", target: "example.com" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.allowed, false);
    assert.equal(body.decision, "deny");
  } finally {
    await shut(ctx);
  }
});

test("full lifecycle over HTTP: create → asset → authorize → activate → preflight allow, and governance prompt", async () => {
  const ctx = await boot();
  const h = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  try {
    const created = await (await fetch(`${ctx.base}/v1/engagements`, { method: "POST", headers: h, body: JSON.stringify({ name: "HTTP audit" }) })).json();
    const id = created.id;
    assert.ok(id);

    await fetch(`${ctx.base}/v1/engagements/${id}/assets`, { method: "POST", headers: h, body: JSON.stringify({ kind: "domain", value: "example.com", includeSubdomains: true }) });
    await fetch(`${ctx.base}/v1/engagements/${id}/authorize`, { method: "POST", headers: h, body: JSON.stringify({ letterRef: "LOA-1", signer: "Owner" }) });
    await fetch(`${ctx.base}/v1/engagements/${id}/activate`, { method: "POST", headers: h, body: JSON.stringify({ by: "Owner", confirm: true }) });

    const allow = await (await fetch(`${ctx.base}/v1/preflight`, { method: "POST", headers: h, body: JSON.stringify({ engagementId: id, actor: "exec", action: "scan", target: "a.example.com" }) })).json();
    assert.equal(allow.allowed, true);

    // Egress render reflects the scope.
    const egress = await (await fetch(`${ctx.base}/v1/egress/${id}`, { headers: h })).json();
    assert.ok(egress.allowlist.domains.includes("example.com"));
    assert.match(egress.nftables, /policy drop/);

    // Governance system prompt comes from the single source and names the scope.
    const gov = await (await fetch(`${ctx.base}/v1/governance/system-prompt?engagementId=${id}`, { headers: h })).json();
    assert.equal(gov.rules.length, 6);
    assert.match(gov.prompt, /example\.com/);

    // Audit chain verifies.
    const verify = await (await fetch(`${ctx.base}/v1/audit/verify`, { headers: h })).json();
    assert.equal(verify.ok, true);
  } finally {
    await shut(ctx);
  }
});
