// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const targetsModule = await import("../../server/maintenance/targets.js");
const { PATTERNS, applyCandidate, buildTargets, scanTarget } = targetsModule;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const fsp = fs.promises;
const MiB = 1024 * 1024;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const UUID = "0f3c1a2b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

const setAge = (target: string, ageMs: number, nowMs: number) => {
  const seconds = (nowMs - ageMs) / 1000;
  fs.utimesSync(target, seconds, seconds);
};

const writeFile = (file: string, content: string | Buffer, ageMs: number, nowMs: number) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  setAge(file, ageMs, nowMs);
};

const bigFile = (file: string, bytes: number) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "w");
  fs.ftruncateSync(fd, bytes);
  fs.closeSync(fd);
};

const byId = (targets: Loose[], id: string) => targets.find((target) => target.id === id);

const ctxFor = (nowMs: number, dryRun = false) => {
  let ops = 0;
  return {
    now: () => nowMs,
    dryRun,
    batchSize: 25,
    yield: () => Promise.resolve(),
    canSpend: (count: number) => ops + count <= 2000,
    spend: (count: number) => {
      ops += count;
    },
  };
};

describe("maintenance targets", () => {
  let base: string;
  let projectRoot: string;
  let stateDir: string;
  let tmpDir: string;
  let now: number;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "maint-targets-"));
    projectRoot = path.join(base, "project");
    stateDir = path.join(base, "state");
    tmpDir = path.join(base, "tmp");
    for (const dir of [projectRoot, stateDir, tmpDir]) fs.mkdirSync(dir, { recursive: true });
    now = Date.now();
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const targets = (dev = true, testTemp = true) => buildTargets({ dev, projectRoot, stateDir, tmpDir, testTemp });

  it("has the six targets in dev and only the all-scope ones in production", () => {
    expect(targets(true).map((t: Loose) => t.id)).toEqual([
      "dev-trace",
      "dev-log",
      "hmr-updates",
      "voice-temp",
      "test-temp",
      "orphan-tmp",
    ]);
    expect(targets(false).map((t: Loose) => t.id)).toEqual(["voice-temp", "orphan-tmp"]);
    expect(targets(true, false).map((t: Loose) => t.id)).not.toContain("test-temp");
  });

  it("matches the test-temp names exactly and leaves aegis-pf-* alone", () => {
    const re = PATTERNS.testTemp;
    expect(re.test("office3d-test-abc123")).toBe(true);
    expect(re.test("office3d-skill-remove-Q1w2E3")).toBe(true);
    expect(re.test("office3d-gateway-defaults-a1b2c3")).toBe(true);
    expect(re.test("office3d-e2e-a1b2c3")).toBe(true);
    for (const name of [
      "office3d-test-abc12",
      "office3d-test-abc1234",
      "office3d-test-abc12!",
      "xoffice3d-test-abc123",
      "office3d-voice-abc123",
      "aegis-pf-abc123",
      "aegis-abc123",
      "studio-state-abc123",
      "workspace-abc123",
      "office3d-test-",
      "office3d-test-abc123/..",
    ]) {
      expect(re.test(name), name).toBe(false);
    }
    expect(PATTERNS.voiceTemp.test("office3d-voice-abc123")).toBe(true);
    expect(PATTERNS.voiceTemp.test("office3d-voice-abc1234")).toBe(false);
    expect(PATTERNS.settingsTmp.test(`.settings-${UUID}.tmp`)).toBe(true);
    expect(PATTERNS.settingsTmp.test("settings.json")).toBe(false);
    expect(PATTERNS.tasksTmp.test(`.tasks-${UUID}.tmp`)).toBe(true);
    expect(PATTERNS.tasksTmp.test(`.tasks-${UUID}.tmp.bak`)).toBe(false);
  });

  it("selects the trace and log by size", async () => {
    bigFile(path.join(projectRoot, ".next", "dev", "trace"), 17 * MiB);
    bigFile(path.join(projectRoot, ".next", "dev", "logs", "next-development.log"), 3 * MiB);
    const trace = await scanTarget(fsp, byId(targets(), "dev-trace"), { now: () => now });
    expect(trace.items).toBe(1);
    expect(trace.bytes).toBe(17 * MiB);
    const log = await scanTarget(fsp, byId(targets(), "dev-log"), { now: () => now });
    expect(log.items).toBe(0);
    bigFile(path.join(projectRoot, ".next", "dev", "logs", "next-development.log"), 5 * MiB);
    const log2 = await scanTarget(fsp, byId(targets(), "dev-log"), { now: () => now });
    expect(log2.items).toBe(1);
  });

  it("keeps the newest 50 hot updates per folder and only takes old ones", async () => {
    const webpack = path.join(projectRoot, ".next", "dev", "static", "webpack");
    for (let i = 0; i < 60; i += 1) writeFile(path.join(webpack, `h${i}.webpack.hot-update.json`), "{}", 2 * HOUR + i * 1000, now);
    for (let i = 0; i < 5; i += 1) writeFile(path.join(webpack, `n${i}.webpack.hot-update.json`), "{}", MINUTE, now);
    for (let i = 0; i < 3; i += 1) writeFile(path.join(webpack, "app", `layout.${i}.hot-update.js`), "x", 3 * HOUR, now);
    writeFile(path.join(webpack, "not-an-update.js"), "x", 3 * HOUR, now);
    const scan = await scanTarget(fsp, byId(targets(), "hmr-updates"), { now: () => now });
    // 65 in the folder, the newest 50 kept (5 new + 45 old): 15 old remain.
    expect(scan.items).toBe(15);
    const names = scan.candidates.map((c: Loose) => c.name);
    expect(names.every((name: string) => name.startsWith("h"))).toBe(true);
    // The oldest ones go (largest i).
    expect(names).toContain("h59.webpack.hot-update.json");
    expect(names).not.toContain("h0.webpack.hot-update.json");
  });

  it("selects old test temp folders only when everything in them is old", async () => {
    const oldDir = path.join(tmpDir, "office3d-test-abc123");
    writeFile(path.join(oldDir, "sub", "settings.json"), "{}", 30 * HOUR, now);
    setAge(path.join(oldDir, "sub"), 30 * HOUR, now);
    setAge(oldDir, 30 * HOUR, now);
    const freshInside = path.join(tmpDir, "office3d-test-def456");
    writeFile(path.join(freshInside, "a.txt"), "x", HOUR, now);
    setAge(freshInside, 30 * HOUR, now);
    const young = path.join(tmpDir, "office3d-skill-remove-ghi789");
    fs.mkdirSync(young);
    const aegis = path.join(tmpDir, "aegis-pf-abc123");
    writeFile(path.join(aegis, "x"), "x", 30 * HOUR, now);
    setAge(aegis, 30 * HOUR, now);
    const scan = await scanTarget(fsp, byId(targets(), "test-temp"), { now: () => now });
    expect(scan.candidates.map((c: Loose) => c.name)).toEqual(["office3d-test-abc123"]);
  });

  it("never selects a test temp folder with a junction inside", async () => {
    const outside = path.join(base, "outside");
    writeFile(path.join(outside, "keep.txt"), "keep", 30 * HOUR, now);
    const dir = path.join(tmpDir, "office3d-test-jjj111");
    writeFile(path.join(dir, "a.txt"), "x", 30 * HOUR, now);
    fs.symlinkSync(outside, path.join(dir, "link"), "junction");
    setAge(dir, 30 * HOUR, now);
    const scan = await scanTarget(fsp, byId(targets(), "test-temp"), { now: () => now });
    expect(scan.items).toBe(0);
    expect(fs.existsSync(path.join(outside, "keep.txt"))).toBe(true);
  });

  it("selects old orphaned .tmp files and never settings.json", async () => {
    const office = path.join(stateDir, "office3d");
    writeFile(path.join(office, "settings.json"), "{}", 30 * HOUR, now);
    writeFile(path.join(office, `.settings-${UUID}.tmp`), "{}", 20 * MINUTE, now);
    writeFile(path.join(office, `.settings-${UUID.replace("0f", "1f")}.tmp`), "{}", 2 * MINUTE, now);
    writeFile(path.join(office, "task-manager", "tasks.json"), "{}", 30 * HOUR, now);
    writeFile(path.join(office, "task-manager", `.tasks-${UUID}.tmp`), "{}", 20 * MINUTE, now);
    const scan = await scanTarget(fsp, byId(targets(false), "orphan-tmp"), { now: () => now });
    expect(scan.candidates.map((c: Loose) => c.name).sort()).toEqual([`.settings-${UUID}.tmp`, `.tasks-${UUID}.tmp`]);
  });

  it("truncates to 0 while an open 'a' stream keeps appending", async () => {
    const logFile = path.join(projectRoot, ".next", "dev", "logs", "next-development.log");
    bigFile(logFile, 5 * MiB);
    const stream = fs.createWriteStream(logFile, { flags: "a" });
    await new Promise((resolve) => stream.once("open", resolve));
    const target = byId(targets(), "dev-log");
    const scan = await scanTarget(fsp, target, { now: () => now });
    const result = await applyCandidate(fsp, target, scan.candidates[0], ctxFor(now));
    expect(result).toMatchObject({ done: true, bytes: 5 * MiB, ops: 1 });
    expect(fs.statSync(logFile).size).toBe(0);
    await new Promise<void>((resolve, reject) => stream.write("hello\n", (err) => (err ? reject(err) : resolve())));
    await new Promise((resolve) => stream.end(resolve));
    expect(fs.readFileSync(logFile, "utf8")).toBe("hello\n");
  });

  it("removes an old tree bottom-up and leaves everything else", async () => {
    const dir = path.join(tmpDir, "office3d-test-abc123");
    writeFile(path.join(dir, "a", "b", "c.txt"), "abc", 30 * HOUR, now);
    writeFile(path.join(dir, "settings.json"), "{}", 30 * HOUR, now);
    setAge(path.join(dir, "a", "b"), 30 * HOUR, now);
    setAge(path.join(dir, "a"), 30 * HOUR, now);
    setAge(dir, 30 * HOUR, now);
    const keep = path.join(tmpDir, "aegis-pf-abc123");
    writeFile(path.join(keep, "x"), "x", 30 * HOUR, now);
    const target = byId(targets(), "test-temp");
    const scan = await scanTarget(fsp, target, { now: () => now });
    expect(scan.items).toBe(1);
    expect(scan.bytes).toBe(5);
    const result = await applyCandidate(fsp, target, scan.candidates[0], ctxFor(now));
    expect(result.done).toBe(true);
    // 2 files + 3 folders.
    expect(result.ops).toBe(5);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.join(keep, "x"))).toBe(true);
  });

  it("re-checks the age right before removing", async () => {
    const office = path.join(stateDir, "office3d");
    const file = path.join(office, `.settings-${UUID}.tmp`);
    writeFile(file, "{}", 20 * MINUTE, now);
    const target = byId(targets(false), "orphan-tmp");
    const scan = await scanTarget(fsp, target, { now: () => now });
    expect(scan.items).toBe(1);
    // Rewritten between the scan and the operation.
    setAge(file, 0, now);
    const result = await applyCandidate(fsp, target, scan.candidates[0], ctxFor(now));
    expect(result).toMatchObject({ done: false, skipped: "rule" });
    expect(fs.existsSync(file)).toBe(true);
  });

  it("does nothing in a dry run", async () => {
    const office = path.join(stateDir, "office3d");
    const file = path.join(office, `.settings-${UUID}.tmp`);
    writeFile(file, "{}", 20 * MINUTE, now);
    const target = byId(targets(false), "orphan-tmp");
    const scan = await scanTarget(fsp, target, { now: () => now });
    const result = await applyCandidate(fsp, target, scan.candidates[0], ctxFor(now, true));
    expect(result).toMatchObject({ done: true, bytes: 2, ops: 0 });
    expect(fs.existsSync(file)).toBe(true);
  });
});
