// Boots the in-process Hermes adapter.
//
// The adapter listens on loopback, on a port the OS picks, and admits only a
// connect frame carrying a secret generated at boot. The gateway proxy is the
// one client that knows the secret, so nothing else on the machine — agents
// running terminal commands included — can drive the office's Hermes session.

const crypto = require("node:crypto");
const path = require("node:path");
const { WebSocketServer } = require("ws");
const { createHermesAdapter } = require("./adapter");
const { createHermesClient, resolveHermesConfig } = require("./client");
const { createHermesStore } = require("./store");

const timingSafeEqualString = (a, b) => {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

/**
 * @param {object} options
 * @param {Record<string, string | undefined>} [options.env]
 * @param {string} options.stateDir  where Office3D keeps its own state
 * @param {(message: string) => void} [options.log]
 * @param {(message: string, error?: unknown) => void} [options.logError]
 * @param {(agentId: string) => Promise<string> | string} [options.buildInstructions]
 * @param {(info: object) => void} [options.onRunFinished]
 * @returns {Promise<null | { url: string, token: string, client: any, adapter: any, store: any, close: () => Promise<void> }>}
 *   null when Hermes is not configured (HERMES_API_URL unset).
 */
const startHermesRuntime = async ({ env = process.env, stateDir, log = console.info, logError = console.error, buildInstructions, onRunFinished }) => {
  const config = resolveHermesConfig(env);
  if (!config) return null;
  if (config.problems.length > 0) {
    throw new Error(`Hermes is misconfigured:\n  - ${config.problems.join("\n  - ")}`);
  }
  const client = createHermesClient(config, {
    logWarn: (message, meta) => log(`[hermes] ${message} ${meta ? JSON.stringify(meta) : ""}`.trim()),
  });
  const store = createHermesStore({
    filePath: path.join(stateDir, "office3d", "hermes-adapter.json"),
    logError: (message, err) => logError(`[hermes] ${message}`, err),
  });
  const adapter = createHermesAdapter({
    client,
    store,
    buildInstructions,
    onRunFinished,
    log: (message) => log(`[hermes] ${message}`),
    logError: (message, err) => logError(`[hermes] ${message}`, err),
  });

  const token = crypto.randomBytes(32).toString("hex");
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 4 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  wss.on("connection", (ws) => {
    adapter.handleSocket(ws, {
      authorize: (params) => timingSafeEqualString(params?.auth?.token, token),
    });
  });
  const { port } = wss.address();

  // Hermes may start after Office3D (compose starts both together), so an
  // unreachable Hermes here is logged, not fatal; the office reports it when
  // someone connects.
  client
    .health("default", { retry: false, timeoutMs: 5_000 })
    .then((health) => {
      const version = health?.version ? ` ${health.version}` : "";
      log(`[hermes] Connected to Hermes${version} at ${config.apiUrl}.`);
    })
    .catch((err) => log(`[hermes] Hermes is not reachable yet (${err.code || err.message}); will retry on demand.`));

  return {
    url: `ws://127.0.0.1:${port}`,
    token,
    client,
    adapter,
    store,
    close: async () => {
      adapter.close();
      await new Promise((resolve) => wss.close(() => resolve()));
      await store.flush();
    },
  };
};

module.exports = { startHermesRuntime };
