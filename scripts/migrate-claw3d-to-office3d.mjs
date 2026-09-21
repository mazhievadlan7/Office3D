#!/usr/bin/env node
/**
 * One-shot migration for the Claw3D -> Office3D rebrand.
 *
 * The rebrand was a hard cut with no backwards-compatibility layer, so local
 * state written by a Claw3D install is invisible to Office3D until it is moved
 * and rewritten. This script does that.
 *
 * It handles:
 *   1. the state directory        <stateDir>/claw3d      -> <stateDir>/office3d
 *   2. persisted runtime ids      "claw3d"               -> "office3d"
 *   3. persisted task sources     "claw3d_manual"        -> "office3d_manual"
 *   4. environment variables      CLAW3D_*               -> OFFICE3D_*
 *
 * Browser localStorage cannot be migrated from Node; the keys are reported at
 * the end so they can be renamed from the browser console if the onboarding
 * state matters.
 *
 * Safe by default: prints a plan and changes nothing. Pass --apply to execute.
 * Every file it rewrites is backed up alongside the original first.
 *
 *   node scripts/migrate-claw3d-to-office3d.mjs
 *   node scripts/migrate-claw3d-to-office3d.mjs --apply
 *
 * Re-running after a successful migration is a no-op.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APPLY = process.argv.includes("--apply");
const MERGE = process.argv.includes("--merge");

// Mirrors resolveStateDir() in server/studio-settings.js. Kept in sync
// deliberately: a mismatch here would migrate the wrong directory.
const NEW_STATE_DIRNAME = ".openclaw";
const LEGACY_STATE_DIRNAMES = [".clawdbot", ".moltbot"];

const exists = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

const resolveUserPath = (input) =>
  input.startsWith("~")
    ? path.join(os.homedir(), input.slice(1))
    : path.resolve(input);

const resolveDefaultHomeDir = () => {
  const home = os.homedir();
  return home && exists(home) ? home : os.tmpdir();
};

const resolveStateDir = (env = process.env) => {
  const override =
    env.OPENCLAW_STATE_DIR?.trim() ||
    env.MOLTBOT_STATE_DIR?.trim() ||
    env.CLAWDBOT_STATE_DIR?.trim();
  if (override) return resolveUserPath(override);

  const home = resolveDefaultHomeDir();
  const newDir = path.join(home, NEW_STATE_DIRNAME);
  if (exists(newDir)) return newDir;
  for (const dir of LEGACY_STATE_DIRNAMES.map((d) => path.join(home, d))) {
    if (exists(dir)) return dir;
  }
  return newDir;
};

const actions = [];
const notes = [];
const plan = (what) => actions.push(what);

const backup = (file) => {
  const dest = `${file}.claw3d-backup`;
  if (!APPLY) return dest;
  if (!exists(dest)) fs.copyFileSync(file, dest);
  return dest;
};

/** Recursively merge `from` into `to`, leaving existing files in `to` alone. */
const mergeDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      mergeDir(src, dst);
    } else if (!exists(dst)) {
      fs.renameSync(src, dst);
    }
  }
};

// ---------------------------------------------------------------- state dir

const stateDir = resolveStateDir();
const legacyDir = path.join(stateDir, "claw3d");
const targetDir = path.join(stateDir, "office3d");

console.log(`state directory: ${stateDir}`);

if (!exists(legacyDir)) {
  plan(`state dir: nothing to move (${legacyDir} does not exist)`);
} else if (!exists(targetDir)) {
  plan(`state dir: move ${legacyDir} -> ${targetDir}`);
  if (APPLY) fs.renameSync(legacyDir, targetDir);
} else if (MERGE) {
  plan(`state dir: merge ${legacyDir} into existing ${targetDir}`);
  if (APPLY) {
    mergeDir(legacyDir, targetDir);
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
} else {
  plan(
    `state dir: BOTH ${legacyDir} and ${targetDir} exist — refusing to move. ` +
      `Inspect them, then re-run with --merge to keep the newer files.`,
  );
}

// ------------------------------------------------------------ persisted JSON

/** Rewrite brand-scoped string values in a JSON document, in place. */
const rewriteJsonValues = (value) => {
  if (typeof value === "string") {
    if (value === "claw3d") return ["office3d", true];
    if (value === "claw3d_manual") return ["office3d_manual", true];
    return [value, false];
  }
  if (Array.isArray(value)) {
    let touched = false;
    const out = value.map((item) => {
      const [next, hit] = rewriteJsonValues(item);
      touched ||= hit;
      return next;
    });
    return [out, touched];
  }
  if (value && typeof value === "object") {
    let touched = false;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const [next, hit] = rewriteJsonValues(v);
      touched ||= hit;
      out[k] = next;
    }
    return [out, touched];
  }
  return [value, false];
};

const migrateJsonFile = (file, label) => {
  if (!exists(file)) {
    plan(`${label}: not present, skipped`);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    plan(`${label}: UNREADABLE (${err.message}) — left untouched`);
    return;
  }
  const [next, touched] = rewriteJsonValues(parsed);
  if (!touched) {
    plan(`${label}: already migrated`);
    return;
  }
  plan(`${label}: rewrite claw3d ids (backup -> ${path.basename(backup(file))})`);
  if (APPLY) fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
};

// On a dry run the move above has not happened, so the files are still under
// the legacy directory. Inspect wherever they actually are right now.
const inspectDir = exists(targetDir) ? targetDir : legacyDir;

migrateJsonFile(path.join(inspectDir, "settings.json"), "settings.json");
migrateJsonFile(
  path.join(inspectDir, "task-manager", "tasks.json"),
  "tasks.json",
);

// ------------------------------------------------------------------ env files

const ENV_PREFIX = /\bCLAW3D_/g;
const repoRoot = path.resolve(import.meta.dirname, "..");

for (const name of [".env", ".env.local", ".env.production", ".env.development"]) {
  const file = path.join(repoRoot, name);
  if (!exists(file)) continue;
  const text = fs.readFileSync(file, "utf8");
  const hits = text.match(ENV_PREFIX);
  if (!hits) {
    plan(`${name}: no CLAW3D_ variables`);
    continue;
  }
  plan(
    `${name}: rename ${hits.length} CLAW3D_ variable(s) to OFFICE3D_ ` +
      `(backup -> ${path.basename(backup(file))})`,
  );
  if (APPLY) fs.writeFileSync(file, text.replace(ENV_PREFIX, "OFFICE3D_"));
}

notes.push(
  "Browser state cannot be migrated from Node. If the onboarding screen " +
    "reappears, run this in the browser console on the app origin:\n" +
    "    localStorage.setItem('office3d:onboarding:completed'," +
    " localStorage.getItem('claw3d:onboarding:completed') ?? 'true');",
);

// ---------------------------------------------------------------------- report

console.log(`\n${APPLY ? "Applied" : "Planned (dry run)"}:`);
for (const line of actions) console.log(`  - ${line}`);
for (const note of notes) console.log(`\n${note}`);
if (!APPLY) {
  console.log("\nNothing was changed. Re-run with --apply to execute.");
}
