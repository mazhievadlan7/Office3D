// HTTP client for a Hermes Agent installation.
//
// Hermes exposes two HTTP surfaces and Office3D needs both:
//   - the API server (API_SERVER_*, default :8642): runs, sessions, jobs,
//     models. One listener serves every profile; a named profile is reached
//     under /p/<profile>/ and signed with that profile's own API_SERVER_KEY.
//   - the dashboard backend (`hermes dashboard`, default :9119): profile
//     lifecycle, per-profile .env, and the kanban plugin. Signed with the
//     dashboard session token (X-Hermes-Session-Token).
//
// Neither surface is ever exposed to the browser; this client runs in the
// Office3D server only.

const crypto = require("node:crypto");
const { readSse } = require("./sse");

const DEFAULT_TIMEOUT_MS = 15_000;
const RETRY_DELAYS_MS = [250, 1_000];
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const PROFILE_KEY_CONTEXT = "office3d:hermes-profile:";
// Hermes' own rule for profile ids (hermes_cli/profiles.py, _PROFILE_ID_RE).
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

class HermesApiError extends Error {
  constructor({ status = 0, code = "hermes_error", message, retryable = false, cause } = {}) {
    super(message || "Hermes request failed.");
    this.name = "HermesApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

const trimSlash = (value) => String(value || "").trim().replace(/\/+$/, "");

const isValidProfileName = (name) => name === "default" || PROFILE_NAME_RE.test(String(name || ""));

const assertProfileName = (name) => {
  if (!isValidProfileName(name)) {
    throw new HermesApiError({
      status: 400,
      code: "invalid_profile_name",
      message: `Недопустимое имя профиля Hermes: ${JSON.stringify(name)}.`,
    });
  }
};

/**
 * Derives a named profile's API key from the Office3D secret, so no per-profile
 * key has to be stored anywhere. The derivation is one-way: knowing one
 * profile's key reveals nothing about another's or about the secret.
 */
const deriveProfileKey = (secret, profile) =>
  crypto.createHmac("sha256", secret).update(`${PROFILE_KEY_CONTEXT}${profile}`).digest("hex");

/** Pulls a readable message out of the error shapes Hermes answers with. */
const describeErrorBody = (body) => {
  if (!body || typeof body !== "object") return { message: typeof body === "string" ? body : "", code: "" };
  const err = body.error;
  if (err && typeof err === "object") {
    return { message: String(err.message || ""), code: String(err.code || err.type || "") };
  }
  if (typeof err === "string") return { message: err, code: String(body.code || "") };
  if (body.detail !== undefined) {
    const detail = body.detail;
    if (typeof detail === "string") return { message: detail, code: "" };
    if (Array.isArray(detail)) {
      return { message: detail.map((d) => d?.msg || JSON.stringify(d)).join("; "), code: "validation_error" };
    }
    if (detail && typeof detail === "object") {
      return { message: String(detail.message || JSON.stringify(detail)), code: String(detail.code || "") };
    }
  }
  if (typeof body.message === "string") return { message: body.message, code: String(body.code || "") };
  return { message: "", code: "" };
};

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true }
    );
  });

/**
 * Reads the Hermes connection settings from the environment. Returns null
 * when Hermes is not configured, so callers can tell "not set up" from
 * "set up wrong".
 */
const resolveHermesConfig = (env = process.env) => {
  const apiUrl = trimSlash(env.HERMES_API_URL);
  if (!apiUrl) return null;
  const problems = [];
  const apiKey = String(env.HERMES_API_KEY || "").trim();
  if (apiKey.length < 16) problems.push("HERMES_API_KEY must be at least 16 characters (Hermes refuses shorter keys).");
  const dashboardUrl = trimSlash(env.HERMES_DASHBOARD_URL);
  const dashboardToken = String(env.HERMES_DASHBOARD_TOKEN || "").trim();
  if (dashboardUrl && dashboardToken.length < 16) {
    problems.push("HERMES_DASHBOARD_TOKEN must be at least 16 characters when HERMES_DASHBOARD_URL is set.");
  }
  const keySecret = String(env.OFFICE3D_HERMES_KEY_SECRET || "").trim();
  if (dashboardUrl && keySecret.length < 32) {
    problems.push("OFFICE3D_HERMES_KEY_SECRET must be at least 32 characters when HERMES_DASHBOARD_URL is set.");
  }
  for (const [name, value] of [["HERMES_API_URL", apiUrl], ["HERMES_DASHBOARD_URL", dashboardUrl]]) {
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") problems.push(`${name} must be http(s).`);
    } catch {
      problems.push(`${name} is not a valid URL.`);
    }
  }
  return { apiUrl, apiKey, dashboardUrl, dashboardToken, keySecret, problems };
};

