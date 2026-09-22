import { telephonyError, telephonyJson } from "@/app/api/telephony/respond";
import { appendTurn, requireCall, setPendingSay } from "@/lib/telephony/store";
import {
  TelephonyError,
  assertSpeakableText,
  isTerminalCallStatus,
} from "@/lib/telephony/types";
import { describeOperatorChannelReadiness } from "@/lib/telephony/webhookAuth";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

/**
 * The operator handing the agent a line to say next.
 *
 * Queued, not spoken: ElevenLabs runs the conversation, and the agent picks
 * the note up when it next calls its tool. So this lands on the agent's next
 * turn rather than instantly, and the panel says so rather than implying the
 * words went straight down the line.
 *
 * A later note replaces an earlier one that has not been collected — when an
 * operator types twice before the agent comes back, the second is the one
 * they meant.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ sid: string }> },
) {
  try {
    const { sid } = await params;
    const call = requireCall(sid);

    if (isTerminalCallStatus(call.status)) {
      throw new TelephonyError(t("apiTelephony.callEnded"), 409);
    }

    const readiness = describeOperatorChannelReadiness();
    if (!readiness.configured) {
      // Refused rather than queued: a note nothing can collect would sit in
      // the transcript looking delivered.
      throw new TelephonyError(
        t("apiTelephony.operatorNotConfigured", { missing: readiness.missing.join(", ") }),
        503,
      );
    }

    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      throw new TelephonyError(t("apiCommon.bodyNotJson"));
    }
    const text = assertSpeakableText(
      typeof (parsed as { text?: unknown })?.text === "string"
        ? ((parsed as { text: string }).text)
        : "",
      "text",
    );

    setPendingSay(call.sid, text);
    // Shown in the feed straight away, attributed to the operator, so the
    // transcript records what was asked for as well as what was said.
    const turn = appendTurn(call.sid, { speaker: "operator", text });

    return telephonyJson({ call: requireCall(call.sid), turn }, 202);
  } catch (error) {
    return telephonyError(error);
  }
}
