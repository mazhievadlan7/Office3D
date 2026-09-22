import { NextResponse } from "next/server";
import { synthesizeVoiceReply, type VoiceReplyProvider } from "@/lib/voiceReply/provider";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

type VoiceReplyRequestBody = {
  text?: string;
  provider?: VoiceReplyProvider;
  voiceId?: string | null;
  speed?: number;
};

const MAX_REPLY_CHARS = 5_000;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as VoiceReplyRequestBody;
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
    const response = await synthesizeVoiceReply({
      text,
      provider: body.provider,
      voiceId: body.voiceId,
      speed: body.speed,
    });
    return new Response(response.body, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": response.headers.get("content-type") ?? "audio/mpeg",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : t("apiOffice.voiceReplyFailed");
    const status = message.includes("Missing ELEVENLABS_API_KEY") ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
