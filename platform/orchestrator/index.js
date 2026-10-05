// Orchestrator — the task-routing control plane (§II.4), the backbone every floor
// uses. It assembles the pure pieces (work-item state machine, matrix router,
// board, Карцер hook, Capability Registry) and wires them to the AEGIS Security
// Core's two powers: the append-only audit ledger and the preflight scope gate.
//
// Three guarantees hold for every state change:
//   1. The matrix (§26) is enforced BEFORE the move: small requests go direct,
//      crups межуправленческие — только по санкции AM7 (routing.plan, fail-closed).
//   2. Anything that touches a real target passes preflight FIRST — out-of-scope
//      is refused and recorded (core.preflight), so a transition can only ever
//      fail closed, never act outside an active authorized engagement.
//   3. Every transition is journaled to the hash-chained ledger (core.audit).
//
// No LLM calls, no DB: in-memory + JSON-file persistence (board.js / registry.js),
// per the task. This is the legal, defensive control plane — it routes work and
// records it; it never acts on a third party.

const path = require("node:path");

const { AegisError } = require("../core/errors");
const { createBoard } = require("./board");
const { createRegistry } = require("./registry");
const { createQuarantine } = require("./quarantine");
const { createWorkItem, applyTransition, ACTIONS } = require("./workItem");
const routing = require("./routing");
const { unitLabel } = require("./directorates");

// Transitions that put an agent to work on the item's real target. These are the
// ones gated by preflight when the item carries a concrete target + engagement.
const ACTING_TRANSITIONS = new Set(["submit", "start", "help-request"]);

/**
 * @param {object} deps
 * @param {ReturnType<import("../core/index.js").createAegisCore>} deps.core  reused audit + preflight
 * @param {string} [deps.dataDir]  where board.json / registry.json live; omit for memory-only (tests)
 * @param {() => number} [deps.now]
 * @param {(message: string, err?: unknown) => void} [deps.logError]
 * @param {(intent: object) => void} [deps.onReclone]  runtime hook for Карцер reclone intents
 */
const createOrchestrator = ({ core, dataDir, now = () => Date.now(), logError = () => {}, onReclone } = {}) => {
  if (!core || !core.audit || !core.preflight) throw new Error("Оркестратору нужен AEGIS core (audit + preflight).");
  const audit = core.audit;

  const board = createBoard({ filePath: dataDir ? path.join(dataDir, "orchestrator-board.json") : undefined, logError });
  const registry = createRegistry({ filePath: dataDir ? path.join(dataDir, "capability-registry.json") : undefined, logError });
  const quarantineHook = createQuarantine({ audit, registry, onReclone, now, logError });

  const auditTransition = (item, action, extra = {}) => {
    audit.append({
      type: "orchestrator.transition",
      engagementId: item.engagementId || null,
      actor: extra.by ?? null,
      target: item.target ? { target: String(typeof item.target === "object" ? JSON.stringify(item.target) : item.target).slice(0, 200) } : { unit: unitLabel(item.currentUnit) },
      decision: action,
      reason: extra.reason ?? null,
      detail: {
        workItemId: item.id,
        action,
        from: extra.from ?? null,
        to: extra.to ?? item.currentUnit,
        status: item.status,
        kind: item.kind,
      },
    });
  };

  // Preflight scope gate: run before an acting transition when the item is tied
  // to an engagement AND names a concrete target. Fail-closed — a deny/hold stops
  // the transition. (preflight writes its own ledger entry either way.)
  const gateScope = (item, action, by) => {
    if (!ACTING_TRANSITIONS.has(action)) return;
    if (!item.engagementId || item.target == null) return;
    const result = core.preflight.check({
      engagementId: item.engagementId,
      actor: by || `unit:${item.currentUnit}`,
      action: `workitem:${action}`,
      target: item.target,
    });
    if (!result.allowed) {
      throw new AegisError("DENIED", `Переход '${action}' отклонён preflight: ${result.reason}`, { decision: result.decision });
    }
  };

  return {
    board,
    registry,
    ACTIONS,

    /** Create a work item on the board. Audited. */
    createItem(input = {}) {
      const item = createWorkItem(input, { now });
      board.put(item);
      const birth = item.routingTrail[item.routingTrail.length - 1];
      auditTransition(item, "create", { by: item.createdBy, reason: birth.reason, from: item.originUnit, to: item.targetUnit });
      return item;
    },

    getItem: (id) => board.get(id),
    listItems: (filter) => board.list(filter),
    summary: () => board.summary(),

    /**
     * Apply a transition to a work item. Order: matrix guard (routing.plan) →
     * preflight scope gate (for acting transitions) → state machine → persist →
     * audit. Any failure throws before the item is changed (fail-closed).
     * @param {string} id
     * @param {string} action  one of ACTIONS
     * @param {object} [params]
     */
    transition(id, action, params = {}) {
      const current = board.get(id);
      if (!current) throw new AegisError("NOT_FOUND", `Рабочий элемент не найден: ${id}.`);
      const by = params.by != null ? String(params.by) : undefined;

      // 1. Matrix (§26): refuses, e.g., a cross-floor op starting without AM7 sanction.
      routing.plan(current, action, params);

      // 2. Scope gate (fail-closed) for anything touching a real target.
      gateScope(current, action, by);

      // 3. State machine (pure) + persist + audit.
      const { item, reason } = applyTransition(current, action, params, { now });
      board.put(item);
      const last = item.routingTrail[item.routingTrail.length - 1];
      auditTransition(item, action, { by: by ?? last.by, reason, from: last.from, to: last.to });
      return item;
    },

    /**
     * Карцер (§19): an agent's output failed the orchestrator check. Flag the
     * item quarantined, emit a reclone intent (+ audit), persist. Returns
     * { item, intent }. Does not advance the work-item status.
     */
    quarantine(id, opts = {}) {
      const current = board.get(id);
      if (!current) throw new AegisError("NOT_FOUND", `Рабочий элемент не найден: ${id}.`);
      const { item, intent } = quarantineHook.quarantine(current, opts);
      board.put(item);
      return { item, intent };
    },

    async close() {
      await board.flush();
    },
  };
};

module.exports = { createOrchestrator, ACTING_TRANSITIONS };
