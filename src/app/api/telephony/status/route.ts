import { NextResponse } from "next/server";

import { listCalls } from "@/lib/telephony/store";
import { describeVoiceAgentReadiness } from "@/lib/telephony/voiceAgent";

export const runtime = "nodejs";

/**
 * Whether this deployment can place agent phone calls, and what is live.
 *
 * The carrier is registered with ElevenLabs rather than here: it places the
 * call over its own SIP trunk, so this app needs no carrier credentials and
 * reports only whether the voice agent is configured.
 *
 * Only variable names are returned, never values.
 */
export async function GET() {
  const voiceAgent = describeVoiceAgentReadiness();

  return NextResponse.json(
    {
      ready: voiceAgent.configured,
      voiceAgent,
      calls: listCalls().map((call) => ({
        sid: call.sid,
        status: call.status,
        to: call.to,
        agentId: call.agentId,
        startedAt: call.startedAt,
        endedAt: call.endedAt,
        turnCount: call.transcript.length,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
