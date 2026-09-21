import crypto from "node:crypto";

import {
  TelephonyError,
  isTerminalCallStatus,
  type CallRecord,
  type CallStatus,
  type TranscriptSpeaker,
  type TranscriptTurn,
} from "@/lib/telephony/types";

/**
 * Live calls, held in the server process.
 *
 * Deliberately in memory: a call is a live thing measured in minutes, and a
 * restart drops the call along with the record of it, so persisting would
 * describe a conversation that is no longer happening. The consequence is that
 * this does not survive a restart and does not work across multiple instances
 * — a deployment that scales the app horizontally needs a shared store before
 * telephony is reliable, and that is a real limitation rather than an
 * oversight.
 *
 * Finished calls are kept briefly so the transcript can still be read after a
 * hang-up, then evicted to bound memory.
 */

const MAX_RETAINED_CALLS = 50;
const MAX_TRANSCRIPT_TURNS = 500;

const calls = new Map<string, CallRecord>();

/** Newest first, so the office shows the current call at the top. */
export const listCalls = (): CallRecord[] =>
  [...calls.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));

export const getCall = (sid: string): CallRecord | null =>
  calls.get(sid.trim()) ?? null;

export const requireCall = (sid: string): CallRecord => {
  const call = getCall(sid);
  if (!call) {
    throw new TelephonyError(`No call with SID "${sid}".`, 404);
  }
  return call;
};

const evictOldest = (): void => {
  if (calls.size <= MAX_RETAINED_CALLS) return;
  const finished = [...calls.values()]
    .filter((call) => isTerminalCallStatus(call.status))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  // Only finished calls are evicted: dropping a live one would lose the
  // transcript of a conversation still in progress.
  for (const call of finished) {
    if (calls.size <= MAX_RETAINED_CALLS) break;
    calls.delete(call.sid);
  }
};

export const createCall = (params: {
  sid: string;
  to: string;
  from: string;
  agentId: string;
  status: CallStatus;
}): CallRecord => {
  const record: CallRecord = {
    sid: params.sid,
    direction: "outbound",
    status: params.status,
    to: params.to,
    from: params.from,
    agentId: params.agentId,
    startedAt: new Date().toISOString(),
    endedAt: null,
    errorMessage: null,
    transcript: [],
    pendingSay: null,
  };
  calls.set(record.sid, record);
  evictOldest();
  return record;
};

export const appendTurn = (
  sid: string,
  turn: {
    speaker: TranscriptSpeaker;
    text: string;
    confidence?: number | null;
  },
): TranscriptTurn => {
  const call = requireCall(sid);
  const entry: TranscriptTurn = {
    id: crypto.randomUUID(),
    speaker: turn.speaker,
    text: turn.text,
    at: new Date().toISOString(),
    confidence: turn.confidence ?? null,
  };
  call.transcript.push(entry);
  if (call.transcript.length > MAX_TRANSCRIPT_TURNS) {
    // Drop from the front: a very long call keeps its recent exchange, which
    // is what an operator is reading.
    call.transcript.splice(0, call.transcript.length - MAX_TRANSCRIPT_TURNS);
  }
  return entry;
};

export const updateCallStatus = (
  sid: string,
  status: CallStatus,
  errorMessage?: string | null,
): CallRecord => {
  const call = requireCall(sid);
  call.status = status;
  if (errorMessage !== undefined) {
    call.errorMessage = errorMessage;
  }
  if (isTerminalCallStatus(status) && !call.endedAt) {
    call.endedAt = new Date().toISOString();
  }
  return call;
};

/**
 * Queues a line for the agent to speak at its next turn. Replaces anything
 * already queued: when an operator types twice before Twilio comes back, the
 * later instruction is the one they meant.
 */
export const setPendingSay = (sid: string, text: string): CallRecord => {
  const call = requireCall(sid);
  call.pendingSay = text;
  return call;
};

/** Takes the queued line, if any, and clears it so it is never said twice. */
export const drainPendingSay = (sid: string): string | null => {
  const call = getCall(sid);
  if (!call) return null;
  const pending = call.pendingSay;
  call.pendingSay = null;
  return pending;
};

/** Test seam: drops every record. */
export const resetCallStore = (): void => {
  calls.clear();
};
