import { telephonyError, telephonyJson } from "@/app/api/telephony/respond";
import { drainPendingSay, getCall } from "@/lib/telephony/store";
import { TelephonyError } from "@/lib/telephony/types";
import { assertWebhookAuthorized } from "@/lib/telephony/webhookAuth";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

/**
 * The agent asking whether the operator has a note for it.
 *
 * This is a webhook tool: ElevenLabs calls it from their infrastructure mid
 * call, which makes it the one telephony endpoint on the open internet. The
 * server's access gate does not cover it, so it authenticates itself with a
 * shared secret and is closed when none is configured.
 *
 * The note is drained, not read: an instruction the agent has picked up must
 * never be delivered twice, and a repeat would have it say the same line again
 * on its next turn.
 */

type ToolRequest = {
  conversation_id?: unknown;
  conversationId?: unknown;
};

const readConversationId = (body: ToolRequest): string => {
  // ElevenLabs sends whatever the tool's body schema declares; both spellings
  // are accepted so a dashboard configured either way works.
  const raw = body.conversation_id ?? body.conversationId;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new TelephonyError(t("apiTelephony.conversationIdRequired"));
  }
  return raw.trim();
};

export async function POST(request: Request) {
  try {
    assertWebhookAuthorized(request);

    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      throw new TelephonyError(t("apiCommon.bodyNotJson"));
    }
    if (!parsed || typeof parsed !== "object") {
      throw new TelephonyError(t("apiCommon.expectedJsonObject"));
    }

    const conversationId = readConversationId(parsed as ToolRequest);

    // A conversation this office never placed gets the same empty answer as
    // one with nothing queued: an authenticated caller should not be able to
    // probe which conversation ids exist here.
    if (!getCall(conversationId)) {
      return telephonyJson({ instruction: null });
    }

    const instruction = drainPendingSay(conversationId);

    return telephonyJson({ instruction: instruction ?? null });
  } catch (error) {
    return telephonyError(error);
  }
}
