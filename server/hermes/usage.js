// Spending and token usage for the office's analytics panel, from Hermes' own
// accounting. Hermes records tokens and cost on every session of every
// profile; the office reads them through the dashboard and reshapes them into
// what the panel expects (`usage.cost` by day, `sessions.usage` by session).
//
// Hermes counts by UTC day, as the panel does. It knows input, output and
// cache-read tokens and a session's cost (the provider's actual cost when it
// reported one, otherwise Hermes' estimate); it does not split cost by token
// kind or count cache writes, so those stay zero.

const DAY_MS = 24 * 60 * 60_000;
const MAX_DAYS = 365;
const PAGE = 100;
const MAX_SESSIONS_PER_PROFILE = 2_000;
const MAX_SESSIONS = 1_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const str = (value) => (typeof value === "string" ? value.trim() : "");
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Cost as Hermes knows it: the provider's own figure when there is one. */
const costOf = (actual, estimated) => (num(actual) > 0 ? num(actual) : num(estimated));

const totalsFrom = ({ input = 0, output = 0, cacheRead = 0, cost = 0, durationMs = 0 }) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  totalTokens: input + output + cacheRead,
  totalCost: cost,
  inputCost: 0,
  outputCost: 0,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  durationMs,
});

const addTotals = (left, right) => Object.fromEntries(Object.keys(left).map((key) => [key, left[key] + right[key]]));

/**
 * The period asked for, as UTC days. Defaults to the last 30 days; never more
 * than a year, never ending in the future.
 */
const periodOf = (p, now) => {
  const today = utcDay(now);
  const end = DATE_RE.test(str(p?.endDate)) && str(p.endDate) < today ? str(p.endDate) : today;
  const fallbackStart = utcDay(Date.parse(`${end}T00:00:00Z`) - 29 * DAY_MS);
  let start = DATE_RE.test(str(p?.startDate)) ? str(p.startDate) : fallbackStart;
  if (start > end) start = end;
  const earliest = utcDay(Date.parse(`${today}T00:00:00Z`) - (MAX_DAYS - 1) * DAY_MS);
  if (start < earliest) start = earliest;
  // Hermes' analytics looks back whole days from now.
  const days = Math.min(MAX_DAYS, Math.max(1, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1));
  return {
    start,
    end,
    days,
    startMs: Date.parse(`${start}T00:00:00Z`),
    endMs: Date.parse(`${end}T00:00:00Z`) + DAY_MS,
  };
};

/**
 * @param {object} deps
 * @param {any} deps.client
 * @param {any} deps.store
 * @param {() => Promise<Array<{name: string}>>} deps.listProfiles
 * @param {(profile: string) => string} deps.agentIdOf
 * @param {() => boolean} deps.hasDashboard
 * @param {new (code: string, message: string) => Error} deps.AdapterError
 * @param {() => number} [deps.now]
 * @param {(message: string) => void} [deps.log]
 */
