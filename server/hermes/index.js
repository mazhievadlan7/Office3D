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
const { createMcpHandler, startMcpServer, deriveMcpToken } = require("./mcp");
const { createAlerter, resolveAlertConfig } = require("./alerts");
const { createMonitor } = require("./monitor");

const DEFAULT_MCP_PORT = 3010;
// Retry a failed reconcile soon (Hermes still starting), then settle into a
// slow sweep that picks up profiles created outside the office.
const RECONCILE_RETRY_MS = [5_000, 15_000, 30_000, 60_000];
const RECONCILE_SWEEP_MS = 10 * 60_000;
const BOARD_GUARD_MS = 15_000;
const AUTONOMY_TICK_MS = 60_000;
const AUTONOMY_FIRST_TICK_MS = 10_000;
const UPDATE_FIRST_CHECK_MS = 60_000;
const UPDATE_CHECK_MS = 6 * 60 * 60_000;
const UPDATE_PROGRESS_MS = 5_000;

/** The update service, when configured (Docker installs; see server/updater). */
const resolveUpdaterConfig = (env) => {
  const url = String(env.OFFICE3D_UPDATER_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env.OFFICE3D_UPDATER_TOKEN ?? "").trim();
  if (!url) return null;
  if (!/^https?:\/\//.test(url)) throw new Error("OFFICE3D_UPDATER_URL must be an http(s) URL.");
  if (token.length < 32) throw new Error("OFFICE3D_UPDATER_TOKEN must be at least 32 characters when OFFICE3D_UPDATER_URL is set.");
  return { url, token };
};

/** Where Office3D's MCP server listens, and the URL Hermes reaches it at. */
const resolveMcpConfig = (env) => {
  const rawPort = String(env.OFFICE3D_MCP_PORT ?? "").trim();
  const port = rawPort ? Number(rawPort) : DEFAULT_MCP_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`OFFICE3D_MCP_PORT must be a port number, got "${rawPort}".`);
  }
  const host = String(env.OFFICE3D_MCP_HOST ?? "").trim() || "127.0.0.1";
  const publicUrl = String(env.OFFICE3D_MCP_URL ?? "").trim().replace(/\/+$/, "");
  if (publicUrl && !/^https?:\/\//.test(publicUrl)) throw new Error("OFFICE3D_MCP_URL must be an http(s) URL.");
  return { host, port, publicUrl };
};

const GIB = 1024 ** 3;
const DISK_MIN_FREE_BYTES = 2 * GIB;
const DISK_MIN_FREE_SHARE = 0.05;
const BACKUP_MAX_AGE_MS = 26 * 60 * 60_000;

const gib = (bytes) => `${(bytes / GIB).toFixed(1)} ГБ`;

