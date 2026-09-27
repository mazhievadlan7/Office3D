import { listAudit, verifyAudit } from "@/lib/aegis/core";
import { aegisError, aegisJson } from "@/lib/aegis/respond";

export const runtime = "nodejs";

/** The audit trail (optionally for one engagement) plus a live integrity check. */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const engagementId = url.searchParams.get("engagementId") ?? undefined;
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;
    return aegisJson({ entries: listAudit({ engagementId, limit }), integrity: verifyAudit() });
  } catch (error) {
    return aegisError(error);
  }
}
