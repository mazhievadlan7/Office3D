import { preflight } from "@/lib/aegis/core";
import { aegisError, aegisJson, readJson } from "@/lib/aegis/respond";

export const runtime = "nodejs";

/**
 * The execution seam: the Phase-1 execution plane calls this before it runs
 * any tool against any target. Deny-by-default; every decision is audited by
 * the kernel. Returns { allowed, decision: allow|deny|hold, reason, assetId }.
 */
export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const decision = preflight({
      engagementId: typeof body.engagementId === "string" ? body.engagementId : "",
      actor: typeof body.actor === "string" ? body.actor : "unknown",
      action: typeof body.action === "string" ? body.action : "",
      target: (body.target as string | object) ?? "",
      humanApproved: body.humanApproved === true,
    });
    return aegisJson(decision);
  } catch (error) {
    return aegisError(error);
  }
}
