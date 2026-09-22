/**
 * Agent phone calls.
 *
 * An agent places a real call through the voice-agent provider, speaks to
 * whoever answers, and the conversation appears in the office as it happens,
 * so a human can watch a live call rather than review a transcript afterwards.
 *
 * This module holds the shapes only. Nothing here talks to a provider.
 */

export type CallDirection = "outbound";

/**
 * The life of an outbound call. Kept as a closed union so the UI cannot be
 * handed a status it has no rendering for.
 *
 * "processing" is the gap between the line dropping and the provider finishing
 * the transcript: the conversation is over but the record is not final, so it
 * is deliberately not terminal and the office keeps reading until it settles.
 */
export type CallStatus =
  | "queued"
  | "ringing"
  | "in-progress"
  | "processing"
  | "completed"
  | "busy"
  | "no-answer"
  | "canceled"
  | "failed";

export const TERMINAL_CALL_STATUSES: ReadonlySet<CallStatus> = new Set<CallStatus>([
  "completed",
  "busy",
  "no-answer",
  "canceled",
  "failed",
]);

export const isTerminalCallStatus = (status: CallStatus): boolean =>
  TERMINAL_CALL_STATUSES.has(status);

/** Who produced a line of the conversation. */
export type TranscriptSpeaker =
  /** The agent, via text-to-speech. */
  | "agent"
  /** The person on the other end, via speech recognition. */
  | "callee"
  /** The operator, injecting a line for the agent to say. */
  | "operator"
  /** The system: dialing, answered, hung up. */
  | "system";

export type TranscriptTurn = {
  id: string;
  speaker: TranscriptSpeaker;
  text: string;
  /** ISO timestamp of when the turn was recorded. */
  at: string;
  /**
   * Speech recognition confidence, 0..1, when the provider reported one.
   * Null for anything not transcribed — an agent line is known exactly.
   */
  confidence: number | null;
};

export type CallRecord = {
  /** The provider's conversation id, and our identifier for the call. */
  sid: string;
  direction: CallDirection;
  status: CallStatus;
  /** E.164 number that was dialled. */
  to: string;
  /**
   * The number the office called from. Null until the provider reports it:
   * this deployment holds a phone number id, not the number behind it, so
   * filling this in at dial time would mean inventing it.
   */
  from: string | null;
  /** The agent placing the call, so the office knows who is at the phone. */
  agentId: string;
  startedAt: string;
  endedAt: string | null;
  /** Set when the provider reported why a call did not complete. */
  errorMessage: string | null;
  transcript: TranscriptTurn[];
  /**
   * How many turns of this transcript came from the provider. The provider
   * returns the whole conversation on every read, so this is the watermark
   * that keeps a poll from appending lines the office already shows.
   */
  providerTurnCount: number;
  /**
   * What the agent should say at its next turn. The operator writes here
   * mid-call.
   *
   * Nothing consumes it yet: the provider runs the conversation, and steering
   * it mid-call is a separate piece of work. It is kept because the store is
   * the right place for it, not because the feature is finished.
   */
  pendingSay: string | null;
};

export class TelephonyError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TelephonyError";
  }
}

/**
 * E.164: a leading + and 8–15 digits.
 *
 * Validated before dialling rather than after: a malformed number reaches a
 * paid API, and a wrong one reaches a stranger. The provider would reject most
 * bad input, but not a well-formed number that is simply not the one intended,
 * so the caller is still responsible for what it passes.
 */
const E164 = /^\+[1-9]\d{7,14}$/;

export const assertE164 = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (!E164.test(trimmed)) {
    throw new TelephonyError(
      `${field} must be an E.164 phone number such as +14155550100, got "${value}".`,
    );
  }
  return trimmed;
};

/** Spoken text is capped: a runaway prompt costs money and time on the line. */
export const MAX_SPOKEN_CHARS = 1500;

export const assertSpeakableText = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new TelephonyError(`${field} is required.`);
  }
  if (trimmed.length > MAX_SPOKEN_CHARS) {
    throw new TelephonyError(
      `${field} is ${trimmed.length} characters, over the ${MAX_SPOKEN_CHARS} limit.`,
    );
  }
  return trimmed;
};
