/**
 * The work-item state machine — ported in LOGIC from the rolled-back
 * platform/orchestrator/workItem.js, re-mapped to FLAT ROLES.
 *
 * What was kept (the proven core): the lifecycle created → in_progress → review →
 * rework → verified → closed (+ blocked / escalated), the append-only routing
 * trail (кто → кому → зачем → когда), the rework loop, help-request/return,
 * escalation, and independent verification of critical items.
 *
 * What was DROPPED (the 27-floor / AM7 model): the cross-floor «kind», the
 * AM7-sanction gate before work may start, the fixed Кибербез/ИБ review floor and
 * the chief/directorate vocabulary. Routing is flat: peers hand work to peers by
 * role; verification is by an INDEPENDENT operative (a different callsign), not a
 * ranked authority.
 *
 * Pure and side-effect-free: every transition returns a NEW item (the input is
 * never mutated) plus the trail entry just appended. Audit, the scope gate and
 * persistence are layered on by the controller, exactly as before — so this core
 * stays deterministic under an injected clock and is trivially testable.
 */

import { isOpsRole, roleLabel, type OpsRole } from "./roles";
import type { OpsStatus, OpsTrailEntry, OpsWorkItem } from "./types";

/** A refusal shaped like the AEGIS kernel's, so the controller can map codes to
 *  HTTP/UI the same way. Fail-closed: an unknown or out-of-order action throws. */
export class OpsError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OpsError";
    this.code = code;
  }
}

const invalid = (message: string): never => {
  throw new OpsError("INVALID_INPUT", message);
};

export const OPS_STATUSES: readonly OpsStatus[] = [
  "created",
  "in_progress",
  "review",
  "rework",
  "verified",
  "closed",
  "blocked",
  "escalated",
];

/** Terminal statuses accept no further transitions (closed is the end of the line). */
const TERMINAL = new Set<OpsStatus>(["closed"]);

let seq = 0;
const newId = (): string => `wi_${(seq += 1).toString(36)}_${Date.now().toString(36)}`;

const cleanText = (value: unknown, max: number): string => String(value ?? "").trim().slice(0, max);

const toRole = (value: unknown): OpsRole | null => (isOpsRole(value) ? value : null);

const clone = <T>(value: T): T => (value == null ? value : (JSON.parse(JSON.stringify(value)) as T));

/** Input to create a fresh work item in 'created'. */
export type CreateWorkItemInput = {
  title: string;
  type?: string;
  originRole: OpsRole | string;
  targetRole: OpsRole | string;
  reviewRole?: OpsRole | string;
  critical?: boolean;
  assignee?: string | null;
  engagementId?: string | null;
  target?: string | null;
  payload?: Record<string, unknown>;
  parentId?: string | null;
  chainedFrom?: OpsRole | string | null;
  createdBy?: string;
  reason?: string;
};

/**
 * Build a fresh work item in 'created'. Pure: no I/O, clock injected. Routing is
 * flat — origin & target are ROLES, not floors, and there is no sanction gate.
 */
