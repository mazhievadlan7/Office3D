const { Buffer } = require("node:buffer");
const { WebSocket, WebSocketServer } = require("ws");

const DEFAULT_UPSTREAM_HANDSHAKE_TIMEOUT_MS = 10_000;

// Liveness, both ways. Every interval the proxy
//  - sends the browser a "studio.heartbeat" event, so the browser client can
//    tell a silent socket from a dead one (GatewayBrowserClient drops the
//    socket after 45 s without any frame and reconnects);
//  - pings the browser and the upstream at the WebSocket level; a side that
//    has not answered the previous ping is terminated. A dead upstream then
//    closes the browser with 1012, and the office reconnects by itself.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
const STUDIO_HEARTBEAT_EVENT = "studio.heartbeat";

/** Maximum frame payload size (256 KB). */
const MAX_FRAME_SIZE = 256 * 1024;

/**
 * Sustained frame rate per connection. Loading a team of hundreds of agents
 * sends several requests per agent; the browser client paces itself at 200/s
 * (SEND_RATE in GatewayBrowserClient.ts), so this leaves it headroom.
 */
const MAX_FRAMES_PER_SECOND = 250;

/** Allow short startup bursts before rate limiting. */
const MAX_FRAME_BURST = 500;

// The close code GatewayClient treats as a failed connect; the reason carries
// "connect failed: <code> <message>" (see parseConnectFailedCloseReason).
const CONNECT_FAILED_CLOSE_CODE = 4008;
// RFC 6455 caps a close reason at 123 bytes of UTF-8, and ws throws beyond it.
// Russian text is two bytes a letter, so the message is cut on a character
// boundary rather than risking the close itself failing.
const MAX_CLOSE_REASON_BYTES = 123;

const connectFailedReason = ({ code, message }) => {
  let reason = `connect failed: ${code} ${message}`;
  while (Buffer.byteLength(reason, "utf8") > MAX_CLOSE_REASON_BYTES) {
    reason = Array.from(reason).slice(0, -1).join("");
  }
  return reason;
};

const buildErrorResponse = (id, code, message) => {
  return {
    type: "res",
    id,
    ok: false,
    error: { code, message },
  };
};

const isObject = (value) => Boolean(value && typeof value === "object");

const safeJsonParse = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** Per-connection token bucket rate limiter. */
const createFrameRateLimiter = (
  maxPerSecond = MAX_FRAMES_PER_SECOND,
  maxBurst = MAX_FRAME_BURST
) => {
  let tokens = maxBurst;
  let lastRefillAt = Date.now();

  const refill = () => {
    const now = Date.now();
    const elapsedMs = Math.max(0, now - lastRefillAt);
    if (elapsedMs <= 0) return;
    const replenished = (elapsedMs / 1000) * maxPerSecond;
    tokens = Math.min(maxBurst, tokens + replenished);
    lastRefillAt = now;
  };

  return {
    check() {
      refill();
      if (tokens < 1) {
        return false;
      }
      tokens -= 1;
      return true;
    },
    destroy() {
      // No-op: token bucket has no timers to clean up.
    },
  };
};

/**
 * Validate upstream URL against an allowlist.
 * If UPSTREAM_ALLOWLIST env var is set, only those hosts are permitted.
 * Format: comma-separated hostnames, e.g. "gateway.percival-labs.ai,localhost"
 */
const isUpstreamAllowed = (url) => {
  const allowlist = (process.env.UPSTREAM_ALLOWLIST || "").trim();
  if (!allowlist) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[gateway-proxy] refusing upstream connection: UPSTREAM_ALLOWLIST is " +
          "empty in production. Set UPSTREAM_ALLOWLIST=host1,host2 (comma-" +
          "separated hostnames) to allow specific upstream hosts."
      );
      return false;
    }
    return true;
  }
  try {
    const parsed = new URL(url);
    const allowed = allowlist
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    const hostname = parsed.hostname.toLowerCase();
    if (!allowed.includes(hostname)) {
      console.warn(
        `[gateway-proxy] refusing upstream connection to "${hostname}": host ` +
          `not in UPSTREAM_ALLOWLIST (${allowlist}). Add the host to the ` +
          `allowlist if you trust it.`
      );
      return false;
    }
    return true;
  } catch (err) {
    const reason = err && typeof err === "object" && "message" in err ? err.message : "invalid URL";
    console.warn(
      `[gateway-proxy] refusing upstream connection: could not parse URL ` +
        `"${url}" (${reason}).`
    );
    return false;
  }
};

