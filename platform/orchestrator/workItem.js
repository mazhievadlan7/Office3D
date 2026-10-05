// Work item — the single unit of inter-directorate work, and the state machine
// that moves it (§II.4 control plane, «Взаимодействие и делегирование» в
// FLOOR_CHARTERS.md).
//
// Любая передача между этажами — это work item со статусом и маршрутным следом
// (кто → кому → зачем → когда). Этот модуль чистый и без побочных эффектов: он
// только строит элемент и применяет переходы, возвращая НОВЫЙ элемент (исходный
// не мутируется) плюс запись маршрута. Аудит, preflight и персистентность
// навешивает оркестратор (index.js) вокруг этих переходов — так ядро легко
// тестируется и остаётся детерминированным при впрыснутых часах.
//
// Статусы (из устава): created → in_progress → review → rework → verified → closed,
// плюс blocked и escalated. Правила переходов:
//   • мелкий запрос (kind 'small') идёт напрямую unit→unit (§26 «Прямой путь»);
//   • крупная межуправленческая операция (kind 'cross-floor') не может покинуть
//     'created' без санкции AM7 (§26);
//   • проверка маршрутизируется в Кибербез/ИБ (unit 23);
//   • критичный элемент требует независимой проверки (Proof-or-Silence:
//     Prover → Skeptic другой «семьи» → Judge) ПЕРЕД 'verified';
//   • петля доработки: review не прошёл → rework → повторная работа → повторная проверка;
//   • запрос помощи: управление просит другое устранить замечания и получает элемент обратно;
//   • эскалация к AM7 — когда не решается на этаже или выходит за scope.

const crypto = require("node:crypto");

const { AegisError, invalid } = require("../core/errors");
const { AM7_UNIT, REVIEW_UNIT, toUnit, unitLabel } = require("./directorates");

const STATUSES = Object.freeze([
  "created",
  "in_progress",
  "review",
  "rework",
  "verified",
  "closed",
  "blocked",
  "escalated",
]);

const KINDS = Object.freeze(["small", "cross-floor"]);

/** Terminal statuses accept no further transitions (closed is the end of the line). */
const TERMINAL = new Set(["closed"]);

const newId = () => `wi_${crypto.randomBytes(8).toString("hex")}`;

const cleanText = (value, max) => String(value ?? "").trim().slice(0, max);

/** Resolve an actor to a unit number: accepts a floor number, "unit:N", or a
 *  known floor string; null when it names no known unit. Used for authority
 *  checks (only AM7 may sanction / resolve escalations). */
const actorUnit = (value) => {
  if (value == null) return null;
  const direct = toUnit(value);
  if (direct !== null) return direct;
  const m = /^unit:(\d+)$/.exec(String(value).trim());
  return m ? toUnit(m[1]) : null;
};

const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

/**
 * Build a fresh work item in 'created'. Pure: no I/O, clock injected.
 * @param {object} input
 * @param {string} input.title
 * @param {string} [input.type]        free-form category (e.g. "finding", "pr", "task")
 * @param {"small"|"cross-floor"} input.kind
 * @param {number} input.originUnit    floor number of the requesting directorate
 * @param {number} input.targetUnit    floor number of the receiving directorate
 * @param {boolean} [input.critical]   critical items need Proof-or-Silence before 'verified'
 * @param {object} [input.payload]
 * @param {string} [input.engagementId]  links the item to an authorized scope (for preflight)
 * @param {string|object} [input.target] concrete host/asset the work touches (gated by preflight)
 * @param {string} [input.createdBy]
 * @param {{now?: () => number}} [deps]
 */
