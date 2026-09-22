import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as agentToolRoute } from "@/app/api/telephony/agent-tool/instruction/route";
import { GET as audioRoute } from "@/app/api/telephony/calls/[sid]/audio/route";
import { POST as sayRoute } from "@/app/api/telephony/calls/[sid]/say/route";
import { createCall, getCall, resetCallStore, updateCallStatus } from "@/lib/telephony/store";
import { MAX_SPOKEN_CHARS } from "@/lib/telephony/types";
import {
  TELEPHONY_WEBHOOK_HEADER,
  assertWebhookAuthorized,
  describeOperatorChannelReadiness,
} from "@/lib/telephony/webhookAuth";

const ORIGINAL_ENV = { ...process.env };

const SECRET = "a-long-enough-webhook-secret-value";

const CHANNEL_ENV = {
  ELEVENLABS_API_KEY: "xi-key",
  ELEVENLABS_AGENT_ID: "agent_abc",
  ELEVENLABS_PHONE_NUMBER_ID: "phnum_123",
  OFFICE3D_TELEPHONY_WEBHOOK_SECRET: SECRET,
  OFFICE3D_PUBLIC_URL: "https://office.example.com",
};

const say = (sid: string, body: unknown) =>
  sayRoute(
    new Request(`http://localhost/api/telephony/calls/${sid}/say`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ sid }) },
  );

const agentTool = (body: unknown, secret: string | null = SECRET) =>
  agentToolRoute(
    new Request("http://localhost/api/telephony/agent-tool/instruction", {
      method: "POST",
      headers: secret ? { [TELEPHONY_WEBHOOK_HEADER]: secret } : {},
      body: JSON.stringify(body),
    }),
  );

const audio = (sid: string) =>
  audioRoute(new Request(`http://localhost/api/telephony/calls/${sid}/audio`), {
    params: Promise.resolve({ sid }),
  });

const seed = (sid = "conv_1") =>
  createCall({ sid, to: "+447700900123", agentId: "agent-1", status: "in-progress" });

beforeEach(() => {
  resetCallStore();
  Object.assign(process.env, CHANNEL_ENV);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetCallStore();
});

describe("describeOperatorChannelReadiness", () => {
  it("needs_both_a_secret_and_a_url_the_provider_can_reach", () => {
    expect(describeOperatorChannelReadiness(CHANNEL_ENV as unknown as NodeJS.ProcessEnv))
      .toEqual({ configured: true, missing: [] });

    expect(
      describeOperatorChannelReadiness({
        OFFICE3D_TELEPHONY_WEBHOOK_SECRET: SECRET,
      } as unknown as NodeJS.ProcessEnv).missing,
    ).toEqual(["OFFICE3D_PUBLIC_URL"]);
  });

  it("counts_a_too_short_secret_as_missing", () => {
    // A short secret on a public endpoint is worse than none: it looks
    // protected and is not.
    expect(
      describeOperatorChannelReadiness({
        ...CHANNEL_ENV,
        OFFICE3D_TELEPHONY_WEBHOOK_SECRET: "short",
      } as unknown as NodeJS.ProcessEnv).missing,
    ).toContain("OFFICE3D_TELEPHONY_WEBHOOK_SECRET");
  });
});

