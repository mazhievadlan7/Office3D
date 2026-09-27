// Client calls to the AEGIS legal-core API. Every response is read fresh; the
// server maps a kernel refusal to an HTTP status and a Russian message, which
// is surfaced as a thrown Error the panel shows inline.

import type {
  AegisAuditEntry,
  AegisAuditIntegrity,
  AegisEgress,
  AegisEngagement,
  AegisGovernance,
  AegisKillSwitch,
  AegisOverview,
  AegisVerifyInstructions,
  AegisVerifyMethod,
  AegisVerifyResult,
} from "@/lib/aegis/types";

const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : `Ошибка ${response.status}`);
  }
  return data;
};

const post = (url: string, body: unknown): Promise<Response> =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(body),
  });

export const fetchOverview = (): Promise<AegisOverview> =>
  fetch("/api/aegis", { cache: "no-store" }).then(readJson) as Promise<AegisOverview>;

export const fetchEngagement = async (
  id: string,
): Promise<{ engagement: AegisEngagement; egress: AegisEgress | null }> => {
  const data = await fetch(`/api/aegis/engagements/${encodeURIComponent(id)}`, { cache: "no-store" }).then(readJson);
  return { engagement: data.engagement as AegisEngagement, egress: (data.egress as AegisEgress) ?? null };
};

export const createEngagement = async (input: { name: string; note?: string }): Promise<AegisEngagement> =>
  ((await post("/api/aegis/engagements", input).then(readJson)).engagement as AegisEngagement);

export type EngagementOp =
  | { op: "addAsset"; asset: unknown }
  | { op: "removeAsset"; assetId: string }
  | { op: "authorize"; letterRef: string; signer: string; verification?: unknown }
  | { op: "activate"; by: string; confirm: boolean }
  | { op: "stop"; by: string; reason: string }
  | { op: "reactivate"; by: string }
  | { op: "complete"; by: string };

export const engagementOp = async (id: string, op: EngagementOp): Promise<AegisEngagement> =>
  ((await post(`/api/aegis/engagements/${encodeURIComponent(id)}`, op).then(readJson)).engagement as AegisEngagement);

export const setKillSwitch = async (input: { on: boolean; by: string; reason?: string }): Promise<AegisKillSwitch> =>
  ((await post("/api/aegis/killswitch", input).then(readJson)).killSwitch as AegisKillSwitch);

export const fetchAudit = async (
  input: { engagementId?: string; limit?: number } = {},
): Promise<{ entries: AegisAuditEntry[]; integrity: AegisAuditIntegrity }> => {
  const params = new URLSearchParams();
  if (input.engagementId) params.set("engagementId", input.engagementId);
  if (input.limit) params.set("limit", String(input.limit));
  const query = params.toString();
  const data = await fetch(`/api/aegis/audit${query ? `?${query}` : ""}`, { cache: "no-store" }).then(readJson);
  return { entries: (data.entries as AegisAuditEntry[]) ?? [], integrity: data.integrity as AegisAuditIntegrity };
};

export const fetchGovernance = (): Promise<AegisGovernance> =>
  fetch("/api/aegis/governance", { cache: "no-store" }).then(readJson) as Promise<AegisGovernance>;

export const fetchVerifyInstructions = (id: string): Promise<AegisVerifyInstructions> =>
  fetch(`/api/aegis/engagements/${encodeURIComponent(id)}/verify`, { cache: "no-store" }).then(
    readJson,
  ) as Promise<AegisVerifyInstructions>;

export const runVerify = async (
  id: string,
  assetId: string,
  method: AegisVerifyMethod,
): Promise<AegisVerifyResult> =>
  ((await post(`/api/aegis/engagements/${encodeURIComponent(id)}/verify`, { assetId, method }).then(readJson))
    .result as AegisVerifyResult);