const createWorkItem = (input = {}, { now = () => Date.now() } = {}) => {
  const title = cleanText(input.title, 300);
  if (!title) throw invalid("У рабочего элемента должно быть название.");

  const kind = String(input.kind ?? "small");
  if (!KINDS.includes(kind)) throw invalid(`Неизвестный тип элемента (kind): ${kind}. Ожидается 'small' или 'cross-floor'.`);

  const originUnit = toUnit(input.originUnit);
  if (originUnit === null) throw invalid(`Неизвестное управление-источник (originUnit): ${input.originUnit}.`);
  const targetUnit = toUnit(input.targetUnit);
  if (targetUnit === null) throw invalid(`Неизвестное управление-получатель (targetUnit): ${input.targetUnit}.`);

  const at = now();
  const createdBy = cleanText(input.createdBy, 120) || `unit:${originUnit}`;
  const item = {
    id: newId(),
    title,
    type: cleanText(input.type, 80) || "task",
    kind,
    critical: input.critical === true,
    originUnit,
    targetUnit,
    currentUnit: originUnit, // the origin holds it until submitted
    status: "created",
    payload: clone(input.payload ?? {}),
    engagementId: input.engagementId ? cleanText(input.engagementId, 120) : null,
    target: input.target ?? null,
    sanction: null, // { by, at, reason } once AM7 sanctions a cross-floor op
    proof: [], // Proof-or-Silence entries for critical items
    help: null, // { requester, helper, reason, at } while a help-request is open
    quarantine: null, // set by quarantine.js when an output fails the orchestrator check
    verdicts: [], // history of review verdicts
    routingTrail: [], // append-only кто → кому → зачем → когда
    createdAt: at,
    createdBy,
    updatedAt: at,
  };

  // Seed the trail with the item's birth so «кто → кому → зачем → когда» is complete
  // from the very first entry.
  item.routingTrail.push({
    seq: 1,
    action: "create",
    from: originUnit,
    to: targetUnit,
    by: createdBy,
    reason: cleanText(input.reason, 300) || "создан рабочий элемент",
    status: "created",
    at,
  });

  return item;
};

/** Whether a critical item's Proof-or-Silence chain is complete and confirmed.
 *  Needs a Prover, a Skeptic from a DIFFERENT model family, and a Judge whose
 *  verdict confirms — reproducible in sandbox. (§26 «независимая проверка».) */
const proofConfirmed = (item) => {
  const proof = Array.isArray(item.proof) ? item.proof : [];
  const byRole = (role) => proof.filter((p) => p.role === role);
  const provers = byRole("prover");
  const skeptics = byRole("skeptic");
  const judges = byRole("judge");
  if (!provers.length || !skeptics.length || !judges.length) return false;
  // Skeptic must come from a different model family than the prover (adversarial independence).
  const proverFamilies = new Set(provers.map((p) => p.modelFamily).filter(Boolean));
  const skepticIndependent = skeptics.some((s) => s.modelFamily && !proverFamilies.has(s.modelFamily));
  if (!skepticIndependent) return false;
  // The latest judge verdict must confirm.
  const lastJudge = judges[judges.length - 1];
  return lastJudge.verdict === "confirmed";
};

const appendTrail = (item, entry) => {
  const seq = (item.routingTrail[item.routingTrail.length - 1]?.seq ?? 0) + 1;
  item.routingTrail.push({ seq, ...entry });
};

// Each handler validates the FROM status and params, mutates the (already cloned)
// next item, and returns a short human reason for the trail/audit. They never do
// I/O. applyTransition() clones first, so callers get immutability for free.
const PROOF_ROLES = new Set(["prover", "skeptic", "judge"]);
const JUDGE_VERDICTS = new Set(["confirmed", "refuted", "inconclusive"]);

