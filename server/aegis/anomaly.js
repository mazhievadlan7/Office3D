// Auto-stop anomaly counter (TZ §4.2 «Auto-stop триггеры: цель вне scope, деструктив, rate-limit, аномалия»).
//
// The Scope Enforcement Engine must not only deny a bad action — it must notice
// a pattern of bad actions and pull the engagement offline on its own. This is
// a pure, injected-clock sliding-window counter, kept per engagement. preflight
// increments it on every anomaly signal:
//
//   • out_of_scope          — a target outside the authorized scope
//   • destructive_no_approval — a destructive action without human approval
//   • rate_limit            — the per-engagement rate limit was exceeded
//   • gate0                 — a Gate-0 canary was touched
//
// When the count within the window reaches the threshold, record() reports
// `tripped: true` and preflight auto-deactivates that engagement (engagements
// .autoStop) and audits `auto_stop`. The global kill-switch is a separate,
// heavier hammer and stays as-is.
//
// Disabled by default (threshold <= 0): record() is then a no-op that never
// trips, so the proven preflight behaviour is unchanged unless auto-stop is
// explicitly configured (on in prod/control-plane, on in the test net).

const ANOMALY_KINDS = new Set(["out_of_scope", "destructive_no_approval", "rate_limit", "gate0"]);

/**
 * @param {object} deps
 * @param {number} [deps.threshold]  anomalies within the window that trip auto-stop; <=0 disables
 * @param {number} [deps.windowMs]   sliding window length
 * @param {() => number} [deps.now]  injected clock
 */
const createAnomalyTracker = ({ threshold = 0, windowMs = 60_000, now = () => Date.now() } = {}) => {
  /** @type {Map<string, Array<{at: number, kind: string}>>} */
  const hits = new Map();
  const enabled = Number.isFinite(threshold) && threshold > 0;

  const prune = (list, t) => list.filter((h) => t - h.at < windowMs);

  return {
    enabled,
    threshold,
    windowMs,
    /**
     * Record one anomaly for an engagement and report whether it now trips.
     * @param {string} key   engagementId
     * @param {string} kind  one of ANOMALY_KINDS
     * @returns {{tripped: boolean, count: number, kind: string|null}}
     */
    record(key, kind) {
      if (!enabled || !key) return { tripped: false, count: 0, kind: kind ?? null };
      const safeKind = ANOMALY_KINDS.has(kind) ? kind : "out_of_scope";
      const t = now();
      const list = prune(hits.get(key) ?? [], t);
      list.push({ at: t, kind: safeKind });
      hits.set(key, list);
      return { tripped: list.length >= threshold, count: list.length, kind: safeKind };
    },
    /** Current anomaly count in the window (for reporting/tests). */
    count(key) {
      if (!enabled || !key) return 0;
      const list = prune(hits.get(key) ?? [], now());
      hits.set(key, list);
      return list.length;
    },
    /** Clear the counter for one engagement (e.g. after a clean reactivation) or all. */
    reset(key) {
      if (key) hits.delete(key);
      else hits.clear();
    },
  };
};

module.exports = { createAnomalyTracker, ANOMALY_KINDS };
