import { afterEach, describe, expect, it, vi } from "vitest";

import type { OfficeCallerIdentity } from "@/lib/telephony/agentPrompt";
import { fetchConversation, placeVoiceAgentCall } from "@/lib/telephony/elevenlabs";
import type { VoiceAgentConfig } from "@/lib/telephony/voiceAgent";

const caller = (overrides: Partial<OfficeCallerIdentity> = {}): OfficeCallerIdentity => ({
  agentId: "agent-1",
  agentName: "Nova",
  agentRole: "Handles overdue invoices",
  organisation: "Northwind",
  ...overrides,
});

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("placeVoiceAgentCall", () => {
  it("posts_the_call_in_the_shape_elevenlabs_expects", async () => {
    const spy = vi
      .fn()
      .mockResolvedValue(
        json({ success: true, message: "ok", conversation_id: "conv_1", sip_call_id: "sip_1" }),
      );
    vi.stubGlobal("fetch", spy);

    const placed = await placeVoiceAgentCall(
      { toNumber: "+447700900123", caller: caller() },
      CONFIG,
    );

    const [url, init] = spy.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("xi-key");

    // Field names are snake_case on the wire; these were taken from the
    // official SDK's serializers rather than guessed.
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({
      agent_id: "agent_abc",
      agent_phone_number_id: "phnum_123",
      to_number: "+447700900123",
      conversation_initiation_client_data: {
        dynamic_variables: { office_agent_id: "agent-1" },
      },
    });

    // One agent and one number serve the whole office, so who is speaking is
    // sent per call as an override rather than set in the dashboard.
    const override =
      sent.conversation_initiation_client_data.conversation_config_override.agent;
    expect(override.prompt.prompt).toContain("You are Nova, calling on behalf of Northwind.");
    expect(override.prompt.prompt).toContain("Handles overdue invoices");
    expect(override.first_message).toBe(
      "Hello, this is Nova, an AI assistant calling from Northwind. Do you have a moment?",
    );

    expect(placed).toEqual({
      conversationId: "conv_1",
      sipCallId: "sip_1",
      message: "ok",
    });
  });

  it("rejects_a_bad_number_before_spending_a_call", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    await expect(
      placeVoiceAgentCall({ toNumber: "0123", caller: caller() }, CONFIG),
    ).rejects.toThrow(/E.164/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("requires_the_office_agent_placing_the_call", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(
      placeVoiceAgentCall({ toNumber: "+14155550100", caller: caller({ agentId: "  " }) }, CONFIG),
    ).rejects.toThrow(/agentId is required/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("treats_a_success_false_body_as_a_failure", async () => {
    // A 200 with success:false is still a call that did not happen; reporting
    // it as placed would leave the office showing a conversation that is not.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ success: false, message: "No credit" })),
    );

    await expect(
      placeVoiceAgentCall({ toNumber: "+14155550100", caller: caller() }, CONFIG),
    ).rejects.toThrow(/No credit/);
  });

  it("treats_a_missing_conversation_id_as_a_failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ success: true, message: "ok" })));
    await expect(
      placeVoiceAgentCall({ toNumber: "+14155550100", caller: caller() }, CONFIG),
    ).rejects.toThrow(/did not start the call/);
  });

  it("preserves_the_api_status_so_a_bad_key_is_distinguishable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ detail: "Invalid API key" }, 401)));

    await expect(
      placeVoiceAgentCall({ toNumber: "+14155550100", caller: caller() }, CONFIG),
    ).rejects.toMatchObject({
      status: 401,
      // The provider's own words, plus the one thing its message cannot say:
      // where the override switch lives.
      message: expect.stringContaining("ElevenLabs: Invalid API key"),
    });
  });

  it("points_at_the_override_switch_when_the_provider_refuses", async () => {
    // ElevenLabs rejects a per-call prompt unless the agent allows overrides,
    // and its message does not say where that setting is.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ detail: "Overrides are not enabled" }, 422)),
    );

    await expect(
      placeVoiceAgentCall({ toNumber: "+14155550100", caller: caller() }, CONFIG),
    ).rejects.toThrow(/allow overrides/);
  });

  it("does_not_add_the_override_hint_to_a_server_side_failure", async () => {
    // A 500 is not a misconfigured agent; the hint would send someone to the
    // wrong screen.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ detail: "Boom" }, 500)));

    await expect(
      placeVoiceAgentCall({ toNumber: "+14155550100", caller: caller() }, CONFIG),
    ).rejects.toThrow(/^ElevenLabs: Boom$/);
  });

  it("reports_a_transport_failure_as_a_gateway_error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ENOTFOUND")));
    await expect(
      placeVoiceAgentCall({ toNumber: "+14155550100", caller: caller() }, CONFIG),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe("fetchConversation", () => {
  it("maps_roles_onto_the_office_transcript", async () => {
    const spy = vi.fn().mockResolvedValue(
      json({
        status: "in-progress",
        transcript: [
          { role: "agent", message: "Hello, this is the assistant." },
          { role: "user", message: "Go ahead." },
        ],
      }),
    );
    vi.stubGlobal("fetch", spy);

    const snapshot = await fetchConversation("conv_1", CONFIG);

    expect(String(spy.mock.calls[0][0])).toBe(
      "https://api.elevenlabs.io/v1/convai/conversations/conv_1",
    );
    // ElevenLabs says "user"; from the office the other party is the callee,
    // since the user here is the operator watching.
    expect(snapshot).toEqual({
      status: "in-progress",
      terminationReason: null,
      agentNumber: null,
      turns: [
        { speaker: "agent", text: "Hello, this is the assistant." },
        { speaker: "callee", text: "Go ahead." },
      ],
    });
  });

  it("drops_turns_that_carry_no_speech", async () => {
    // Tool calls and interruption markers are turns with no message; they are
    // not something a person said.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          transcript: [
            { role: "agent", message: "Hi." },
            { role: "agent", message: null, tool_calls: [{ name: "lookup" }] },
            { role: "system", message: "internal" },
            { role: "user", message: "   " },
          ],
        }),
      ),
    );

    expect((await fetchConversation("conv_1", CONFIG)).turns).toEqual([
      { speaker: "agent", text: "Hi." },
    ]);
  });

  it("survives_a_conversation_with_no_transcript_yet", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ status: "initiated" })));
    expect(await fetchConversation("conv_1", CONFIG)).toEqual({
      status: "initiated",
      terminationReason: null,
      agentNumber: null,
      turns: [],
    });
  });

  it("carries_why_a_call_ended_and_the_number_it_came_from", async () => {
    // "failed" on its own sends an operator to the dashboard to find out what
    // happened; the reason and the caller id are both only ElevenLabs' to say.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          status: "failed",
          transcript: [],
          metadata: {
            termination_reason: "The number was unreachable.",
            phone_call: { type: "sip_trunking", agent_number: "+441234567890" },
          },
        }),
      ),
    );

    expect(await fetchConversation("conv_1", CONFIG)).toMatchObject({
      terminationReason: "The number was unreachable.",
      agentNumber: "+441234567890",
    });
  });

  it("falls_back_to_the_error_reason_when_no_termination_reason_is_given", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({ status: "failed", metadata: { error: { code: 500, reason: "SIP 503" } } }),
      ),
    );

    expect((await fetchConversation("conv_1", CONFIG)).terminationReason).toBe("SIP 503");
  });

  it("requires_a_conversation_id", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(fetchConversation("  ", CONFIG)).rejects.toThrow(/conversation id is required/);
    expect(spy).not.toHaveBeenCalled();
  });
});
