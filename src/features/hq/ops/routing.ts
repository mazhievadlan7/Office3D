/**
 * Flat-role router — the interaction model of the ported orchestrator made
 * executable, with the §26 floor-matrix REMOVED.
 *
 * In the flat model there is no cross-floor «kind» and no AM7-sanction gate:
 * every hand-off is a direct peer→peer move. The router answers one question,
 * deterministically and without side effects: which ROLE should hold the item
 * after `action`. Scope checks and audit are the controller's job, not the
 * router's.
 */

import { isOpsRole, type OpsRole } from "./roles";
import { OpsError } from "./workItem";
import type { OpsWorkItem } from "./types";

const toRole = (value: unknown): OpsRole | null => (isOpsRole(value) ? value : null);

const invalid = (message: string): never => {
  throw new OpsError("INVALID_INPUT", message);
};

/** The role that should hold the item after `action`. Deterministic, flat. */
export const nextHandler = (item: OpsWorkItem, action: string, params: { helper?: unknown; assignTo?: unknown } = {}): OpsRole => {
  switch (action) {
    case "start":
      return item.targetRole;
    case "send-to-review":
      return item.reviewRole;
    case "verdict":
    case "rework":
      return item.targetRole; // the owning role gets the result / the remarks
    case "help-request": {
      const helper = toRole(params.helper);
      if (helper === null) invalid(`Неизвестная роль-помощник (helper): ${String(params.helper)}.`);
      return helper as OpsRole;
    }
    case "help-return":
      return item.help?.requester ?? item.currentRole;
    case "escalate":
      return item.currentRole; // the coordinating operative, flat — no floor 27
    case "resolve-escalation":
      return toRole(params.assignTo) ?? item.escalatedFrom?.role ?? item.targetRole;
    case "close":
      return item.originRole;
    case "block":
    case "unblock":
      return item.currentRole;
    default:
      invalid(`Router не знает маршрут для действия: ${action}.`);
      return item.currentRole; // unreachable
  }
};

/**
 * Guard a transition against the flat model BEFORE it is applied. There is no
 * sanction gate to enforce, so this only computes a {from, to} plan for the
 * audit/trail; it stays as the seam where a future policy check would live.
 */
export const plan = (item: OpsWorkItem, action: string, params: { helper?: unknown; assignTo?: unknown } = {}): { from: OpsRole; to: OpsRole; mode: "direct" } => {
  if (!item || typeof item !== "object") invalid("Нет рабочего элемента для маршрутизации.");
  return { from: item.currentRole, to: nextHandler(item, action, params), mode: "direct" };
};
