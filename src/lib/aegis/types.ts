// Shared DTOs for the AEGIS legal core, used by the API routes and the HQ
// control panel. The authoritative logic lives in the CommonJS kernel under
// server/aegis; these types describe what crosses the API boundary.

export type AegisAssetKind = "domain" | "ip" | "cidr" | "url";

export type AegisAsset = {
  id: string;
  kind: AegisAssetKind;
  value: string;
  note?: string;
  ports?: number[] | null;
  includeSubdomains?: boolean;
  pathPrefix?: string;
  host?: string;
  isIpHost?: boolean;
};

export type AegisStatus = "draft" | "authorized" | "active" | "stopped" | "completed";

export type AegisAuthorization = {
  letterRef: string;
  signer: string;
  signature?: string | null;
  verification: unknown | null;
  recordedAt: number;
};

export type AegisEngagement = {
  id: string;
  name: string;
  note: string;
  status: AegisStatus;
  assets: AegisAsset[];
  authorization: AegisAuthorization | null;
  activation: { by: string; at: number } | null;
  stop: { by: string; reason: string; at: number; auto?: boolean; trigger?: string | null; count?: number | null } | null;
  completedBy?: string;
  createdAt: number;
  updatedAt: number;
};

/** A compact engagement row for the overview list. */
export type AegisEngagementSummary = {
  id: string;
  name: string;
  status: AegisStatus;
  assetCount: number;
  updatedAt: number;
};

export type AegisKillSwitch = {
  global: boolean;
  at: number | null;
  by: string | null;
  reason: string | null;
};

export type AegisAuditEntry = {
  seq: number;
  at: number;
  type: string;
  engagementId: string | null;
  actor: string | null;
  target: unknown;
  decision: string | null;
  reason: string | null;
  detail: unknown;
  prevHash: string;
  hash: string;
};

export type AegisAuditIntegrity = { ok: boolean; count: number; signed?: boolean; reason?: string; brokenAt?: number };

export type AegisEgress = {
  engagementId: string | null;
  ipv4: string[];
  ipv6: string[];
  domains: string[];
  note: string;
  nftables: string;
};

/** The always-on security posture: kill-switch plus the Gate-0 and auto-stop
 *  guards and whether each is armed. Surfaced read-only in the overview. */
export type AegisSecurityStatus = {
  killSwitch: AegisKillSwitch;
  gate0: { enabled: boolean; canaryCount: number };
  autoStop: { enabled: boolean; threshold: number; windowMs: number };
};

export type AegisOverview = {
  killSwitch: AegisKillSwitch;
  engagements: AegisEngagementSummary[];
  audit: AegisAuditIntegrity;
  security: AegisSecurityStatus;
};

/** A first-order governance rule (RULE_0…RULE_5) carried by every agent. */
export type AegisRule = { id: string; title: string; text: string };
export type AegisGovernance = { rules: AegisRule[]; prompt: string };

export type AegisPreflightDecision = { allowed: boolean; decision: string; reason: string; assetId: string | null };

/** What the operator places to prove control of an asset. */
export type AegisVerifyInstructions = { token: string; challenge: string; wellKnownPath: string };

export type AegisVerifyMethod = "dns" | "file" | "whois";

export type AegisVerifyResult = {
  method: AegisVerifyMethod;
  assetId: string | null;
  assetValue: string | null;
  ok: boolean;
  informational: boolean;
  detail: {
    ok?: boolean;
    reason?: string;
    name?: string;
    url?: string;
    registrar?: string | null;
    org?: string | null;
    updated?: string | null;
  };
  checkedAt: number;
};
