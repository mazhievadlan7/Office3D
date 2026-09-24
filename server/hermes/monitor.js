// Watches the deployment and tells the person when something is wrong.
//
// Every minute each check runs (Hermes, its dashboard, the updater, backups,
// disk space). A check that fails twice in a row is a problem: an alert goes
// out (see alerts.js), again every REMIND_MS while it lasts, and a
// "recovered" note when it passes again. One-off events (an update rolled
// back, the daily budget spent) are sent once each. The office shows the
// same picture in its settings, and the dead man's switch is pinged every
// few minutes with whether everything is fine.

const TICK_MS = 60_000;
const CHECK_TIMEOUT_MS = 20_000;
const REMIND_MS = 12 * 60 * 60_000;
const HEARTBEAT_MS = 5 * 60_000;
const KEEP_EVENTS = 200;

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer in ${Math.round(ms / 1000)} s`)), ms).unref?.())]);

/**
 * @typedef {{ok: boolean, detail?: string}} CheckResult
 * @typedef {{id: string, label: string, run: () => Promise<CheckResult>, confirmAfter?: number}} Check
 * @typedef {{key: string, title: string, body: string, level?: "problem" | "info"}} MonitorEvent
 *
 * @param {object} deps
 * @param {Check[]} deps.checks
 * @param {() => Promise<MonitorEvent[]>} [deps.events]
 * @param {ReturnType<import("./alerts").createAlerter>} deps.alerter
 * @param {string[]} [deps.configProblems]
 * @param {any} deps.store
 * @param {(event: string, payload: object) => void} [deps.broadcast]
 * @param {() => number} [deps.now]
 * @param {(message: string) => void} [deps.log]
 */
const createMonitor = ({ checks, events = async () => [], alerter, configProblems = [], store, broadcast = () => {}, now = () => Date.now(), log = () => {} }) => {
  const states = new Map(checks.map((check) => [check.id, { ok: null, detail: "", since: null, failures: 0, alertedAt: null, checkedAt: null }]));
  let checkedAt = null;
  let lastHeartbeat = 0;
  let lastShape = "";

  const sentEvents = () => {
    const saved = store.getOrganization().monitor?.sentEvents;
    return Array.isArray(saved) ? saved : [];
  };

  const snapshot = () => {
    const rows = checks.map((check) => {
      const state = states.get(check.id);
      return {
        id: check.id,
        label: check.label,
        // Unknown until the first run; a single failure is not a problem yet.
        status: state.ok === null ? "unknown" : state.ok ? "ok" : state.alertedAt || state.failures >= (check.confirmAfter ?? 2) ? "problem" : "checking",
        detail: state.detail,
        since: state.since,
        checkedAt: state.checkedAt,
      };
    });
    return {
      checkedAt,
      // Only a confirmed problem counts, as for alerts: one failed round is
      // re-checked before anyone is told.
      ok: rows.every((row) => row.status !== "problem"),
      checks: rows,
      channels: alerter.channels(),
      heartbeat: alerter.hasHeartbeat,
      configProblems,
    };
  };

  const describe = (check, state) => `${check.label}: ${state.detail || "не отвечает"}`;

  const runCheck = async (check) => {
    const state = states.get(check.id);
    let result;
    try {
      result = await withTimeout(check.run(), CHECK_TIMEOUT_MS);
    } catch (err) {
      result = { ok: false, detail: err?.message ?? String(err) };
    }
    const at = new Date(now()).toISOString();
    state.checkedAt = at;
    state.detail = result.detail ?? "";
    if (result.ok) {
      if (state.alertedAt) {
        await alerter.send({ level: "recovered", title: `${check.label} — снова в порядке`, body: `${check.label}: ${state.detail || "работает"}.` });
        log(`Recovered: ${check.id}.`);
      }
      if (state.ok !== true) state.since = at;
      Object.assign(state, { ok: true, failures: 0, alertedAt: null });
      return;
    }
    if (state.ok !== false) state.since = at;
    state.ok = false;
    state.failures += 1;
    const confirmed = state.failures >= (check.confirmAfter ?? 2);
    const remind = state.alertedAt && now() - state.alertedAt >= REMIND_MS;
    if (confirmed && (!state.alertedAt || remind)) {
      await alerter.send({
        level: "problem",
        title: remind ? `Всё ещё: ${check.label}` : `Проблема: ${check.label}`,
        body: `${describe(check, state)}\nС ${state.since}.`,
      });
      state.alertedAt = now();
      log(`Problem: ${check.id} — ${state.detail}`);
    }
  };

  const runEvents = async () => {
    let list = [];
    try {
      list = await events();
    } catch (err) {
      log(`Monitor events failed: ${err.message}`);
      return;
    }
    const sent = sentEvents();
    const fresh = list.filter((event) => !sent.includes(event.key));
    if (!fresh.length) return;
    for (const event of fresh) {
      await alerter.send({ level: event.level ?? "problem", title: event.title, body: event.body });
    }
    await store.updateOrganization({
      monitor: { ...(store.getOrganization().monitor ?? {}), sentEvents: [...fresh.map((event) => event.key), ...sent].slice(0, KEEP_EVENTS) },
    });
  };

  let running = null;
  /** One round of every check and event. */
  const tick = () => {
    if (running) return running;
    running = (async () => {
      await Promise.all(checks.map((check) => runCheck(check)));
      await runEvents();
      checkedAt = new Date(now()).toISOString();
      const current = snapshot();
      const shape = JSON.stringify(current.checks.map((row) => [row.id, row.status]));
      if (shape !== lastShape) {
        lastShape = shape;
        broadcast("system.health", current);
      }
      if (now() - lastHeartbeat >= HEARTBEAT_MS) {
        lastHeartbeat = now();
        await alerter.heartbeat(current.ok);
      }
      return current;
    })().finally(() => {
      running = null;
    });
    return running;
  };

  let timer = null;
  const start = ({ firstAfterMs = 30_000 } = {}) => {
    const loop = async () => {
      await tick().catch((err) => log(`Monitor round failed: ${err.message}`));
      timer = setTimeout(() => void loop(), TICK_MS);
      timer.unref?.();
    };
    timer = setTimeout(() => void loop(), firstAfterMs);
    timer.unref?.();
  };
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const handlers = {
    async "system.health"(p) {
      return p?.refresh ? tick() : snapshot();
    },
    /** A test message on every channel, so the person sees alerts arrive. */
    async "system.testAlert"() {
      const result = await alerter.send({ level: "info", title: "Проверка оповещений", body: "Это тестовое оповещение Office3D: канал работает." });
      return { ...result, channels: alerter.channels() };
    },
  };

  return { tick, start, stop, snapshot, handlers };
};

module.exports = { createMonitor };
