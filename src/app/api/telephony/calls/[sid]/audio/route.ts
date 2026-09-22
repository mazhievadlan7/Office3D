import { telephonyError } from "@/app/api/telephony/respond";
import { fetchConversationAudio } from "@/lib/telephony/elevenlabs";
import { requireCall } from "@/lib/telephony/store";
import { TelephonyError, isTerminalCallStatus } from "@/lib/telephony/types";
import { resolveVoiceAgentConfig } from "@/lib/telephony/voiceAgent";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

/**
 * The recording of a call, once it is over.
 *
 * Proxied rather than linked: the ElevenLabs API key is what fetches it, and
 * that key must not reach a browser. The audio is streamed straight through,
 * so a long call does not sit in this server's memory.
 *
 * This is a recording, not a live tap. ElevenLabs' API has no way to listen in
 * on a call that is still running, so a call in progress is refused here
 * rather than served something that only looks live.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sid: string }> },
) {
  try {
    const { sid } = await params;
    const call = requireCall(sid);

    if (!isTerminalCallStatus(call.status)) {
      throw new TelephonyError(
        t("apiTelephony.recordingAfterEnd"),
        409,
      );
    }

    const { body, contentType } = await fetchConversationAudio(
      call.sid,
      resolveVoiceAgentConfig(),
    );

    return new Response(body, {
      headers: {
        "Content-Type": contentType,
        // The recording of a finished call never changes, but it is also a
        // conversation with a third party: cached by the one browser that
        // asked, never by anything in between.
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": `inline; filename="call-${encodeURIComponent(call.sid)}"`,
      },
    });
  } catch (error) {
    return telephonyError(error);
  }
}