const resolvePathname = (url) => {
  const raw = typeof url === "string" ? url : "";
  const idx = raw.indexOf("?");
  return (idx === -1 ? raw : raw.slice(0, idx)) || "/";
};

const injectAuthToken = (params, token) => {
  const next = isObject(params) ? { ...params } : {};
  const auth = isObject(next.auth) ? { ...next.auth } : {};
  auth.token = token;
  next.auth = auth;
  return next;
};

const resolveOriginForUpstream = (upstreamUrl) => {
  const url = new URL(upstreamUrl);
  const proto = url.protocol === "wss:" ? "https:" : "http:";
  const hostname =
    url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "0.0.0.0"
      ? "localhost"
      : url.hostname;
  const host = url.port ? `${hostname}:${url.port}` : hostname;
  return `${proto}//${host}`;
};

const hasNonEmptyToken = (params) => {
  const raw = params && isObject(params) && isObject(params.auth) ? params.auth.token : "";
  return typeof raw === "string" && raw.trim().length > 0;
};

const hasNonEmptyPassword = (params) => {
  const raw = params && isObject(params) && isObject(params.auth) ? params.auth.password : "";
  return typeof raw === "string" && raw.trim().length > 0;
};

const hasNonEmptyDeviceToken = (params) => {
  const raw = params && isObject(params) && isObject(params.auth) ? params.auth.deviceToken : "";
  return typeof raw === "string" && raw.trim().length > 0;
};

const hasCompleteDeviceAuth = (params) => {
  const device = params && isObject(params) && isObject(params.device) ? params.device : null;
  if (!device) {
    return false;
  }
  const id = typeof device.id === "string" ? device.id.trim() : "";
  const publicKey = typeof device.publicKey === "string" ? device.publicKey.trim() : "";
  const signature = typeof device.signature === "string" ? device.signature.trim() : "";
  const nonce = typeof device.nonce === "string" ? device.nonce.trim() : "";
  const signedAt = device.signedAt;
  return (
    id.length > 0 &&
    publicKey.length > 0 &&
    signature.length > 0 &&
    nonce.length > 0 &&
    Number.isFinite(signedAt) &&
    signedAt >= 0
  );
};

