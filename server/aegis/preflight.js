// Pre-flight gate — the one check every active action must pass.
//
// The offensive execution plane (Phase 1) calls check() before it may run any
// tool against any target. The order is fixed and deny-by-default:
//
//   1. kill-switch (global or per-engagement) → deny
//   2. engagement must be active → deny
//   3. target must match the engagement's authorized scope → deny
//   4. rate limit not exceeded → deny (and optional auto-stop)
//   5. destructive actions may require human authorization → hold
//   6. otherwise → allow
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

/**
 * @param {object} deps
 * @param {ReturnType<import("./engagement").createEngagementManager>} deps.engagements
 * @param {ReturnType<import("./audit").createAuditLog>} deps.audit
 * @param {{allow: (key: string) => boolean}} [deps.rateLimiter]
 * @param {(action: string) => boolean} [deps.isDestructive]  classifier; destructive actions need human authorization
 * @param {boolean} [deps.requireApprovalForDestructive]
 */
const createPreflight = ({
  engagements,
  audit,
  rateLimiter = createRateLimiter(),
  isDestructive = () => false,
  requireApprovalForDestructive = true,
}) => {
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
      const gate = engagements.actionable(engagementId);
      if (!gate.ok) {
        reason = gate.reason;
      } else {
        const match = matchTarget(gate.engagement.assets, request.target);
        if (!match.allowed) {
          reason = match.reason;
        } else if (!rateLimiter.allow(`${engagementId}:${actor}`)) {
          reason = "превышен лимит частоты действий";
        } else if (isDestructive(action) && requireApprovalForDestructive && request.humanApproved !== true) {
          reason = "разрушительное действие требует подтверждения человека";
          decision = "hold";
        } else {
          decision = "allow";
          reason = match.reason;
          assetId = match.asset?.id ?? null;
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
