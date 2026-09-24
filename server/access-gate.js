const crypto = require("node:crypto");

// Access to the office when STUDIO_ACCESS_TOKEN is set.
//
// The person signs in once at /login with the access token. The server then
// sets a session cookie: an expiry signed with a key derived from the token
// (HMAC), never the token itself. Changing the token signs everyone out. The
// cookie is HttpOnly, SameSite=Lax, and Secure whenever the page came over
// HTTPS. A `studio_access=<token>` cookie is still accepted, for scripts and
// older setups.
//
// Wrong tokens and forged sessions are counted per client address; after
// ten in a minute that address is refused for the rest of the minute.

const SESSION_COOKIE = "studio_session";
const SESSION_DAYS = 30;
const MAX_LOGIN_BODY = 8 * 1024;

const parseCookies = (header) => {
  const raw = typeof header === "string" ? header : "";
  if (!raw.trim()) return {};
  const out = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = value;
  }
  return out;
};

/** Constant-time string comparison to prevent timing attacks. */
const safeCompare = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Compare against self to burn constant time, then return false
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
};

/** Simple in-memory rate limiter for auth attempts. */
const createRateLimiter = (maxAttempts = 10, windowMs = 60_000) => {
  const attempts = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of attempts) {
      if (now - entry.start > windowMs) attempts.delete(key);
    }
  }, windowMs);
  cleanup.unref();

  return {
    isLimited(ip) {
      const entry = attempts.get(ip);
      if (!entry) return false;
      if (Date.now() - entry.start > windowMs) {
        attempts.delete(ip);
        return false;
      }
      return entry.count >= maxAttempts;
    },
    recordFailure(ip) {
      const now = Date.now();
      const entry = attempts.get(ip);
      if (!entry || now - entry.start > windowMs) {
        attempts.set(ip, { count: 1, start: now });
        return;
      }
      entry.count++;
    },
    reset(ip) {
      attempts.delete(ip);
    },
  };
};

/**
 * Resolve client IP for rate limiting.
 * When TRUSTED_PROXY=1 is set, the first value of X-Forwarded-For is used.
 * Only set TRUSTED_PROXY=1 when this server sits behind a reverse proxy that
 * you control (nginx, Caddy, Vercel edge). Without it, X-Forwarded-For is
 * ignored to prevent spoofing by direct clients.
 */
