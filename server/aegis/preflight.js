// Pre-flight gate — the one check every active action must pass.
//
// The offensive execution plane (Phase 1) calls check() before it may run any
// tool against any target. The order is fixed and deny-by-default:
//
//   0. Gate-0 canary (TZ §16.2-5) → deny + trip GLOBAL kill-switch + `gate0_tripped`
//   1. kill-switch (global or per-engagement) → deny
//   2. engagement must be active → deny
//   3. target must match the engagement's authorized scope → deny
//   4. rate limit not exceeded → deny (and auto-stop anomaly count)
//   5. destructive actions may require human authorization → hold
//   6. otherwise → allow
//
// Step 0 is the Gate-0 tripwire: it runs first so a bait target outside every
// scope fires even if other checks would also deny, and it can only ever make
// the gate MORE closed. Steps 1–6 keep the proven relative order unchanged.
//
// Alongside the decision, anomaly signals (out-of-scope, destructive-without-
// approval, rate-limit, Gate-0) feed a per-engagement sliding-window counter
// (TZ §4.2); crossing its threshold auto-deactivates that engagement
// (engagements.autoStop) and audits `auto_stop`. Both mechanisms are off by
// default and injected, so default behaviour is unchanged until configured.
//
// Every outcome — allow AND deny — is written to the audit ledger. check()
// never throws: any internal error becomes a DENY that is also recorded, so a
// bug can only ever fail closed, never open.

const { matchTarget, parseTarget } = require("./scope");

/** A compact, log-safe description of a target for the ledger. */
const describeTarget = (target) => {
  const parsed = parseTarget(target);
  if (!parsed) return { raw: typeof target === "string" ? target.slice(0, 200) : "(object)" };
  return { host: parsed.host, ip: parsed.ip ? `v${parsed.ip.version}` : null, port: parsed.port, path: parsed.path };
};

/**
 * A minimal fixed-window rate limiter, per engagement. Off by default (max: 0
 * means unlimited). Kept in memory — a soft guard against runaway loops, not a
 * security boundary (the scope gate is).
 */
const createRateLimiter = ({ max = 0, windowMs = 60_000, now = () => Date.now() } = {}) => {
  const windows = new Map();
  return {
    allow(key) {
      if (max <= 0) return true;
      const bucket = now() - (now() % windowMs);
      const state = windows.get(key);
      if (!state || state.bucket !== bucket) {
        windows.set(key, { bucket, count: 1 });
        return true;
      }
      state.count += 1;
      return state.count <= max;
    },
  };
};

/** A no-op Gate-0 and anomaly tracker, so preflight behaves exactly as before
 *  when neither is configured (both are off by default). */
const NO_GATE0 = { enabled: false, isCanary: () => false, onTrip: () => {} };
const NO_ANOMALY = { enabled: false, record: () => ({ tripped: false, count: 0, kind: null }) };

/**
 * @param {object} deps
 * @param {ReturnType<import("./engagement").createEngagementManager>} deps.engagements
 * @param {ReturnType<import("./audit").createAuditLog>} deps.audit
 * @param {{allow: (key: string) => boolean}} [deps.rateLimiter]
 * @param {(action: string) => boolean} [deps.isDestructive]  classifier; destructive actions need human authorization
 * @param {boolean} [deps.requireApprovalForDestructive]
 * @param {ReturnType<import("./gate0").createGate0>} [deps.gate0]  Gate-0 canary tripwire (off by default)
 * @param {ReturnType<import("./anomaly").createAnomalyTracker>} [deps.anomaly]  auto-stop counter (off by default)
 * @param {(message: string, err?: unknown) => void} [deps.logError]
 */