export const createWorkItem = (input: CreateWorkItemInput, { now = () => Date.now() }: { now?: () => number } = {}): OpsWorkItem => {
  const title = cleanText(input.title, 300);
  if (!title) invalid("У рабочего элемента должно быть название.");

  const originRole = toRole(input.originRole);
  if (originRole === null) invalid(`Неизвестная роль-источник (originRole): ${String(input.originRole)}.`);
  const targetRole = toRole(input.targetRole);
  if (targetRole === null) invalid(`Неизвестная роль-получатель (targetRole): ${String(input.targetRole)}.`);
  const reviewRole = toRole(input.reviewRole) ?? "reporting";

  const at = now();
  const createdBy = cleanText(input.createdBy, 120) || `role:${originRole}`;
  const item: OpsWorkItem = {
    id: newId(),
    title,
    type: cleanText(input.type, 80) || "task",
    originRole: originRole as OpsRole,
    targetRole: targetRole as OpsRole,
    currentRole: originRole as OpsRole, // the origin holds it until started
    reviewRole,
    status: "created",
    critical: input.critical === true,
    assignee: input.assignee ? cleanText(input.assignee, 120) : null,
    engagementId: input.engagementId ? cleanText(input.engagementId, 120) : null,
    target: input.target != null ? cleanText(input.target, 200) : null,
    payload: clone(input.payload ?? {}),
    parentId: input.parentId ? cleanText(input.parentId, 120) : null,
    chainedFrom: toRole(input.chainedFrom),
    help: null,
    verdicts: [],
    routingTrail: [],
    escalatedFrom: null,
    blockedFrom: null,
    createdAt: at,
    createdBy,
    updatedAt: at,
  };

  item.routingTrail.push({
    seq: 1,
    action: input.parentId ? "chain" : "create",
    from: originRole as OpsRole,
    to: targetRole as OpsRole,
    by: createdBy,
    reason: cleanText(input.reason, 300) || (input.parentId ? "передано по цепочке" : "создан рабочий элемент"),
    status: "created",
    at,
  });

  return item;
};

const appendTrail = (item: OpsWorkItem, entry: Omit<OpsTrailEntry, "seq">): void => {
  const last = item.routingTrail[item.routingTrail.length - 1];
  item.routingTrail.push({ seq: (last?.seq ?? 0) + 1, ...entry });
};

type Params = {
  by?: string;
  reason?: string;
  note?: string;
  pass?: boolean;
  helper?: OpsRole | string;
  assignTo?: OpsRole | string;
  at: number;
};