const resolveClientIp = (req) => {
  if (process.env.TRUSTED_PROXY === "1") {
    const forwarded = req.headers?.["x-forwarded-for"];
    if (typeof forwarded === "string") {
      const first = forwarded.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  return req.socket?.remoteAddress || "unknown";
};

/** Whether the browser reached us over HTTPS (directly or through the proxy). */
const isHttps = (req) => {
  if (req.socket?.encrypted) return true;
  return process.env.TRUSTED_PROXY === "1" && String(req.headers?.["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
};

// Answered without the access token: container and uptime health checks
// cannot carry the cookie, and the answer says only that the server is up.
const PUBLIC_PATHS = new Set(["/api/health"]);

const pathOf = (req) => String(req.url || "/").split("?")[0];

const isPublicRequest = (req) => {
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  return PUBLIC_PATHS.has(pathOf(req));
};

/** Where to go after signing in: a path on this site, nothing else. */
const safeNext = (value) => {
  const next = typeof value === "string" ? value : "";
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || next.startsWith("/login")) return "/";
  return next.slice(0, 2000);
};

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

const loginPage = ({ next, error }) => `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Вход в Office3D</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0d10; color: #e8eaed;
         font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: min(360px, calc(100vw - 32px)); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { margin: 0 0 20px; color: #9aa0a6; font-size: 13px; }
  label { display: block; font-size: 13px; margin-bottom: 6px; }
  input { box-sizing: border-box; width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #3c4043;
          background: #15181c; color: inherit; font: inherit; }
  input:focus { outline: 2px solid #22d3ee; outline-offset: 1px; }
  button { margin-top: 14px; width: 100%; padding: 10px; border: 0; border-radius: 8px; background: #22d3ee; color: #062329;
           font: inherit; font-weight: 600; cursor: pointer; }
  .error { margin: 0 0 14px; padding: 8px 10px; border-radius: 8px; background: #3b1219; color: #fecdd3; font-size: 13px; }
</style>
</head>
<body>
<main>
  <h1>Office3D</h1>
  <p>Введите токен доступа (STUDIO_ACCESS_TOKEN из .env на сервере).</p>
  ${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ""}
  <form method="post" action="/login">
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <label for="token">Токен доступа</label>
    <input id="token" name="token" type="password" autocomplete="current-password" required autofocus>
    <button type="submit">Войти</button>
  </form>
</main>
</body>
</html>`;

const LOGIN_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const TOO_MANY = "Слишком много неудачных попыток входа в Studio. Подождите минуту и повторите.";

function createAccessGate(options) {
  const token = String(options?.token ?? "").trim();
  const cookieName = String(options?.cookieName ?? "studio_access").trim() || "studio_access";
  const now = typeof options?.now === "function" ? options.now : () => Date.now();

  const enabled = Boolean(token);
  const rateLimiter = createRateLimiter(10, 60_000);
  // Sessions are signed with a key only this token yields.
  const sessionKey = crypto.createHmac("sha256", token || "unset").update("office3d:session:v1").digest();

  const sign = (payload) => crypto.createHmac("sha256", sessionKey).update(payload).digest("base64url");

  const issueSession = () => {
    const payload = Buffer.from(JSON.stringify({ v: 1, exp: now() + SESSION_DAYS * 86_400_000 })).toString("base64url");
    return `${payload}.${sign(payload)}`;
  };

  /** "valid", "expired" (signed by us, ran out) or "invalid". */
  const sessionState = (value) => {
    if (typeof value !== "string" || value.length > 512) return "invalid";
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra !== undefined) return "invalid";
    if (!safeCompare(signature, sign(payload))) return "invalid";
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (data?.v !== 1 || !Number.isFinite(data.exp)) return "invalid";
      return data.exp > now() ? "valid" : "expired";
    } catch {
      return "invalid";
    }
  };

  const sessionCookie = (req, value, maxAgeSeconds) =>
    [
      `${SESSION_COOKIE}=${value}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${maxAgeSeconds}`,
      ...(isHttps(req) ? ["Secure"] : []),
    ].join("; ");

  const getAuthState = (req) => {
    if (!enabled) return { authorized: true, limited: false };
    const ip = resolveClientIp(req);
    const cookies = parseCookies(req.headers?.cookie);
    const session = cookies[SESSION_COOKIE];
    const legacy = cookies[cookieName];
    const state = session ? sessionState(session) : null;
    if (state === "valid" || (legacy && safeCompare(legacy, token))) {
      rateLimiter.reset(ip);
      return { authorized: true, limited: false };
    }
    if (rateLimiter.isLimited(ip)) return { authorized: false, limited: true };
    // A wrong token or a forged session is an attempt; no credentials, or a
    // sign-in that simply ran out, is not.
    if (legacy || state === "invalid") rateLimiter.recordFailure(ip);
    return { authorized: false, limited: rateLimiter.isLimited(ip) };
  };

  const readForm = (req) =>
    new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > MAX_LOGIN_BODY) {
          reject(new Error("too large"));
          req.destroy?.();
        }
      });
      req.on("end", () => resolve(new URLSearchParams(raw)));
      req.on("error", reject);
    });

  const sendLogin = (res, status, { next = "/", error = "" } = {}) => {
    res.statusCode = status;
    for (const [key, value] of Object.entries(LOGIN_HEADERS)) res.setHeader(key, value);
    res.end(loginPage({ next, error }));
  };

  const redirect = (res, location, cookie) => {
    res.statusCode = 303;
    res.setHeader("Location", location);
    res.setHeader("Cache-Control", "no-store");
    if (cookie) res.setHeader("Set-Cookie", cookie);
    res.end();
  };

  const handleLogin = async (req, res) => {
    const ip = resolveClientIp(req);
    let form;
    try {
      form = await readForm(req);
    } catch {
      res.statusCode = 413;
      res.end();
      return;
    }
    const next = safeNext(form.get("next"));
    if (rateLimiter.isLimited(ip)) {
      sendLogin(res, 429, { next, error: TOO_MANY });
      return;
    }
    if (!safeCompare(String(form.get("token") ?? "").trim(), token)) {
      rateLimiter.recordFailure(ip);
      const limited = rateLimiter.isLimited(ip);
      sendLogin(res, limited ? 429 : 401, { next, error: limited ? TOO_MANY : "Неверный токен доступа." });
      return;
    }
    rateLimiter.reset(ip);
    redirect(res, next, sessionCookie(req, issueSession(), SESSION_DAYS * 86_400));
  };

  const handleHttp = (req, res) => {
    if (!enabled) return false;
    if (isPublicRequest(req)) return false;
    const method = String(req.method || "GET").toUpperCase();
    const path = pathOf(req);

    if (path === "/login") {
      if (method === "POST") {
        void handleLogin(req, res);
        return true;
      }
      if (method === "GET" || method === "HEAD") {
        const next = safeNext(new URL(req.url || "/", "http://office3d.local").searchParams.get("next"));
        if (getAuthState(req).authorized) {
          redirect(res, next);
          return true;
        }
        sendLogin(res, 200, { next });
        return true;
      }
    }
    if (path === "/logout" && method === "POST") {
      redirect(res, "/login", sessionCookie(req, "", 0));
      return true;
    }

    const auth = getAuthState(req);
    if (auth.authorized) return false;
    const statusCode = auth.limited ? 429 : 401;
    if (path.startsWith("/api/")) {
      res.statusCode = statusCode;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: auth.limited ? TOO_MANY : "Нужен вход в Studio: откройте /login и введите токен доступа." }));
      return true;
    }
    if ((method === "GET" || method === "HEAD") && !auth.limited) {
      redirect(res, `/login?next=${encodeURIComponent(safeNext(req.url || "/"))}`);
      return true;
    }
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(auth.limited ? TOO_MANY : "Нужен вход в Studio: откройте /login.");
    return true;
  };

  const allowUpgrade = (req) => {
    if (!enabled) return true;
    return getAuthState(req).authorized;
  };

  return { enabled, handleHttp, allowUpgrade };
}

module.exports = { createAccessGate };