const HANDLERS = {
  // AM7 sanctions a cross-floor operation. Status stays 'created'; this is the
  // gate that lets 'submit'/'start' leave 'created' for a cross-floor item.
  sanction(next, params) {
    if (next.status !== "created") throw new AegisError("CONFLICT", `Санкция возможна только в статусе 'created' (сейчас '${next.status}').`);
    if (next.kind !== "cross-floor") throw invalid("Санкция AM7 нужна только для крупных межуправленческих операций (kind 'cross-floor').");
    if (actorUnit(params.by) !== AM7_UNIT) throw new AegisError("FORBIDDEN", "Санкционировать межуправленческую операцию может только AM7 (unit 27).");
    const at = params.at;
    next.sanction = { by: AM7_UNIT, at, reason: cleanText(params.reason, 300) || "санкция AM7 на межуправленческую операцию" };
    appendTrail(next, { action: "sanction", from: AM7_UNIT, to: next.targetUnit, by: `unit:${AM7_UNIT}`, reason: next.sanction.reason, status: next.status, at });
    return next.sanction.reason;
  },

  // Origin submits the item into work; it reaches the target. A cross-floor item
  // may not leave 'created' without AM7 sanction.
  submit(next, params) {
    if (next.status !== "created") throw new AegisError("CONFLICT", `Отправить в работу можно только 'created' (сейчас '${next.status}').`);
    if (next.kind === "cross-floor" && !next.sanction) {
      throw new AegisError("FORBIDDEN", "Крупная межуправленческая операция не может покинуть 'created' без санкции AM7 (§26).");
    }
    return advanceToWork(next, params, "submit", "передан в работу");
  },

  // Target starts working. From 'created' (direct small path) or from 'rework'
  // (re-work after a failed review — the rework loop).
  start(next, params) {
    if (next.status !== "created" && next.status !== "rework") {
      throw new AegisError("CONFLICT", `Начать работу можно из 'created' или 'rework' (сейчас '${next.status}').`);
    }
    if (next.status === "created" && next.kind === "cross-floor" && !next.sanction) {
      throw new AegisError("FORBIDDEN", "Крупная межуправленческая операция не может покинуть 'created' без санкции AM7 (§26).");
    }
    const reason = next.status === "rework" ? "доработка начата" : "работа начата";
    return advanceToWork(next, params, "start", reason);
  },

  // Technical review is routed to Кибербез/ИБ (unit 23). (§26 «Маршрут проверки».)
  "send-to-review"(next, params) {
    if (next.status !== "in_progress") throw new AegisError("CONFLICT", `На проверку можно отправить только 'in_progress' (сейчас '${next.status}').`);
    const at = params.at;
    const from = next.currentUnit;
    next.status = "review";
    next.currentUnit = REVIEW_UNIT;
    appendTrail(next, { action: "send-to-review", from, to: REVIEW_UNIT, by: cleanText(params.by, 120) || `unit:${from}`, reason: cleanText(params.reason, 300) || "отправлено на техническую проверку (Кибербез/ИБ)", status: "review", at });
    return "на проверке (Кибербез/ИБ)";
  },

  // A Proof-or-Silence entry (Prover / Skeptic / Judge). Only on a critical item
  // under review; does not change status, only records the independent-verify chain.
  "record-proof"(next, params) {
    if (next.status !== "review") throw new AegisError("CONFLICT", `Запись Proof-or-Silence возможна только во время 'review' (сейчас '${next.status}').`);
    if (!next.critical) throw invalid("Proof-or-Silence применяется только к критичным элементам.");
    const role = String(params.role ?? "").trim().toLowerCase();
    if (!PROOF_ROLES.has(role)) throw invalid(`Неизвестная роль Proof-or-Silence: ${role || "(пусто)"} (ожидается prover/skeptic/judge).`);
    if (role === "judge") {
      const verdict = String(params.verdict ?? "").trim().toLowerCase();
      if (!JUDGE_VERDICTS.has(verdict)) throw invalid(`Вердикт Judge должен быть одним из: ${[...JUDGE_VERDICTS].join(", ")}.`);
      params = { ...params, verdict };
    }
    const at = params.at;
    const entry = {
      role,
      modelFamily: cleanText(params.modelFamily, 80) || null,
      verdict: role === "judge" ? params.verdict : null,
      note: cleanText(params.note, 500),
      by: cleanText(params.by, 120) || null,
      at,
    };
    next.proof.push(entry);
    appendTrail(next, { action: "record-proof", from: REVIEW_UNIT, to: REVIEW_UNIT, by: entry.by || `unit:${REVIEW_UNIT}`, reason: `Proof-or-Silence: ${role}${entry.verdict ? ` → ${entry.verdict}` : ""}`, status: next.status, at });
    return `proof: ${role}`;
  },

  // Review passed → verified. For a critical item the Proof-or-Silence chain must
  // be complete and confirmed first (independent verify, §26).
  verdict(next, params) {
    if (next.status !== "review") throw new AegisError("CONFLICT", `Вердикт выносится только в 'review' (сейчас '${next.status}').`);
    if (params.pass !== true) throw invalid("verdict принимает только положительный результат (pass:true); для отрицательного используйте 'rework'.");
    if (next.critical && !proofConfirmed(next)) {
      throw new AegisError("CONFLICT", "Критичный элемент нельзя принять без завершённой независимой проверки (Prover → Skeptic другой семьи → Judge: confirmed).");
    }
    const at = params.at;
    const by = cleanText(params.by, 120) || `unit:${REVIEW_UNIT}`;
    next.status = "verified";
    next.verdicts.push({ result: "pass", by, note: cleanText(params.note, 500), at });
    appendTrail(next, { action: "verdict", from: REVIEW_UNIT, to: next.targetUnit, by, reason: cleanText(params.note, 300) || "проверка пройдена", status: "verified", at });
    return "проверено";
  },

  // Review failed → rework loop: back to the author with remarks.
  rework(next, params) {
    if (next.status !== "review") throw new AegisError("CONFLICT", `Вернуть на доработку можно только из 'review' (сейчас '${next.status}').`);
    const at = params.at;
    const by = cleanText(params.by, 120) || `unit:${REVIEW_UNIT}`;
    const to = next.targetUnit; // the author/owner of the work
    next.status = "rework";
    next.currentUnit = to;
    next.verdicts.push({ result: "fail", by, note: cleanText(params.note, 500), at });
    appendTrail(next, { action: "rework", from: REVIEW_UNIT, to, by, reason: cleanText(params.note, 300) || "возвращено на доработку с замечаниями", status: "rework", at });
    return "на доработке";
  },

  // A unit asks another (e.g. Кибербез/ИБ) to fix the remarks; the item is held
  // with the helper and will be returned. Allowed while in work or in rework.
  "help-request"(next, params) {
    if (next.status !== "in_progress" && next.status !== "rework") {
      throw new AegisError("CONFLICT", `Запросить помощь можно в 'in_progress' или 'rework' (сейчас '${next.status}').`);
    }
    if (next.help) throw new AegisError("CONFLICT", "По элементу уже открыт запрос помощи; сначала верните его (help-return).");
    const helper = toUnit(params.helper);
    if (helper === null) throw invalid(`Неизвестное управление-помощник (helper): ${params.helper}.`);
    const at = params.at;
    const requester = next.currentUnit;
    if (helper === requester) throw invalid("Нельзя запросить помощь у самого себя.");
    next.help = { requester, helper, reason: cleanText(params.reason, 300) || "запрос помощи в устранении замечаний", at, resumeStatus: next.status };
    next.currentUnit = helper;
    appendTrail(next, { action: "help-request", from: requester, to: helper, by: cleanText(params.by, 120) || `unit:${requester}`, reason: next.help.reason, status: next.status, at });
    return `запрошена помощь (${unitLabel(helper)})`;
  },

  // The helper finishes and returns the item to the requester; work continues.
  "help-return"(next, params) {
    if (!next.help) throw new AegisError("CONFLICT", "По элементу нет открытого запроса помощи.");
    const at = params.at;
    const { requester, helper, resumeStatus } = next.help;
    next.currentUnit = requester;
    next.status = resumeStatus || "in_progress";
    appendTrail(next, { action: "help-return", from: helper, to: requester, by: cleanText(params.by, 120) || `unit:${helper}`, reason: cleanText(params.reason, 300) || "помощь оказана, элемент возвращён", status: next.status, at });
    next.help = null;
    return "помощь возвращена";
  },

  // Escalate to AM7 — unresolved on the floor or out of scope. (§26.)
  escalate(next, params) {
    if (TERMINAL.has(next.status)) throw new AegisError("CONFLICT", `Закрытый элемент не эскалируется (статус '${next.status}').`);
    if (next.status === "escalated") throw new AegisError("CONFLICT", "Элемент уже эскалирован к AM7.");
    const at = params.at;
    const from = next.currentUnit;
    next.escalatedFrom = { status: next.status, unit: from };
    next.status = "escalated";
    next.currentUnit = AM7_UNIT;
    appendTrail(next, { action: "escalate", from, to: AM7_UNIT, by: cleanText(params.by, 120) || `unit:${from}`, reason: cleanText(params.reason, 300) || "эскалация к AM7 (не решается на этаже / вне scope)", status: "escalated", at });
    return "эскалировано к AM7";
  },

  // AM7 hands an escalated item back for work (optionally re-routing / sanctioning).
  "resolve-escalation"(next, params) {
    if (next.status !== "escalated") throw new AegisError("CONFLICT", `Разрешить эскалацию можно только для 'escalated' (сейчас '${next.status}').`);
    if (actorUnit(params.by) !== AM7_UNIT) throw new AegisError("FORBIDDEN", "Разрешить эскалацию может только AM7 (unit 27).");
    const at = params.at;
    const to = toUnit(params.assignTo) ?? next.escalatedFrom?.unit ?? next.targetUnit;
    if (params.sanction === true && next.kind === "cross-floor") {
      next.sanction = { by: AM7_UNIT, at, reason: "санкция AM7 выдана при разрешении эскалации" };
    }
    next.status = "in_progress";
    next.currentUnit = to;
    appendTrail(next, { action: "resolve-escalation", from: AM7_UNIT, to, by: `unit:${AM7_UNIT}`, reason: cleanText(params.reason, 300) || "эскалация разрешена, возвращено в работу", status: "in_progress", at });
    return "эскалация разрешена";
  },

  // Owner accepts the verified result → closed (end of the line).
  close(next, params) {
    if (next.status !== "verified") throw new AegisError("CONFLICT", `Закрыть можно только 'verified' (сейчас '${next.status}').`);
    const at = params.at;
    const by = cleanText(params.by, 120) || `unit:${next.currentUnit}`;
    const from = next.currentUnit;
    next.status = "closed";
    next.closedAt = at;
    appendTrail(next, { action: "close", from, to: next.originUnit, by, reason: cleanText(params.reason, 300) || "принято и закрыто", status: "closed", at });
    return "закрыто";
  },

  // Park the item (e.g. awaiting an external dependency). Reversible.
  block(next, params) {
    if (TERMINAL.has(next.status)) throw new AegisError("CONFLICT", `Закрытый элемент не блокируется (статус '${next.status}').`);
    if (next.status === "blocked") throw new AegisError("CONFLICT", "Элемент уже заблокирован.");
    const at = params.at;
    next.blockedFrom = next.status;
    next.status = "blocked";
    appendTrail(next, { action: "block", from: next.currentUnit, to: next.currentUnit, by: cleanText(params.by, 120) || `unit:${next.currentUnit}`, reason: cleanText(params.reason, 300) || "элемент заблокирован", status: "blocked", at });
    return "заблокировано";
  },

  unblock(next, params) {
    if (next.status !== "blocked") throw new AegisError("CONFLICT", `Разблокировать можно только 'blocked' (сейчас '${next.status}').`);
    const at = params.at;
    const resume = STATUSES.includes(next.blockedFrom) ? next.blockedFrom : "in_progress";
    next.status = resume;
    next.blockedFrom = null;
    appendTrail(next, { action: "unblock", from: next.currentUnit, to: next.currentUnit, by: cleanText(params.by, 120) || `unit:${next.currentUnit}`, reason: cleanText(params.reason, 300) || "элемент разблокирован", status: resume, at });
    return "разблокировано";
  },
};

