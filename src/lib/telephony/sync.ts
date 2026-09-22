import { fetchConversation } from "@/lib/telephony/elevenlabs";
import {
  appendTurn,
  requireCall,
  setCallFrom,
  setProviderTurnCount,
  updateCallStatus,
} from "@/lib/telephony/store";
import { isTerminalCallStatus, type CallRecord, type CallStatus } from "@/lib/telephony/types";
import { resolveVoiceAgentConfig, type VoiceAgentConfig } from "@/lib/telephony/voiceAgent";

/**
 * Keeps the office's copy of a call level with the provider's.
 *
 * The provider returns the whole conversation on every read, so reconciling is
 * a watermark rather than a diff: turns past the count already taken are new,
 * everything before it is already on screen. That holds because the transcript
 * is append-only — a turn is never rewritten once spoken.
 *
 * Operator and system lines live in the same transcript but are not the
 * provider's, which is why the watermark counts provider turns rather than
 * using the transcript's length.
 */

/**
 * ElevenLabs conversation status → the office's call status.
 *
 * "initiated" is a call placed and not yet answered, which the office calls
 * ringing. "processing" is the line already dropped while the transcript is
 * still being finalised; it is not terminal, so the office keeps reading.
 */
export const mapConversationStatus = (status: string | null): CallStatus | null => {
  switch (status) {
    case "initiated":
      return "ringing";
    case "in-progress":
      return "in-progress";
    case "processing":
      return "processing";
    case "done":
      return "completed";
    case "failed":
      return "failed";
    default:
      // An unknown status is left alone rather than guessed at: showing the
      // last status we understood beats inventing one.
      return null;
  }
};

/**
 * Reads a call from the provider and folds what is new into the store.
 *
 * A call that has already finished is not re-read: its transcript is final and
 * a poll would only spend a request. The updated record is returned either way.
 */
export const syncCall = async (
  sid: string,
  config: VoiceAgentConfig = resolveVoiceAgentConfig(),
): Promise<CallRecord> => {
  const existing = requireCall(sid);
  if (isTerminalCallStatus(existing.status)) {
    return existing;
  }

  const snapshot = await fetchConversation(sid, config);

  const fresh = snapshot.turns.slice(existing.providerTurnCount);
  for (const turn of fresh) {
    appendTurn(sid, { speaker: turn.speaker, text: turn.text });
  }
  if (fresh.length > 0) {
    setProviderTurnCount(sid, snapshot.turns.length);
  }

  if (!existing.from && snapshot.agentNumber) {
    setCallFrom(sid, snapshot.agentNumber);
  }

  const status = mapConversationStatus(snapshot.status);
  if (status && status !== existing.status) {
    updateCallStatus(
      sid,
      status,
      status === "failed" ? snapshot.terminationReason : undefined,
    );
  }

  return requireCall(sid);
};

/**
 * Syncs several calls, reporting a failure per call rather than as a whole.
 *
 * The office polls every live call at once; one conversation the provider
 * cannot serve must not blank the rest of the feed, so a failed read leaves
 * that call showing its last known state.
 */
export const syncCalls = async (
  sids: string[],
  config: VoiceAgentConfig = resolveVoiceAgentConfig(),
): Promise<Map<string, string>> => {
  const errors = new Map<string, string>();
  await Promise.all(
    sids.map(async (sid) => {
      try {
        await syncCall(sid, config);
      } catch (error) {
        errors.set(sid, error instanceof Error ? error.message : String(error));
      }
    }),
  );
  return errors;
};
