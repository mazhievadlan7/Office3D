// AEGIS legal core — the assembled control plane (Phase 0).
//
// This wires the pieces into one object and hands the caller exactly two
// powers: manage engagements (with the customer's manual activation and the
// kill-switch), and ask preflight whether an action is allowed. Every
// engagement state change and every preflight decision is written to the
// hash-chained audit ledger.
//
// There is deliberately nothing here that acts on a target. The execution
// plane (Phase 1) is a separate subsystem that must call preflight.check()
// before it runs any tool — this core only ever answers yes/no and records it.

const path = require("node:path");

const { createAegisStore } = require("./store");
const { createAuditLog } = require("./audit");
const { createEngagementManager } = require("./engagement");
const { createPreflight, createRateLimiter } = require("./preflight");
const { compileAllowlist, renderNftables } = require("./egress");
const { createVerifier } = require("./verify");
const { createGate0 } = require("./gate0");
const { createAnomalyTracker } = require("./anomaly");

const TRUTHY = /^(1|true|on|yes)$/i;

/** Resolve the Gate-0 canary config from explicit options, falling back to the
 *  environment (PLATFORM_GATE0 / PLATFORM_GATE0_TARGETS). Off by default: with
 *  neither set the gate is disabled, which is the required prod default. The
 *  test net turns it on by passing options.gate0.enabled. */
const resolveGate0 = (option) => {
  const envTargets = String(process.env.PLATFORM_GATE0_TARGETS ?? "")
    .split(/[\s,]+/)
    .filter(Boolean);
  return {
    enabled: option?.enabled ?? TRUTHY.test(String(process.env.PLATFORM_GATE0 ?? "")),
    targets: option?.targets ?? envTargets,
  };
};

/**
 * @param {object} options
 * @param {string} options.dataDir  where the store and ledger live
 * @param {() => number} [options.now]
 * @param {(message: string, err?: unknown) => void} [options.logError]
 * @param {object} [options.rateLimit]  { max, windowMs } for the per-engagement limiter
 * @param {(action: string) => boolean} [options.isDestructive]
 * @param {{enabled?: boolean, targets?: Array<object|string>}} [options.gate0]  Gate-0 canary config (off by default; env PLATFORM_GATE0 / PLATFORM_GATE0_TARGETS)
 * @param {{threshold?: number, windowMs?: number}} [options.autoStop]  anomaly auto-stop config (off by default)
 * @param {string|Buffer|null} [options.auditKey]  sign the audit ledger (off by default; env AEGIS_AUDIT_KEY)
 */
const createAegisCore = ({ dataDir, now = () => Date.now(), logError = () => {}, rateLimit, isDestructive, gate0, autoStop, auditKey } = {}) => {
  if (!dataDir) throw new Error("AEGIS core needs a dataDir.");

  const store = createAegisStore({ filePath: path.join(dataDir, "aegis-state.json"), logError });
  const audit = createAuditLog({
    filePath: path.join(dataDir, "aegis-audit.jsonl"),
    now,
    logError,
    // Optional cryptographic signing on top of the hash-chain (§13.5). Absent
    // key = unchanged hash-chain behaviour.
    signingKey: auditKey ?? process.env.AEGIS_AUDIT_KEY ?? null,
  });

  const engagements = createEngagementManager({
    store,
    now,
    // Every lifecycle change is journaled, so the ledger is the full story of
    // who authorized what and when.
    onEvent: (event) =>
      audit.append({
        type: event.type,
        engagementId: event.engagementId,
        actor: event.detail?.by ?? null,
        decision: null,
        reason: null,
        detail: event.detail,
      }),
  });

  // Auto-stop anomaly counter (TZ §4.2) and Gate-0 canary (TZ §16.2-5). Both
  // are off unless configured, so the proven preflight behaviour is unchanged
  // by default. Gate-0's trip handler engages the GLOBAL kill-switch.
  const anomaly = createAnomalyTracker({ ...(autoStop || {}), now });
  const gate0Engine = createGate0({
    ...resolveGate0(gate0),
    logError,
    onTrip: ({ actor, action }) =>
      Promise.resolve(
        engagements.setGlobalKill({
          on: true,
          by: "gate0",
          reason: `Gate-0 канарейка задета (actor=${actor ?? "?"}, action=${action ?? "?"})`,
        }),
      ).catch((err) => logError("Gate-0 не смог включить kill-switch", err)),
  });

  const preflight = createPreflight({
    engagements,
    audit,
    rateLimiter: createRateLimiter({ ...(rateLimit || {}), now }),
    isDestructive,
    gate0: gate0Engine,
    anomaly,
    logError,
  });

  // The authorization gateway: proof-of-ownership checks before an engagement
  // may be authorized (DNS / file / WHOIS). It contacts only the operator's
  // own declared assets and holds no offensive capability.
  const verifier = createVerifier({ dataDir, now, logError });

  return {
    engagements,
    preflight,
    audit,
    verifier,
    gate0: gate0Engine,
    anomaly,
    /** Read-only snapshot of the always-on security posture, for the control plane. */
    securityStatus: () => ({
      killSwitch: engagements.getKillSwitch(),
      gate0: { enabled: gate0Engine.enabled, canaryCount: gate0Engine.canaries.length },
      autoStop: { enabled: anomaly.enabled, threshold: anomaly.threshold, windowMs: anomaly.windowMs },
    }),
    /** Compile the egress firewall allowlist for an active engagement. */
    egressAllowlist: (engagementId) => compileAllowlist(store.getEngagement(engagementId)),
    renderEgressNftables: (engagementId) => renderNftables(compileAllowlist(store.getEngagement(engagementId))),
    verifyAudit: () => audit.verify(),
    async close() {
      await store.flush();
      await audit.flush();
    },
  };
};

module.exports = { createAegisCore };