describe("assertWebhookAuthorized", () => {
  const withHeader = (value?: string) =>
    new Request("http://localhost/x", {
      headers: value ? { [TELEPHONY_WEBHOOK_HEADER]: value } : {},
    });

  it("accepts_the_configured_secret", () => {
    expect(() =>
      assertWebhookAuthorized(withHeader(SECRET), CHANNEL_ENV as unknown as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("rejects_a_wrong_or_absent_secret_with_a_401", () => {
    for (const presented of [undefined, "", "not-the-secret-but-long-enough"]) {
      expect(() =>
        assertWebhookAuthorized(
          withHeader(presented),
          CHANNEL_ENV as unknown as NodeJS.ProcessEnv,
        ),
      ).toThrow(/Нет доступа/);
    }
  });

  it("is_closed_rather_than_open_when_no_secret_is_configured", () => {
    // A deployment that has not set a secret has not opted into a public
    // callback; defaulting to open would expose it.
    expect(() =>
      assertWebhookAuthorized(withHeader("anything"), {} as unknown as NodeJS.ProcessEnv),
    ).toThrow(/OFFICE3D_TELEPHONY_WEBHOOK_SECRET/);
  });
});

describe("POST /api/telephony/calls/[sid]/say", () => {
  it("queues_the_note_and_shows_it_in_the_transcript_at_once", async () => {
    seed();
    const response = await say("conv_1", { text: "  Ask when they can pay.  " });
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.call.pendingSay).toBe("Ask when they can pay.");
    // Recorded as the operator's, so the transcript shows what was asked for
    // as well as what the agent went on to say.
    expect(body.turn).toMatchObject({ speaker: "operator", text: "Ask when they can pay." });
  });

  it("replaces_a_note_the_agent_has_not_collected_yet", async () => {
    seed();
    await say("conv_1", { text: "First thought." });
    await say("conv_1", { text: "No, ask about the invoice." });

    expect(getCall("conv_1")?.pendingSay).toBe("No, ask about the invoice.");
  });

  it("refuses_a_note_on_a_call_that_has_ended", async () => {
    seed();
    updateCallStatus("conv_1", "completed");

    const response = await say("conv_1", { text: "Too late." });
    expect(response.status).toBe(409);
    expect(getCall("conv_1")?.pendingSay).toBeNull();
  });

  it("refuses_rather_than_queues_when_the_channel_is_not_configured", async () => {
    delete process.env.OFFICE3D_PUBLIC_URL;
    seed();

    const response = await say("conv_1", { text: "Nobody can collect this." });

    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("OFFICE3D_PUBLIC_URL");
    // Nothing queued, and nothing in the transcript looking delivered.
    expect(getCall("conv_1")?.pendingSay).toBeNull();
    expect(getCall("conv_1")?.transcript).toHaveLength(0);
  });

  it("rejects_empty_and_runaway_text", async () => {
    seed();
    expect((await say("conv_1", { text: "   " })).status).toBe(400);
    expect((await say("conv_1", { text: "x".repeat(MAX_SPOKEN_CHARS + 1) })).status).toBe(400);
  });

  it("404s_for_a_call_the_office_does_not_have", async () => {
    expect((await say("conv_missing", { text: "Hello." })).status).toBe(404);
  });
});

describe("POST /api/telephony/agent-tool/instruction", () => {
  it("hands_the_note_over_exactly_once", async () => {
    seed();
    await say("conv_1", { text: "Ask when they can pay." });

    const first = await (await agentTool({ conversation_id: "conv_1" })).json();
    const second = await (await agentTool({ conversation_id: "conv_1" })).json();

    expect(first.instruction).toBe("Ask when they can pay.");
    // Delivered twice, the agent would say the same line again on its next
    // turn.
    expect(second.instruction).toBeNull();
  });

  it("answers_with_nothing_when_no_note_is_waiting", async () => {
    seed();
    expect((await (await agentTool({ conversation_id: "conv_1" })).json()).instruction).toBeNull();
  });

  it("accepts_either_spelling_of_the_conversation_id", async () => {
    seed();
    await say("conv_1", { text: "Wrap up." });
    expect((await (await agentTool({ conversationId: "conv_1" })).json()).instruction).toBe(
      "Wrap up.",
    );
  });

  it("refuses_a_request_without_the_secret", async () => {
    seed();
    await say("conv_1", { text: "Secret business." });

    const response = await agentTool({ conversation_id: "conv_1" }, null);

    expect(response.status).toBe(401);
    // The note is still queued: a rejected caller must not consume it.
    expect(getCall("conv_1")?.pendingSay).toBe("Secret business.");
  });

  it("does_not_reveal_which_conversations_exist", async () => {
    // An unknown id gets the same empty answer as a known one with nothing
    // queued, so an authenticated caller cannot enumerate calls.
    const unknown = await agentTool({ conversation_id: "conv_nope" });
    expect(unknown.status).toBe(200);
    expect((await unknown.json()).instruction).toBeNull();
  });
});

describe("GET /api/telephony/calls/[sid]/audio", () => {
  it("refuses_a_live_call_rather_than_pretending_to_stream_it", async () => {
    seed();
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    const response = await audio("conv_1");

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/прослушать звонок в реальном времени нельзя/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("streams_the_recording_of_a_finished_call", async () => {
    seed();
    updateCallStatus("conv_1", "completed");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "audio/mpeg" } },
        ),
      ),
    );

    const response = await audio("conv_1");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    // A recording of somebody's conversation: cached by the one browser that
    // asked for it, never by anything in between.
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=3600");
  });

  it("passes_the_providers_status_through_when_there_is_no_recording", async () => {
    seed();
    updateCallStatus("conv_1", "failed");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));

    expect((await audio("conv_1")).status).toBe(404);
  });
});
