import { telephonyError, telephonyJson } from "@/app/api/telephony/respond";
import { requireCall } from "@/lib/telephony/store";
import { syncCall } from "@/lib/telephony/sync";
import { isTerminalCallStatus } from "@/lib/telephony/types";
import { resolveVoiceAgentConfig } from "@/lib/telephony/voiceAgent";

export const runtime = "nodejs";

/**
 * One call, read fresh.
 *
 * The office uses this when an operator is watching a single conversation, so
 * it can poll one call rather than the whole feed. A finished call is served
 * from the store: its transcript is final and re-reading it would only spend a
 * provider request.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sid: string }> },
) {
  try {
    const { sid } = await params;
    // 404s before any provider call when the id is not one of ours.
    const existing = requireCall(sid);

    const call = isTerminalCallStatus(existing.status)
      ? existing
      : await syncCall(existing.sid, resolveVoiceAgentConfig());

    return telephonyJson({ call });
  } catch (error) {
    return telephonyError(error);
  }
}
