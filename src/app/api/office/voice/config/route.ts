import { NextResponse } from "next/server";

import { describeVoiceSetup } from "@/lib/voice/providers";

export const runtime = "nodejs";

/** The server's voice setup for the office: providers, readiness and voices — no keys. */
export async function GET() {
  return NextResponse.json(describeVoiceSetup(), { headers: { "Cache-Control": "no-store" } });
}
