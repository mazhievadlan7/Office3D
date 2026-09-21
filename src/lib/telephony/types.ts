/**
 * Agent phone calls.
 *
 * An agent places a real call through Twilio, speaks to whoever answers, and
 * the conversation appears in the office as it happens. The operator watching
 * can send the agent a line to say next, which is the point of the whole
 * feature: a human stays in the loop on a live call rather than reviewing a
 * transcript afterwards.
 *
 * This module holds the shapes only. Nothing here talks to Twilio.
 */

export type CallDirection = "outbound";

/**
 * Mirrors Twilio's call status vocabulary, plus "failed" for a call we could
 * never place. Kept as a closed union so the UI cannot be handed a status it
 * has no rendering for.
 */
export type CallStatus =
  | "queued"
  | "ringing"
  | "in-progress"
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
  /** Twilio's call SID, and our identifier for the call. */
  sid: string;
  direction: CallDirection;
  status: CallStatus;
  /** E.164 number that was dialled. */
  to: string;
  from: string;
  /** The agent placing the call, so the office knows who is at the phone. */
  agentId: string;
  startedAt: string;
  endedAt: string | null;
  /** Set when Twilio reported why a call did not complete. */
  errorMessage: string | null;
  transcript: TranscriptTurn[];
  /**
   * What the agent should say at its next turn. The operator writes here
   * mid-call; the TwiML endpoint drains it when Twilio next asks what to do.
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
 * paid API, and a wrong one reaches a stranger. Twilio would reject most bad
 * input, but not a well-formed number that is simply not the one intended,
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

/** Spoken text is capped: TwiML has limits and a runaway prompt costs money. */
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
