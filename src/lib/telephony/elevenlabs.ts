import {
  buildOfficeAgentFirstMessage,
  buildOfficeAgentPrompt,
  type OfficeCallerIdentity,
} from "@/lib/telephony/agentPrompt";
import {
  TelephonyError,
  assertE164,
  type TranscriptTurn,
} from "@/lib/telephony/types";
import { resolveVoiceAgentConfig, type VoiceAgentConfig } from "@/lib/telephony/voiceAgent";
import { t } from "@/lib/i18n";

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
      t("libTelephony.elevenLabsUnreachable", { message: error instanceof Error ? error.message : String(error) }),
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
      t("libTelephony.elevenLabsStatus", { status: response.status });
    // The status is preserved: 401 is a bad key, 422 a bad request body, and
    // telling those apart saves a deployment looking in the wrong place.
    throw new TelephonyError(`ElevenLabs: ${detail}`, response.status, parsed);
  }

  return (parsed ?? {}) as T;
};

/**
 * Adds the one hint a refused override needs.
 *
 * ElevenLabs rejects a per-call prompt unless the agent allows overrides, and
 * its own message does not say where that switch is. Appended only to a 4xx,
 * and phrased as a likely cause rather than a diagnosis, because the same
 * status also covers an unrelated bad request.
 */
const withOverrideHint = (error: unknown): unknown => {
  if (
    !(error instanceof TelephonyError) ||
    error.status < 400 ||
    error.status >= 500
  ) {
    return error;
  }
  return new TelephonyError(
    t("libTelephony.overrideHint", { message: error.message }),
    error.status,
    error.cause,
  );
};

/**
 * Asks the voice agent to call a number.
 *
 * One ElevenLabs agent and one number serve the whole office, so who is
 * speaking is decided per call: the caller's prompt and opening line are sent
 * as an override, and the office agent id travels as a dynamic variable so the
 * conversation can be traced back to the desk that placed it.
 *
 * The override needs "allow overrides" enabled for prompt and first message on
 * the agent in the ElevenLabs dashboard. Without it ElevenLabs refuses the
 * call, and that refusal is reported with the hint rather than swallowed.
 */
export const placeVoiceAgentCall = async (
  params: { toNumber: string; caller: OfficeCallerIdentity },
  config: VoiceAgentConfig = resolveVoiceAgentConfig(),
): Promise<PlacedVoiceAgentCall> => {
  const toNumber = assertE164(params.toNumber, "toNumber");
  const officeAgentId = params.caller.agentId.trim();
  if (!officeAgentId) {
    throw new TelephonyError(t("libTelephony.agentIdRequired"));
  }

  // Composed here from the office's own facts. A raw prompt is never accepted
  // from a caller, so the AI disclosure cannot be edited out.
  const prompt = buildOfficeAgentPrompt(params.caller);
  const firstMessage = buildOfficeAgentFirstMessage(params.caller);

  let payload: OutboundCallResponse;
  try {
    payload = await request<OutboundCallResponse>(
      config,
      "v1/convai/sip-trunk/outbound-call",
      {
        method: "POST",
        body: {
          agent_id: config.agentId,
          agent_phone_number_id: config.phoneNumberId,
          to_number: toNumber,
          conversation_initiation_client_data: {
            conversation_config_override: {
              agent: { prompt: { prompt }, first_message: firstMessage },
            },
            dynamic_variables: { office_agent_id: officeAgentId },
          },
        },
      },
    );
  } catch (error) {
    throw withOverrideHint(error);
  }

  // Two different failures, reported apart: the service refusing says why,
  // while a response with no conversation id leaves nothing to follow and its
  // own "ok" message would explain nothing.
  if (payload.success === false) {
    throw new TelephonyError(
      asString(payload.message) ?? t("libTelephony.callRefused"),
      502,
      payload,
    );
  }

  const conversationId = asString(payload.conversation_id);
  if (!conversationId) {
    throw new TelephonyError(
      t("libTelephony.noConversationId"),
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
    throw new TelephonyError(t("libTelephony.conversationIdRequired"));
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

/**
 * The recording of a finished call.
 *
 * Streamed back rather than buffered: a long call is a large file, and this
 * server has no reason to hold one in memory. The API key never leaves the
 * server, which is why the browser fetches audio through this app at all.
 *
 * There is no live equivalent. ElevenLabs exposes the recording of a
 * conversation, not a tap on one in progress: the signed-url and token
 * endpoints start a new conversation as a client, they do not attach to a
 * call already running on a SIP trunk.
 */
export const fetchConversationAudio = async (
  conversationId: string,
  config: VoiceAgentConfig = resolveVoiceAgentConfig(),
): Promise<{ body: ReadableStream<Uint8Array>; contentType: string }> => {
  const id = conversationId.trim();
  if (!id) {
    throw new TelephonyError(t("libTelephony.conversationIdRequired"));
  }

  const url = new URL(
    `v1/convai/conversations/${encodeURIComponent(id)}/audio`,
    `${ELEVENLABS_API_BASE}/`,
  );

  let response: Response;
  try {
    response = await fetch(url, { headers: { "xi-api-key": config.apiKey } });
  } catch (error) {
    throw new TelephonyError(
      t("libTelephony.elevenLabsUnreachable", { message: error instanceof Error ? error.message : String(error) }),
      502,
      error,
    );
  }

  if (!response.ok || !response.body) {
    // A recording is absent for a call that never connected, and not yet
    // written for one that just ended; the status tells those apart.
    const detail = await response.text().catch(() => "");
    throw new TelephonyError(
      `ElevenLabs: ${detail.trim() || t("libTelephony.recordingStatus", { status: response.status })}`,
      response.ok ? 502 : response.status,
    );
  }

  return {
    body: response.body,
    contentType: response.headers.get("Content-Type") || "audio/mpeg",
  };
};