const createUsageHandlers = ({ client, store, listProfiles, agentIdOf, hasDashboard, AdapterError, now = () => Date.now(), log = () => {} }) => {
  const requireDashboard = () => {
    if (!hasDashboard()) throw new AdapterError("UNAVAILABLE", "Расходы видны при подключённой панели Hermes.");
  };

  /** Runs `read` for each profile; a profile that fails is left out and logged. */
  const perProfile = async (read) => {
    const profiles = await listProfiles();
    const results = await Promise.all(
      profiles.map(async (profile) => {
        try {
          return { profile: profile.name, value: await read(profile.name) };
        } catch (err) {
          log(`Usage for profile ${profile.name} is unavailable: ${err.message}`);
          return { profile: profile.name, value: null, failed: true };
        }
      })
    );
    if (results.length > 0 && results.every((entry) => entry.failed)) {
      throw new AdapterError("UNAVAILABLE", "Hermes не отдал данные о расходах.");
    }
    return results.filter((entry) => !entry.failed);
  };

  /** The office's session key for a Hermes session it created, if any. */
  const officeKeys = () => {
    const byHermesId = new Map();
    for (const [key, record] of store.listSessions?.() ?? []) {
      if (record?.createdId) byHermesId.set(record.createdId, key);
    }
    return byHermesId;
  };

  const readSessions = async (profile, period) => {
    const rows = [];
    let offset = 0;
    for (; offset < MAX_SESSIONS_PER_PROFILE; offset += PAGE) {
      const page = await client.dashboard("/api/sessions", {
        query: { profile, limit: PAGE, offset, order: "created", archived: "include" },
      });
      const sessions = Array.isArray(page?.sessions) ? page.sessions.filter(isRecord) : [];
      let older = false;
      for (const row of sessions) {
        const startedMs = num(row.started_at) * 1000;
        if (startedMs < period.startMs) {
          older = true;
          continue;
        }
        if (startedMs < period.endMs) rows.push(row);
      }
      // Newest first: once a page reaches before the period, the rest is older.
      if (older || sessions.length < PAGE) return { rows, capped: false };
    }
    return { rows, capped: true };
  };

  const handlers = {
    /** Tokens and cost per day, across the whole team. */
    async "usage.cost"(p) {
      requireDashboard();
      const period = periodOf(p, now());
      const results = await perProfile((profile) => client.dashboard("/api/analytics/usage", { query: { days: period.days, profile } }));
      const byDay = new Map();
      for (const { value } of results) {
        for (const row of Array.isArray(value?.daily) ? value.daily.filter(isRecord) : []) {
          const date = str(row.day);
          if (!DATE_RE.test(date) || date < period.start || date > period.end) continue;
          const totals = totalsFrom({
            input: num(row.input_tokens),
            output: num(row.output_tokens),
            cacheRead: num(row.cache_read_tokens),
            cost: costOf(row.actual_cost, row.estimated_cost),
          });
          byDay.set(date, byDay.has(date) ? addTotals(byDay.get(date), totals) : totals);
        }
      }
      const daily = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, totals]) => ({ date, ...totals }));
      let totals = totalsFrom({});
      for (const { date: _date, ...row } of daily) totals = addTotals(totals, row);
      return { updatedAt: now(), days: period.days, daily, totals };
    },

    /** Each session of the period with its tokens and cost, newest first. */
    async "sessions.usage"(p) {
      requireDashboard();
      const period = periodOf(p, now());
      const limit = Math.min(Math.max(Number(p?.limit) || MAX_SESSIONS, 1), MAX_SESSIONS);
      const keys = officeKeys();
      const results = await perProfile((profile) => readSessions(profile, period));
      const sessions = [];
      let capped = false;
      for (const { profile, value } of results) {
        const agentId = agentIdOf(profile);
        if (value.capped) capped = true;
        for (const row of value.rows) {
          const id = str(row.id);
          if (!id) continue;
          const startedMs = num(row.started_at) * 1000;
          const lastMs = num(row.last_active || row.last_activity_at || row.ended_at || row.started_at) * 1000;
          const endedMs = num(row.ended_at) * 1000 || lastMs;
          const provider = str(row.billing_provider) || null;
          const model = str(row.model) || null;
          const totals = totalsFrom({
            input: num(row.input_tokens),
            output: num(row.output_tokens),
            cacheRead: num(row.cache_read_tokens),
            cost: costOf(row.actual_cost_usd, row.estimated_cost_usd),
            durationMs: Math.max(0, endedMs - startedMs),
          });
          const date = utcDay(startedMs);
          sessions.push({
            key: keys.get(id) ?? `hermes:${profile}:${id}`,
            sessionId: id,
            label: str(row.title) || str(row.preview).slice(0, 80) || null,
            agentId,
            channel: str(row.source) || null,
            model,
            modelProvider: provider,
            updatedAt: lastMs || null,
            usage: {
              ...totals,
              messageCounts: {
                total: num(row.message_count),
                user: 0,
                assistant: 0,
                toolCalls: num(row.tool_call_count),
                toolResults: 0,
                errors: 0,
              },
              modelUsage: model || provider ? [{ provider, model, count: 1, totals }] : [],
              dailyBreakdown: [{ date, tokens: totals.totalTokens, cost: totals.totalCost }],
              dailyMessageCounts: [{ date, total: num(row.message_count), toolCalls: num(row.tool_call_count), errors: 0 }],
            },
          });
        }
      }
      sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      const kept = sessions.slice(0, limit);
      // Totals cover the whole period, not only the sessions listed.
      let totals = totalsFrom({});
      for (const session of sessions) {
        const { messageCounts: _m, modelUsage: _mu, dailyBreakdown: _d, dailyMessageCounts: _dm, ...row } = session.usage;
        totals = addTotals(totals, row);
      }
      return {
        updatedAt: now(),
        startDate: period.start,
        endDate: period.end,
        sessions: kept,
        totals,
        truncated: capped || sessions.length > kept.length,
      };
    },
  };

  return handlers;
};

module.exports = { createUsageHandlers, periodOf };
