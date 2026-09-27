import { governance } from "@/lib/aegis/core";
import { aegisError, aegisJson } from "@/lib/aegis/respond";

export const runtime = "nodejs";

/**
 * The first-order rules (RULE_0…RULE_5) and the composed system-prompt block
 * every agent carries. With ?engagementId it pins the prompt to that scope.
 */
export async function GET(request: Request) {
  try {
    const engagementId = new URL(request.url).searchParams.get("engagementId") ?? undefined;
    return aegisJson(governance(engagementId));
  } catch (error) {
    return aegisError(error);
  }
}
