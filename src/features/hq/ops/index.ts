/**
 * The flat-roles orchestrator + the task/delegation/report flow (TZ §3.1/§3.2,
 * owner 2026-10-07). One lead («Главный хакер», AM7) announces a task, the swarm
 * allocates N operatives, they self-delegate across momentary FLAT roles — recon
 * / web-api / network / identity / cloud / wireless / reversing / osint /
 * social-eng / exploitation / reporting — chain findings role-to-role, and
 * deliver a clean report (NO tools listed, by invariant).
 *
 * Framework-free controllers (opsController) sit alongside osintController /
 * geoController / chatterController and feed them, so one coherent live demo
 * drives the боевой пульт. Display / coordination only — nothing acts on a
 * target. Demo scope is the fictional reserved lab (example.com / TEST-NET-3).
 */

export { opsController, OPS_DEMO_TASK, OPS_DEMO_SCOPE } from "./opsController";
export type { OpsControllerDeps, OpsHandle, StartOpOptions } from "./opsController";

export { OPS_ROLES, OPS_ROLE_META, isOpsRole, roleLabel, roleShort } from "./roles";
export type { OpsRole, OpsRoleMeta } from "./roles";

export { OPS_STATUSES, OPS_ACTIONS, applyTransition, createWorkItem, OpsError } from "./workItem";
export type { CreateWorkItemInput } from "./workItem";

export { nextHandler, plan as planTransition } from "./routing";

export { createBoard } from "./board";
export type { OpsBoard, OpsBoardFilter } from "./board";

export { createDemoScopeGate, createScopeGate, DEMO_SCOPE_ASSETS } from "./scope";
export type { OpsScopeAsset } from "./scope";

export { allocateSwarm, recommendAgentCount, rolesForTask, LEAD_CALLSIGN, SWARM_CALLSIGNS } from "./swarm";
export type { SwarmAllocation } from "./swarm";

export {
  buildReport,
  renderReportMarkdown,
  renderReportText,
  stripToolNames,
  findToolNames,
  assertNoToolNames,
  REPORT_TOOL_DENYLIST,
  REPORT_SEVERITY_BADGE,
  REPORT_SEVERITY_RU,
} from "./report";
export type {
  OpsReport,
  OpsReportInput,
  OpsReportMode,
  OpsReportSeverity,
  OpsReportVuln,
} from "./report";

export type {
  OpsAuditEntry,
  OpsHelp,
  OpsListener,
  OpsOperative,
  OpsPhase,
  OpsScopeDecision,
  OpsScopeGate,
  OpsScopeRequest,
  OpsSource,
  OpsState,
  OpsStatus,
  OpsTrailEntry,
  OpsVerdict,
  OpsWorkItem,
} from "./types";

export { OpsReportPanel } from "./OpsReportPanel";
export type { OpsReportPanelProps } from "./OpsReportPanel";
