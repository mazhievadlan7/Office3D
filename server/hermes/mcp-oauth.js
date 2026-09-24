// Signing an agent in to an MCP server that uses OAuth, from the office.
//
// Hermes does the OAuth work itself (discovery, client registration, PKCE,
// state, token exchange and refresh; tokens stay in the agent's profile and
// never pass through the office). What it cannot do on its own here is take
// the browser's redirect: its dashboard is private to the machine. So:
//
//   1. hermes.mcp.login points the server's `oauth.redirect_uri` at this
//      office (/oauth/mcp/<server>) and starts Hermes' sign-in, which returns
//      the provider's authorization URL; the office opens it in a new tab;
//   2. the provider sends the browser back to /oauth/mcp/<server>; the office
//      (behind its own sign-in) passes code and state to Hermes, which checks
//      the state against the waiting sign-in and exchanges the code;
//   3. hermes.mcp.loginStatus follows the sign-in until Hermes has the tokens
//      and has listed the server's tools.
//
// Each agent (Hermes profile) keeps its own tokens, so each signs in once.

const crypto = require("node:crypto");

const CALLBACK_PREFIX = "/oauth/mcp/";
const RESERVED_MCP = new Set(["office3d", "office3d_team"]);
const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FLOW_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const CALLBACK_PARAMS = ["code", "state", "error", "iss"];
const MAX_PARAM_LENGTH = 4096;
// Hermes forgets a sign-in after 15 minutes; the office a little later.
const FLOW_TTL_MS = 16 * 60_000;
const MAX_FLOWS = 50;
const START_TIMEOUT_MS = 45_000;
const BUSY_RETRIES = 5;
const BUSY_RETRY_MS = 1_000;
// A value the office writes into Hermes' config: printable, no spaces.
const TOKEN_LIKE_RE = /^[\x21-\x7e]+$/;
const SCOPE_RE = /^[\x20-\x7e]+$/;

const str = (value) => (typeof value === "string" ? value.trim() : "");
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The office's own address as the provider must see it: an explicit
 * OFFICE3D_PUBLIC_URL, or the origin the person's browser is on.
 * @returns {string} scheme://host[:port], no trailing slash; "" if unusable
 */
const normalizeOrigin = (value) => {
  const text = str(value);
  if (!text) return "";
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return "";
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) return "";
  return parsed.origin;
};

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

/** Hermes' English failure text, told in the office's words where it is a known case. */
const describeFailure = (raw) => {
  const text = str(raw);
  if (!text) return "Вход не удался.";
  if (/cancelled by user/i.test(text)) return "Вход отменён.";
  if (/timed out waiting for mcp oauth callback/i.test(text)) return "Вход не завершён вовремя: страница входа ждёт не дольше 5 минут. Начните заново.";
  if (/timed out waiting for mcp authorization url/i.test(text)) return "Сервер не ответил на запрос входа. Проверьте адрес и попробуйте ещё раз.";
  if (/manually-registered oauth client|pre-approved|registration/i.test(text)) {
    return `Сервис не выдаёт доступ новым приложениям сам: зарегистрируйте OAuth-приложение у него и укажите его Client ID. (${text.slice(0, 300)})`;
  }
  if (/access_denied/i.test(text)) return "Доступ не разрешён на странице входа.";
  return `Вход не удался: ${text.slice(0, 500)}`;
};

/**
 * @param {object} deps
 * @param {any} deps.client
 * @param {(agentId: string) => Promise<string>} deps.profileFor
 * @param {() => boolean} deps.hasDashboard
 * @param {typeof import("./client").HermesApiError} deps.HermesApiError
 * @param {new (code: string, message: string) => Error} deps.AdapterError
 * @param {(key: string, task: () => Promise<any>) => Promise<any>} deps.withLock  shared with the MCP settings
 * @param {string} [deps.publicUrl]   OFFICE3D_PUBLIC_URL, when set
 * @param {(message: string) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.wait]
 */
