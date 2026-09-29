// The run log (<stateDir>/office3d/maintenance/runs.jsonl, one run per line)
// and the scheduler state (state.json). The log is rewritten to its last 200
// lines once it passes 400 lines or 256 KB; corrupt lines are skipped.

const crypto = require("node:crypto");
const path = require("node:path");

const KEEP_LINES = 200;
const MAX_LINES = 400;
const MAX_BYTES = 256 * 1024;
const RECENT = 10;

const isRecord = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));

const parseLines = (raw) => {
  const runs = [];
  for (const line of String(raw).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const run = JSON.parse(trimmed);
      if (isRecord(run) && typeof run.id === "string" && Number.isFinite(run.finishedAt)) runs.push(run);
    } catch {
      // A torn or corrupt line: skip it.
    }
  }
  return runs;
};

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CODE_RE = /^E[A-Z0-9_]{1,24}$/;
const num = (value) => (Number.isFinite(value) ? value : 0);
const numOrNull = (value) => (Number.isFinite(value) ? value : null);

/**
 * A run read back from disk, reduced to the fields the service writes. The
 * status endpoint serves these runs, so nothing else in the file (a hand
 * edit, a line from another version) ever reaches a response.
 */
const sanitizeRun = (run) => ({
  id: String(run.id).slice(0, 64),
  trigger: ["scheduled", "threshold", "manual"].includes(run.trigger) ? run.trigger : "manual",
  dryRun: run.dryRun === true,
  startedAt: numOrNull(run.startedAt),
  finishedAt: run.finishedAt,
  freedBytes: num(run.freedBytes),
  removedFiles: num(run.removedFiles),
  truncatedFiles: num(run.truncatedFiles),
  clutterBefore: num(run.clutterBefore),
  clutterAfter: num(run.clutterAfter),
  cartworthy: run.cartworthy === true,
  capped: run.capped === "ops" || run.capped === "time" ? run.capped : null,
  actions: (Array.isArray(run.actions) ? run.actions : [])
    .filter((a) => isRecord(a) && ID_RE.test(String(a.target)) && (a.op === "truncate" || a.op === "remove"))
    .slice(0, 16)
    .map((a) => ({ target: a.target, op: a.op, bytes: num(a.bytes), items: num(a.items) })),
  errors: (Array.isArray(run.errors) ? run.errors : [])
    .filter((e) => isRecord(e) && ID_RE.test(String(e.target)) && CODE_RE.test(String(e.code)))
    .slice(0, 32)
    .map((e) => ({ target: e.target, code: e.code, count: num(e.count) })),
});

const writeAtomic = async (fsp, file, text) => {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}-${crypto.randomUUID()}.tmp`);
  try {
    await fsp.writeFile(tmp, text, "utf8");
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
};

/**
 * @param {object} options
 * @param {object} options.fsp  fs.promises
 * @param {string} options.dir  <stateDir>/office3d/maintenance
 * @param {(msg: string) => void} [options.log]
 */
const createRunLog = ({ fsp, dir, log = () => {} }) => {
  const logFile = path.join(dir, "runs.jsonl");
  const stateFile = path.join(dir, "state.json");
  let lines = 0;
  let bytes = 0;
  let recent = [];
  let ready = false;
  let chain = Promise.resolve();

  const ensureDir = () => fsp.mkdir(dir, { recursive: true });

  /** Reads the log and state once. Never throws. */
  const load = async () => {
    let state = { lastRunAt: null, lastScheduledRunAt: null };
    try {
      const raw = await fsp.readFile(logFile, "utf8");
      const runs = parseLines(raw);
      lines = raw.split("\n").filter((line) => line.trim()).length;
      bytes = Buffer.byteLength(raw);
      recent = runs.slice(-RECENT).reverse().map(sanitizeRun);
    } catch {
      lines = 0;
      bytes = 0;
      recent = [];
    }
    try {
      const parsed = JSON.parse(await fsp.readFile(stateFile, "utf8"));
      if (isRecord(parsed)) {
        state = {
          lastRunAt: Number.isFinite(parsed.lastRunAt) ? parsed.lastRunAt : null,
          lastScheduledRunAt: Number.isFinite(parsed.lastScheduledRunAt) ? parsed.lastScheduledRunAt : null,
        };
      }
    } catch {
      // No state yet (or corrupt): start fresh.
    }
    ready = true;
    return state;
  };

  const compact = async () => {
    const raw = await fsp.readFile(logFile, "utf8");
    const kept = raw
      .split("\n")
      .filter((line) => line.trim())
      .filter((line) => parseLines(line).length === 1)
      .slice(-KEEP_LINES);
    const text = kept.length ? `${kept.join("\n")}\n` : "";
    await writeAtomic(fsp, logFile, text);
    lines = kept.length;
    bytes = Buffer.byteLength(text);
  };

  const serial = (task) => {
    const next = chain.then(task, task);
    chain = next.catch(() => {});
    return next;
  };

  /** Appends a run (and keeps it in the recent list). Never throws. */
  const append = (run) => {
    recent = [run, ...recent].slice(0, RECENT);
    return serial(async () => {
      try {
        await ensureDir();
        const line = `${JSON.stringify(run)}\n`;
        await fsp.appendFile(logFile, line, "utf8");
        lines += 1;
        bytes += Buffer.byteLength(line);
        if (lines > MAX_LINES || bytes > MAX_BYTES) await compact();
      } catch (err) {
        log(`[maintenance] Run log not written (${err?.code ?? "error"}).`);
      }
    });
  };

  /** Persists the scheduler state. Never throws. */
  const saveState = (state) =>
    serial(async () => {
      try {
        await ensureDir();
        await writeAtomic(
          fsp,
          stateFile,
          JSON.stringify({ lastRunAt: state.lastRunAt ?? null, lastScheduledRunAt: state.lastScheduledRunAt ?? null })
        );
      } catch (err) {
        log(`[maintenance] State not written (${err?.code ?? "error"}).`);
      }
    });

  return {
    load,
    append,
    saveState,
    /** Newest first, at most 10. */
    recent: () => recent,
    flush: () => chain,
    get ready() {
      return ready;
    },
  };
};

module.exports = { KEEP_LINES, MAX_BYTES, MAX_LINES, RECENT, createRunLog, parseLines, sanitizeRun };
