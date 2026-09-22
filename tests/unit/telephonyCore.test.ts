import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendTurn,
  createCall,
  drainPendingSay,
  getCall,
  listCalls,
  requireCall,
  resetCallStore,
  setPendingSay,
  updateCallStatus,
} from "@/lib/telephony/store";
import {
  MAX_SPOKEN_CHARS,
  TelephonyError,
  assertE164,
  assertSpeakableText,
  isTerminalCallStatus,
} from "@/lib/telephony/types";

beforeEach(() => {
  resetCallStore();
});

afterEach(() => {
  resetCallStore();
});

describe("phone number validation", () => {
  it("accepts_e164_and_rejects_everything_else", () => {
    // A malformed number reaches a paid API; a plausible-but-wrong one reaches
    // a stranger. Only the format can be checked here.
    expect(assertE164(" +14155550100 ", "to")).toBe("+14155550100");
    for (const bad of ["14155550100", "+0415555010", "+1 415 555 0100", "", "+1415555010a"]) {
      expect(() => assertE164(bad, "to")).toThrow(TelephonyError);
    }
  });
});

describe("spoken text validation", () => {
  it("requires_text_and_caps_its_length", () => {
    expect(assertSpeakableText("  hello  ", "message")).toBe("hello");
    expect(() => assertSpeakableText("   ", "message")).toThrow(/Не указано поле message/);
    expect(() => assertSpeakableText("x".repeat(MAX_SPOKEN_CHARS + 1), "message")).toThrow(
      /Поле message слишком длинное: символов — 1501, допустимо не больше 1500/,
    );
  });
});

describe("call store", () => {
  const seed = (sid: string) =>
    createCall({
      sid,
      to: "+447700900123",
      from: "+14155550100",
      agentId: "agent-1",
      status: "queued",
    });

  it("records_a_call_and_its_transcript", () => {
    seed("CA1");
    appendTurn("CA1", { speaker: "agent", text: "Hello, calling about the order." });
    appendTurn("CA1", { speaker: "callee", text: "Go ahead.", confidence: 0.92 });

    const call = requireCall("CA1");
    expect(call.transcript.map((turn) => turn.speaker)).toEqual(["agent", "callee"]);
    expect(call.transcript[0].confidence).toBeNull();
    expect(call.transcript[1].confidence).toBe(0.92);
  });

  it("marks_an_end_time_once_and_only_for_terminal_statuses", () => {
    seed("CA1");
    updateCallStatus("CA1", "in-progress");
    expect(requireCall("CA1").endedAt).toBeNull();

    updateCallStatus("CA1", "completed");
    const endedAt = requireCall("CA1").endedAt;
    expect(endedAt).not.toBeNull();

    updateCallStatus("CA1", "failed", "Carrier rejected the call");
    expect(requireCall("CA1").endedAt).toBe(endedAt);
    expect(requireCall("CA1").errorMessage).toBe("Carrier rejected the call");
  });

  it("queues_one_pending_line_and_drains_it_once", () => {
    seed("CA1");
    setPendingSay("CA1", "Ask when they can deliver.");
    setPendingSay("CA1", "Actually, ask about the price.");

    // The later instruction wins: the operator changed their mind before the
    // agent got a turn.
    expect(drainPendingSay("CA1")).toBe("Actually, ask about the price.");
    expect(drainPendingSay("CA1")).toBeNull();
  });

  it("drains_nothing_for_an_unknown_call", () => {
    expect(drainPendingSay("nope")).toBeNull();
  });

  it("reports_an_unknown_call_as_not_found", () => {
    expect(getCall("nope")).toBeNull();
    expect(() => requireCall("nope")).toThrow(/Звонок с SID «nope» не найден/);
  });

  it("lists_calls_newest_first", () => {
    seed("CA1");
    seed("CA2");
    expect(listCalls()).toHaveLength(2);
  });

  it("classifies_terminal_statuses", () => {
    expect(isTerminalCallStatus("in-progress")).toBe(false);
    for (const status of ["completed", "busy", "no-answer", "canceled", "failed"] as const) {
      expect(isTerminalCallStatus(status)).toBe(true);
    }
  });
});
