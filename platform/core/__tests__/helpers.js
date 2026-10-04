// Shared test helpers for the platform Security Core negative test net.
// (Plain .js — not a *.test.js — so the node:test runner does not execute it.)

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createAegisCore } = require("../index.js");

const tmpDirs = [];

/** A fresh isolated core with a monotonic injected clock. */
const makeCore = (options = {}) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-platform-"));
  tmpDirs.push(dataDir);
  let clock = 1_700_000_000_000;
  const core = createAegisCore({ dataDir, now: () => (clock += 1000), ...options });
  return { core, dataDir };
};

/** Drive one engagement all the way to active with the given assets. */
const makeActive = async (core, assets = [{ kind: "domain", value: "example.com", includeSubdomains: true }]) => {
  const eng = await core.engagements.create({ name: "Own audit" });
  for (const asset of assets) await core.engagements.addAsset(eng.id, asset);
  await core.engagements.recordAuthorization(eng.id, { letterRef: "LOA-1", signer: "Owner" });
  await core.engagements.activate(eng.id, { by: "Owner", confirm: true });
  return eng.id;
};

const cleanup = () => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // best effort
    }
  }
};

module.exports = { makeCore, makeActive, cleanup };
