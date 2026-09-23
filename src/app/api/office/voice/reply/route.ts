import { NextResponse } from "next/server";
import { t } from "@/lib/i18n";
import { ttsProvider, VoiceProviderError } from "@/lib/voice/providers";
import { voiceRateLimited } from "@/lib/voice/rateLimit";

export const runtime = "nodejs";

type VoiceReplyRequestBody = {
  text?: string;
  /** Ignored: the server's configured provider speaks. Kept for older clients. */
  provider?: string;
  voiceId?: string | null;
  speed?: number;
};

const MAX_REPLY_CHARS = 5_000;
const REPLIES_PER_MINUTE = 60;

export async function POST(request: Request) {
  if (voiceRateLimited(request, "tts", REPLIES_PER_MINUTE)) {
    return NextResponse.json({ error: t("apiOffice.voiceRateLimited") }, { status: 429 });
  }
  try {
    const body = (await request.json().catch(() => ({}))) as VoiceReplyRequestBody;
    const text = typeof body.text === "string" ? body.text.replace(/\s+/g, " ").trim() : "";
    if (!text) {
      return NextResponse.json({ error: t("apiOffice.voiceReplyTextRequired") }, { status: 400 });
    }
    if (text.length > MAX_REPLY_CHARS) {
      return NextResponse.json(
        { error: t("apiOffice.voiceReplyTooLong", { max: MAX_REPLY_CHARS }) },
        { status: 400 }
      );
    }
    const response = await ttsProvider().synthesize({
      text,
      voiceId: typeof body.voiceId === "string" ? body.voiceId : null,
      speed: typeof body.speed === "number" ? body.speed : undefined,
    });
    return new Response(response.body, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": response.headers.get("content-type") ?? "audio/mpeg",
      },
    });
  } catch (error) {
    if (error instanceof VoiceProviderError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[voice] Speech synthesis failed:", error);
    return NextResponse.json({ error: t("apiOffice.voiceReplyFailed") }, { status: 500 });
  }
}
