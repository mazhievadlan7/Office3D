const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const next = require("next");
const { loadEnvConfig } = require("@next/env");

const { createAccessGate } = require("./access-gate");
const { allowHttpOrigin, createRequestGuard, createTrustedProxies } = require("./request-guard");
const { createSecurityLog, createSecuritySummaryEndpoint } = require("./security-log");
const { createGatewayProxy } = require("./gateway-proxy");
const { assertPublicHostAllowed, isOptionalListenFailure, resolveHosts } = require("./network-policy");
const { startHermesRuntime } = require("./hermes");
const { createMaintenanceService } = require("./maintenance");
const { loadUpstreamGatewaySettings, resolveStateDir } = require("./studio-settings");

const resolvePort = () => {
  const raw = process.env.PORT?.trim() || "3000";
  const port = Number(raw);
  if (!Number.isFinite(port) || port <= 0) return 3000;
  return port;
};

const resolvePathname = (url) => {
  const raw = typeof url === "string" ? url : "";
  const idx = raw.indexOf("?");
  return (idx === -1 ? raw : raw.slice(0, idx)) || "/";
};

const CERT_DIR = require("node:path").join(__dirname, "..", ".certs");
const CERT_PATH = require("node:path").join(CERT_DIR, "localhost.crt");
const KEY_PATH = require("node:path").join(CERT_DIR, "localhost.key");

const generateHttpsCert = async () => {
  const fs = require("node:fs");

  // Re-use a saved cert so the browser only needs to trust it once.
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
    return {
      key: fs.readFileSync(KEY_PATH, "utf8"),
      cert: fs.readFileSync(CERT_PATH, "utf8"),
    };
  }

  const selfsigned = require("selfsigned");
  const attrs = [{ name: "commonName", value: "localhost" }];
  const pems = await selfsigned.generate(attrs, {
    days: 825,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 7, ip: "127.0.0.1" },
        ],
      },
    ],
  });

  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(CERT_PATH, pems.cert);
  fs.writeFileSync(KEY_PATH, pems.private);

  console.info(`\nCert saved to ${CERT_DIR}`);
  console.info("To make browsers trust it (macOS), run:");
  console.info(`  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${CERT_PATH}"\n`);

  return { key: pems.private, cert: pems.cert };
};

