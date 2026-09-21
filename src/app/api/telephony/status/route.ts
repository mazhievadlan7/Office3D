import { NextResponse } from "next/server";

import { listCalls } from "@/lib/telephony/store";
import { isTelephonyConfigured } from "@/lib/telephony/twilio";
import { describeVoiceAgentReadiness } from "@/lib/telephony/voiceAgent";

export const runtime = "nodejs";

/**
 * Whether this deployment can place agent phone calls, and what is live.
 *
 * Two independent pieces have to be configured: a carrier to carry the call
 * and a voice agent platform to hold the conversation. Reporting them apart
 * means a deployment sees which one it is missing instead of a single unhelpful
 * "not configured".
 *
 * Only variable names are returned, never values.
 */
export async function GET() {
  const voiceAgent = describeVoiceAgentReadiness();
  const carrierConfigured = isTelephonyConfigured();

  return NextResponse.json(
    {
      ready: carrierConfigured && voiceAgent.configured,
      carrier: { provider: "twilio", configured: carrierConfigured },
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