// Shared helper for submit/start: move into in_progress at the target unit.
function advanceToWork(next, params, action, reason) {
  const at = params.at;
  const from = next.currentUnit;
  const to = next.targetUnit;
  next.status = "in_progress";
  next.currentUnit = to;
  appendTrail(next, { action, from, to, by: cleanText(params.by, 120) || `unit:${from}`, reason: cleanText(params.reason, 300) || reason, status: "in_progress", at });
  return reason;
}

const ACTIONS = Object.freeze(Object.keys(HANDLERS));

/**
 * Apply one transition to a work item. Pure: returns a NEW item plus the trail
 * entry just appended; the input is never mutated. Throws AegisError on an
 * illegal transition (fail-closed — an unknown or out-of-order action is refused).
 *
 * @param {object} item
 * @param {string} action   one of ACTIONS
 * @param {object} [params]  action-specific args; `by` is the actor (unit or name)
 * @param {{now?: () => number}} [deps]
 * @returns {{item: object, trail: object, reason: string}}
 */
const applyTransition = (item, action, params = {}, { now = () => Date.now() } = {}) => {
  if (!item || typeof item !== "object") throw invalid("Нет рабочего элемента для перехода.");
  const handler = HANDLERS[action];
  if (!handler) throw invalid(`Неизвестный переход: ${action}. Допустимые: ${ACTIONS.join(", ")}.`);
  if (TERMINAL.has(item.status) && action !== "close") {
    throw new AegisError("CONFLICT", `Элемент в терминальном статусе '${item.status}' — переходы недоступны.`);
  }
  const next = clone(item);
  const at = now();
  const reason = handler(next, { ...params, at });
  next.updatedAt = at;
  return { item: next, trail: next.routingTrail[next.routingTrail.length - 1], reason };
};

module.exports = {
  STATUSES,
  KINDS,
  ACTIONS,
  TERMINAL,
  createWorkItem,
  applyTransition,
  proofConfirmed,
};
