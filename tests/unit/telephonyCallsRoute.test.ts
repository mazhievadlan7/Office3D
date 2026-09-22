import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getCallRoute } from "@/app/api/telephony/calls/[sid]/route";
import { GET as listCallsRoute, POST as placeCallRoute } from "@/app/api/telephony/calls/route";
import { createCall, getCall, resetCallStore, updateCallStatus } from "@/lib/telephony/store";

const ORIGINAL_ENV = { ...process.env };

const AGENT_ENV = {
  ELEVENLABS_API_KEY: "xi-key",
  ELEVENLABS_AGENT_ID: "agent_abc",
  ELEVENLABS_PHONE_NUMBER_ID: "phnum_123",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const post = (body: unknown) =>
  placeCallRoute(
    new Request("http://localhost/api/telephony/calls", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const readOne = (sid: string) =>
  getCallRoute(new Request(`http://localhost/api/telephony/calls/${sid}`), {
    params: Promise.resolve({ sid }),
  });

beforeEach(() => {
  resetCallStore();
  Object.assign(process.env, AGENT_ENV);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetCallStore();
});

describe("POST /api/telephony/calls", () => {
  it("places_the_call_and_puts_it_in_the_live_feed", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          json({ success: true, conversation_id: "conv_1", sip_call_id: "sip_1" }),
        ),
    );

    const response = await post({ toNumber: "+447700900123", agentId: "agent-1" });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.call).toMatchObject({
      sid: "conv_1",
      to: "+447700900123",
      agentId: "agent-1",
      // Placed, not answered: claiming "in-progress" here would show a
      // connected call to an operator whose phone is still ringing.
      status: "ringing",
      from: null,
      transcript: [],
    });
    expect(body.sipCallId).toBe("sip_1");
    expect(getCall("conv_1")).not.toBeNull();
  });

  it("rejects_a_bad_number_with_a_400_and_never_dials", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    const response = await post({ toNumber: "555-0100", agentId: "agent-1" });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/E\.164/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("requires_the_agent_placing_the_call", async () => {
    const response = await post({ toNumber: "+447700900123" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/agentId is required/);
  });

  it("rejects_a_body_that_is_not_json", async () => {
    const response = await post("not json");
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/JSON/);
  });

  it("answers_503_naming_what_the_deployment_is_missing", async () => {
    delete process.env.ELEVENLABS_AGENT_ID;
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    const response = await post({ toNumber: "+447700900123", agentId: "agent-1" });

    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("ELEVENLABS_AGENT_ID");
    expect(spy).not.toHaveBeenCalled();
  });

  it("passes_the_providers_refusal_status_through", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ detail: "Invalid API key" }, 401)));

    const response = await post({ toNumber: "+447700900123", agentId: "agent-1" });

    expect(response.status).toBe(401);
    expect((await response.json()).error).toContain("Invalid API key");
  });

  it("does_not_double_up_a_conversation_the_feed_already_holds", async () => {
    // A fresh Response each call: a body can only be read once.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () =>
        json({ success: true, conversation_id: "conv_1" }),
      ),
    );

    await post({ toNumber: "+447700900123", agentId: "agent-1" });
    const second = await post({ toNumber: "+447700900123", agentId: "agent-1" });

    expect(second.status).toBe(200);
    expect((await (await listCallsRoute()).json()).calls).toHaveLength(1);
  });
});

describe("GET /api/telephony/calls", () => {
  it("reads_live_calls_fresh_and_returns_their_transcripts", async () => {
    createCall({ sid: "conv_1", to: "+447700900123", agentId: "agent-1", status: "ringing" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          status: "in-progress",
          transcript: [
            { role: "agent", message: "Hello, this is the assistant." },
            { role: "user", message: "Go ahead." },
          ],
        }),
      ),
    );

    const body = await (await listCallsRoute()).json();

    expect(body.ready).toBe(true);
    expect(body.calls[0].status).toBe("in-progress");
    expect(body.calls[0].transcript.map((turn: { speaker: string }) => turn.speaker)).toEqual([
      "agent",
      "callee",
    ]);
    expect(body.syncErrors).toEqual({});
  });

  it("reports_a_call_it_could_not_read_beside_the_ones_it_could", async () => {
    createCall({ sid: "conv_bad", to: "+447700900123", agentId: "agent-1", status: "ringing" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ detail: "Gone" }, 404)));

    const body = await (await listCallsRoute()).json();

    expect(body.calls).toHaveLength(1);
    expect(body.syncErrors.conv_bad).toContain("Gone");
  });

  it("serves_the_feed_unconfigured_without_pretending_to_be_ready", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    const body = await (await listCallsRoute()).json();

    expect(body.ready).toBe(false);
    expect(body.voiceAgent.missing).toContain("ELEVENLABS_API_KEY");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("GET /api/telephony/calls/[sid]", () => {
  it("404s_for_a_call_the_office_never_placed", async () => {
    const response = await readOne("conv_nope");
    expect(response.status).toBe(404);
  });

  it("serves_a_finished_call_without_spending_a_provider_request", async () => {
    createCall({ sid: "conv_1", to: "+447700900123", agentId: "agent-1", status: "ringing" });
    updateCallStatus("conv_1", "completed");
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    const response = await readOne("conv_1");

    expect(response.status).toBe(200);
    expect((await response.json()).call.status).toBe("completed");
    expect(spy).not.toHaveBeenCalled();
  });

  it("reads_a_live_call_fresh", async () => {
    createCall({ sid: "conv_1", to: "+447700900123", agentId: "agent-1", status: "ringing" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({ status: "in-progress", transcript: [{ role: "agent", message: "Hello." }] }),
      ),
    );

    const body = await (await readOne("conv_1")).json();

    expect(body.call.status).toBe("in-progress");
    expect(body.call.transcript).toHaveLength(1);
  });
});
