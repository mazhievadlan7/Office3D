// The maintenance service: keeps the office's own disk litter in check and
// reports the server's memory, in the custom-server process.
//
// It cleans only the allowlist in targets.js (dev trace and log truncation,
// old hot-update files, leftover voice and test temp folders, orphaned
// atomic-write temp files), with every safety check in safety.js repeated
// right before each operation. Everything else is only measured ("weight").
// All file-system work is async, in batches of 25 with a yield between them,
// capped at 2000 operations or 30 s per run, and single-flight.
//
// OFFICE3D_MAINTENANCE=on|report|off (default on): "report" measures and
// logs what a run would do without touching anything; "off" does no file
// work at all. OFFICE3D_MAINTENANCE_TEST_TEMP=off leaves test temp folders.
//
// HTTP (behind the access gate, wired in server/index.js):
//   GET  /api/maintenance/status  cached snapshot, no I/O per request
//   POST /api/maintenance/run     {"trigger":"manual"}: same-origin only,
//                                 at most once a minute
// Responses carry ids and numbers only, never a path.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { allowHttpOrigin } = require("../request-guard");
const { summarizeClutter } = require("./clutter");
const { createMemoryMonitor } = require("./memory");
const { createRunLog } = require("./runlog");
const { applyCandidate, buildTargets, errorCode, measureWeight, scanTarget, yieldNow } = require("./targets");

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const MiB = 1024 * 1024;

const LIMITS = {
  batchSize: 25,
  maxOps: 2000,
  maxRunMs: 30 * SECOND,
  scanEntries: 20_000,
};

const SCHEDULE = {
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
  tickMs: 15 * SECOND,
};

// A run is worth a visible trip in the HQ when it freed at least this much.
const CARTWORTHY = { bytes: 1 * MiB, items: 20 };

const MAX_BODY = 1024;
const STATUS_PATH = "/api/maintenance/status";
const RUN_PATH = "/api/maintenance/run";

const parseMode = (value, log) => {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "on") return "on";
  if (raw === "report" || raw === "off") return raw;
  log(`[maintenance] OFFICE3D_MAINTENANCE=${JSON.stringify(raw).slice(0, 40)} is not on|report|off; using report.`);
  return "report";
};

const isOff = (value) => ["off", "0", "false", "no"].includes(String(value ?? "").trim().toLowerCase());

/** The next local `hour`:00 strictly after `from`. */
const nextLocalHour = (from, hour) => {
  const date = new Date(from);
  date.setHours(hour, 0, 0, 0);
  if (date.getTime() <= from) date.setDate(date.getDate() + 1);
  return date.getTime();
};

const pathOf = (req) => String(req.url || "/").split("?")[0];

const sendJson = (res, status, body, extraHeaders = {}) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
  res.end(body === undefined ? undefined : JSON.stringify(body));
};

const readBody = (req, limit) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("too large"), { code: "E2BIG" }));
        req.destroy?.();
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

/**
 * @param {object} options
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {boolean} [options.dev]
 * @param {string} options.projectRoot
 * @param {string} options.stateDir      the OpenClaw state dir (resolveStateDir)
 * @param {string} [options.tmpDir]      os.tmpdir()
 * @param {() => number} [options.now]
 * @param {(msg: string) => void} [options.log]
 * @param {object} [options.fsImpl]      fs.promises or a test double
 * @param {string} [options.homeDir]
 * @param {() => object} [options.readMemory]
 * @param {(req) => boolean} [options.allowOrigin]
 * @param {Partial<typeof LIMITS>} [options.limits]
 * @param {() => Promise<void>} [options.yieldFn]
 */
