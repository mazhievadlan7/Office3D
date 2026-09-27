// Server-side singleton for the AEGIS legal core.
//
// The kernel (server/aegis) keeps engagement state and the hash-chained audit
// ledger on disk under the office state dir. It must be ONE instance per
// process so two requests never race on those files, so it is cached on
// globalThis (which also survives dev HMR module reloads). This module is
// imported only by the /api/aegis routes — never by client code.

import path from "node:path";

import { resolveStateDir } from "@/lib/clawdbot/paths";
import type {
  AegisAuditEntry,
  AegisAuditIntegrity,
  AegisEgress,
  AegisEngagement,
  AegisKillSwitch,
  AegisOverview,
  AegisVerifyInstructions,
  AegisVerifyMethod,
  AegisVerifyResult,
} from "@/lib/aegis/types";
// The kernel is JSDoc-typed CommonJS; allowJs lets it import cleanly.
import { createAegisCore } from "../../../server/aegis/index.js";

type AegisKernel = ReturnType<typeof createAegisCore>;

const CACHE_KEY = Symbol.for("office3d.aegis.core");

const kernel = (): AegisKernel => {
  const globalStore = globalThis as unknown as Record<symbol, AegisKernel | undefined>;
  if (!globalStore[CACHE_KEY]) {
    globalStore[CACHE_KEY] = createAegisCore({
      dataDir: path.join(resolveStateDir(), "aegis"),
      logError: (message: string, err?: unknown) => console.error(`[aegis] ${message}`, err ?? ""),
      // A soft runaway guard; the scope gate is the real boundary.
      rateLimit: { max: 600, windowMs: 60_000 },
    });
  }
  return globalStore[CACHE_KEY]!;
};

/** Maps an AegisError code to an HTTP status; anything else is a 500. */
export const aegisErrorStatus = (error: unknown): number | null => {
  if (!error || typeof error !== "object" || (error as { name?: string }).name !== "AegisError") return null;
  switch ((error as { code?: string }).code) {
    case "INVALID_INPUT":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "FORBIDDEN":
    case "DENIED":
      return 403;
    case "UNAVAILABLE":
      return 503;
    default:
      return 400;
  }
};

const summarize = (engagement: AegisEngagement) => ({
  id: engagement.id,
  name: engagement.name,
  status: engagement.status,
  assetCount: engagement.assets.length,
  updatedAt: engagement.updatedAt,
});

export const overview = (): AegisOverview => {
  const core = kernel();
  return {
    killSwitch: core.engagements.getKillSwitch() as AegisKillSwitch,
    engagements: (core.engagements.list() as AegisEngagement[]).map(summarize),
    audit: core.verifyAudit() as AegisAuditIntegrity,
  };
};

export const listEngagements = (): AegisEngagement[] => kernel().engagements.list() as AegisEngagement[];
export const getEngagement = (id: string): AegisEngagement | null => kernel().engagements.get(id) as AegisEngagement | null;

export const createEngagement = (input: { name?: string; note?: string }): Promise<AegisEngagement> =>
  kernel().engagements.create(input) as Promise<AegisEngagement>;

export const addAsset = (id: string, asset: unknown): Promise<AegisEngagement> =>
  kernel().engagements.addAsset(id, asset) as Promise<AegisEngagement>;
export const removeAsset = (id: string, assetId: string): Promise<AegisEngagement> =>
  kernel().engagements.removeAsset(id, assetId) as Promise<AegisEngagement>;

export const recordAuthorization = (
  id: string,
  input: { letterRef?: string; signer?: string; verification?: unknown },
): Promise<AegisEngagement> => kernel().engagements.recordAuthorization(id, input) as Promise<AegisEngagement>;

export const activate = (id: string, input: { by?: string; confirm?: boolean }): Promise<AegisEngagement> =>
  kernel().engagements.activate(id, input) as Promise<AegisEngagement>;
export const stop = (id: string, input: { by?: string; reason?: string }): Promise<AegisEngagement> =>
  kernel().engagements.stop(id, input) as Promise<AegisEngagement>;
export const reactivate = (id: string, input: { by?: string }): Promise<AegisEngagement> =>
  kernel().engagements.reactivate(id, input) as Promise<AegisEngagement>;
export const complete = (id: string, input: { by?: string }): Promise<AegisEngagement> =>
  kernel().engagements.complete(id, input) as Promise<AegisEngagement>;

export const setGlobalKill = (input: { on: boolean; by?: string; reason?: string }): Promise<AegisKillSwitch> =>
  kernel().engagements.setGlobalKill(input) as Promise<AegisKillSwitch>;
export const getKillSwitch = (): AegisKillSwitch => kernel().engagements.getKillSwitch() as AegisKillSwitch;

export const listAudit = (input: { engagementId?: string; limit?: number } = {}): AegisAuditEntry[] =>
  kernel().audit.list(input) as AegisAuditEntry[];
export const verifyAudit = (): AegisAuditIntegrity => kernel().verifyAudit() as AegisAuditIntegrity;

export const egressFor = (id: string): AegisEgress => {
  const core = kernel();
  const allow = core.egressAllowlist(id) as Omit<AegisEgress, "nftables">;
  return { ...allow, nftables: core.renderEgressNftables(id) as string };
};

/** A refusal shaped like the kernel's, so aegisErrorStatus maps it to a status. */
const aegisFail = (code: string, message: string): never => {
  const error = new Error(message) as Error & { name: string; code: string };
  error.name = "AegisError";
  error.code = code;
  throw error;
};

export const verifyInstructions = (engagementId: string): AegisVerifyInstructions => {
  const core = kernel();
  return {
    token: core.verifier.token(engagementId),
    challenge: core.verifier.challenge(engagementId),
    wellKnownPath: core.verifier.wellKnownPath,
  };
};

/** Runs one ownership check for one asset the engagement actually holds. */
export const runVerification = (
  engagementId: string,
  assetId: string,
  method: AegisVerifyMethod,
): Promise<AegisVerifyResult> => {
  const core = kernel();
  const engagement = core.engagements.get(engagementId) as AegisEngagement | null;
  if (!engagement) aegisFail("NOT_FOUND", `Engagement не найден: ${engagementId}.`);
  const asset = engagement!.assets.find((item) => item.id === assetId);
  if (!asset) aegisFail("NOT_FOUND", `Актив не найден: ${assetId}.`);
  return core.verifier.check({ engagementId, method, asset: asset! }) as Promise<AegisVerifyResult>;
};

/** For the Phase-1 execution plane: the single gate every active action passes. */
export const preflight = (request: {
  engagementId: string;
  actor: string;
  action: string;
  target: string | object;
  humanApproved?: boolean;
}): { allowed: boolean; decision: string; reason: string; assetId: string | null } =>
  kernel().preflight.check(request);