/**
 * @param {object} config            resolveHermesConfig() output
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(msg: string, meta?: object) => void} [options.logWarn]
 */
const createHermesClient = (config, options = {}) => {
  if (!config?.apiUrl) throw new Error("Hermes client needs an apiUrl.");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const logWarn = options.logWarn ?? (() => {});

  const profileKey = (profile) => {
    assertProfileName(profile);
    if (profile === "default") return config.apiKey;
    if (!config.keySecret) {
      throw new HermesApiError({
        code: "profile_keys_unavailable",
        message: "Для работы с профилями Hermes нужен OFFICE3D_HERMES_KEY_SECRET.",
      });
    }
    return deriveProfileKey(config.keySecret, profile);
  };

  const apiBase = (profile) =>
    profile === "default" ? config.apiUrl : `${config.apiUrl}/p/${encodeURIComponent(profile)}`;

  const buildUrl = (base, path, query) => {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  };

  /**
   * One HTTP exchange with timeouts and bounded retries. Only requests that
   * are safe to repeat are retried: GETs, and POSTs that carry an
   * Idempotency-Key Hermes deduplicates.
   */
  const exchange = async ({ url, method = "GET", headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS, signal, retry, stream = false }) => {
    const canRetry = retry ?? (method === "GET" || Boolean(headers["Idempotency-Key"]));
    const attempts = canRetry ? RETRY_DELAYS_MS.length + 1 : 1;
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1], signal);
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      // A stream's timeout covers only the wait for the response headers; the
      // body is then bounded by readSse's idle timeout.
      const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method,
          headers: {
            Accept: stream ? "text/event-stream" : "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...headers,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (response.ok) {
          if (stream) {
            signal?.removeEventListener("abort", onAbort);
            return { response, controller };
          }
          const text = await response.text();
          signal?.removeEventListener("abort", onAbort);
          if (!text) return null;
          try {
            return JSON.parse(text);
          } catch {
            throw new HermesApiError({ status: response.status, code: "invalid_json", message: "Hermes ответил не JSON." });
          }
        }
        const text = await response.text().catch(() => "");
        let parsed = text;
        try {
          parsed = JSON.parse(text);
        } catch {}
        const { message, code } = describeErrorBody(parsed);
        const error = new HermesApiError({
          status: response.status,
          code: code || `http_${response.status}`,
          message: message || `Hermes ответил ${response.status}.`,
          retryable: RETRYABLE_STATUS.has(response.status),
        });
        signal?.removeEventListener("abort", onAbort);
        if (!error.retryable || attempt === attempts - 1) throw error;
        lastError = error;
      } catch (err) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (err instanceof HermesApiError) {
          if (!err.retryable || attempt === attempts - 1) throw err;
          lastError = err;
          continue;
        }
        if (signal?.aborted) throw err;
        const timedOut = controller.signal.aborted;
        const error = new HermesApiError({
          code: timedOut ? "hermes_timeout" : "hermes_unreachable",
          message: timedOut
            ? `Hermes не ответил за ${Math.round(timeoutMs / 1000)} с.`
            : `Hermes недоступен: ${err?.cause?.code || err?.message || err}.`,
          retryable: true,
          cause: err,
        });
        if (attempt === attempts - 1) throw error;
        lastError = error;
      }
      logWarn("Retrying Hermes request.", { url, attempt: attempt + 1, code: lastError?.code });
    }
    throw lastError;
  };

  const api = (profile, path, { method = "GET", query, body, headers, timeoutMs, signal, retry } = {}) =>
    exchange({
      url: buildUrl(apiBase(profile), path, query),
      method,
      body,
      timeoutMs,
      signal,
      retry,
      headers: { Authorization: `Bearer ${profileKey(profile)}`, ...(headers || {}) },
    });

  const dashboard = (path, { method = "GET", query, body, timeoutMs, signal, retry } = {}) => {
    if (!config.dashboardUrl) {
      return Promise.reject(
        new HermesApiError({
          code: "dashboard_unavailable",
          message: "Панель Hermes не настроена (HERMES_DASHBOARD_URL).",
        })
      );
    }
    return exchange({
      url: buildUrl(config.dashboardUrl, path, query),
      method,
      body,
      timeoutMs,
      signal,
      retry,
      headers: { "X-Hermes-Session-Token": config.dashboardToken },
    });
  };

  const enc = encodeURIComponent;