const createMcpOAuth = ({
  client,
  profileFor,
  hasDashboard,
  HermesApiError,
  AdapterError,
  withLock,
  publicUrl = "",
  log = () => {},
  now = () => Date.now(),
  wait = sleep,
}) => {
  const invalid = (message) => new AdapterError("INVALID_REQUEST", message);
  const configuredOrigin = normalizeOrigin(publicUrl);

  /** flowId → { profile, name, startedAt }: only sign-ins this office started. */
  const flows = new Map();
  /** `${profile}\n${name}` → flowId of the sign-in still waiting. */
  const pending = new Map();
  const serverKey = (profile, name) => `${profile}\n${name}`;

  const forget = (flowId) => {
    const flow = flows.get(flowId);
    flows.delete(flowId);
    if (flow && pending.get(serverKey(flow.profile, flow.name)) === flowId) pending.delete(serverKey(flow.profile, flow.name));
  };
  const collect = () => {
    const cutoff = now() - FLOW_TTL_MS;
    for (const [flowId, flow] of flows) if (flow.startedAt < cutoff) forget(flowId);
    while (flows.size > MAX_FLOWS) forget(flows.keys().next().value);
  };

  const redirectFor = (origin, name) => `${origin}${CALLBACK_PREFIX}${encodeURIComponent(name)}`;

  /** Optional pre-registered OAuth client, for providers without self-registration. */
  const clientSettings = (value) => {
    if (value === undefined || value === null) return {};
    if (!isRecord(value)) throw invalid("Неверные данные OAuth-клиента.");
    const settings = {};
    const clientId = str(value.clientId);
    const clientSecret = str(value.clientSecret);
    const scope = str(value.scope);
    if (clientId) {
      if (clientId.length > 512 || !TOKEN_LIKE_RE.test(clientId)) throw invalid("Client ID: без пробелов, до 512 символов.");
      settings.client_id = clientId;
    }
    if (clientSecret) {
      if (!clientId) throw invalid("Секрет клиента указывается вместе с Client ID.");
      if (clientSecret.length > 1024 || !TOKEN_LIKE_RE.test(clientSecret)) throw invalid("Секрет клиента: без пробелов, до 1024 символов.");
      settings.client_secret = clientSecret;
    }
    if (scope) {
      if (scope.length > 1000 || !SCOPE_RE.test(scope)) throw invalid("Права (scope): латиница через пробел, до 1000 символов.");
      settings.scope = scope;
    }
    return settings;
  };

  const snapshotOf = (flowId, raw) => {
    const status = str(raw?.status) || "error";
    const tools = (Array.isArray(raw?.tools) ? raw.tools : [])
      .filter(isRecord)
      .slice(0, 200)
      .map((tool) => ({ name: str(tool.name), description: str(tool.description).slice(0, 300) }));
    return {
      flowId,
      status: ["starting", "authorization_required", "approved", "error"].includes(status) ? status : "error",
      error: status === "error" ? describeFailure(raw?.error) : null,
      tools,
    };
  };

  const cancelInHermes = async (flowId) => {
    try {
      await client.dashboard(`/api/mcp/oauth/flows/${encodeURIComponent(flowId)}`, { method: "DELETE" });
    } catch (err) {
      if (!(err instanceof HermesApiError)) throw err;
    }
  };

  const startInHermes = async (profile, name) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await client.dashboard(`/api/mcp/servers/${encodeURIComponent(name)}/auth`, {
          method: "POST",
          query: { profile },
          timeoutMs: START_TIMEOUT_MS,
        });
      } catch (err) {
        if (!(err instanceof HermesApiError)) throw err;
        // A cancelled sign-in frees its slot once Hermes' worker has stopped.
        if (err.status === 409 && /already in progress/i.test(err.message) && attempt < BUSY_RETRIES) {
          await wait(BUSY_RETRY_MS);
          continue;
        }
        if (err.status === 409) throw new AdapterError("CONFLICT", "Вход в этот сервер уже идёт — возможно, начат в панели Hermes. Завершите его или подождите 5 минут.");
        if (err.status === 429) throw new AdapterError("CONFLICT", "Слишком много незавершённых входов. Завершите их или подождите 15 минут.");
        if (err.status === 404) throw new AdapterError("NOT_FOUND", "У агента нет такого MCP-сервера.");
        if (err.status === 400) throw invalid(describeFailure(err.message));
        throw err;
      }
    }
  };

  const handlers = {
    /**
     * Starts signing the agent in to one of its MCP servers. Returns the
     * provider's page to open; the office follows with hermes.mcp.loginStatus.
     */
    async "hermes.mcp.login"(p) {
      if (!hasDashboard()) throw new AdapterError("UNAVAILABLE", "Вход в MCP-серверы доступен при подключённой панели Hermes.");
      const profile = await profileFor(str(p?.agentId) || "main");
      const name = str(p?.name);
      if (!MCP_NAME_RE.test(name)) throw invalid("Неверное имя MCP-сервера.");
      if (RESERVED_MCP.has(name)) throw new AdapterError("FORBIDDEN", "Этот сервер — доступ агента к офису; входить в него не нужно.");
      const origin = configuredOrigin || normalizeOrigin(p?.origin);
      if (!origin) throw invalid("Не удалось определить адрес офиса для возврата после входа. Задайте OFFICE3D_PUBLIC_URL.");
      const redirectUri = redirectFor(origin, name);
      const extra = clientSettings(p?.client);

      collect();
      const previous = pending.get(serverKey(profile, name));
      if (previous) {
        await cancelInHermes(previous);
        forget(previous);
      }

      await withLock(`mcp:${profile}`, async () => {
        const listed = await client.dashboard("/api/mcp/servers", { query: { profile } });
        const row = (Array.isArray(listed?.servers) ? listed.servers : []).filter(isRecord).find((entry) => str(entry.name) === name);
        if (!row) throw new AdapterError("NOT_FOUND", "У агента нет такого MCP-сервера.");
        if (str(row.source) === "plugin") throw new AdapterError("FORBIDDEN", "Этим сервером управляет плагин Hermes.");
        if (!str(row.url)) throw invalid("Вход через OAuth есть только у серверов по адресу.");
        if (str(row.auth) === "header") throw invalid("Этот сервер подключён по токену доступа, а не через OAuth.");
        // Where the provider sends the browser back, plus a pre-registered
        // client when given. Written only while the server is known to exist:
        // the config update merges, so it would otherwise create an entry.
        const config = await client.dashboard("/api/config", { query: { profile } });
        const saved = isRecord(config?.mcp_servers?.[name]?.oauth) ? config.mcp_servers[name].oauth : {};
        const wanted = { redirect_uri: redirectUri, ...extra };
        if (Object.entries(wanted).some(([key, value]) => saved[key] !== value)) {
          await client.dashboard("/api/config", {
            method: "PUT",
            query: { profile },
            body: { config: { mcp_servers: { [name]: { oauth: wanted } } } },
          });
        }
      });

      const started = await startInHermes(profile, name);
      const flowId = str(started?.flow_id);
      if (!FLOW_ID_RE.test(flowId)) throw new AdapterError("UNAVAILABLE", "Hermes не начал вход.");
      const snapshot = snapshotOf(flowId, started);
      let authorizationUrl = null;
      if (snapshot.status === "authorization_required") {
        try {
          const parsed = new URL(str(started.authorization_url));
          if (["https:", "http:"].includes(parsed.protocol)) authorizationUrl = parsed.toString();
        } catch {}
        if (!authorizationUrl) {
          await cancelInHermes(flowId);
          throw new AdapterError("UNAVAILABLE", "Сервер прислал неверную ссылку на страницу входа.");
        }
      }
      flows.set(flowId, { profile, name, startedAt: now() });
      if (snapshot.status !== "error" && snapshot.status !== "approved") pending.set(serverKey(profile, name), flowId);
      log(`MCP sign-in for ${name} (${profile}) started.`);
      return { ...snapshot, authorizationUrl };
    },

    /** Where a sign-in the office started stands. */
    async "hermes.mcp.loginStatus"(p) {
      const flowId = str(p?.flowId);
      collect();
      const flow = FLOW_ID_RE.test(flowId) ? flows.get(flowId) : undefined;
      if (!flow) throw new AdapterError("NOT_FOUND", "Вход не найден или устарел. Начните заново.");
      let raw;
      try {
        raw = await client.dashboard(`/api/mcp/oauth/flows/${encodeURIComponent(flowId)}`);
      } catch (err) {
        if (err instanceof HermesApiError && err.status === 404) {
          forget(flowId);
          return { flowId, status: "error", error: "Вход устарел. Начните заново.", tools: [] };
        }
        throw err;
      }
      const snapshot = snapshotOf(flowId, raw);
      if (snapshot.status === "approved" || snapshot.status === "error") {
        if (pending.get(serverKey(flow.profile, flow.name)) === flowId) pending.delete(serverKey(flow.profile, flow.name));
        if (snapshot.status === "approved" && !flow.reported) {
          flow.reported = true;
          log(`MCP sign-in for ${flow.name} (${flow.profile}) completed: ${snapshot.tools.length} tool(s).`);
        }
      }
      return snapshot;
    },

    async "hermes.mcp.loginCancel"(p) {
      const flowId = str(p?.flowId);
      const flow = FLOW_ID_RE.test(flowId) ? flows.get(flowId) : undefined;
      if (!flow) return { ok: true };
      await cancelInHermes(flowId);
      forget(flowId);
      return { ok: true };
    },
  };

  // --- the provider's redirect ------------------------------------------------

  const page = (res, status, { title, text, close = false }) => {
    const nonce = crypto.randomBytes(16).toString("base64");
    res.statusCode = status;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    // The code is in this page's URL: never hand it on as a referrer.
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
    );
    const script = close ? `<script nonce="${nonce}">setTimeout(function(){window.close()},1500)</script>` : "";
    res.end(`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — Office3D</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#15171a;--muted:#5b6270;--card:#fff;--line:#dfe3ea}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e8eaee;--muted:#9aa3b2;--card:#171a20;--line:#2a2f38}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box}
main{max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:18px;margin:0 0 8px}p{margin:0;color:var(--muted)}
</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></main>${script}</body></html>`);
  };

  /**
   * GET /oauth/mcp/<server>?code&state: the provider's redirect. Returns
   * false for any other path. The access gate runs before this.
   */
  const handleCallback = (req, res) => {
    const rawUrl = typeof req.url === "string" ? req.url : "";
    if (!rawUrl.startsWith(CALLBACK_PREFIX)) return false;
    void (async () => {
      // Only a browser's navigation hands the code on: a HEAD (a link
      // preview, say) must not spend it.
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return page(res, 405, { title: "Неверный запрос", text: "Эта страница открывается только переходом со страницы входа." });
      }
      let url;
      let name = "";
      try {
        url = new URL(rawUrl, "http://office3d.local");
        name = decodeURIComponent(url.pathname.slice(CALLBACK_PREFIX.length));
      } catch {}
      if (!url || !MCP_NAME_RE.test(name) || RESERVED_MCP.has(name)) {
        return page(res, 404, { title: "Страница не найдена", text: "Такого MCP-сервера нет." });
      }
      const params = {};
      for (const key of CALLBACK_PARAMS) {
        const value = url.searchParams.get(key);
        if (value === null || value === "") continue;
        if (value.length > MAX_PARAM_LENGTH) return page(res, 400, { title: "Неверный ответ", text: "Страница входа вернула слишком длинный ответ." });
        params[key] = value;
      }
      if (!params.state || (!params.code && !params.error)) {
        return page(res, 400, { title: "Неверный ответ", text: "В ответе страницы входа нет нужных данных. Начните вход заново в офисе." });
      }
      let status;
      try {
        ({ status } = await client.mcpOAuthCallback(name, params));
      } catch (err) {
        log(`MCP sign-in callback for ${name} could not reach Hermes: ${err?.message || err}`);
        return page(res, 502, { title: "Hermes недоступен", text: "Не удалось передать ответ Hermes. Начните вход заново, когда Hermes будет доступен." });
      }
      if (status === 200 && !params.error) {
        return page(res, 200, {
          title: "Вход выполнен",
          text: "Hermes получил доступ и проверяет сервер. Вкладку можно закрыть — в офисе появится результат.",
          close: true,
        });
      }
      if (status === 200 || status === 400) {
        return page(res, 400, {
          title: params.error ? "Доступ не разрешён" : "Вход не удался",
          text: params.error ? `Страница входа ответила: ${params.error.slice(0, 200)}. Можно начать заново в офисе.` : "Hermes не принял ответ страницы входа. Начните заново в офисе.",
        });
      }
      if (status === 404) return page(res, 404, { title: "Вход устарел", text: "Этот вход уже завершён или отменён. Начните заново в офисе." });
      if (status === 409) return page(res, 409, { title: "Ответ уже получен", text: "Эта ссылка уже использована. Результат — в офисе." });
      return page(res, 502, { title: "Вход не удался", text: `Hermes ответил ${status}. Начните заново в офисе.` });
    })().catch((err) => {
      log(`MCP sign-in callback failed: ${err?.message || err}`);
      if (!res.headersSent) page(res, 500, { title: "Ошибка", text: "Не удалось обработать ответ страницы входа." });
      else res.end();
    });
    return true;
  };

  return { handlers, handleCallback, redirectFor };
};

module.exports = { createMcpOAuth, normalizeOrigin, CALLBACK_PREFIX };
