// @vitest-environment node
// Hardening of the maintenance service found in its security review: other
// users' files on POSIX, roots above the home folder, bounded scans, and the
// run log served back through the status endpoint.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const safety = await import("../../server/maintenance/safety.js");
const targetsModule = await import("../../server/maintenance/targets.js");
const { MAX_SUBDIRS, buildTargets, expandSubdirs, scanTarget, walkTree } = targetsModule;
const { createMaintenanceService } = await import("../../server/maintenance/index.js");
const { sanitizeRun } = await import("../../server/maintenance/runlog.js");
const { allowHttpOrigin } = await import("../../server/request-guard.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const fsp = fs.promises;
const HOUR = 3_600_000;
const MiB = 1024 * 1024;
// A uid no file in the fixtures belongs to (Windows reports 0 for all).
const STRANGER = 424242;

const setAge = (target: string, ageMs: number, nowMs: number) => {
  const seconds = (nowMs - ageMs) / 1000;
  fs.utimesSync(target, seconds, seconds);
};

const oldTree = (dir: string, files: number, nowMs: number) => {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < files; i += 1) {
    fs.writeFileSync(path.join(dir, `f${i}.txt`), "x");
    setAge(path.join(dir, `f${i}.txt`), 30 * HOUR, nowMs);
  }
  setAge(dir, 30 * HOUR, nowMs);
};

describe("maintenance security: roots", () => {
  it("refuses the home folder and every folder above it", () => {
    const home = os.homedir();
    expect(safety.isDangerousRoot(home, home)).toBe(true);
    expect(safety.isDangerousRoot(path.dirname(home), home)).toBe(true);
    expect(safety.isDangerousRoot(path.join(home, "AppData", "Local", "Temp"), home)).toBe(false);
    expect(safety.isDangerousRoot(`${home}x`, home)).toBe(false);
    expect(safety.isDangerousRoot("/tmp", "/")).toBe(false);
  });
});

describe("maintenance security: ownership (POSIX)", () => {
  const fakeStat = (uid: number, mode: number, dir: boolean) => ({ uid, mode, isDirectory: () => dir });

  it("refuses items another user owns and folders others can write to", () => {
    expect(safety.ownershipProblem(fakeStat(1000, 0o100644, false), 1000)).toBeNull();
    expect(safety.ownershipProblem(fakeStat(1001, 0o100644, false), 1000)).toBe("not-owner");
    expect(safety.ownershipProblem(fakeStat(1000, 0o40700, true), 1000)).toBeNull();
    expect(safety.ownershipProblem(fakeStat(1000, 0o40777, true), 1000)).toBe("shared-dir");
    expect(safety.ownershipProblem(fakeStat(1000, 0o40770, true), 1000)).toBe("shared-dir");
    // Windows: no uid check at all.
    expect(safety.ownershipProblem(fakeStat(0, 0o40777, true), null)).toBeNull();
    if (process.platform === "win32") expect(safety.currentUid()).toBeNull();
    else expect(safety.currentUid()).toBe(process.getuid?.());
  });

  let base: string;
  let tmpDir: string;
  let now: number;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "maint-sec-"));
    tmpDir = path.join(base, "tmp");
    fs.mkdirSync(tmpDir);
    now = Date.now();
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("never selects or walks a folder another user owns", async () => {
    const dir = path.join(tmpDir, "office3d-voice-abc123");
    oldTree(dir, 1, now);
    const target = buildTargets({ dev: false, projectRoot: base, stateDir: base, tmpDir }).find((t: Loose) => t.id === "voice-temp");
    const own = await scanTarget(fsp, target, { now: () => now, ownerUid: null });
    expect(own.items).toBe(1);
    const foreign = await scanTarget(fsp, target, { now: () => now, ownerUid: STRANGER });
    expect(foreign.items).toBe(0);
    const walked = await walkTree(fsp, dir, { maxEntries: 16, maxDepth: 1, ownerUid: STRANGER });
    expect(walked).toMatchObject({ ok: false, reason: "not-owner" });
    const check = await safety.checkItem(fsp, {
      realRoot: fs.realpathSync(tmpDir),
      name: "office3d-voice-abc123",
      regex: /.*/,
      expect: "dir",
      ownerUid: STRANGER,
    });
    expect(check).toEqual({ ok: false, reason: "not-owner" });
  });
});