async function main() {
  const dev = process.argv.includes("--dev");
  // Load .env now, the way Next.js does: Next reads it only when the app is
  // prepared, after the access gate and the network policy have already read
  // STUDIO_ACCESS_TOKEN and friends. Variables already set win over the file.
  loadEnvConfig(path.resolve(__dirname, ".."), dev);
  const useHttps = process.argv.includes("--https") || process.env.HTTPS === "true";
  const hostnames = Array.from(new Set(resolveHosts(process.env)));
  const hostname = hostnames[0] ?? "127.0.0.1";
  const port = resolvePort();
  for (const host of hostnames) {
    assertPublicHostAllowed({
      host,
      studioAccessToken: process.env.STUDIO_ACCESS_TOKEN,
    });
  }

  const app = next({
    dev,
    hostname,
    port,
    ...(dev ? { webpack: true } : null),
  });
  const handle = app.getRequestHandler();

  const trustedProxies = createTrustedProxies({
    hosts: String(process.env.TRUSTED_PROXY_HOSTS ?? "").split(","),
    log: (message) => console.warn(message),
  });
  // Unauthorized sign-in attempts and blocked requests, counted for the
  // owner's greeting (server/security-log.js): counts only, no addresses.
  const securityLog = createSecurityLog({
    file: path.join(resolveStateDir(process.env), "office3d", "security.json"),
    log: (message) => console.warn(message),
  });
  const accessGate = createAccessGate({
    token: process.env.STUDIO_ACCESS_TOKEN,
    login: process.env.STUDIO_LOGIN,
    ownerName: process.env.STUDIO_OWNER_NAME,
    isTrustedProxy: trustedProxies.isTrusted,
    securityLog,
  });
  const securitySummary = createSecuritySummaryEndpoint({
    securityLog,
    gateEnabled: accessGate.enabled,
    allowOrigin: allowHttpOrigin,
  });
  const requestGuard = createRequestGuard({
    allowedOrigins: String(process.env.OFFICE3D_ALLOWED_ORIGINS ?? "").split(","),
  });
  /** False when the request must not be served at all (see request-guard.js). */
  const addressedCorrectly = (req) => accessGate.enabled || requestGuard.addressedToLoopback(req);
  /**
   * Whether a WebSocket upgrade passes the request guard (address and
   * Origin); a refusal is a blocked request for the security log.
   */
  const upgradeGuarded = (req) => {
    if (addressedCorrectly(req) && requestGuard.allowWebSocketOrigin(req)) return true;
    securityLog.recordBlocked();
    return false;
  };

  // With HERMES_API_URL set, the Hermes backend is served by the adapter in
  // this process; the URL saved for Hermes in the office settings is then not
  // used. A misconfigured Hermes stops the server here rather than failing on
  // every connect later.
  const hermes = await startHermesRuntime({ env: process.env, stateDir: resolveStateDir(process.env) });
  if (hermes) console.info("Hermes backend: in-process adapter.");

  // Disk litter and memory report (server/maintenance). Started once the
  // server listens; its timers never keep the process alive.
  const maintenance = createMaintenanceService({
    env: process.env,
    dev,
    projectRoot: path.resolve(__dirname, ".."),
    stateDir: resolveStateDir(process.env),
    tmpDir: require("node:os").tmpdir(),
    log: (message) => console.info(message),
  });

  const proxy = createGatewayProxy({
    loadUpstreamSettings: async () => {
      const settings = loadUpstreamGatewaySettings(process.env);
      if (hermes && settings.adapterType === "hermes") {
        // The adapter admits only its own secret, so it replaces whatever the
        // browser sent rather than being offered alongside it.
        return { url: hermes.url, token: hermes.token, adapterType: "hermes", forceToken: true, trusted: true };
      }
      return { url: settings.url, token: settings.token, adapterType: settings.adapterType };
    },
    log: (message) => console.info(message),
    logError: (message, error) => console.error(message, error),
    allowWs: (req) => {
      if (resolvePathname(req.url) !== "/api/gateway/ws") return false;
      return true;
    },
    verifyClient: (info) => upgradeGuarded(info.req) && accessGate.allowUpgrade(info.req),
  });

  await app.prepare();
  // Next's own upgrade handler, the one it would attach to the server itself:
  // in development it carries hot reload and React's debug channel, which the
  // page waits on before it hydrates. app.getUpgradeHandler() goes to the
  // inner page server instead — it accepts the socket and then never writes to
  // it, so in development the office rendered on the server and then sat on
  // «Подключаемся…» with every button dead. Only one upgrade listener is ever
  // attached (see attachUpgradeHandlers), so this is where Next's has to go.
  const handleUpgrade =
    typeof app.upgradeHandler === "function" ? app.upgradeHandler : app.getUpgradeHandler();
  const handleServerUpgrade = (req, socket, head) => {
    if (resolvePathname(req.url) === "/api/gateway/ws") {
      proxy.handleUpgrade(req, socket, head);
      return;
    }
    // Next's own sockets (hot reload in development) need the same access.
    if (!upgradeGuarded(req) || !accessGate.allowUpgrade(req)) {
      socket.destroy();
      return;
    }
    handleUpgrade(req, socket, head);
  };

  const misdirected = (res) => {
    securityLog.recordBlocked();
    res.statusCode = 421;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Без STUDIO_ACCESS_TOKEN офис отвечает только по адресам localhost / 127.0.0.1.");
  };

  const httpsCert = useHttps ? await generateHttpsCert() : null;

  const createServer = () =>
    useHttps
      ? https.createServer(httpsCert, (req, res) => {
          if (!addressedCorrectly(req)) return misdirected(res);
          if (accessGate.handleHttp(req, res)) return;
          if (securitySummary.handleHttp(req, res)) return;
          if (maintenance.handleHttp(req, res)) return;
          if (hermes?.handleHttp(req, res)) return;
          handle(req, res);
        })
      : http.createServer((req, res) => {
          if (!addressedCorrectly(req)) return misdirected(res);
          if (accessGate.handleHttp(req, res)) return;
          if (securitySummary.handleHttp(req, res)) return;
          if (maintenance.handleHttp(req, res)) return;
          if (hermes?.handleHttp(req, res)) return;
          handle(req, res);
        });

  const servers = hostnames.map(() => createServer());

  const attachUpgradeHandlers = (server) => {
    server.on("upgrade", handleServerUpgrade);
    server.on("newListener", (eventName, listener) => {
      if (eventName !== "upgrade") return;
      if (listener === handleServerUpgrade) return;
      process.nextTick(() => {
        server.removeListener("upgrade", listener);
      });
    });
  };

  for (const server of servers) {
    attachUpgradeHandlers(server);
    server.on("close", () => {
      maintenance.stop();
      securityLog.close();
    });
  }

  const listenOnHost = (server, host) =>
    new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off("error", onError);
        reject(err);
      };
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        resolve();
      });
    });

  const closeServer = (server) =>
    new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    });

  const results = await Promise.allSettled(
    servers.map((server, index) => listenOnHost(server, hostnames[index]))
  );
  const fatal = results.find(
    (result, index) =>
      result.status === "rejected" &&
      !isOptionalListenFailure({ host: hostnames[index], error: result.reason })
  );
  if (fatal) {
    await Promise.all(servers.map((server) => closeServer(server)));
    throw fatal.reason;
  }
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.warn(
        `Not listening on ${hostnames[index]}: ${result.reason?.code ?? result.reason} (IPv6 is unavailable here). Studio is still reachable on the other loopback address.`
      );
    }
  });

  void maintenance.start();

  const hostForBrowser = hostnames.some((value) => value === "127.0.0.1" || value === "::1")
    ? "localhost"
    : hostname === "0.0.0.0" || hostname === "::"
      ? "localhost"
      : hostname;

  const protocol = useHttps ? "https" : "http";
  const browserUrl = `${protocol}://${hostForBrowser}:${port}`;
  console.info(`Open in browser: ${browserUrl}`);
  if (useHttps) {
    console.info("HTTPS mode: self-signed cert in use. You may need to accept a browser security warning once.");
    console.info(`Spotify redirect URI: ${browserUrl}/office`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
