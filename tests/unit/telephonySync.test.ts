import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCall, getCall, resetCallStore, updateCallStatus } from "@/lib/telephony/store";
import { mapConversationStatus, syncCall, syncCalls } from "@/lib/telephony/sync";
import type { VoiceAgentConfig } from "@/lib/telephony/voiceAgent";

const CONFIG: VoiceAgentConfig = {
  provider: "elevenlabs",
  apiKey: "xi-key",
  agentId: "agent_abc",
  phoneNumberId: "phnum_123",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const seed = (sid = "conv_1") =>
  createCall({ sid, to: "+447700900123", agentId: "agent-1", status: "ringing" });

beforeEach(() => {
  resetCallStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetCallStore();
});

describe("mapConversationStatus", () => {
  it("maps_every_status_the_provider_documents", () => {
    expect(mapConversationStatus("initiated")).toBe("ringing");
    expect(mapConversationStatus("in-progress")).toBe("in-progress");
    expect(mapConversationStatus("done")).toBe("completed");
    expect(mapConversationStatus("failed")).toBe("failed");
  });

  it("keeps_processing_off_the_terminal_list_so_the_feed_keeps_reading", () => {
    // The line has dropped but the transcript is still being finalised; ending
    // the call here would freeze the feed short of the last turns.
    expect(mapConversationStatus("processing")).toBe("processing");
  });

  it("leaves_an_unknown_status_alone_rather_than_guessing", () => {
    expect(mapConversationStatus("something-new")).toBeNull();
    expect(mapConversationStatus(null)).toBeNull();
  });
});

describe("syncCall", () => {
  it("appends_only_turns_the_office_has_not_seen", async () => {
    seed();
    const spy = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          status: "in-progress",
          transcript: [{ role: "agent", message: "Hello." }],
        }),
      )
      .mockResolvedValueOnce(
        json({
          status: "in-progress",
          transcript: [
            { role: "agent", message: "Hello." },
            { role: "user", message: "Hi there." },
          ],
        }),
      );
    vi.stubGlobal("fetch", spy);

    await syncCall("conv_1", CONFIG);
    const after = await syncCall("conv_1", CONFIG);

    // The provider returns the whole conversation each time; replaying it
    // would show every line twice.
    expect(after.transcript.map((turn) => turn.text)).toEqual(["Hello.", "Hi there."]);
    expect(after.providerTurnCount).toBe(2);
    expect(after.status).toBe("in-progress");
  });

  it("does_not_recount_operator_lines_as_the_providers", async () => {
    const call = seed();
    // An operator line shares the transcript but is not the provider's, so the
    // watermark must count provider turns rather than transcript length.
    call.transcript.push({
      id: "op-1",
      speaker: "operator",
      text: "Ask about the invoice.",
      at: new Date().toISOString(),
      confidence: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({ status: "in-progress", transcript: [{ role: "agent", message: "Hello." }] }),
      ),
    );

    const after = await syncCall("conv_1", CONFIG);

    expect(after.transcript.map((turn) => turn.speaker)).toEqual(["operator", "agent"]);
  });

  it("records_why_a_failed_call_failed", async () => {
    seed();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          status: "failed",
          transcript: [],
          metadata: { termination_reason: "The number was unreachable." },
        }),
      ),
    );

    const after = await syncCall("conv_1", CONFIG);

    expect(after.status).toBe("failed");
    expect(after.errorMessage).toBe("The number was unreachable.");
    expect(after.endedAt).not.toBeNull();
  });

  it("fills_in_the_number_the_office_called_from_once_the_provider_says", async () => {
    seed();
    expect(getCall("conv_1")?.from).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          status: "in-progress",
          transcript: [],
          metadata: { phone_call: { type: "sip_trunking", agent_number: "+441234567890" } },
        }),
      ),
    );

    expect((await syncCall("conv_1", CONFIG)).from).toBe("+441234567890");
  });

  it("does_not_re_read_a_call_that_already_finished", async () => {
    seed();
    updateCallStatus("conv_1", "completed");
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    await syncCall("conv_1", CONFIG);

    expect(spy).not.toHaveBeenCalled();
  });

  it("fails_loudly_for_a_call_the_office_does_not_have", async () => {
    await expect(syncCall("conv_missing", CONFIG)).rejects.toMatchObject({ status: 404 });
  });
});

describe("syncCalls", () => {
  it("keeps_one_unreadable_call_from_blanking_the_rest", async () => {
    seed("conv_ok");
    seed("conv_bad");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: URL) =>
        String(url).includes("conv_bad")
          ? Promise.resolve(json({ detail: "Not found" }, 404))
          : Promise.resolve(
              json({ status: "in-progress", transcript: [{ role: "agent", message: "Hi." }] }),
            ),
      ),
    );

    const errors = await syncCalls(["conv_ok", "conv_bad"], CONFIG);

    expect([...errors.keys()]).toEqual(["conv_bad"]);
    expect(getCall("conv_ok")?.transcript).toHaveLength(1);
    // The call that could not be read keeps its last known state.
    expect(getCall("conv_bad")?.status).toBe("ringing");
  });
});