// Each handler validates the FROM status, mutates the (already cloned) next item
// and returns a short human reason for the trail/audit. No I/O.
const HANDLERS: Record<string, (next: OpsWorkItem, params: Params) => string> = {
  // The target role starts working — direct, flat path. From 'created' or from
  // 'rework' (the re-work loop after a failed review). No sanction gate.
  start(next, params) {
    if (next.status !== "created" && next.status !== "rework") {
      throw new OpsError("CONFLICT", `Начать работу можно из 'created' или 'rework' (сейчас '${next.status}').`);
    }
    const reason = next.status === "rework" ? "доработка начата" : "работа начата";
    const from = next.currentRole;
    next.status = "in_progress";
    next.currentRole = next.targetRole;
    if (params.by) next.assignee = cleanText(params.by, 120);
    appendTrail(next, { action: "start", from, to: next.targetRole, by: cleanText(params.by, 120) || `role:${from}`, reason: cleanText(params.reason, 300) || reason, status: "in_progress", at: params.at });
    return reason;
  },

  // Hand the result to a PEER for independent verification (flat — not a floor).
  "send-to-review"(next, params) {
    if (next.status !== "in_progress") throw new OpsError("CONFLICT", `На проверку можно отправить только 'in_progress' (сейчас '${next.status}').`);
    const from = next.currentRole;
    next.status = "review";
    next.currentRole = next.reviewRole;
    appendTrail(next, { action: "send-to-review", from, to: next.reviewRole, by: cleanText(params.by, 120) || `role:${from}`, reason: cleanText(params.reason, 300) || `на независимую проверку (${roleLabel(next.reviewRole)})`, status: "review", at: params.at });
    return "на проверке";
  },

  // Review passed → verified. A CRITICAL item needs an INDEPENDENT verifier: the
  // operative who signs the verdict must differ from the item's author (flat
  // adversarial independence — no ranked authority, just a second pair of eyes).
  verdict(next, params) {
    if (next.status !== "review") throw new OpsError("CONFLICT", `Вердикт выносится только в 'review' (сейчас '${next.status}').`);
    if (params.pass !== true) invalid("verdict принимает только положительный результат (pass:true); для отрицательного используйте 'rework'.");
    const by = cleanText(params.by, 120) || `role:${next.reviewRole}`;
    if (next.critical && next.assignee && by === next.assignee) {
      throw new OpsError("CONFLICT", "Критичный элемент должен проверить ДРУГОЙ оператор, не автор находки.");
    }
    next.status = "verified";
    next.verdicts.push({ result: "pass", by, note: cleanText(params.note, 500), at: params.at });
    appendTrail(next, { action: "verdict", from: next.currentRole, to: next.targetRole, by, reason: cleanText(params.note, 300) || "проверка пройдена", status: "verified", at: params.at });
    next.currentRole = next.targetRole;
    return "проверено";
  },

  // Review failed → rework loop: back to the author with remarks.
  rework(next, params) {
    if (next.status !== "review") throw new OpsError("CONFLICT", `Вернуть на доработку можно только из 'review' (сейчас '${next.status}').`);
    const by = cleanText(params.by, 120) || `role:${next.reviewRole}`;
    const to = next.targetRole;
    next.status = "rework";
    next.currentRole = to;
    next.verdicts.push({ result: "fail", by, note: cleanText(params.note, 500), at: params.at });
    appendTrail(next, { action: "rework", from: next.reviewRole, to, by, reason: cleanText(params.note, 300) || "возвращено на доработку с замечаниями", status: "rework", at: params.at });
    return "на доработке";
  },

  // One operative asks a peer role to help resolve remarks; the item is held with
  // the helper and will be returned. Allowed while in work or in rework.
  "help-request"(next, params) {
    if (next.status !== "in_progress" && next.status !== "rework") {
      throw new OpsError("CONFLICT", `Запросить помощь можно в 'in_progress' или 'rework' (сейчас '${next.status}').`);
    }
    if (next.help) throw new OpsError("CONFLICT", "По элементу уже открыт запрос помощи; сначала верните его (help-return).");
    const helper = toRole(params.helper);
    if (helper === null) invalid(`Неизвестная роль-помощник (helper): ${String(params.helper)}.`);
    const requester = next.currentRole;
    if (helper === requester) invalid("Нельзя запросить помощь у самой же роли.");
    next.help = { requester, helper: helper as OpsRole, reason: cleanText(params.reason, 300) || "запрос помощи", at: params.at, resumeStatus: next.status };
    next.currentRole = helper as OpsRole;
    appendTrail(next, { action: "help-request", from: requester, to: helper as OpsRole, by: cleanText(params.by, 120) || `role:${requester}`, reason: next.help.reason, status: next.status, at: params.at });
    return `запрошена помощь (${roleLabel(helper as OpsRole)})`;
  },

  "help-return"(next, params) {
    if (!next.help) throw new OpsError("CONFLICT", "По элементу нет открытого запроса помощи.");
    const { requester, helper, resumeStatus } = next.help;
    next.currentRole = requester;
    next.status = resumeStatus;
    appendTrail(next, { action: "help-return", from: helper, to: requester, by: cleanText(params.by, 120) || `role:${helper}`, reason: cleanText(params.reason, 300) || "помощь оказана, элемент возвращён", status: next.status, at: params.at });
    next.help = null;
    return "помощь возвращена";
  },

  // Escalate to the lead/coordinator — unresolved or out of scope. Flat: the lead
  // is just the coordinating operative, NOT a sanctioning authority.
  escalate(next, params) {
    if (TERMINAL.has(next.status)) throw new OpsError("CONFLICT", `Закрытый элемент не эскалируется (статус '${next.status}').`);
    if (next.status === "escalated") throw new OpsError("CONFLICT", "Элемент уже эскалирован.");
    const from = next.currentRole;
    next.escalatedFrom = { status: next.status, role: from };
    next.status = "escalated";
    appendTrail(next, { action: "escalate", from, to: from, by: cleanText(params.by, 120) || `role:${from}`, reason: cleanText(params.reason, 300) || "эскалация координатору (не решается / вне scope)", status: "escalated", at: params.at });
    return "эскалировано";
  },

  "resolve-escalation"(next, params) {
    if (next.status !== "escalated") throw new OpsError("CONFLICT", `Разрешить эскалацию можно только для 'escalated' (сейчас '${next.status}').`);
    const to = toRole(params.assignTo) ?? next.escalatedFrom?.role ?? next.targetRole;
    next.status = "in_progress";
    next.currentRole = to as OpsRole;
    appendTrail(next, { action: "resolve-escalation", from: next.currentRole, to: to as OpsRole, by: cleanText(params.by, 120) || "coordinator", reason: cleanText(params.reason, 300) || "эскалация разрешена, возвращено в работу", status: "in_progress", at: params.at });
    return "эскалация разрешена";
  },

  close(next, params) {
    if (next.status !== "verified") throw new OpsError("CONFLICT", `Закрыть можно только 'verified' (сейчас '${next.status}').`);
    const by = cleanText(params.by, 120) || `role:${next.currentRole}`;
    const from = next.currentRole;
    next.status = "closed";
    next.closedAt = params.at;
    appendTrail(next, { action: "close", from, to: next.originRole, by, reason: cleanText(params.reason, 300) || "принято и закрыто", status: "closed", at: params.at });
    return "закрыто";
  },

  block(next, params) {
    if (TERMINAL.has(next.status)) throw new OpsError("CONFLICT", `Закрытый элемент не блокируется (статус '${next.status}').`);
    if (next.status === "blocked") throw new OpsError("CONFLICT", "Элемент уже заблокирован.");
    next.blockedFrom = next.status;
    next.status = "blocked";
    appendTrail(next, { action: "block", from: next.currentRole, to: next.currentRole, by: cleanText(params.by, 120) || `role:${next.currentRole}`, reason: cleanText(params.reason, 300) || "элемент заблокирован", status: "blocked", at: params.at });
    return "заблокировано";
  },

  unblock(next, params) {
    if (next.status !== "blocked") throw new OpsError("CONFLICT", `Разблокировать можно только 'blocked' (сейчас '${next.status}').`);
    const resume = next.blockedFrom && OPS_STATUSES.includes(next.blockedFrom) ? next.blockedFrom : "in_progress";
    next.status = resume;
    next.blockedFrom = null;
    appendTrail(next, { action: "unblock", from: next.currentRole, to: next.currentRole, by: cleanText(params.by, 120) || `role:${next.currentRole}`, reason: cleanText(params.reason, 300) || "элемент разблокирован", status: resume, at: params.at });
    return "разблокировано";
  },
};

export const OPS_ACTIONS: readonly string[] = Object.freeze(Object.keys(HANDLERS));

/**
 * Apply one transition. Pure: returns a NEW item plus the trail entry just
 * appended; the input is never mutated. Throws OpsError on an illegal transition
 * (fail-closed — an unknown or out-of-order action is refused).
 */
export const applyTransition = (
  item: OpsWorkItem,
  action: string,
  params: Partial<Params> = {},
  { now = () => Date.now() }: { now?: () => number } = {},
): { item: OpsWorkItem; trail: OpsTrailEntry; reason: string } => {
  if (!item || typeof item !== "object") invalid("Нет рабочего элемента для перехода.");
  const handler = HANDLERS[action];
  if (!handler) invalid(`Неизвестный переход: ${action}. Допустимые: ${OPS_ACTIONS.join(", ")}.`);
  if (TERMINAL.has(item.status) && action !== "close") {
    throw new OpsError("CONFLICT", `Элемент в терминальном статусе '${item.status}' — переходы недоступны.`);
  }
  const next = clone(item);
  const at = now();
  const reason = handler(next, { ...params, at });
  next.updatedAt = at;
  return { item: next, trail: next.routingTrail[next.routingTrail.length - 1], reason };
};
