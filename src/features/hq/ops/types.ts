/**
 * The flat-role orchestrator model (TZ §3.1 / §3.2). Ported in LOGIC from the
 * rolled-back platform/orchestrator (the work-item state machine, the append-only
 * routing trail, chaining and the scope-gated/audited transitions), but re-mapped
 * to FLAT ROLES: there are no floors, no AM7-sanction gate and no chief model —
 * work is distributed by momentary role (recon / web-api / … / reporting) between
 * peers who self-delegate.
 *
 * Pure, serialisable, framework-free (no React, no DOM): the controller holds it,
 * the demo swarm fills it now and the real Execution Plane will drive the same
 * seam later. Display/coordination only — nothing here ever acts on a target.
 */

import type { OpsRole } from "./roles";

/** The work-item lifecycle. Mirrors the ported machine minus the sanction states. */
export type OpsStatus =
  | "created"
  | "in_progress"
  | "review"
  | "rework"
  | "verified"
  | "closed"
  | "blocked"
  | "escalated";

/** One append-only routing-trail entry: кто → кому → зачем → когда. */
export type OpsTrailEntry = {
  seq: number;
  action: string;
  from: OpsRole;
  to: OpsRole;
  /** The operative (callsign) or role that moved it. */
  by: string;
  reason: string;
  status: OpsStatus;
  at: number;
};

/** A review verdict kept in the item's history. */
export type OpsVerdict = { result: "pass" | "fail"; by: string; note: string; at: number };

/** An open help-request (one operative asking another to resolve remarks). */
export type OpsHelp = { requester: OpsRole; helper: OpsRole; reason: string; at: number; resumeStatus: OpsStatus };

/** The single unit of work the orchestrator routes between flat roles. */
export type OpsWorkItem = {
  id: string;
  title: string;
  /** Free category: "task" | "finding" | "chain" | "report" … */
  type: string;
  /** The role that raised the item. */
  originRole: OpsRole;
  /** The role the work is for. */
  targetRole: OpsRole;
  /** Where the item sits right now. */
  currentRole: OpsRole;
  /** Who performs review/verification (a peer role; defaults to reporting). */
  reviewRole: OpsRole;
  status: OpsStatus;
  /** Critical items need an INDEPENDENT verifier (a different operative) before verified. */
  critical: boolean;
  /** The operative (callsign) currently assigned, when known. */
  assignee: string | null;
  /** Links the item to an authorized scope (for the scope gate). */
  engagementId: string | null;
  /** The concrete in-scope target the work touches (gated before any acting step). */
  target: string | null;
  payload: Record<string, unknown>;
  /** Provenance when this item was CHAINED from another's finding. */
  parentId: string | null;
  /** The role whose finding spawned this item (chaining source). */
  chainedFrom: OpsRole | null;
  help: OpsHelp | null;
  verdicts: OpsVerdict[];
  /** Append-only кто → кому → зачем → когда. */
  routingTrail: OpsTrailEntry[];
  escalatedFrom?: { status: OpsStatus; role: OpsRole } | null;
  blockedFrom?: OpsStatus | null;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  closedAt?: number;
};

/** What a scope-gate check returns — the SAME shape as the AEGIS preflight, so the
 *  real preflight can be injected in place of the demo gate with no model change. */
export type OpsScopeDecision = {
  allowed: boolean;
  decision: string;
  reason: string;
  assetId: string | null;
};

/** The one request a scope gate answers (mirrors core.preflight.check). */
export type OpsScopeRequest = {
  engagementId: string | null;
  actor: string;
  action: string;
  target: string | object | null;
};

/** The scope-gate seam: the demo gate now, the AEGIS preflight later. */
export type OpsScopeGate = {
  check(request: OpsScopeRequest): OpsScopeDecision;
};

/** One audit entry the controller keeps (append-only; the real core signs it). */
export type OpsAuditEntry = {
  seq: number;
  at: number;
  type: string;
  engagementId: string | null;
  actor: string | null;
  decision: string | null;
  reason: string | null;
  detail: Record<string, unknown>;
};

/** An operative in the swarm. */
export type OpsOperative = {
  /** APT-style callsign shown in chatter and on the board. */
  callsign: string;
  /** The role this operative is on right now (can change as they self-delegate). */
  role: OpsRole;
  /** True for the single lead («Главный хакер», AM7) who announces & allocates. */
  lead: boolean;
};

/** The op's lifecycle for the live view. */
export type OpsPhase = "allocating" | "running" | "chaining" | "verifying" | "reporting" | "complete" | "stopped";

/** Where this op came from, so the pult can stop a demo op without killing a real one. */
export type OpsSource = "demo" | "briefing" | "runtime";

/** The live op state the controller publishes to subscribers. */
export type OpsState = {
  opId: string;
  source: OpsSource;
  task: string;
  engagementId: string | null;
  phase: OpsPhase;
  operatives: OpsOperative[];
  /** Roles currently represented in the swarm. */
  roles: OpsRole[];
  /** Counts for a quick header. */
  counts: { operatives: number; items: number; findings: number; verified: number; closed: number };
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type OpsListener = (state: OpsState | null) => void;
