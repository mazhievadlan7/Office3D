export type ExecApprovalDecision = "allow-once" | "allow-always" | "deny";

export type PendingExecApproval = {
  id: string;
  agentId: string | null;
  sessionKey: string | null;
  command: string;
  cwd: string | null;
  host: string | null;
  security: string | null;
  ask: string | null;
  resolvedPath: string | null;
  createdAtMs: number;
  expiresAtMs: number;
  resolving: boolean;
  error: string | null;
  /** Set when the main agent (or Office3D, when it could not decide) passed the request on. */
  escalation?: { by: string; reason: string | null } | null;
};
