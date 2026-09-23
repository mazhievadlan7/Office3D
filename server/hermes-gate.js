// hermes-gate: the one door into the Hermes dashboard backend.
//
// The Hermes dashboard (`hermes dashboard`, :9119) serves profile management,
// per-profile .env and the kanban board. On a non-loopback bind it insists on
// an interactive login (password or OAuth, cookie-based), which a server-side
// client cannot use; on loopback it accepts the machine session token — but
// then only processes in its own network namespace can reach it. And its
// plugin routes (the kanban board) check no credentials at all, by design.
//
// So the dashboard stays on 127.0.0.1 and this gate runs in the same network
// namespace (compose: network_mode "service:hermes"). It listens on the
// internal network and forwards a request only when it carries the session
// token, for every route, plugin routes included. Nothing is cached, nothing
// is rewritten except the Host header the dashboard checks.
//
// Environment:
//   HERMES_DASHBOARD_TOKEN   session token (required, ≥16 chars); the same
//                            value Hermes gets as HERMES_DASHBOARD_SESSION_TOKEN
//   HERMES_GATE_PORT         listen port (default 9120)
//   HERMES_GATE_HOST         listen host (default 0.0.0.0)
//   HERMES_DASHBOARD_TARGET  upstream (default http://127.0.0.1:9119)

const crypto = require("node:crypto");
const http = require("node:http");
const net = require("node:net");

const HEADER = "x-hermes-session-token";

const timingSafeEqualString = (a, b) => {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

const presentedToken = (req) => {
  const header = req.headers[HEADER];
  if (typeof header === "string" && header) return header;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  // WebSocket upgrades cannot set headers from a browser; the dashboard's own
  // WS routes take ?token= for the same reason.
  try {
    return new URL(req.url, "http://gate").searchParams.get("token") ?? "";
  } catch {
    return "";
  }
};

const createHermesGate = ({ token, target = "http://127.0.0.1:9119", log = console.info, logError = console.error }) => {
  if (String(token || "").length < 16) throw new Error("HERMES_DASHBOARD_TOKEN must be at least 16 characters.");
  const upstream = new URL(target);
  const upstreamHost = upstream.host;

  const allowed = (req) => timingSafeEqualString(presentedToken(req), token);

  const server = http.createServer((req, res) => {
    if (req.url === "/gate/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"ok"}');
      return;
    }
    if (!allowed(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end('{"detail":"Unauthorized"}');
      return;
    }
    const proxyReq = http.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: upstreamHost, [HEADER]: token },
        timeout: 120_000,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );
    proxyReq.on("timeout", () => proxyReq.destroy(new Error("upstream timeout")));
    proxyReq.on("error", (err) => {
      logError(`[hermes-gate] ${req.method} ${req.url?.split("?")[0]} failed: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end('{"detail":"Hermes dashboard is unavailable"}');
      } else {
        res.destroy();
      }
    });
    req.pipe(proxyReq);
  });

  server.on("upgrade", (req, socket, head) => {
    if (!allowed(req)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstreamSocket = net.connect(Number(upstream.port) || 80, upstream.hostname, () => {
      const headers = { ...req.headers, host: upstreamHost };
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (const [key, value] of Object.entries(headers)) {
        for (const v of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${v}`);
      }
      upstreamSocket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    const close = () => {
      upstreamSocket.destroy();
      socket.destroy();
    };
    upstreamSocket.on("error", close);
    socket.on("error", close);
  });

  return {
    server,
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          log(`[hermes-gate] Forwarding authenticated requests on ${host}:${port} to ${target}.`);
          resolve();
        });
      }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

if (require.main === module) {
  const gate = createHermesGate({
    token: process.env.HERMES_DASHBOARD_TOKEN,
    target: process.env.HERMES_DASHBOARD_TARGET || "http://127.0.0.1:9119",
  });
  const port = Number(process.env.HERMES_GATE_PORT || 9120);
  const host = process.env.HERMES_GATE_HOST || "0.0.0.0";
  gate.listen(port, host).catch((err) => {
    console.error(`[hermes-gate] Cannot listen on ${host}:${port}: ${err.message}`);
    process.exit(1);
  });
  const shutdown = () => gate.close().then(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

module.exports = { createHermesGate };