/** The monitor's checks for this deployment. */
const buildChecks = ({ client, adapter, updater, hasDashboard }) => {
  const checks = [
    {
      id: "hermes",
      label: "Hermes",
      run: async () => {
        const health = await client.health("default", { retry: false, timeoutMs: 8_000 });
        return { ok: true, detail: health?.version ? `версия ${health.version}` : "отвечает" };
      },
    },
  ];
  if (hasDashboard) {
    checks.push({
      id: "dashboard",
      label: "Панель Hermes",
      run: async () => {
        const profiles = await adapter.listProfiles({ fresh: true });
        return { ok: true, detail: `агентов: ${profiles.length}` };
      },
    });
  }
  if (updater) {
    // One request feeds three checks.
    let cached = { at: 0, value: null };
    const backups = async () => {
      if (Date.now() - cached.at < 30_000 && cached.value) return cached.value;
      const response = await fetch(`${updater.url}/backups`, {
        headers: { Authorization: `Bearer ${updater.token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`сервис обновлений ответил ${response.status}`);
      cached = { at: Date.now(), value: await response.json() };
      return cached.value;
    };
    checks.push(
      {
        id: "updater",
        label: "Сервис обновлений и копий",
        run: async () => {
          await backups();
          return { ok: true, detail: "отвечает" };
        },
      },
      {
        id: "backups",
        label: "Резервные копии",
        run: async () => {
          const status = await backups();
          if (!status.schedule) return { ok: true, detail: "ежедневные копии выключены" };
          if (status.last?.status === "failed") return { ok: false, detail: `последняя копия не удалась: ${(status.last.errors ?? []).join("; ")}` };
          if (!status.lastSuccess) return { ok: true, detail: "первая копия ещё не сделана" };
          const age = Date.now() - Date.parse(status.lastSuccess.at);
          if (age > BACKUP_MAX_AGE_MS) return { ok: false, detail: `последняя удачная копия — ${status.lastSuccess.at}` };
          return { ok: true, detail: `последняя — ${status.lastSuccess.at}` };
        },
      },
      {
        id: "disk",
        label: "Место на диске",
        run: async () => {
          const disks = Object.values((await backups()).disk ?? {}).filter(Boolean);
          if (!disks.length) return { ok: true, detail: "неизвестно" };
          const tightest = disks.reduce((a, b) => (a.freeBytes / a.totalBytes <= b.freeBytes / b.totalBytes ? a : b));
          const low = tightest.freeBytes < DISK_MIN_FREE_BYTES || tightest.freeBytes / tightest.totalBytes < DISK_MIN_FREE_SHARE;
          return { ok: !low, detail: `свободно ${gib(tightest.freeBytes)} из ${gib(tightest.totalBytes)}` };
        },
      },
    );
  }
  return checks;
};

/** One-off happenings worth an alert, each with a stable key. */
const monitorEvents = async ({ adapter, hasDashboard }) => {
  const events = [];
  if (adapter.updates.available) {
    const view = await adapter.updates.refresh();
    const job = view?.job;
    if (job && ["rolled_back", "failed", "rollback_failed"].includes(job.status)) {
      const text = {
        rolled_back: `Обновление Hermes до ${job.to} не прошло проверку; вернулась версия ${job.from}, данные восстановлены.`,
        failed: `Обновление Hermes до ${job.to} не удалось: ${job.error ?? ""}. Работает версия ${job.from}.`,
        rollback_failed: `Обновление Hermes до ${job.to} не удалось, и откат тоже: ${job.error ?? ""}. Нужна ручная проверка сервера.`,
      }[job.status];
      events.push({ key: `update:${job.id}:${job.status}`, title: "Обновление Hermes", body: text, level: "problem" });
    }
  }
  if (hasDashboard) {
    const autonomy = await adapter.autonomy.status();
    if (autonomy.budgetExceeded) {
      events.push({
        key: `budget:${adapter.autonomy.today()}`,
        title: "Дневной бюджет исчерпан",
        body: `Сегодня потрачено $${Number(autonomy.spentTodayUsd ?? 0).toFixed(2)} из $${autonomy.settings.dailyBudgetUsd}. Автономные обзоры остановлены до полуночи${autonomy.boardPaused ? ", доска задач на паузе" : ""}.`,
        level: "info",
      });
    }
  }
  return events;
};

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
 * @param {number} [options.meetingGatherTimeoutMs]  how long a meeting waits for agents to reach the room
 * @param {number} [options.approvalReviewTimeoutMs] how long the main agent may take over a member's approval
 * @returns {Promise<null | { url: string, token: string, client: any, adapter: any, store: any, mcpUrl: string, close: () => Promise<void> }>}
 *   null when Hermes is not configured (HERMES_API_URL unset).
 */
const startHermesRuntime = async ({
  env = process.env,
  stateDir,
  log = console.info,
  logError = console.error,
  buildInstructions,
  onRunFinished,
  meetingGatherTimeoutMs,
  approvalReviewTimeoutMs,
}) => {
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
  // The MCP server only makes sense with the dashboard: without it there are
  // no profiles to give tools to, and no way to write their config.
  let mcp = null;
  let mcpUrl = "";
  const mcpConfig = config.dashboardUrl ? resolveMcpConfig(env) : null;

  const adapter = createHermesAdapter({
    client,
    store,
    buildInstructions,
    onRunFinished,
    meetingGatherTimeoutMs,
    approvalReviewTimeoutMs,
    updater: resolveUpdaterConfig(env),
    autonomyTimeZone: String(env.OFFICE3D_TIMEZONE ?? "").trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    mcpEndpoint: (profile) =>
      mcpUrl ? { url: `${mcpUrl}/mcp/${encodeURIComponent(profile)}`, token: deriveMcpToken(config.keySecret, profile) } : null,
    log: (message) => log(`[hermes] ${message}`),
    logError: (message, err) => logError(`[hermes] ${message}`, err),
  });

  if (mcpConfig) {
    const handler = createMcpHandler({
      secret: config.keySecret,
      profileExists: async (profile) => (await adapter.listProfiles()).some((p) => p.name === profile),
      toolsFor: (profile) => adapter.team.toolsFor(profile),
      version: process.env.npm_package_version || "0.0.0",
      log: (message) => log(`[hermes] ${message}`),
      logError: (message, err) => logError(`[hermes] ${message}`, err),
    });
    mcp = await startMcpServer({ host: mcpConfig.host, port: mcpConfig.port, handler });
    mcpUrl = mcpConfig.publicUrl || `http://127.0.0.1:${mcp.port}`;
    log(`[hermes] Office3D MCP server on ${mcpConfig.host}:${mcp.port}; agents reach it at ${mcpUrl}.`);
  }
  await adapter.team.recover();
  await adapter.meetings.recover();

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
  // unreachable Hermes here is logged, not fatal: the office reports it when
  // someone connects, and the reconcile below keeps retrying. Reconciling
  // brings every agent's organization block, tools and Office3D MCP access up
  // to date with this office; the slow sweep afterwards also covers profiles
  // created outside the office.
  let reconcileTimer = null;
  let closed = false;
  let failures = 0;
  let announced = false;
  const reconcile = async () => {
    reconcileTimer = null;
    if (closed) return;
    try {
      const health = await client.health("default", { retry: false, timeoutMs: 5_000 });
      if (!announced) {
        const version = health?.version ? ` ${health.version}` : "";
        log(`[hermes] Connected to Hermes${version} at ${config.apiUrl}.`);
        announced = true;
      }
      await adapter.organization.reconcile();
      failures = 0;
    } catch (err) {
      if (failures === 0) log(`[hermes] Hermes is not reachable yet (${err.code || err.message}); retrying.`);
      failures += 1;
    }
    if (closed) return;
    const delay = failures > 0 ? RECONCILE_RETRY_MS[Math.min(failures - 1, RECONCILE_RETRY_MS.length - 1)] : RECONCILE_SWEEP_MS;
    reconcileTimer = setTimeout(() => void reconcile(), delay);
    reconcileTimer.unref?.();
  };
  void reconcile();

  // Tasks other agents put on the board become proposals within seconds —
  // well before the Hermes dispatcher (a one-minute tick) would start them.
  let guardTimer = null;
  let guardFailing = false;
  const guardBoard = async () => {
    guardTimer = null;
    if (closed) return;
    try {
      const held = await adapter.guardBoard();
      if (held.length) log(`[hermes] Moved ${held.length} task(s) proposed by agents to triage.`);
      guardFailing = false;
    } catch (err) {
      if (!guardFailing) log(`[hermes] Board check failed (${err.code || err.message}); retrying.`);
      guardFailing = true;
    }
    if (closed) return;
    guardTimer = setTimeout(() => void guardBoard(), BOARD_GUARD_MS);
    guardTimer.unref?.();
  };
  if (config.dashboardUrl) void guardBoard();

  // Autonomy: budget, board gate and due reviews, once a minute.
  let autonomyTimer = null;
  let autonomyFailing = false;
  const autonomyTick = async () => {
    autonomyTimer = null;
    if (closed) return;
    try {
      await adapter.autonomy.tick();
      autonomyFailing = false;
    } catch (err) {
      if (!autonomyFailing) logError("[hermes] Autonomy check failed; retrying.", err);
      autonomyFailing = true;
    }
    if (closed) return;
    autonomyTimer = setTimeout(() => void autonomyTick(), AUTONOMY_TICK_MS);
    autonomyTimer.unref?.();
  };
  if (config.dashboardUrl) {
    autonomyTimer = setTimeout(() => void autonomyTick(), AUTONOMY_FIRST_TICK_MS);
    autonomyTimer.unref?.();
  }

  // Hermes updates: a check every few hours; every few seconds while an
  // update runs, so the office sees each step.
  let updateTimer = null;
  const updateCheck = async () => {
    updateTimer = null;
    if (closed) return;
    await adapter.updates.refresh();
    if (closed) return;
    updateTimer = setTimeout(() => void updateCheck(), adapter.updates.isRunning() ? UPDATE_PROGRESS_MS : UPDATE_CHECK_MS);
    updateTimer.unref?.();
  };
  if (adapter.updates.available) {
    updateTimer = setTimeout(() => void updateCheck(), UPDATE_FIRST_CHECK_MS);
    updateTimer.unref?.();
  }

  // Health of the whole deployment, and alerts when part of it fails.
  const alertConfig = resolveAlertConfig(env);
  for (const problem of alertConfig.problems) logError(`[hermes] Alerts: ${problem}`);
  const monitor = createMonitor({
    checks: buildChecks({ client, adapter, updater: resolveUpdaterConfig(env), hasDashboard: Boolean(config.dashboardUrl) }),
    events: () => monitorEvents({ adapter, hasDashboard: Boolean(config.dashboardUrl) }),
    alerter: createAlerter({ config: alertConfig, log: (message) => log(`[hermes] ${message}`) }),
    configProblems: alertConfig.problems,
    store,
    broadcast: (event, payload) => adapter.broadcast(event, payload),
    log: (message) => log(`[hermes] ${message}`),
  });
  Object.assign(adapter.handlers, monitor.handlers);
  monitor.start();

  return {
    url: `ws://127.0.0.1:${port}`,
    token,
    client,
    adapter,
    store,
    monitor,
    mcpUrl,
    close: async () => {
      closed = true;
      monitor.stop();
      if (reconcileTimer) clearTimeout(reconcileTimer);
      if (guardTimer) clearTimeout(guardTimer);
      if (autonomyTimer) clearTimeout(autonomyTimer);
      if (updateTimer) clearTimeout(updateTimer);
      adapter.updates.close();
      adapter.close();
      await mcp?.close();
      // Closing the server alone waits for every open socket to go away.
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(() => resolve()));
      await store.flush();
    },
  };
};

module.exports = { startHermesRuntime };