function createGatewayProxy(options) {
  const {
    loadUpstreamSettings,
    allowWs = (req) => resolvePathname(req.url) === "/api/gateway/ws",
    log = () => {},
    logError = (msg, err) => console.error(msg, err),
    upstreamHandshakeTimeoutMs = DEFAULT_UPSTREAM_HANDSHAKE_TIMEOUT_MS,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  } = options || {};

  const { verifyClient } = options || {};

  if (typeof loadUpstreamSettings !== "function") {
    throw new Error("createGatewayProxy requires loadUpstreamSettings().");
  }

  const wss = new WebSocketServer({ noServer: true, verifyClient });

  wss.on("connection", (browserWs) => {
    let upstreamWs = null;
    let upstreamReady = false;
    let upstreamUrl = "";
    let upstreamToken = "";
    let upstreamAdapterType = "openclaw";
    let upstreamForceToken = false;
    let upstreamTrusted = false;
    let connectRequestId = null;
    let connectResponseSent = false;
    let pendingConnectFrame = null;
    let pendingUpstreamSetupError = null;
    let closed = false;
    const frameRateLimiter = createFrameRateLimiter();
    let upstreamHandshakeTimeoutId = null;
    let browserAlive = true;
    let upstreamAlive = true;
    let heartbeatTimer = null;

    const closeBoth = (code, reason) => {
      if (closed) return;
      closed = true;
      frameRateLimiter.destroy();
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (upstreamHandshakeTimeoutId !== null) {
        clearTimeout(upstreamHandshakeTimeoutId);
        upstreamHandshakeTimeoutId = null;
      }
      try {
        browserWs.close(code, reason);
      } catch {}
      try {
        upstreamWs?.close(code, reason);
      } catch {}
    };

    const sendToBrowser = (frame) => {
      if (browserWs.readyState !== WebSocket.OPEN) return;
      browserWs.send(JSON.stringify(frame));
    };

    const sendConnectError = (code, message) => {
      if (connectRequestId && !connectResponseSent) {
        connectResponseSent = true;
        sendToBrowser(buildErrorResponse(connectRequestId, code, message));
      }
      closeBoth(1011, "connect failed");
    };

    // The upstream cannot be reached, or is not configured, before the browser
    // has sent its connect frame. The browser waits up to 5 s for a
    // connect.challenge before sending one, then its own timeout; holding the
    // error until then left the connect form replaced by a spinner for about
    // twelve seconds while the answer was already known. Closing with the
    // connect-failed code hands the browser the same code and message at once:
    // GatewayClient parses "connect failed: <code> <message>" from the reason.
    const failSetup = (error) => {
      pendingUpstreamSetupError = error;
      if (connectRequestId) {
        sendConnectError(error.code, error.message);
        return;
      }
      closeBoth(CONNECT_FAILED_CLOSE_CODE, connectFailedReason(error));
    };

    const forwardConnectFrame = (frame) => {
      const browserHasAuth =
        !upstreamForceToken &&
        (hasNonEmptyToken(frame.params) ||
        hasNonEmptyPassword(frame.params) ||
        hasNonEmptyDeviceToken(frame.params) ||
        hasCompleteDeviceAuth(frame.params));

      const requiresToken = upstreamAdapterType === "openclaw";
      if (requiresToken && !upstreamToken && !browserHasAuth) {
        sendConnectError(
          "studio.gateway_token_missing",
          "Токен шлюза не настроен на хосте Studio."
        );
        return;
      }

      const baseConnectFrame = browserHasAuth
        ? frame
        : {
            ...frame,
            params: injectAuthToken(frame.params, upstreamToken),
          };

      const connectParams = isObject(baseConnectFrame.params)
        ? { ...baseConnectFrame.params }
        : {};
      const hasDeviceAuth = hasCompleteDeviceAuth(connectParams);
      const client = isObject(connectParams.client) ? { ...connectParams.client } : {};
      const clientId = typeof client.id === "string" ? client.id.trim() : "";

      if (
        upstreamAdapterType === "openclaw" &&
        clientId === "openclaw-control-ui" &&
        !hasDeviceAuth
      ) {
        client.id = "webchat-ui";
        connectParams.client = client;
        if (isObject(connectParams.device) && !hasCompleteDeviceAuth(connectParams)) {
          delete connectParams.device;
        }
      }

      const connectFrame = {
        ...baseConnectFrame,
        params: connectParams,
      };
      upstreamWs.send(JSON.stringify(connectFrame));
    };

    const maybeForwardPendingConnect = () => {
      if (!pendingConnectFrame || !upstreamReady || upstreamWs?.readyState !== WebSocket.OPEN) {
        return;
      }
      const frame = pendingConnectFrame;
      pendingConnectFrame = null;
      forwardConnectFrame(frame);
    };

    const startUpstream = async () => {
      try {
        const settings = await loadUpstreamSettings();
        upstreamUrl = typeof settings?.url === "string" ? settings.url.trim() : "";
        upstreamToken = typeof settings?.token === "string" ? settings.token.trim() : "";
        upstreamForceToken = settings?.forceToken === true;
        // The server's own in-process adapter: its address comes from this
        // process, not from settings a browser can change, so the allowlist
        // (which guards against pointing the proxy at arbitrary hosts) does
        // not apply to it.
        upstreamTrusted = settings?.trusted === true;
        upstreamAdapterType =
          typeof settings?.adapterType === "string" && settings.adapterType.trim()
            ? settings.adapterType.trim().toLowerCase()
            : "openclaw";
      } catch (err) {
        logError("Failed to load upstream gateway settings.", err);
        failSetup({
          code: "studio.settings_load_failed",
          message: "Не удалось загрузить настройки шлюза Studio.",
        });
        return;
      }

      if (!upstreamUrl) {
        failSetup({
          code: "studio.gateway_url_missing",
          message: "Адрес шлюза не настроен на хосте Studio.",
        });
        return;
      }

      if (!upstreamTrusted && !isUpstreamAllowed(upstreamUrl)) {
        failSetup({
          code: "studio.gateway_url_blocked",
          message: "Адреса шлюза нет в списке разрешённых хостов.",
        });
        return;
      }

      let upstreamOrigin = "";
      try {
        upstreamOrigin = resolveOriginForUpstream(upstreamUrl);
      } catch {
        failSetup({
          code: "studio.gateway_url_invalid",
          message: "Адрес шлюза на хосте Studio указан неверно.",
        });
        return;
      }

      upstreamWs = new WebSocket(upstreamUrl, {
        origin: upstreamOrigin,
        handshakeTimeout: upstreamHandshakeTimeoutMs,
      });

      upstreamHandshakeTimeoutId = setTimeout(() => {
        const timeoutError = {
          code: "studio.upstream_timeout",
          message: "Studio не дождалась подключения к шлюзу по WebSocket.",
        };
        try {
          upstreamWs?.terminate();
        } catch {}
        failSetup(timeoutError);
      }, upstreamHandshakeTimeoutMs);

      upstreamWs.on("pong", () => {
        upstreamAlive = true;
      });

      upstreamWs.on("open", () => {
        if (upstreamHandshakeTimeoutId !== null) {
          clearTimeout(upstreamHandshakeTimeoutId);
          upstreamHandshakeTimeoutId = null;
        }
        upstreamReady = true;
        maybeForwardPendingConnect();
      });

      upstreamWs.on("message", (upRaw) => {
        const upParsed = safeJsonParse(String(upRaw ?? ""));
        if (upParsed && isObject(upParsed) && upParsed.type === "res") {
          const resId = typeof upParsed.id === "string" ? upParsed.id : "";
          if (resId && connectRequestId && resId === connectRequestId) {
            connectResponseSent = true;
          }
        }
        if (browserWs.readyState === WebSocket.OPEN) {
          browserWs.send(String(upRaw ?? ""));
        }
      });

      upstreamWs.on("close", (code, reasonBuffer) => {
        if (upstreamHandshakeTimeoutId !== null) {
          clearTimeout(upstreamHandshakeTimeoutId);
          upstreamHandshakeTimeoutId = null;
        }
        const reason =
          typeof reasonBuffer === "string"
            ? reasonBuffer
            : Buffer.isBuffer(reasonBuffer)
              ? reasonBuffer.toString()
              : "";
        log(
          `[gateway-proxy] upstream closed code=${code} reason=${reason || "(none)"} hadConnect=${Boolean(connectRequestId)} responseSent=${connectResponseSent}`
        );
        if (!connectRequestId) {
          failSetup(
            pendingUpstreamSetupError ?? {
              code: "studio.upstream_closed",
              message: `Шлюз закрыл соединение (${code}): ${reason}`,
            }
          );
          return;
        }
        if (!connectResponseSent && connectRequestId) {
          connectResponseSent = true;
          sendToBrowser(
            buildErrorResponse(
              connectRequestId,
              code === 1008 ? "studio.upstream_rejected" : "studio.upstream_closed",
              code === 1008
                ? `Шлюз отклонил подключение (${code}): ${reason || "причина не указана"}`
                : `Шлюз закрыл соединение (${code}): ${reason}`
            )
          );
          return;
        }
        closeBoth(1012, "upstream closed");
      });

      upstreamWs.on("error", (err) => {
        if (upstreamHandshakeTimeoutId !== null) {
          clearTimeout(upstreamHandshakeTimeoutId);
          upstreamHandshakeTimeoutId = null;
        }
        logError("Upstream gateway WebSocket error.", err);
        if (!connectRequestId) {
          failSetup(
            pendingUpstreamSetupError ?? {
              code: "studio.upstream_error",
              message: "Не удалось подключиться к шлюзу по WebSocket.",
            }
          );
          return;
        }
        if (
          pendingUpstreamSetupError?.code === "studio.upstream_timeout" &&
          pendingUpstreamSetupError?.message
        ) {
          sendConnectError(pendingUpstreamSetupError.code, pendingUpstreamSetupError.message);
          return;
        }
        sendConnectError(
          "studio.upstream_error",
          "Не удалось подключиться к шлюзу по WebSocket."
        );
      });

      log("proxy connected");
    };

    browserWs.on("pong", () => {
      browserAlive = true;
    });

    const heartbeat = () => {
      if (closed) return;
      if (!browserAlive) {
        log("[gateway-proxy] browser missed a heartbeat; dropping the connection");
        try {
          browserWs.terminate();
        } catch {}
        closeBoth(1001, "browser heartbeat timeout");
        return;
      }
      if (upstreamReady && upstreamWs?.readyState === WebSocket.OPEN) {
        if (!upstreamAlive) {
          log("[gateway-proxy] upstream missed a heartbeat; dropping the connection");
          try {
            upstreamWs.terminate();
          } catch {}
          closeBoth(1012, "upstream heartbeat timeout");
          return;
        }
        upstreamAlive = false;
        try {
          upstreamWs.ping();
        } catch {}
      }
      browserAlive = false;
      try {
        browserWs.ping();
      } catch {}
      sendToBrowser({ type: "event", event: STUDIO_HEARTBEAT_EVENT, payload: { ts: Date.now() } });
    };
    if (heartbeatIntervalMs > 0) {
      heartbeatTimer = setInterval(heartbeat, heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    }

    void startUpstream();

    browserWs.on("message", async (raw) => {
      const rawStr = String(raw ?? "");
      const rawByteLength = Buffer.byteLength(rawStr, "utf8");

      // Frame size limit
      if (rawByteLength > MAX_FRAME_SIZE) {
        closeBoth(1009, "frame too large");
        return;
      }

      // Rate limiting
      if (!frameRateLimiter.check()) {
        log(
          "[gateway-proxy] proxy rate limit hit (>" +
            MAX_FRAMES_PER_SECOND +
            " frames/s sustained, burst " +
            MAX_FRAME_BURST +
            ")"
        );
        closeBoth(1008, "rate limit exceeded");
        return;
      }

      const parsed = safeJsonParse(rawStr);
      if (!parsed || !isObject(parsed)) {
        closeBoth(1003, "invalid json");
        return;
      }

      if (!connectRequestId) {
        if (parsed.type !== "req" || parsed.method !== "connect") {
          closeBoth(1008, "connect required");
          return;
        }
        const id = typeof parsed.id === "string" ? parsed.id : "";
        if (!id) {
          closeBoth(1008, "connect id required");
          return;
        }
        connectRequestId = id;
        const params = isObject(parsed.params) ? parsed.params : null;
        const client = params && isObject(params.client) ? params.client : null;
        log(
          `[gateway-proxy] connect frame client.id=${
            typeof client?.id === "string" ? client.id : "n/a"
          } client.mode=${
            typeof client?.mode === "string" ? client.mode : "n/a"
          } hasToken=${hasNonEmptyToken(params)} hasDevice=${hasCompleteDeviceAuth(params)}`
        );
        if (pendingUpstreamSetupError) {
          sendConnectError(pendingUpstreamSetupError.code, pendingUpstreamSetupError.message);
          return;
        }
        pendingConnectFrame = parsed;
        maybeForwardPendingConnect();
        return;
      }

      if (!upstreamReady || upstreamWs.readyState !== WebSocket.OPEN) {
        closeBoth(1013, "upstream not ready");
        return;
      }

      if (parsed.type === "req" && parsed.method === "connect" && !connectResponseSent) {
        pendingConnectFrame = null;
        forwardConnectFrame(parsed);
        return;
      }

      upstreamWs.send(JSON.stringify(parsed));
    });

    browserWs.on("close", () => {
      log("[gateway-proxy] browser disconnected");
      closeBoth(1000, "client closed");
    });

    browserWs.on("error", (err) => {
      logError("Browser WebSocket error.", err);
      closeBoth(1011, "client error");
    });
  });

  const handleUpgrade = (req, socket, head) => {
    if (!allowWs(req)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  };

  return { wss, handleUpgrade };
}

module.exports = { createGatewayProxy };
