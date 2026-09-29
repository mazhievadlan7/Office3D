// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { CARTWORTHY, LIMITS, SCHEDULE, createMaintenanceService, nextLocalHour } = await import(
  "../../server/maintenance/index.js"
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const MiB = 1024 * 1024;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const UUID = "0f3c1a2b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

const setAge = (target: string, ageMs: number, nowMs: number) => {
  const seconds = (nowMs - ageMs) / 1000;
  fs.utimesSync(target, seconds, seconds);
};

const writeFile = (file: string, content: string, ageMs: number, nowMs: number) => {
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

const quietMemory = () => ({ rss: 300 * MiB, heapUsed: 100 * MiB, heapLimit: 4096 * MiB, external: 0, arrayBuffers: 0 });

describe("maintenance service", () => {
  let base: string;
  let projectRoot: string;
  let stateDir: string;
  let tmpDir: string;
  let t0: number;
  let t: number;
  let services: Loose[];

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "maint-service-"));
    projectRoot = path.join(base, "project");
    stateDir = path.join(base, "state");
    tmpDir = path.join(base, "tmp");
    for (const dir of [projectRoot, stateDir, tmpDir]) fs.mkdirSync(dir, { recursive: true });
    t0 = Date.now();
    t = t0;
    services = [];
  });

  afterEach(() => {
    for (const service of services) service.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const make = (options: Loose = {}) => {
    const { env = {}, dev = true, ...rest } = options;
    const service = createMaintenanceService({
      env,
      dev,
      projectRoot,
      stateDir,
      tmpDir,
      now: () => t,
      log: () => {},
      readMemory: quietMemory,
      ...rest,
    });
    services.push(service);
    return service;
  };

  /** Moves the clock and runs one scheduler step. */
  const at = async (service: Loose, ms: number) => {
    t = t0 + ms;
    await service.tick();
  };

  const tracePath = () => path.join(projectRoot, ".next", "dev", "trace");
  const hmrDir = () => path.join(projectRoot, ".next", "dev", "static", "webpack");
  const makeHmr = (count: number, ageMs = 2 * HOUR) => {
    for (let i = 0; i < count; i += 1) writeFile(path.join(hmrDir(), `u${i}.webpack.hot-update.json`), "{}", ageMs + i * SECOND, t0);
  };

  it("measures 60 s after start, then every 5 min in dev", async () => {
    const service = make();
    await service.start();
    await at(service, 0);
    expect(service.snapshot().service).toBe("starting");
    expect(service.snapshot().clutter.measuredAt).toBeNull();
    await at(service, 59 * SECOND);
    expect(service.snapshot().clutter.measuredAt).toBeNull();
    await at(service, 60 * SECOND);
    expect(service.snapshot().clutter.measuredAt).toBe(t0 + 60 * SECOND);
    expect(service.snapshot().schedule.nextMeasureAt).toBe(t0 + 60 * SECOND + 5 * MINUTE);
    await at(service, 5 * MINUTE);
    expect(service.snapshot().clutter.measuredAt).toBe(t0 + 60 * SECOND);
    await at(service, 6 * MINUTE);
    expect(service.snapshot().clutter.measuredAt).toBe(t0 + 6 * MINUTE);
    expect(service.snapshot().service).toBe("idle");
  });

  it("measures every 15 min in production", async () => {
    const service = make({ dev: false });
    await service.start();
    await at(service, 60 * SECOND);
    expect(service.snapshot().schedule.nextMeasureAt).toBe(t0 + 60 * SECOND + 15 * MINUTE);
    expect(service.snapshot().clutter.byTarget.map((b: Loose) => b.id)).toEqual(["voice-temp", "orphan-tmp"]);
  });

  it("runs on the threshold, then waits 30 min before the next one", async () => {
    bigFile(tracePath(), 50 * MiB);
    const service = make();
    await service.start();
    await at(service, 60 * SECOND);
    const first = service.snapshot().lastRun;
    expect(first).toMatchObject({ trigger: "threshold", truncatedFiles: 1, freedBytes: 50 * MiB, cartworthy: true, dryRun: false });
    expect(first.clutterBefore).toBeGreaterThanOrEqual(0.75);
    expect(first.clutterAfter).toBe(0);
    expect(fs.statSync(tracePath()).size).toBe(0);

    bigFile(tracePath(), 50 * MiB);
    await at(service, 6 * MINUTE + SECOND);
    expect(service.snapshot().clutter.level).toBeGreaterThanOrEqual(0.75);
    // The 10-min scheduled slot does not fire either: the threshold run counts.
    for (let m = 11; m <= 30; m += 5) await at(service, m * MINUTE + SECOND);
    expect(service.snapshot().lastRun.id).toBe(first.id);
    expect(fs.statSync(tracePath()).size).toBe(50 * MiB);
    await at(service, 31 * MINUTE + 2 * SECOND);
    expect(service.snapshot().lastRun.id).not.toBe(first.id);
    expect(fs.statSync(tracePath()).size).toBe(0);
  });

  it("runs the dev schedule every 6 h, never within 10 min of start", async () => {
    bigFile(tracePath(), 17 * MiB);
    const service = make();
    await service.start();
    await at(service, 60 * SECOND);
    expect(service.snapshot().clutter.level).toBeGreaterThan(0.1);
    expect(service.snapshot().lastRun).toBeNull();
    await at(service, 9 * MINUTE + 59 * SECOND);
    expect(service.snapshot().lastRun).toBeNull();
    expect(service.nextScheduledRunAt()).toBe(t0 + 10 * MINUTE);
    await at(service, 10 * MINUTE);
    const run = service.snapshot().lastRun;
    expect(run.trigger).toBe("scheduled");
    expect(service.nextScheduledRunAt()).toBe(run.finishedAt + 6 * HOUR);
    bigFile(tracePath(), 17 * MiB);
    await at(service, 5 * HOUR);
    expect(service.snapshot().lastRun.id).toBe(run.id);
    await at(service, 6 * HOUR + 10 * MINUTE + SECOND);
    expect(service.snapshot().lastRun.id).not.toBe(run.id);
  });

  it("skips the dev schedule while clutter is under 0.1", async () => {
    writeFile(path.join(stateDir, "office3d", `.settings-${UUID}.tmp`), "{}", 20 * MINUTE, t0);
    const service = make();
    await service.start();
    await at(service, 60 * SECOND);
    await at(service, 11 * MINUTE);
    expect(service.snapshot().clutter.level).toBeLessThan(0.1);
    expect(service.snapshot().lastRun).toBeNull();
  });

  it("runs daily at 04:00 in production when anything is reclaimable", async () => {
    const tmpFile = path.join(stateDir, "office3d", `.settings-${UUID}.tmp`);
    writeFile(tmpFile, "{}", 20 * MINUTE, t0);
    const service = make({ dev: false });
    await service.start();
    const due = Math.max(nextLocalHour(t0, 4), t0 + 10 * MINUTE);
    expect(service.nextScheduledRunAt()).toBe(due);
    await at(service, 60 * SECOND);
    await at(service, due - t0 - SECOND);
    expect(service.snapshot().lastRun).toBeNull();
    expect(fs.existsSync(tmpFile)).toBe(true);
    await at(service, due - t0);
    expect(service.snapshot().lastRun).toMatchObject({ trigger: "scheduled", removedFiles: 1 });
    expect(fs.existsSync(tmpFile)).toBe(false);
    expect(service.nextScheduledRunAt()).toBe(nextLocalHour(due, 4));
  });

  it("uses up an empty 04:00 slot in production", async () => {
    const service = make({ dev: false });
    await service.start();
    const due = service.nextScheduledRunAt() as number;
    await at(service, 60 * SECOND);
    await at(service, due - t0 + SECOND);
    expect(service.snapshot().lastRun).toBeNull();
    expect(service.nextScheduledRunAt()).toBe(nextLocalHour(due + SECOND, 4));
  });

  it("is single-flight", async () => {
    makeHmr(80);
    const service = make();
    await service.start();
    const a = service.runNow("manual");
    const b = service.runNow("threshold");
    expect(a).toBe(b);
    const run = await a;
    expect(run.trigger).toBe("manual");
    expect(run.removedFiles).toBe(30);
  });

  it("never deletes in report mode", async () => {
    bigFile(tracePath(), 50 * MiB);
    makeHmr(60);
    const service = make({ env: { OFFICE3D_MAINTENANCE: "report" } });
    await service.start();
    await at(service, 60 * SECOND);
    const run = service.snapshot().lastRun;
    expect(run).toMatchObject({ dryRun: true, freedBytes: 0, removedFiles: 0, truncatedFiles: 0, cartworthy: false });
    expect(run.actions).toEqual(
      expect.arrayContaining([
        { target: "dev-trace", op: "truncate", bytes: 50 * MiB, items: 1 },
        { target: "hmr-updates", op: "remove", bytes: 20, items: 10 },
      ])
    );
    expect(fs.statSync(tracePath()).size).toBe(50 * MiB);
    expect(fs.readdirSync(hmrDir())).toHaveLength(60);
  });

  it("does no file work when off", async () => {
    bigFile(tracePath(), 50 * MiB);
    const service = make({ env: { OFFICE3D_MAINTENANCE: "off" } });
    await service.start();
    await at(service, 2 * HOUR);
    expect(await service.runNow("manual")).toBeNull();
    const snapshot = service.snapshot();
    expect(snapshot).toMatchObject({ mode: "off", service: "off", lastRun: null });
    expect(snapshot.schedule).toMatchObject({ nextMeasureAt: null, nextScheduledRunAt: null });
    expect(fs.statSync(tracePath()).size).toBe(50 * MiB);
  });

  it("treats an unknown mode as report", async () => {
    const service = make({ env: { OFFICE3D_MAINTENANCE: "yes please" } });
    expect(service.mode).toBe("report");
  });

  it("counts EBUSY instead of throwing", async () => {
    const busy = path.join(tmpDir, "office3d-voice-busy12");
    const free = path.join(tmpDir, "office3d-voice-free12");
    for (const dir of [busy, free]) {
      writeFile(path.join(dir, "clip.webm"), "abcd", 2 * HOUR, t0);
      setAge(dir, 2 * HOUR, t0);
    }
    const fsImpl = {
      ...fs.promises,
      unlink: async (target: string) => {
        if (target.includes("busy12")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
        return fs.promises.unlink(target);
      },
    };
    const service = make({ fsImpl });
    await service.start();
    const run = await service.runNow("manual");
    expect(run.errors).toEqual([{ target: "voice-temp", code: "EBUSY", count: 1 }]);
    expect(run.removedFiles).toBe(1);
    expect(fs.existsSync(free)).toBe(false);
    expect(fs.existsSync(busy)).toBe(true);
  });

  it("yields between batches of 25", async () => {
    makeHmr(110);
    let yields = 0;
    const service = make({
      yieldFn: () => {
        yields += 1;
        return new Promise((resolve) => setImmediate(resolve));
      },
    });
    await service.start();
    const run = await service.runNow("manual");
    expect(run.removedFiles).toBe(60);
    expect(yields).toBeGreaterThanOrEqual(2);
  });

  it("stops at the operation cap", async () => {
    expect(LIMITS).toMatchObject({ batchSize: 25, maxOps: 2000, maxRunMs: 30_000 });
    makeHmr(110);
    const service = make({ limits: { maxOps: 10 } });
    await service.start();
    const run = await service.runNow("manual");
    expect(run.removedFiles).toBe(10);
    expect(run.capped).toBe("ops");
    expect(fs.readdirSync(hmrDir())).toHaveLength(100);
  });

  it("stops at the time cap", async () => {
    makeHmr(110);
    const fsImpl = {
      ...fs.promises,
      unlink: async (target: string) => {
        t += 11 * SECOND;
        return fs.promises.unlink(target);
      },
    };
    const service = make({ fsImpl });
    await service.start();
    const run = await service.runNow("manual");
    expect(run.capped).toBe("time");
    expect(run.removedFiles).toBeLessThanOrEqual(3);
  });

  it("marks a run cartworthy from 1 MiB or 20 items", async () => {
    expect(CARTWORTHY).toEqual({ bytes: MiB, items: 20 });
    makeHmr(55);
    const service = make();
    await service.start();
    const small = await service.runNow("manual");
    expect(small).toMatchObject({ removedFiles: 5, cartworthy: false });
    makeHmr(70, 3 * HOUR);
    const many = await service.runNow("manual");
    expect(many.removedFiles).toBeGreaterThanOrEqual(20);
    expect(many.cartworthy).toBe(true);
  });

  it("persists state.json and the last run across restarts", async () => {
    bigFile(tracePath(), 17 * MiB);
    const first = make();
    await first.start();
    await at(first, 60 * SECOND);
    await at(first, 10 * MINUTE);
    const run = first.snapshot().lastRun;
    expect(run.trigger).toBe("scheduled");
    first.stop();
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, "office3d", "maintenance", "state.json"), "utf8"));
    expect(saved).toEqual({ lastRunAt: run.finishedAt, lastScheduledRunAt: run.startedAt });

    t = t0 + HOUR;
    const second = make();
    await second.start();
    expect(second.snapshot().lastRun.id).toBe(run.id);
    expect(second.snapshot().recentRuns.map((r: Loose) => r.id)).toEqual([run.id]);
    expect(second.nextScheduledRunAt()).toBe(run.finishedAt + 6 * HOUR);
  });

  it("caps the run log at 200 lines and skips corrupt ones", async () => {
    const logDir = path.join(stateDir, "office3d", "maintenance");
    fs.mkdirSync(logDir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 440; i += 1) lines.push(JSON.stringify({ id: `old-${i}`, finishedAt: t0 - (500 - i) * MINUTE }));
    for (let i = 0; i < 10; i += 1) lines.splice(100 + i * 30, 0, "{not json");
    lines.push('{"id": "torn"');
    fs.writeFileSync(path.join(logDir, "runs.jsonl"), `${lines.join("\n")}\n`);
    const service = make();
    await service.start();
    expect(service.snapshot().recentRuns).toHaveLength(10);
    expect(service.snapshot().recentRuns[0].id).toBe("old-439");
    const run = await service.runNow("manual");
    const kept = fs.readFileSync(path.join(logDir, "runs.jsonl"), "utf8").trim().split("\n");
    expect(kept).toHaveLength(200);
    for (const line of kept) expect(() => JSON.parse(line)).not.toThrow();
    expect(JSON.parse(kept[kept.length - 1]).id).toBe(run.id);
    expect(service.snapshot().recentRuns[0].id).toBe(run.id);
    expect(service.snapshot().recentRuns).toHaveLength(10);
  });

  it("uses the documented schedule constants", () => {
    expect(SCHEDULE).toMatchObject({
      firstMeasureMs: 60 * SECOND,
      measureEveryMs: { dev: 5 * MINUTE, production: 15 * MINUTE },
      memoryEveryMs: 60 * SECOND,
      threshold: 0.75,
      minGapMs: 30 * MINUTE,
      startGraceMs: 10 * MINUTE,
      devEveryMs: 6 * HOUR,
      devMinClutter: 0.1,
      productionHour: 4,
      manualGapMs: 60 * SECOND,
    });
  });
});
