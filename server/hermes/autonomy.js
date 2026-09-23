// Autonomy: the organization keeps working toward its mission without the
// person asking — within a daily budget, and with a pause button.
//
// Two modes, both driven by the main agent (it is the one who hands out
// work; everyone else works the tasks on the board, which Hermes' dispatcher
// starts on its own):
//   - scheduled: every N minutes the main agent reviews the mission and the
//     board — triage, blocked tasks, next steps;
//   - continuous: the main agent is called in as soon as the board runs dry
//     or agents propose new tasks, with a cooldown that grows while nothing
//     changes, so an idle office does not burn money in a loop.
// Active hours can limit either mode to a daily window.
//
// Budget. Hermes prices every session. Its per-day report files a session's
// whole cost under the day it started, which would hide today's part of a
// long conversation, so the office measures spending as the growth of each
// agent's running total since local midnight (baselines kept in the store).
// Past the budget, autonomous reviews stop and — unless turned off — the board
// pauses: Hermes' dispatcher takes no new tasks (running ones finish). The
// person's own chats are never blocked. Only what Hermes can price counts;
// a subscription provider may report no cost at all.
//
// Pausing the board uses Hermes' `kanban.dispatch_profiles` claim list, read
// on every dispatcher tick: an empty list claims nothing. Office3D only
// touches it after the first pause; from then on it keeps the list equal to
// the current team while the board runs.

const DEFAULT_PROFILE = "default";
const MAIN_AGENT_ID = "main";
const MIN_INTERVAL = 15;
const MAX_INTERVAL = 24 * 60;
const CONTINUOUS_COOLDOWN_MS = 15 * 60_000;
const SPEND_CACHE_MS = 55_000;
const MAX_BUDGET_USD = 10_000;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const str = (value) => (typeof value === "string" ? value.trim() : "");
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

const validTimeZone = (tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** Local calendar day and minute-of-day of `date` in `timeZone`. */
const localClock = (date, timeZone) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
};