describe("maintenance security: bounded work", () => {
  let base: string;
  let tmpDir: string;
  let now: number;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "maint-sec-"));
    tmpDir = path.join(base, "tmp");
    fs.mkdirSync(tmpDir);
    now = Date.now();
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("stops walking test temp trees once the scan budget is spent", async () => {
    for (const suffix of ["aaa111", "bbb222", "ccc333"]) oldTree(path.join(tmpDir, `office3d-test-${suffix}`), 10, now);
    const target = buildTargets({ dev: true, projectRoot: base, stateDir: base, tmpDir }).find((t: Loose) => t.id === "test-temp");
    let lstats = 0;
    const counting = {
      ...fsp,
      lstat: (p: string) => {
        lstats += 1;
        return fsp.lstat(p);
      },
    };
    const tight = await scanTarget(counting, target, { now: () => now, budget: { entries: 12 }, ownerUid: null });
    expect(tight.partial).toBe(true);
    expect(tight.items).toBe(0);
    // 3 names checked + one bounded walk (at most ~budget entries), not 3 whole trees.
    expect(lstats).toBeLessThan(25);
    const roomy = await scanTarget(fsp, target, { now: () => now, budget: { entries: 100 }, ownerUid: null });
    expect(roomy).toMatchObject({ items: 3, partial: false });
  });

  it("never removes a temp tree that holds this server's own state dir", async () => {
    const e2eState = path.join(tmpDir, "office3d-e2e-abc123");
    oldTree(path.join(e2eState, "office3d"), 1, now);
    setAge(e2eState, 30 * HOUR, now);
    const other = path.join(tmpDir, "office3d-e2e-def456");
    oldTree(other, 1, now);
    const target = buildTargets({ dev: true, projectRoot: path.join(base, "project"), stateDir: e2eState, tmpDir }).find(
      (t: Loose) => t.id === "test-temp"
    );
    const scan = await scanTarget(fsp, target, { now: () => now, ownerUid: null });
    expect(scan.candidates.map((c: Loose) => c.name)).toEqual(["office3d-e2e-def456"]);
    // Even a candidate handed in directly is refused at the operation.
    const { applyCandidate } = targetsModule;
    const forged = { ...scan.candidates[0], name: "office3d-e2e-abc123", stat: fs.lstatSync(e2eState) };
    const ctx = { now: () => now, dryRun: false, batchSize: 25, yield: () => Promise.resolve(), canSpend: () => true, spend: () => {}, ownerUid: null };
    expect(await applyCandidate(fsp, target, forged, ctx)).toMatchObject({ done: false, skipped: "protected" });
    expect(fs.existsSync(path.join(e2eState, "office3d"))).toBe(true);
  });

  it("expands at most MAX_SUBDIRS folders under a root, across all levels", async () => {
    const root = path.join(base, "webpack");
    for (let i = 0; i < 12; i += 1) {
      for (let j = 0; j < 12; j += 1) fs.mkdirSync(path.join(root, `d${i}`, `e${j}`), { recursive: true });
    }
    const dirs = await expandSubdirs(fsp, fs.realpathSync(root), 3);
    expect(MAX_SUBDIRS).toBe(64);
    expect(dirs.length).toBeLessThanOrEqual(MAX_SUBDIRS);
  });
});

describe("maintenance security: run log and origin", () => {
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "maint-sec-"));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("serves runs read back from disk with only the documented fields", async () => {
    const logDir = path.join(base, "state", "office3d", "maintenance");
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(path.join(base, "project"));
    const leaked = path.join(os.homedir(), "secret.txt");
    const line = JSON.stringify({
      id: "run-1",
      finishedAt: 5,
      trigger: "manual",
      path: leaked,
      actions: [{ target: "voice-temp", op: "remove", bytes: 3, items: 1, file: leaked }, { target: leaked, op: "remove" }],
      errors: [{ target: "voice-temp", code: "EBUSY", count: 1, message: leaked }],
    });
    fs.writeFileSync(path.join(logDir, "runs.jsonl"), `${line}\n`);
    const service = createMaintenanceService({
      env: {} as Loose,
      dev: true,
      projectRoot: path.join(base, "project"),
      stateDir: path.join(base, "state"),
      tmpDir: path.join(base, "tmp"),
      log: () => {},
      readMemory: () => ({ rss: MiB, heapUsed: MiB, heapLimit: 64 * MiB, external: 0, arrayBuffers: 0 }),
    });
    await service.start();
    service.stop();
    const body = JSON.stringify(service.snapshot());
    expect(body.includes("secret.txt")).toBe(false);
    const [run] = service.snapshot().recentRuns;
    expect(run.actions).toEqual([{ target: "voice-temp", op: "remove", bytes: 3, items: 1 }]);
    expect(run.errors).toEqual([{ target: "voice-temp", code: "EBUSY", count: 1 }]);
    expect(sanitizeRun({ id: "x", finishedAt: 1, capped: "bogus", trigger: "rm -rf" })).toMatchObject({ capped: null, trigger: "manual" });
  });

  it("refuses a Sec-Fetch-Site header sent twice", () => {
    expect(allowHttpOrigin({ headers: { "sec-fetch-site": "same-origin, cross-site" } })).toBe(false);
    expect(allowHttpOrigin({ headers: { "sec-fetch-site": "none", origin: "http://localhost:3000", host: "localhost:3000" } })).toBe(false);
    expect(allowHttpOrigin({ headers: { origin: "http://localhost:3000@evil.test", host: "localhost:3000" } })).toBe(false);
    expect(allowHttpOrigin({ headers: { origin: "file://localhost:3000", host: "localhost:3000" } })).toBe(false);
  });
});
