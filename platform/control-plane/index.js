#!/usr/bin/env node
// Control-plane bin — start/stop the AEGIS Security Core HTTP service.
//
// Loopback-only, token-gated. Reads config from the environment:
//
//   PLATFORM_TOKEN        bearer token for /v1/* (required; a random one is
//                         generated and logged if unset, for local dev only)
//   PLATFORM_HOST         bind host (default 127.0.0.1 — do NOT change in prod)
//   PLATFORM_PORT         bind port (default 8787)
//   PLATFORM_DATA_DIR     AEGIS state + ledger dir (default platform/.data)
//   PLATFORM_GATE0        "on" to enable the Gate-0 canary tripwire (off default)
//   PLATFORM_GATE0_TARGETS  comma-separated canary hosts/URLs (when Gate-0 is on)
//   PLATFORM_AUTOSTOP_THRESHOLD  anomalies-in-window to auto-stop (0 = off)
//   PLATFORM_AUTOSTOP_WINDOW_MS  sliding window length (default 60000)

const path = require("node:path");
const crypto = require("node:crypto");

const { createAegisCore } = require("../core/index.js");
const { createOrchestrator } = require("../orchestrator/index.js");
const { createControlPlaneServer } = require("./server.js");

const log = (entry) => process.stdout.write(`${JSON.stringify({ svc: "aegis-control-plane", ...entry })}\n`);
const logError = (message, err) => process.stderr.write(`${JSON.stringify({ svc: "aegis-control-plane", level: "error", message, err: err ? String(err.stack || err) : undefined })}\n`);

const parseTargets = (raw) =>
  String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const buildConfig = (env) => {
  let token = env.PLATFORM_TOKEN;
  let ephemeralToken = false;
  if (!token) {
    token = crypto.randomBytes(24).toString("hex");
    ephemeralToken = true;
  }
  const gate0Enabled = String(env.PLATFORM_GATE0 || "").toLowerCase() === "on";
  const threshold = Number(env.PLATFORM_AUTOSTOP_THRESHOLD || 0);
  return {
    token,
    ephemeralToken,
    host: env.PLATFORM_HOST || "127.0.0.1",
    port: Number(env.PLATFORM_PORT || 8787),
    dataDir: env.PLATFORM_DATA_DIR || path.join(__dirname, "..", ".data"),
    gate0: {
      enabled: gate0Enabled,
      targets: parseTargets(env.PLATFORM_GATE0_TARGETS),
    },
    autoStop: {
      threshold: Number.isFinite(threshold) ? threshold : 0,
      windowMs: Number(env.PLATFORM_AUTOSTOP_WINDOW_MS || 60_000),
    },
  };
};

const start = (env = process.env) => {
  const config = buildConfig(env);
  const core = createAegisCore({
    dataDir: config.dataDir,
    logError,
    rateLimit: { max: 600, windowMs: 60_000 },
    gate0: config.gate0,
    autoStop: config.autoStop,
  });

  // Task-routing control plane (orchestrator), reusing the core's audit + preflight.
  // Reclone intents from the Карцер are logged here; the actual container restart
  // is a runtime concern handled elsewhere.
  const orchestrator = createOrchestrator({
    core,
    dataDir: config.dataDir,
    logError,
    onReclone: (intent) => log({ at: new Date().toISOString(), event: "reclone_intent", intent }),
  });

  const server = createControlPlaneServer({ core, orchestrator, token: config.token, log });

  return new Promise((resolve) => {
    server.listen(config.port, config.host, () => {
      if (config.ephemeralToken) {
        logError("PLATFORM_TOKEN не задан — сгенерирован временный токен (только для локальной разработки):", config.token);
      }
      log({
        at: new Date().toISOString(),
        event: "listening",
        host: config.host,
        port: config.port,
        dataDir: config.dataDir,
        gate0: config.gate0.enabled,
        autoStop: config.autoStop.threshold > 0,
      });
      resolve({ server, core, orchestrator, config });
    });
  });
};

const stop = async ({ server, core, orchestrator }) => {
  await new Promise((resolve) => server.close(resolve));
  if (orchestrator) await orchestrator.close();
  await core.close();
};

if (require.main === module) {
  start()
    .then((running) => {
      const shutdown = (signal) => {
        log({ at: new Date().toISOString(), event: "shutdown", signal });
        stop(running)
          .then(() => process.exit(0))
          .catch((err) => {
            logError("graceful shutdown failed", err);
            process.exit(1);
          });
      };
      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
    })
    .catch((err) => {
      logError("control-plane failed to start", err);
      process.exit(1);
    });
}

module.exports = { start, stop, buildConfig };
