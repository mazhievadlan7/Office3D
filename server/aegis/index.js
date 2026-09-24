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

/**
 * @param {object} options
 * @param {string} options.dataDir  where the store and ledger live
 * @param {() => number} [options.now]
 * @param {(message: string, err?: unknown) => void} [options.logError]
 * @param {object} [options.rateLimit]  { max, windowMs } for the per-engagement limiter
 * @param {(action: string) => boolean} [options.isDestructive]
 */
const createAegisCore = ({ dataDir, now = () => Date.now(), logError = () => {}, rateLimit, isDestructive } = {}) => {
  if (!dataDir) throw new Error("AEGIS core needs a dataDir.");

  const store = createAegisStore({ filePath: path.join(dataDir, "aegis-state.json"), logError });
  const audit = createAuditLog({ filePath: path.join(dataDir, "aegis-audit.jsonl"), now, logError });

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

  const preflight = createPreflight({
    engagements,
    audit,
    rateLimiter: createRateLimiter({ ...(rateLimit || {}), now }),
    isDestructive,
  });

  return {
    engagements,
    preflight,
    audit,
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
