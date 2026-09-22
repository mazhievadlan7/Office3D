import {
  TelephonyError,
  assertE164,
  type TranscriptTurn,
} from "@/lib/telephony/types";
import { resolveVoiceAgentConfig, type VoiceAgentConfig } from "@/lib/telephony/voiceAgent";

/**
 * ElevenLabs Agents over a SIP trunk.
 *
 * ElevenLabs places and runs the call: it dials out, holds the conversation,
 * handles barge-in and returns the transcript. Office3D asks it to call a
 * number on an agent's behalf and reads back what was said, rather than
 * orchestrating any audio itself.
 *
 * The request and response shapes here were taken from the official SDK's
 * generated types and serializers (@elevenlabs/elevenlabs-js), not guessed:
 * elevenlabs.io is unreachable from the build environment, so the package on
 * npm was the authoritative source available. A thin fetch client is used
 * rather than the SDK itself to match how the rest of this app calls third
 * parties, and because the surface used here is three endpoints.
 */

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io";

type OutboundCallResponse = {
  success?: unknown;
  message?: unknown;
  conversation_id?: unknown;
  sip_call_id?: unknown;
};

export type PlacedVoiceAgentCall = {
  /** ElevenLabs' id for the conversation; the handle for transcripts. */
  conversationId: string;
  sipCallId: string | null;
  message: string;
};

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const request = async <T>(
  config: VoiceAgentConfig,
  path: string,
  init: { method: string; body?: unknown },
): Promise<T> => {
  const url = new URL(path, `${ELEVENLABS_API_BASE}/`);

  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: {
        "xi-api-key": config.apiKey,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  } catch (error) {
    throw new TelephonyError(
      `Could not reach ElevenLabs: ${
        error instanceof Error ? error.message : String(error)
      }`,
      502,
      error,
    );
  }

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const record = (parsed ?? {}) as Record<string, unknown>;
    const detail =
      asString(record.detail) ??
      asString(record.message) ??
      `ElevenLabs returned ${response.status}.`;
    // The status is preserved: 401 is a bad key, 422 a bad request body, and
    // telling those apart saves a deployment looking in the wrong place.
    throw new TelephonyError(`ElevenLabs: ${detail}`, response.status, parsed);
  }

  return (parsed ?? {}) as T;
};

/**
 * Asks the voice agent to call a number.
 *
 * `officeAgentId` is passed through as a dynamic variable so the agent knows
 * which member of the office it is speaking as — the callee sees one shared
 * number for every agent, so the agent has to say who it is.
 */
export const placeVoiceAgentCall = async (
  params: { toNumber: string; officeAgentId: string },
  config: VoiceAgentConfig = resolveVoiceAgentConfig(),
): Promise<PlacedVoiceAgentCall> => {
  const toNumber = assertE164(params.toNumber, "toNumber");
  const officeAgentId = params.officeAgentId.trim();
  if (!officeAgentId) {
    throw new TelephonyError("officeAgentId is required.");
  }

  const payload = await request<OutboundCallResponse>(
    config,
    "v1/convai/sip-trunk/outbound-call",
    {
      method: "POST",
      body: {
        agent_id: config.agentId,
        agent_phone_number_id: config.phoneNumberId,
        to_number: toNumber,
        conversation_initiation_client_data: {
          dynamic_variables: { office_agent_id: officeAgentId },
        },
      },
    },
  );

  // Two different failures, reported apart: the service refusing says why,
  // while a response with no conversation id leaves nothing to follow and its
  // own "ok" message would explain nothing.
  if (payload.success === false) {
    throw new TelephonyError(
      asString(payload.message) ?? "ElevenLabs refused the call.",
      502,
      payload,
    );
  }

  const conversationId = asString(payload.conversation_id);
  if (!conversationId) {
    throw new TelephonyError(
      "ElevenLabs did not start the call: the response carried no conversation id.",
      502,
      payload,
    );
  }

  return {
    conversationId,
    sipCallId: asString(payload.sip_call_id),
    message: asString(payload.message) ?? "",
  };
};

type ConversationResponse = {
  status?: unknown;
  transcript?: unknown;
  metadata?: unknown;
};

/**
 * ElevenLabs attributes each turn to "user" or "agent". The office calls the
 * other party the callee, since from here the user is the operator watching.
 */
const mapRole = (role: unknown): TranscriptTurn["speaker"] | null => {
  if (role === "agent") return "agent";
  if (role === "user") return "callee";
  return null;
};

export type ConversationSnapshot = {
  status: string | null;
  /**
   * Why the call ended, when ElevenLabs said. Worth carrying: "failed" alone
   * sends an operator to the dashboard to find out what happened.
   */
  terminationReason: string | null;
  /** The number the agent called from, which only ElevenLabs knows. */
  agentNumber: string | null;
  turns: Array<Pick<TranscriptTurn, "speaker" | "text">>;
};

/** Reads a conversation's transcript so far. */
export const fetchConversation = async (
  conversationId: string,
  config: VoiceAgentConfig = resolveVoiceAgentConfig(),
): Promise<ConversationSnapshot> => {
  const id = conversationId.trim();
  if (!id) {
    throw new TelephonyError("A conversation id is required.");
  }

  const payload = await request<ConversationResponse>(
    config,
    `v1/convai/conversations/${encodeURIComponent(id)}`,
    { method: "GET" },
  );

  const rawTurns = Array.isArray(payload.transcript) ? payload.transcript : [];
  const turns = rawTurns
    .map((entry) => {
      const record = entry as Record<string, unknown> | null;
      if (!record) return null;
      const speaker = mapRole(record.role);
      const text = asString(record.message);
      // A turn with no text is a tool call or an interruption marker, not
      // something a person said; it has no place in a spoken transcript.
      if (!speaker || !text) return null;
      return { speaker, text };
    })
    .filter((turn): turn is Pick<TranscriptTurn, "speaker" | "text"> => turn !== null);

  const metadata = (payload.metadata ?? {}) as Record<string, unknown>;
  const error = (metadata.error ?? {}) as Record<string, unknown>;
  const phoneCall = (metadata.phone_call ?? {}) as Record<string, unknown>;

  return {
    status: asString(payload.status),
    terminationReason:
      asString(metadata.termination_reason) ?? asString(error.reason),
    agentNumber: asString(phoneCall.agent_number),
    turns,
  };
};