const toMinute = (hhmm) => {
  const match = HHMM.exec(hhmm ?? "");
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

/** Whether `minute` falls in [from, to); a window may wrap past midnight. */
const withinWindow = (minute, from, to) => {
  if (from === null || to === null || from === to) return true;
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
};

const defaultSettings = (timeZone) => ({
  mode: "off",
  intervalMinutes: 120,
  activeFrom: null,
  activeTo: null,
  dailyBudgetUsd: 5,
  pauseBoardOnBudget: true,
  paused: false,
  timeZone,
});

/**
 * Validates a settings patch against the current settings; throws
 * `invalid(message)` on the first problem.
 */
const mergeSettings = (current, patch, invalid) => {
  const next = { ...current };
  if (patch.mode !== undefined) {
    if (!["off", "scheduled", "continuous"].includes(patch.mode)) throw invalid("Неизвестный режим автономии.");
    next.mode = patch.mode;
  }
  if (patch.intervalMinutes !== undefined) {
    const value = Number(patch.intervalMinutes);
    if (!Number.isInteger(value) || value < MIN_INTERVAL || value > MAX_INTERVAL) {
      throw invalid(`Интервал — от ${MIN_INTERVAL} минут до суток.`);
    }
    next.intervalMinutes = value;
  }
  for (const key of ["activeFrom", "activeTo"]) {
    if (patch[key] === undefined) continue;
    if (patch[key] === null || patch[key] === "") next[key] = null;
    else if (HHMM.test(String(patch[key]))) next[key] = String(patch[key]);
    else throw invalid("Время — в формате ЧЧ:ММ.");
  }
  if (patch.dailyBudgetUsd !== undefined) {
    const value = Number(patch.dailyBudgetUsd);
    if (!Number.isFinite(value) || value < 0 || value > MAX_BUDGET_USD) throw invalid("Бюджет — от 0 до 10 000 $ (0 — без лимита).");
    next.dailyBudgetUsd = Math.round(value * 100) / 100;
  }
  if (patch.pauseBoardOnBudget !== undefined) next.pauseBoardOnBudget = Boolean(patch.pauseBoardOnBudget);
  if (patch.timeZone !== undefined) {
    if (!validTimeZone(String(patch.timeZone))) throw invalid("Неизвестный часовой пояс.");
    next.timeZone = String(patch.timeZone);
  }
  return next;
};

const describeBoard = (tasks) => {
  const count = (statuses) => tasks.filter((task) => statuses.includes(str(task.status))).length;
  const triage = tasks.filter((task) => str(task.status) === "triage");
  return {
    triage: triage.length,
    active: count(["todo", "ready", "running", "review", "scheduled"]),
    blocked: count(["blocked"]),
    triageKey: triage.map((task) => str(task.id)).sort().join(","),
    signature: tasks.map((task) => `${str(task.id)}:${str(task.status)}:${str(task.assignee)}`).sort().join("|"),
  };
};

const REVIEW_STEPS = [
  "1. Разбери задачи в «Разборе»: назначь исполнителей из команды, объедини дубликаты, лишнее отправь в архив.",
  "2. Посмотри заблокированные задачи: помоги снять блокировку или переназначь.",
  "3. Если активной работы мало — поставь на доску следующие шаги к миссии и назначь исполнителей.",
  "Нанимать и увольнять — только предложением руководителю. В конце одним-двумя предложениями напиши, что сделал.",
];

/**
 * @param {object} deps
 * @param {any} deps.client
 * @param {any} deps.store
 * @param {(opts?: {fresh?: boolean}) => Promise<Array<{name: string}>>} deps.listProfiles
 * @param {(profile: string) => number | null} deps.hiredAt           ms when Office3D hired the profile, if it did
 * @param {() => Promise<Array<object>>} deps.readBoard
 * @param {(params: {sessionKey: string, message: string, idempotencyKey: string}) => Promise<{runId: string}>} deps.startRun
 * @param {(sessionKey: string) => boolean} deps.isRunActive
 * @param {() => boolean} deps.hasDashboard
 * @param {new (code: string, message: string) => Error} deps.AdapterError
 * @param {(event: string, payload: object) => void} deps.broadcast
 * @param {string} [deps.defaultTimeZone]
 * @param {() => number} [deps.now]
 * @param {(message: string) => void} [deps.log]
 * @param {(message: string, error?: unknown) => void} [deps.logError]
 */
const createAutonomy = ({
  client,
  store,
  listProfiles,
  hiredAt,
  readBoard,
  startRun,
  isRunActive,
  hasDashboard,
  AdapterError,
  broadcast,
  defaultTimeZone = "UTC",
  now = () => Date.now(),
  log = () => {},
  logError = () => {},
}) => {
  const timeZoneFallback = validTimeZone(defaultTimeZone) ? defaultTimeZone : "UTC";
  const invalid = (message) => new AdapterError("INVALID_REQUEST", message);

  const saved = () => (isRecord(store.getOrganization().autonomy) ? store.getOrganization().autonomy : {});
  const settings = () => ({ ...defaultSettings(timeZoneFallback), ...(isRecord(saved().settings) ? saved().settings : {}) });
  const state = () => (isRecord(saved().state) ? saved().state : {});
  const save = (patch) => store.updateOrganization({ autonomy: { ...saved(), ...patch } });
  const saveState = (patch) => save({ state: { ...state(), ...patch } });

  // --- spending -------------------------------------------------------------------------

  let spendCache = null;

  /** Each profile's running total cost, as Hermes prices it. */
  const readTotals = async () => {
    const profiles = await listProfiles();
    const totals = {};
    await Promise.all(
      profiles.map(async ({ name }) => {
        const usage = await client.dashboard("/api/analytics/usage", { query: { days: 365, profile: name } });
        const t = isRecord(usage?.totals) ? usage.totals : {};
        // Real billing when the provider reports it, the estimate otherwise;
        // the larger of the two keeps the budget on the safe side.
        totals[name] = Math.max(num(t.total_actual_cost), num(t.total_estimated_cost));
      }),
    );
    return totals;
  };

  /** Today's spending (local day), refreshed at most once a minute. */
  const spending = async ({ fresh = false } = {}) => {
    if (!fresh && spendCache && now() - spendCache.at < SPEND_CACHE_MS) return spendCache.value;
    const { timeZone } = settings();
    const { day } = localClock(new Date(now()), timeZone);
    const totals = await readTotals();
    const current = state();
    const sameDay = isRecord(current.budget) && current.budget.day === day;
    const baselines = sameDay && isRecord(current.budget.baselines) ? { ...current.budget.baselines } : {};
    const dayStart = sameDay ? Number(current.budget.startedAt) || now() : now();
    let changed = !sameDay;
    for (const [profile, total] of Object.entries(totals)) {
      if (profile in baselines) continue;
      // A profile first seen today: one Office3D hired today starts from
      // zero; anything else starts from what it has already spent.
      const hired = hiredAt(profile);
      baselines[profile] = sameDay && hired !== null && hired >= dayStart ? 0 : total;
      changed = true;
    }
    let spent = 0;
    for (const [profile, total] of Object.entries(totals)) spent += Math.max(0, total - baselines[profile]);
    // A dismissed agent's spending stays spent.
    spent = Math.max(spent, sameDay ? num(current.budget.spent) : 0);
    spent = Math.round(spent * 10_000) / 10_000;
    if (changed || spent !== num(current.budget?.spent)) {
      await saveState({ budget: { day, startedAt: dayStart, baselines, spent } });
    }
    const value = { day, spentUsd: spent };
    spendCache = { at: now(), value };
    return value;
  };

  // --- the board gate -------------------------------------------------------------------

  let appliedGate = null;

  /**
   * Opens or closes Hermes' dispatcher. Closed: an empty claim list. Open:
   * the current team — written only once Office3D has closed it before.
   */
  const applyBoardGate = async (closed) => {
    if (!hasDashboard()) return;
    const managed = Boolean(state().boardGateManaged);
    if (!closed && !managed) return;
    const claim = closed ? [] : (await listProfiles()).map((profile) => profile.name).sort();
    const key = JSON.stringify(claim);
    if (appliedGate === key) return;
    await client.dashboard("/api/config", {
      method: "PUT",
      query: { profile: DEFAULT_PROFILE },
      body: { config: { kanban: { dispatch_profiles: claim } } },
    });
    appliedGate = key;
    if (!managed) await saveState({ boardGateManaged: true });
    log(closed ? "Board paused: the dispatcher takes no new tasks." : `Board running for ${claim.length} agent(s).`);
  };

  /**
   * The team changed: an open gate's claim list must name the new team right
   * away, or a new hire's first task would wait for the next tick.
   */
  const teamChanged = () => {
    if (appliedGate !== "[]") appliedGate = null;
    if (!state().boardGateManaged) return;
    status()
      .then((current) => applyBoardGate(current.boardPaused))
      .catch((err) => logError("Could not update the board gate for the new team.", err));
  };

  // --- status ---------------------------------------------------------------------------

  const status = async ({ fresh = false } = {}) => {
    const s = settings();
    const st = state();
    let spend = null;
    let spendError = null;
    if (hasDashboard()) {
      try {
        spend = await spending({ fresh });
      } catch (err) {
        spendError = err?.message ?? String(err);
      }
    }
    const exceeded = Boolean(spend && s.dailyBudgetUsd > 0 && spend.spentUsd >= s.dailyBudgetUsd);
    const { minute } = localClock(new Date(now()), s.timeZone);
    const inHours = withinWindow(minute, toMinute(s.activeFrom), toMinute(s.activeTo));
    return {
      settings: s,
      spentTodayUsd: spend?.spentUsd ?? null,
      spendError,
      budgetExceeded: exceeded,
      boardPaused: s.paused || (exceeded && s.pauseBoardOnBudget),
      withinActiveHours: inHours,
      lastReviewAt: st.lastReviewAt ?? null,
      lastReviewReason: st.lastReviewReason ?? null,
      lastReviewRunId: st.lastReviewRunId ?? null,
      nextReviewAt:
        s.mode === "scheduled" && st.lastReviewAt
          ? new Date(Date.parse(st.lastReviewAt) + s.intervalMinutes * 60_000).toISOString()
          : null,
      reviewRunning: isRunActive(sessionKeyFor()),
    };
  };

  const announce = async () => {
    try {
      broadcast("org.autonomy", await status());
    } catch (err) {
      logError("Could not report the autonomy status.", err);
    }
  };

  // --- reviews --------------------------------------------------------------------------

  // A fresh session each local day: Hermes attributes a session's cost to
  // the day it started, and a day's reviews belong together anyway.
  const sessionKeyFor = () => {
    const { day } = localClock(new Date(now()), settings().timeZone);
    return `agent:${MAIN_AGENT_ID}:autonomy-${day}`;
  };

  const review = async (reason, board) => {
    const sessionKey = sessionKeyFor();
    const summary = board
      ? `Сейчас на доске: в разборе — ${board.triage}, в работе и в очереди — ${board.active}, заблокировано — ${board.blocked}.`
      : "";
    const message = [`[Office3D · автономная работа] ${reason}`, summary, "", ...REVIEW_STEPS].filter((line, i) => line || i === 2).join("\n");
    const started = await startRun({ sessionKey, message, idempotencyKey: `autonomy-${now()}` });
    await saveState({
      lastReviewAt: new Date(now()).toISOString(),
      lastReviewReason: reason,
      lastReviewRunId: started?.runId ?? null,
      lastBoardSignature: board?.signature ?? null,
      lastTriageKey: board?.triageKey ?? null,
    });
    log(`Autonomy review started: ${reason}`);
    return started;
  };

  /**
   * What the continuous mode would call the main agent in for, if anything,
   * and the idle streak to remember with that review: how many reviews in a
   * row left the board exactly as they found it.
   */
  const continuousReason = (board, st) => {
    const since = st.lastReviewAt ? now() - Date.parse(st.lastReviewAt) : Infinity;
    const fruitless = Boolean(st.lastBoardSignature !== undefined && board.signature === st.lastBoardSignature);
    const streak = fruitless ? Number(st.idleStreak ?? 0) + 1 : 0;
    if (board.triage > 0 && board.triageKey !== st.lastTriageKey && since >= 60_000) {
      return { reason: "Сотрудники предложили новые задачи.", streak: 0 };
    }
    if (board.active > 0) return null;
    // Idle board. Back off while reviews change nothing: 15 min, 30, 60… up
    // to the scheduled interval.
    const cooldown = Math.min(CONTINUOUS_COOLDOWN_MS * 2 ** streak, settings().intervalMinutes * 60_000);
    return since >= cooldown ? { reason: "На доске нет активной работы — выбери следующие шаги к миссии.", streak } : null;
  };

  let ticking = false;

  /** One pass: budget, board gate, and a review if one is due. */
  const tick = async () => {
    if (ticking || !hasDashboard()) return;
    ticking = true;
    try {
      const s = settings();
      const current = await status({ fresh: true });
      await applyBoardGate(current.boardPaused);
      const st = state();
      const wasExceeded = Boolean(st.budgetExceededDay && st.budgetExceededDay === st.budget?.day);
      if (current.budgetExceeded && !wasExceeded) {
        await saveState({ budgetExceededDay: st.budget?.day ?? null });
        log(`Daily budget of $${s.dailyBudgetUsd} reached ($${current.spentTodayUsd}).`);
        broadcast("org.autonomy", current);
      }
      if (s.mode === "off" || s.paused || current.budgetExceeded || !current.withinActiveHours || current.reviewRunning) return;
      // With a budget set but spending unknown (Hermes' report failed), no
      // autonomous work starts: the budget cannot be checked.
      if (s.dailyBudgetUsd > 0 && current.spentTodayUsd === null) return;
      const board = describeBoard(await readBoard());
      if (s.mode === "scheduled") {
        const since = st.lastReviewAt ? now() - Date.parse(st.lastReviewAt) : Infinity;
        if (since >= s.intervalMinutes * 60_000) await review("Плановый обзор миссии и доски.", board);
      } else {
        const due = continuousReason(board, st);
        if (due) {
          await saveState({ idleStreak: due.streak });
          await review(due.reason, board);
        }
      }
      await announce();
    } finally {
      ticking = false;
    }
  };

  // --- office methods -------------------------------------------------------------------

  const requireDashboard = () => {
    if (!hasDashboard()) throw new AdapterError("UNAVAILABLE", "Автономия доступна при подключённой панели Hermes.");
  };

  const handlers = {
    async "org.autonomy.get"() {
      return status();
    },

    async "org.autonomy.set"(p) {
      requireDashboard();
      const patch = isRecord(p.settings) ? p.settings : {};
      const next = mergeSettings(settings(), patch, invalid);
      delete next.paused; // pausing has its own method
      await save({ settings: { ...settings(), ...next } });
      spendCache = null;
      const result = await status({ fresh: true });
      await applyBoardGate(result.boardPaused).catch((err) => logError("Could not update the board gate.", err));
      broadcast("org.autonomy", result);
      return result;
    },

    async "org.autonomy.pause"(p) {
      requireDashboard();
      if (typeof p.paused !== "boolean") throw invalid("Нужно указать: пауза или продолжить.");
      await save({ settings: { ...settings(), paused: p.paused } });
      const result = await status();
      await applyBoardGate(result.boardPaused);
      broadcast("org.autonomy", result);
      log(p.paused ? "Autonomy paused by the person." : "Autonomy resumed by the person.");
      return result;
    },

    async "org.autonomy.runNow"() {
      requireDashboard();
      const current = await status();
      if (current.reviewRunning) throw new AdapterError("CONFLICT", "Главный агент уже проводит обзор.");
      const board = describeBoard(await readBoard());
      const started = await review("Обзор по просьбе руководителя.", board);
      const result = await status();
      broadcast("org.autonomy", result);
      return { ...result, runId: started?.runId ?? null };
    },
  };

  return { handlers, tick, status, applyBoardGate, teamChanged, spending };
};

module.exports = { createAutonomy, localClock, withinWindow, mergeSettings, describeBoard };
