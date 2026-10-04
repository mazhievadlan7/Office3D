// The server/aegis shims must re-export the platform/core modules unchanged, so
// the Next server and the existing tests/unit/aegis*.test.ts keep working after
// the move. Each shim does `module.exports = require("../../platform/core/x")`,
// so the shim's exports object must be the very same reference.

const test = require("node:test");
const assert = require("node:assert/strict");

const MODULES = [
  "scope",
  "preflight",
  "egress",
  "governance",
  "engagement",
  "audit",
  "verify",
  "store",
  "ip",
  "errors",
  "index",
];

test("every server/aegis shim is the exact same module object as platform/core", () => {
  for (const name of MODULES) {
    const core = require(`../${name}.js`);
    const shim = require(`../../../server/aegis/${name}.js`);
    assert.equal(shim, core, `server/aegis/${name}.js should re-export platform/core/${name}.js`);
    assert.deepEqual(Object.keys(shim).sort(), Object.keys(core).sort(), `exported keys differ for ${name}`);
  }
});

test("the public core API surface is intact through the shim", () => {
  const { createAegisCore } = require("../../../server/aegis/index.js");
  assert.equal(typeof createAegisCore, "function");
  const { RULES, composeSystemPrompt } = require("../../../server/aegis/governance.js");
  assert.ok(Array.isArray(RULES) && RULES.length === 6);
  assert.equal(typeof composeSystemPrompt, "function");
  const { matchTarget, validateAsset } = require("../../../server/aegis/scope.js");
  assert.equal(typeof matchTarget, "function");
  assert.equal(typeof validateAsset, "function");
});