function createMaintenanceService(options) {
  const {
    env = process.env,
    dev = false,
    projectRoot,
    stateDir,
    tmpDir = os.tmpdir(),
    now = () => Date.now(),
    log = (message) => console.info(message),
    fsImpl = fs.promises,
    homeDir = os.homedir(),
    readMemory,
    allowOrigin = allowHttpOrigin,
    limits: limitOverrides,
    yieldFn = yieldNow,
  } = options ?? {};
  if (!projectRoot || !stateDir) throw new Error("createMaintenanceService needs projectRoot and stateDir.");

  const limits = { ...LIMITS, ...(limitOverrides ?? {}) };
  const mode = parseMode(env.OFFICE3D_MAINTENANCE, log);
  const testTemp = !isOff(env.OFFICE3D_MAINTENANCE_TEST_TEMP);
  const context = { dev, projectRoot, stateDir, tmpDir, testTemp };
  const measureEveryMs = dev ? SCHEDULE.measureEveryMs.dev : SCHEDULE.measureEveryMs.production;

  const memory = createMemoryMonitor({ dev, now, ...(readMemory ? { read: readMemory } : null) });
  const runLog = createRunLog({ fsp: fsImpl, dir: path.join(stateDir, "office3d", "maintenance"), log });

  let startedAt = null;
  let stopped = false;
  let timer = null;
  let loaded = null;
  let state = { lastRunAt: null, lastScheduledRunAt: null };
  let nextMeasureAt = null;
  let nextMemoryAt = null;
  let lastScan = null;
  let lastRun = null;
  let running = null;
  let measuring = null;
  let ticking = false;
  let lastManualAt = null;

  const targets = () => buildTargets(context);

  const nextScheduledRunAt = () => {
    if (mode === "off" || startedAt === null) return null;
    const earliest = startedAt + SCHEDULE.startGraceMs;
    if (dev) {
      // Every 6 h counts from the last run of any kind: a threshold or manual
      // run already did the scheduled one's work.
      const last = Math.max(state.lastScheduledRunAt ?? -Infinity, state.lastRunAt ?? -Infinity);
      const base = Number.isFinite(last) ? last + SCHEDULE.devEveryMs : earliest;
      return Math.max(base, earliest);
    }
    const from = state.lastScheduledRunAt ?? startedAt;
    return Math.max(nextLocalHour(from, SCHEDULE.productionHour), earliest);
  };

  const emptyClutter = () => summarizeClutter(
    targets().map((target) => ({ id: target.id, bytes: 0, items: 0 })),
    dev
  );

  /** Measures what a run would free, and the weight. Read-only. */
  const measure = () => {
    if (mode === "off") return Promise.resolve(null);
    if (measuring) return measuring;
    measuring = (async () => {
      try {
        const budget = { entries: limits.scanEntries };
        const byTarget = [];
        for (const target of targets()) {
          const scan = await scanTarget(fsImpl, target, { now, homeDir, budget });
          byTarget.push({ id: scan.id, bytes: scan.bytes, items: scan.items });
        }
        const weight = await measureWeight(fsImpl, context);
        lastScan = { clutter: { ...summarizeClutter(byTarget, dev), measuredAt: now() }, weight };
      } catch (err) {
        log(`[maintenance] Measuring failed (${errorCode(err)}).`);
      } finally {
        nextMeasureAt = now() + measureEveryMs;
      }
      return lastScan;
    })().finally(() => {
      measuring = null;
    });
    return measuring;
  };

  const newRunId = (at) => `run-${at.toString(36)}-${crypto.randomBytes(3).toString("hex")}`;

  const execute = async (trigger) => {
    const dryRun = mode === "report";
    const runStartedAt = now();
    const actions = new Map();
    const errors = new Map();
    let ops = 0;
    let capped = null;
    let freedBytes = 0;
    let removedFiles = 0;
    let truncatedFiles = 0;
    let clutterBefore = 0;
    let sinceYield = 0;

    const timeUp = () => now() - runStartedAt >= limits.maxRunMs;
    const ctx = {
      now,
      dryRun,
      batchSize: limits.batchSize,
      yield: yieldFn,
      canSpend: (count) => ops + count <= limits.maxOps && !timeUp(),
      spend: (count) => {
        ops += count;
      },
    };
    const countError = (target, code) => {
      const key = `${target}\u0000${code}`;
      const entry = errors.get(key) ?? { target, code, count: 0 };
      entry.count += 1;
      errors.set(key, entry);
    };

    try {
      const budget = { entries: limits.scanEntries };
      const scans = [];
      const byTarget = [];
      for (const target of targets()) {
        const scan = await scanTarget(fsImpl, target, { now, homeDir, budget });
        scans.push({ target, scan });
        byTarget.push({ id: scan.id, bytes: scan.bytes, items: scan.items });
      }
      clutterBefore = summarizeClutter(byTarget, dev).level;

      outer: for (const { target, scan } of scans) {
        for (const candidate of scan.candidates) {
          if (timeUp()) {
            capped = "time";
            break outer;
          }
          const opsBefore = ops;
          const result = await applyCandidate(fsImpl, target, candidate, ctx);
          if (result.stop) {
            capped = timeUp() ? "time" : "ops";
            break outer;
          }
          if (result.error) countError(target.id, result.error);
          if (result.done || result.bytes > 0) {
            const action = actions.get(target.id) ?? { target: target.id, op: target.op, bytes: 0, items: 0 };
            action.bytes += result.bytes;
            if (result.done) action.items += 1;
            actions.set(target.id, action);
            if (!dryRun) {
              freedBytes += result.bytes;
              if (result.done && target.op === "truncate") truncatedFiles += 1;
              if (result.done && target.op === "remove") removedFiles += 1;
            }
          }
          sinceYield += 1 + (ops - opsBefore);
          if (sinceYield >= limits.batchSize) {
            sinceYield = 0;
            await yieldFn();
          }
        }
      }
    } catch (err) {
      countError("service", errorCode(err));
      log(`[maintenance] Run failed (${errorCode(err)}).`);
    }

    const finishedAt = now();
    // A measure that started before the run saw the old disk: wait it out and
    // measure again.
    if (measuring) await measuring;
    await measure();
    const clutterAfter = lastScan?.clutter.level ?? clutterBefore;
    const cartworthy = !dryRun && (freedBytes >= CARTWORTHY.bytes || removedFiles >= CARTWORTHY.items);
    const run = {
      id: newRunId(runStartedAt),
      trigger,
      dryRun,
      startedAt: runStartedAt,
      finishedAt,
      freedBytes,
      removedFiles,
      truncatedFiles,
      clutterBefore,
      clutterAfter,
      cartworthy,
      capped,
      actions: [...actions.values()],
      errors: [...errors.values()],
    };
    lastRun = run;
    state = {
      lastRunAt: finishedAt,
      lastScheduledRunAt: trigger === "scheduled" ? runStartedAt : state.lastScheduledRunAt,
    };
    await runLog.append(run);
    await runLog.saveState(state);
    if (freedBytes > 0 || removedFiles > 0 || dryRun) {
      const verb = dryRun ? "would free" : "freed";
      const mb = (run.actions.reduce((sum, a) => sum + a.bytes, 0) / MiB).toFixed(1);
      log(`[maintenance] ${trigger} run ${verb} ${mb} MB (${run.actions.reduce((sum, a) => sum + a.items, 0)} items).`);
    }
    return run;
  };

  /** Runs now (single-flight: a call during a run gets that run's result). */
  const runNow = (trigger = "manual") => {
    if (mode === "off") return Promise.resolve(null);
    if (running) return running;
    const safeTrigger = ["scheduled", "threshold", "manual"].includes(trigger) ? trigger : "manual";
    running = (async () => {
      if (loaded) await loaded;
      return execute(safeTrigger);
    })().finally(() => {
      running = null;
    });
    return running;
  };

  /** Which run (if any) is due now. */
  const dueTrigger = (at) => {
    if (!lastScan) return null;
    const { level, reclaimableBytes, reclaimableItems } = lastScan.clutter;
    const gapOk = state.lastRunAt === null || at - state.lastRunAt >= SCHEDULE.minGapMs;
    if (level >= SCHEDULE.threshold && gapOk) return "threshold";
    const scheduledAt = nextScheduledRunAt();
    if (scheduledAt === null || at < scheduledAt) return null;
    if (dev) return level >= SCHEDULE.devMinClutter ? "scheduled" : null;
    if (reclaimableBytes > 0 || reclaimableItems > 0) return "scheduled";
    // Production: nothing to do at 04:00 — the slot is used up until tomorrow.
    state = { ...state, lastScheduledRunAt: at };
    void runLog.saveState(state);
    return null;
  };

  /** One scheduler step (the timer calls it every 15 s; tests call it directly). */
  const tick = async () => {
    if (stopped || startedAt === null || ticking) return;
    ticking = true;
    try {
      if (loaded) await loaded;
      const at = now();
      if (nextMemoryAt === null || at >= nextMemoryAt) {
        memory.sample();
        nextMemoryAt = at + SCHEDULE.memoryEveryMs;
      }
      if (mode === "off" || running) return;
      if (nextMeasureAt !== null && at >= nextMeasureAt) await measure();
      const trigger = dueTrigger(now());
      if (trigger) await runNow(trigger);
    } catch (err) {
      log(`[maintenance] Tick failed (${errorCode(err)}).`);
    } finally {
      ticking = false;
    }
  };

  const start = () => {
    if (startedAt !== null) return loaded;
    stopped = false;
    startedAt = now();
    nextMeasureAt = mode === "off" ? null : startedAt + SCHEDULE.firstMeasureMs;
    memory.sample();
    nextMemoryAt = startedAt + SCHEDULE.memoryEveryMs;
    loaded = runLog.load().then((saved) => {
      state = saved;
      lastRun = runLog.recent()[0] ?? null;
    });
    timer = setInterval(() => void tick(), SCHEDULE.tickMs);
    timer.unref?.();
    return loaded;
  };

  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  };

  const serviceState = () => {
    if (mode === "off") return "off";
    if (running) return "running";
    if (measuring) return "measuring";
    if (!lastScan) return "starting";
    return "idle";
  };

  /** The status document (see CONTRACT.json). No paths, only ids and numbers. */
  const snapshot = () => ({
    schema: 1,
    mode,
    service: serviceState(),
    now: now(),
    running: Boolean(running),
    clutter: lastScan?.clutter ?? { ...emptyClutter(), measuredAt: null },
    weight: lastScan?.weight ?? [],
    memory: memory.current(),
    schedule: {
      nextMeasureAt: mode === "off" ? null : nextMeasureAt,
      nextScheduledRunAt: nextScheduledRunAt(),
      threshold: SCHEDULE.threshold,
      minGapMs: SCHEDULE.minGapMs,
    },
    lastRun,
    recentRuns: runLog.recent(),
  });

  const handleRun = async (req, res) => {
    if (!allowOrigin(req)) {
      sendJson(res, 403, { error: "same-origin-required" });
      return;
    }
    let raw;
    try {
      raw = await readBody(req, MAX_BODY);
    } catch (err) {
      sendJson(res, err?.code === "E2BIG" ? 413 : 400, { error: "bad-body" });
      return;
    }
    let trigger = "manual";
    if (raw.trim()) {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: "bad-json" });
        return;
      }
      if (body && typeof body === "object" && body.trigger !== undefined) trigger = body.trigger;
    }
    if (trigger !== "manual") {
      sendJson(res, 400, { error: "bad-trigger" });
      return;
    }
    if (mode === "off") {
      sendJson(res, 409, { error: "maintenance-off" });
      return;
    }
    if (!running) {
      const at = now();
      if (lastManualAt !== null && at - lastManualAt < SCHEDULE.manualGapMs) {
        const retry = Math.max(1, Math.ceil((SCHEDULE.manualGapMs - (at - lastManualAt)) / SECOND));
        sendJson(res, 429, { error: "rate-limited", retryAfterSeconds: retry }, { "Retry-After": String(retry) });
        return;
      }
      lastManualAt = at;
    }
    const run = await runNow("manual");
    sendJson(res, 200, run);
  };

  /** Serves the two endpoints; false for every other request. */
  const handleHttp = (req, res) => {
    const pathname = pathOf(req);
    if (pathname !== STATUS_PATH && pathname !== RUN_PATH) return false;
    const method = String(req.method || "GET").toUpperCase();
    try {
      if (pathname === STATUS_PATH) {
        if (method !== "GET" && method !== "HEAD") {
          sendJson(res, 405, { error: "method-not-allowed" }, { Allow: "GET, HEAD" });
          return true;
        }
        if (method === "HEAD") {
          sendJson(res, 200, undefined);
          return true;
        }
        sendJson(res, 200, snapshot());
        return true;
      }
      if (method !== "POST") {
        sendJson(res, 405, { error: "method-not-allowed" }, { Allow: "POST" });
        return true;
      }
      handleRun(req, res).catch((err) => {
        log(`[maintenance] Manual run failed (${errorCode(err)}).`);
        if (!res.headersSent) sendJson(res, 500, { error: "run-failed" });
      });
    } catch (err) {
      log(`[maintenance] Request failed (${errorCode(err)}).`);
      if (!res.headersSent) sendJson(res, 500, { error: "failed" });
    }
    return true;
  };

  return {
    start,
    stop,
    snapshot,
    runNow,
    handleHttp,
    tick,
    measure,
    get mode() {
      return mode;
    },
    // For tests: when the next runs would happen.
    nextScheduledRunAt,
  };
}

module.exports = { CARTWORTHY, LIMITS, SCHEDULE, createMaintenanceService, nextLocalHour, parseMode };
