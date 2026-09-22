import { telephonyError, telephonyJson } from "@/app/api/telephony/respond";
import { resolveOrganisationName } from "@/lib/telephony/agentPrompt";
import { placeVoiceAgentCall } from "@/lib/telephony/elevenlabs";
import { createCall, getCall, listCalls } from "@/lib/telephony/store";
import { syncCalls } from "@/lib/telephony/sync";
import {
  TelephonyError,
  assertE164,
  isTerminalCallStatus,
} from "@/lib/telephony/types";
import {
  describeVoiceAgentReadiness,
  resolveVoiceAgentConfig,
} from "@/lib/telephony/voiceAgent";
import { describeOperatorChannelReadiness } from "@/lib/telephony/webhookAuth";

export const runtime = "nodejs";

/**
 * The office's phone.
 *
 * POST places a call on an agent's behalf; GET is the live feed the office
 * polls, returning every call with its transcript as it stands.
 *
 * Access is already gated by the server in front of this route, so there is no
 * second check here — but note that any session that reaches the app can dial
 * a number, and dialling costs money and rings a stranger's phone. That is the
 * access gate's job to prevent, and worth saying out loud.
 */

type CallRequest = {
  toNumber?: unknown;
  agentId?: unknown;
  /**
   * Who is speaking, as the office knows them. Facts, not instructions: the
   * server composes the agent's prompt from these, and never takes prompt
   * text from a caller.
   */
  agentName?: unknown;
  agentRole?: unknown;
};

const readBody = async (request: Request): Promise<CallRequest> => {
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object") {
      throw new TelephonyError("Expected a JSON object.");
    }
    return parsed as CallRequest;
  } catch (error) {
    if (error instanceof TelephonyError) throw error;
    throw new TelephonyError("Could not read the request body as JSON.");
  }
};

const readString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new TelephonyError(`${field} is required.`);
  }
  return value.trim();
};

const readOptionalString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    const toNumber = assertE164(readString(body.toNumber, "toNumber"), "toNumber");
    const agentId = readString(body.agentId, "agentId");
    const caller = {
      agentId,
      agentName: readString(body.agentName, "agentName"),
      agentRole: readOptionalString(body.agentRole),
      // Never from the request: who an agent claims to represent on a real
      // phone call is the deployment's to decide, not a session's.
      organisation: resolveOrganisationName(),
      // The agent is only told about the tool when this deployment can
      // actually answer it; describing one it cannot call invites it to
      // announce a note that never arrives.
      operatorChannel: describeOperatorChannelReadiness().configured,
    };

    // Resolved before dialling so a half-configured deployment fails with the
    // names of what it is missing rather than a provider error.
    const config = resolveVoiceAgentConfig();

    const placed = await placeVoiceAgentCall({ toNumber, caller }, config);

    // The provider's conversation id is the call's identity here, so a repeat
    // of the same conversation never doubles up in the feed.
    const existing = getCall(placed.conversationId);
    if (existing) {
      return telephonyJson({ call: existing }, 200);
    }

    const call = createCall({
      sid: placed.conversationId,
      to: toNumber,
      agentId,
      // Placed, not yet answered. The first sync corrects this.
      status: "ringing",
    });

    return telephonyJson({ call, sipCallId: placed.sipCallId }, 201);
  } catch (error) {
    return telephonyError(error);
  }
}

export async function GET() {
  const voiceAgent = describeVoiceAgentReadiness();
  let syncErrors: Record<string, string> = {};

  if (voiceAgent.configured) {
    const live = listCalls()
      .filter((call) => !isTerminalCallStatus(call.status))
      .map((call) => call.sid);
    if (live.length > 0) {
      try {
        // Reported per call rather than thrown: a conversation the provider
        // cannot serve must not blank the rest of the feed.
        syncErrors = Object.fromEntries(
          await syncCalls(live, resolveVoiceAgentConfig()),
        );
      } catch (error) {
        return telephonyError(error);
      }
    }
  }

  return telephonyJson({
    ready: voiceAgent.configured,
    voiceAgent,
    operatorChannel: describeOperatorChannelReadiness(),
    calls: listCalls(),
    syncErrors,
  });
}