const createPreflight = ({
  engagements,
  audit,
  rateLimiter = createRateLimiter(),
  isDestructive = () => false,
  requireApprovalForDestructive = true,
  gate0 = NO_GATE0,
  anomaly = NO_ANOMALY,
  logError = () => {},
}) => {
  // Feed one anomaly signal into the auto-stop counter and, if it trips,
  // auto-deactivate the engagement. Fire-and-forget: the state change is queued
  // (its in-memory effect is synchronous, so later checks see it), and any
  // failure is logged, never thrown — check() must never throw.
  const recordAnomaly = (engagementId, kind) => {
    if (!engagementId || !anomaly.enabled) return;
    let result;
    try {
      result = anomaly.record(engagementId, kind);
    } catch (err) {
      logError("Auto-stop anomaly counter failed", err);
      return;
    }
    if (result?.tripped) {
      Promise.resolve(
        engagements.autoStop(engagementId, {
          reason: `авто-стоп: ${result.count} аномалий в окне (последняя: ${result.kind})`,
          trigger: result.kind,
          count: result.count,
        }),
      ).catch((err) => logError("Auto-stop deactivation failed", err));
    }
  };
  /**
   * @param {object} request
   * @param {string} request.engagementId
   * @param {string} request.actor       which agent is asking
   * @param {string} request.action      what it wants to do (tool/verb name)
   * @param {string|object} request.target
   * @param {boolean} [request.humanApproved]  set when the person has authorized this specific destructive action
   * @returns {{allowed: boolean, decision: string, reason: string, assetId: string|null}}
   */
  const check = (request) => {
    const engagementId = String(request?.engagementId ?? "");
    const actor = String(request?.actor ?? "unknown");
    const action = String(request?.action ?? "");
    let decision = "deny";
    let reason = "отказано по умолчанию";
    let assetId = null;

    try {
      // Step 0 — Gate-0 canary tripwire. A target matching the bait (outside
      // every scope) is an immediate hard DENY: trip the global kill-switch,
      // record a dedicated `gate0_tripped` event, count the anomaly, and skip
      // the rest. It runs first so it fires regardless of engagement state.
      if (gate0.isCanary(request.target)) {
        decision = "deny";
        reason = "цель совпала с Gate-0 канарейкой (вне любого scope) — глобальный kill-switch активирован";
        audit.append({
          type: "gate0_tripped",
          engagementId: engagementId || null,
          actor,
          target: describeTarget(request?.target),
          decision: "deny",
          reason,
          detail: { action },
        });
        try {
          gate0.onTrip({ engagementId: engagementId || null, actor, action });
        } catch (err) {
          logError("Gate-0 onTrip handler failed", err);
        }
        recordAnomaly(engagementId, "gate0");
      } else {
        const gate = engagements.actionable(engagementId);
        if (!gate.ok) {
          reason = gate.reason;
        } else {
          const match = matchTarget(gate.engagement.assets, request.target);
          if (!match.allowed) {
            reason = match.reason;
            recordAnomaly(engagementId, "out_of_scope");
          } else if (!rateLimiter.allow(`${engagementId}:${actor}`)) {
            reason = "превышен лимит частоты действий";
            recordAnomaly(engagementId, "rate_limit");
          } else if (isDestructive(action) && requireApprovalForDestructive && request.humanApproved !== true) {
            reason = "разрушительное действие требует подтверждения человека";
            decision = "hold";
            recordAnomaly(engagementId, "destructive_no_approval");
          } else {
            decision = "allow";
            reason = match.reason;
            assetId = match.asset?.id ?? null;
          }
        }
      }
    } catch (err) {
      // Fail closed and record why.
      decision = "deny";
      reason = `внутренняя ошибка pre-flight: ${err?.message ?? err}`;
    }

    audit.append({
      type: "preflight",
      engagementId: engagementId || null,
      actor,
      target: describeTarget(request?.target),
      decision,
      reason,
      detail: { action, assetId },
    });

    return { allowed: decision === "allow", decision, reason, assetId };
  };

  return { check };
};

module.exports = { createPreflight, createRateLimiter, describeTarget };
