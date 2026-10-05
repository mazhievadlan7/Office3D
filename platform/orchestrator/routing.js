// Router — the interaction matrix (§26) made executable.
//
// Given a work item and a proposed transition, the router answers two questions,
// deterministically and with no allocation to speak of:
//   1. who is the next handler (which unit the item should sit with), and
//   2. by what mode it travels — 'direct' (мелкий запрос напрямую unit→unit) or
//      'am7-sanction' (крупная межуправленческая операция только по санкции AM7).
//
// This is pure routing policy: no side effects, no audit, no scope checks (those
// are the orchestrator's job). It encodes the matrix from FLOOR_CHARTERS.md:
//   • small → direct; cross-floor → requires AM7 sanction before it may start;
//   • review always routes to Кибербез/ИБ (23);
//   • escalation always routes to AM7 (27);
//   • help-request routes to the named helper unit.

const { AegisError, invalid } = require("../core/errors");
const { AM7_UNIT, REVIEW_UNIT, toUnit, isUnit } = require("./directorates");

/** Does this item, as a whole, require AM7 sanction to move cross-floor?
 *  Large cross-floor operations do; small direct requests do not (§26). */
const requiresSanction = (item) => item?.kind === "cross-floor";

/** The travel mode between two units for an item: direct vs AM7-sanction. */
const routeMode = (item) => (requiresSanction(item) ? "am7-sanction" : "direct");

/**
 * The unit that should hold the item after `action`. Deterministic.
 * @param {object} item
 * @param {string} action
 * @param {object} [params]  carries `helper` for help-request, `assignTo` for resolve
 * @returns {number} floor number of the next handler
 */
const nextHandler = (item, action, params = {}) => {
  switch (action) {
    case "sanction":
      return item.targetUnit; // sanction clears the way to the target; item still created
    case "submit":
    case "start":
      return item.targetUnit;
    case "send-to-review":
    case "record-proof":
      return REVIEW_UNIT;
    case "verdict":
      return item.targetUnit; // verified result returns to the owning unit
    case "rework":
      return item.targetUnit;
    case "help-request": {
      const helper = toUnit(params.helper);
      if (helper === null) throw invalid(`Неизвестное управление-помощник (helper): ${params.helper}.`);
      return helper;
    }
    case "help-return":
      return item.help?.requester ?? item.currentUnit;
    case "escalate":
      return AM7_UNIT;
    case "resolve-escalation":
      return toUnit(params.assignTo) ?? item.escalatedFrom?.unit ?? item.targetUnit;
    case "close":
      return item.originUnit;
    case "block":
    case "unblock":
      return item.currentUnit;
    default:
      throw invalid(`Router не знает маршрут для действия: ${action}.`);
  }
};

/**
 * Guard a transition against the matrix BEFORE it is applied. Returns a plan
 * {from, to, mode, needsSanction}; throws when the matrix forbids the move
 * (fail-closed) — e.g. a cross-floor op trying to start without AM7 sanction.
 * @param {object} item
 * @param {string} action
 * @param {object} [params]
 * @returns {{from:number,to:number,mode:string,needsSanction:boolean,sanctioned:boolean}}
 */
const plan = (item, action, params = {}) => {
  if (!item || typeof item !== "object") throw invalid("Нет рабочего элемента для маршрутизации.");
  const from = item.currentUnit;
  const to = nextHandler(item, action, params);
  const mode = routeMode(item);
  const sanctioned = Boolean(item.sanction);

  // The matrix rule: a cross-floor item may not START moving into work without a
  // standing AM7 sanction. 'sanction' itself and 'escalate'/'resolve-escalation'
  // are exempt (they are how a sanction is obtained or routed through AM7).
  const startsWork = action === "submit" || action === "start";
  const leavingCreated = item.status === "created";
  if (startsWork && leavingCreated && requiresSanction(item) && !sanctioned) {
    throw new AegisError("FORBIDDEN", "Матрица §26: крупная межуправленческая операция не может начаться без санкции AM7.");
  }

  return { from, to, mode, needsSanction: requiresSanction(item), sanctioned };
};

module.exports = { requiresSanction, routeMode, nextHandler, plan, isUnit };
