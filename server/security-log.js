const crypto = require("node:crypto");
const nodeFs = require("node:fs");
const path = require("node:path");

// What the HQ reports about attacks on the platform when the owner signs in:
// how many unauthorized sign-in attempts there were and how many requests or
// addresses were blocked since the owner's previous sign-in.
//
// Only counts and times are kept — never an address, a login name or a
// password — in <stateDir>/office3d/security.json (a few hundred bytes,
// rewritten atomically, a moment after a change).
//
// The counters run from the owner's latest sign-in. At each sign-in they are
// folded into the period that began at the previous one, so the summary is
// always "since the previous sign-in": what happened before this sign-in
// plus what has happened since.

const FILE_VERSION = 1;
/** Counters stop here; a number this large says enough. */
const COUNT_MAX = 1_000_000_000;
/** How long changes are gathered before the file is written (ms). */
const SAVE_DELAY_MS = 2_000;

const count = (value) => (Number.isFinite(value) && value > 0 ? Math.min(COUNT_MAX, Math.floor(value)) : 0);
const time = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : null);

const emptyState = () => ({
  // When the owner last signed in, and the sign-in before that.
  lastLoginAt: null,
  previousLoginAt: null,
  // Between the previous sign-in and the latest one.
  before: { failedAttempts: 0, blocked: 0 },
  // Since the latest sign-in (or since the log started, before any).
  current: { failedAttempts: 0, blocked: 0 },
});

/** Reads the saved file; anything unreadable or odd starts from zero. */
const parseState = (text) => {
  const state = emptyState();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return state;
  }
  if (!data || typeof data !== "object" || data.v !== FILE_VERSION) return state;
  state.lastLoginAt = time(data.lastLoginAt);
  state.previousLoginAt = time(data.previousLoginAt);
  for (const key of ["before", "current"]) {
    const part = data[key];
    if (part && typeof part === "object") {
      state[key] = { failedAttempts: count(part.failedAttempts), blocked: count(part.blocked) };
    }
  }
  return state;
};

/**
 * @param {object} [options]
 * @param {string|null} [options.file]  where to keep the counters; null keeps them in memory only
 * @param {() => number} [options.now]
 * @param {typeof import("node:fs")} [options.fs]
 * @param {(message: string) => void} [options.log]
 * @param {number} [options.saveDelayMs]
 */
function createSecurityLog(options = {}) {
  const file = typeof options.file === "string" && options.file ? options.file : null;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const fs = options.fs ?? nodeFs;
  const log = typeof options.log === "function" ? options.log : () => {};
  const saveDelayMs = Number.isFinite(options.saveDelayMs) ? options.saveDelayMs : SAVE_DELAY_MS;

  let state = emptyState();
  if (file) {
    try {
      state = parseState(fs.readFileSync(file, "utf8"));
    } catch (err) {
      if (err?.code !== "ENOENT") log(`[security] Could not read the security log (${err?.code ?? "error"}).`);
    }
  }

  let timer = null;
  let writing = Promise.resolve();

  const serialize = () =>
    JSON.stringify({
      v: FILE_VERSION,
      lastLoginAt: state.lastLoginAt,
      previousLoginAt: state.previousLoginAt,
      before: state.before,
      current: state.current,
    });

  const write = () => {
    if (!file) return Promise.resolve();
    const text = serialize();
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}-${crypto.randomUUID()}.tmp`);
    writing = writing
      .then(async () => {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        try {
          await fs.promises.writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
          await fs.promises.rename(tmp, file);
        } catch (err) {
          await fs.promises.unlink(tmp).catch(() => {});
          throw err;
        }
      })
      .catch((err) => log(`[security] Could not save the security log (${err?.code ?? "error"}).`));
    return writing;
  };

  const scheduleSave = () => {
    if (!file || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void write();
    }, saveDelayMs);
    timer.unref?.();
  };

  /** Writes any pending change now (tests, shutdown). */
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      return write();
    }
    return writing;
  };

  const bump = (key) => {
    state.current[key] = Math.min(COUNT_MAX, state.current[key] + 1);
    scheduleSave();
  };

  return {
    /** A wrong login or password, or a wrong access token in a cookie. */
    recordFailedAttempt: () => bump("failedAttempts"),
    /** An address locked out after too many attempts, or a request refused as hostile. */
    recordBlocked: () => bump("blocked"),
    /** The owner signed in: the period since the previous sign-in is closed. */
    recordLogin: () => {
      state.previousLoginAt = state.lastLoginAt;
      state.lastLoginAt = now();
      state.before = { ...state.current };
      state.current = { failedAttempts: 0, blocked: 0 };
      scheduleSave();
    },
    /**
     * Counts since the owner's previous sign-in (before the first sign-in
     * this log saw: since it started). Counts and times only.
     */
    summary: () => ({
      previousLoginAt: state.previousLoginAt,
      lastLoginAt: state.lastLoginAt,
      failedAttempts: Math.min(COUNT_MAX, state.before.failedAttempts + state.current.failedAttempts),
      blocked: Math.min(COUNT_MAX, state.before.blocked + state.current.blocked),
    }),
    flush,
    close: () => {
      void flush();
    },
  };
}

const SUMMARY_PATH = "/api/security/summary";

/**
 * GET /api/security/summary for the HQ's greeting and its «СОЗДАТЕЛЬ В СЕТИ»
 * mark. It runs after the access gate, so with an access token only the
 * signed-in owner reaches it; without one the office answers only on
 * loopback, the owner's own machine. Same-origin pages only (allowOrigin).
 * The answer: how the person got in ("session" or "local"), the owner's
 * previous sign-in time and the counts — nothing else.
 *
 * @param {object} options
 * @param {ReturnType<typeof createSecurityLog>} options.securityLog
 * @param {boolean} options.gateEnabled  whether an access token guards the office
 * @param {(req: import("node:http").IncomingMessage) => boolean} options.allowOrigin
 */
function createSecuritySummaryEndpoint({ securityLog, gateEnabled, allowOrigin }) {
  const send = (res, status, body, headers = {}) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };

  /** Answers the summary; false for every other request. */
  const handleHttp = (req, res) => {
    const pathname = String(req.url || "/").split("?")[0];
    if (pathname !== SUMMARY_PATH) return false;
    const method = String(req.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      send(res, 405, { error: "method-not-allowed" }, { Allow: "GET, HEAD" });
      return true;
    }
    if (!allowOrigin(req)) {
      send(res, 403, { error: "forbidden" });
      return true;
    }
    if (method === "HEAD") {
      send(res, 200, undefined);
      return true;
    }
    const { previousLoginAt, failedAttempts, blocked } = securityLog.summary();
    send(res, 200, {
      access: gateEnabled ? "session" : "local",
      previousLoginAt: previousLoginAt === null ? null : new Date(previousLoginAt).toISOString(),
      failedAttempts,
      blocked,
    });
    return true;
  };

  return { handleHttp };
}

module.exports = {
  createSecurityLog,
  createSecuritySummaryEndpoint,
  SECURITY_LOG_COUNT_MAX: COUNT_MAX,
  SECURITY_SUMMARY_PATH: SUMMARY_PATH,
};