/**
 * One path segment: "." and ".." would be collapsed by URL resolution into
 * a different route, so they (and separators) are refused outright.
 */
const encSegment = (value) => {
  const text = String(value ?? "");
  if (!text || text === "." || text === ".." || /[\\/]/.test(text) || text.length > 200) {
    throw new HermesApiError({ status: 400, code: "invalid_id", message: `Недопустимый идентификатор: ${JSON.stringify(text).slice(0, 60)}.` });
  }
  return encodeURIComponent(text);
};

  return {
    config,
    profileKey,
    isValidProfileName,

    // --- health and capabilities -------------------------------------------
    health: (profile = "default", opts) => api(profile, "/health", opts),
    healthDetailed: (profile = "default", opts) => api(profile, "/health/detailed", opts),
    capabilities: (profile = "default", opts) => api(profile, "/v1/capabilities", opts),
    modelOptions: (profile = "default", opts) =>
      api(profile, "/api/model/options", { timeoutMs: 20_000, ...opts }),
    skills: (profile = "default", opts) => api(profile, "/v1/skills", opts),
    toolsets: (profile = "default", opts) => api(profile, "/v1/toolsets", opts),

    // --- sessions ------------------------------------------------------------
    listSessions: (profile, query, opts) => api(profile, "/api/sessions", { query, ...opts }),
    createSession: (profile, body, opts) => api(profile, "/api/sessions", { method: "POST", body, ...opts }),
    getSession: (profile, id, opts) => api(profile, `/api/sessions/${encSegment(id)}`, opts),
    patchSession: (profile, id, body, opts) =>
      api(profile, `/api/sessions/${encSegment(id)}`, { method: "PATCH", body, ...opts }),
    deleteSession: (profile, id, opts) => api(profile, `/api/sessions/${encSegment(id)}`, { method: "DELETE", ...opts }),
    sessionMessages: (profile, id, query, opts) =>
      api(profile, `/api/sessions/${encSegment(id)}/messages`, { query, ...opts }),

    // --- runs ------------------------------------------------------------------
    startRun: (profile, body, { idempotencyKey, ...opts } = {}) =>
      api(profile, "/v1/runs", {
        method: "POST",
        body,
        headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
        timeoutMs: 30_000,
        ...opts,
      }),
    getRun: (profile, runId, opts) => api(profile, `/v1/runs/${enc(runId)}`, opts),
    stopRun: (profile, runId, opts) =>
      api(profile, `/v1/runs/${enc(runId)}/stop`, { method: "POST", body: {}, ...opts }),
    steerRun: (profile, runId, body, opts) =>
      api(profile, `/v1/runs/${enc(runId)}/steer`, { method: "POST", body, ...opts }),
    resolveApproval: (profile, runId, body, opts) =>
      api(profile, `/v1/runs/${enc(runId)}/approval`, { method: "POST", body, ...opts }),
    /** Async iterator over a run's SSE events. */
    async *runEvents(profile, runId, { signal, idleTimeoutMs = 45_000 } = {}) {
      const { response, controller } = await exchange({
        url: buildUrl(apiBase(profile), `/v1/runs/${enc(runId)}/events`),
        headers: { Authorization: `Bearer ${profileKey(profile)}` },
        stream: true,
        signal,
        timeoutMs: 20_000,
      });
      try {
        yield* readSse(response.body, { idleTimeoutMs, signal });
      } finally {
        controller.abort();
      }
    },

    // --- scheduled jobs ------------------------------------------------------------
    listJobs: (profile, query, opts) => api(profile, "/api/jobs", { query, ...opts }),
    createJob: (profile, body, opts) => api(profile, "/api/jobs", { method: "POST", body, ...opts }),
    getJob: (profile, id, opts) => api(profile, `/api/jobs/${encSegment(id)}`, opts),
    updateJob: (profile, id, body, opts) => api(profile, `/api/jobs/${encSegment(id)}`, { method: "PATCH", body, ...opts }),
    deleteJob: (profile, id, opts) => api(profile, `/api/jobs/${encSegment(id)}`, { method: "DELETE", ...opts }),
    pauseJob: (profile, id, opts) => api(profile, `/api/jobs/${encSegment(id)}/pause`, { method: "POST", body: {}, ...opts }),
    resumeJob: (profile, id, opts) =>
      api(profile, `/api/jobs/${encSegment(id)}/resume`, { method: "POST", body: {}, ...opts }),
    runJob: (profile, id, opts) => api(profile, `/api/jobs/${encSegment(id)}/run`, { method: "POST", body: {}, ...opts }),

    // --- profiles (dashboard) ------------------------------------------------------
    listProfiles: (opts) => dashboard("/api/profiles", opts),
    createProfile: (body, opts) => {
      assertProfileName(body?.name);
      // Cloning a profile and seeding its bundled skills touches many files.
      return dashboard("/api/profiles", { method: "POST", body, timeoutMs: 90_000, ...opts });
    },
    deleteProfile: (name, opts) => {
      assertProfileName(name);
      return dashboard(`/api/profiles/${enc(name)}`, { method: "DELETE", timeoutMs: 60_000, ...opts });
    },
    getSoul: (name, opts) => (assertProfileName(name), dashboard(`/api/profiles/${enc(name)}/soul`, opts)),
    setSoul: (name, content, opts) =>
      (assertProfileName(name), dashboard(`/api/profiles/${enc(name)}/soul`, { method: "PUT", body: { content }, ...opts })),
    setDescription: (name, description, opts) =>
      (assertProfileName(name), dashboard(`/api/profiles/${enc(name)}/description`, { method: "PUT", body: { description }, ...opts })),
    setModel: (name, provider, model, opts) =>
      (assertProfileName(name), dashboard(`/api/profiles/${enc(name)}/model`, { method: "PUT", body: { provider, model }, ...opts })),
    setProfileEnv: (name, key, value, opts) =>
      dashboard("/api/env", { method: "PUT", query: { profile: name }, body: { key, value, profile: name }, ...opts }),
    dashboardStatus: (query, opts) => dashboard("/api/status", { query, ...opts }),
    dashboardSkills: (profile, opts) => dashboard("/api/skills", { query: { profile }, ...opts }),

    /** Any dashboard route; the named helpers above cover the common ones. */
    dashboard,

    /**
     * Hands the browser's OAuth redirect for an MCP server to Hermes, which
     * matches it to the waiting sign-in by `state`. Hermes answers with an
     * HTML page; only its status matters. Never retried: a code works once.
     */
    mcpOAuthCallback: async (name, params, { timeoutMs = 30_000 } = {}) => {
      if (!config.dashboardUrl) {
        throw new HermesApiError({ code: "dashboard_unavailable", message: "Панель Hermes не настроена (HERMES_DASHBOARD_URL)." });
      }
      const url = buildUrl(config.dashboardUrl, `/api/mcp/oauth/callback/${encSegment(name)}`, params);
      try {
        const response = await fetchImpl(url, {
          headers: { Accept: "text/html", "X-Hermes-Session-Token": config.dashboardToken },
          signal: AbortSignal.timeout(timeoutMs),
        });
        await response.body?.cancel().catch(() => {});
        return { status: response.status };
      } catch (err) {
        throw new HermesApiError({
          code: "hermes_unreachable",
          message: `Hermes недоступен: ${err?.cause?.code || err?.message || err}.`,
          retryable: true,
          cause: err,
        });
      }
    },

    // --- kanban (dashboard plugin) ------------------------------------------------
    kanban: (path, opts) => dashboard(`/api/plugins/kanban${path}`, opts),
  };
};

module.exports = {
  HermesApiError,
  createHermesClient,
  deriveProfileKey,
  describeErrorBody,
  isValidProfileName,
  resolveHermesConfig,
};
