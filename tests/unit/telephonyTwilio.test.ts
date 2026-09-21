import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  hangUpCall,
  isTelephonyConfigured,
  isValidTwilioSignature,
  placeCall,
  resolveTwilioConfig,
  type TwilioConfig,
} from "@/lib/telephony/twilio";
import {
  MAX_SPOKEN_CHARS,
  TelephonyError,
  assertE164,
  assertSpeakableText,
  isTerminalCallStatus,
} from "@/lib/telephony/types";

const CONFIG: TwilioConfig = {
  accountSid: "AC123",
  authToken: "token-secret",
  fromNumber: "+14155550100",
  publicBaseUrl: "https://office.example",
};

const env = (overrides: Record<string, string> = {}) =>
  ({
    TWILIO_ACCOUNT_SID: "AC123",
    TWILIO_AUTH_TOKEN: "token-secret",
    TWILIO_PHONE_NUMBER: "+14155550100",
    OFFICE3D_PUBLIC_URL: "https://office.example/",
    ...overrides,
  }) as unknown as NodeJS.ProcessEnv;

const twilioResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  resetCallStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
    expect(() => assertSpeakableText("   ", "message")).toThrow(/required/);
    expect(() => assertSpeakableText("x".repeat(MAX_SPOKEN_CHARS + 1), "message")).toThrow(
      /over the/,
    );
  });
});

describe("resolveTwilioConfig", () => {
  it("names_every_missing_variable_at_once", () => {
    // One error listing all four beats four round trips through a deployment.
    try {
      resolveTwilioConfig({} as unknown as NodeJS.ProcessEnv);
      throw new Error("expected a failure");
    } catch (error) {
      expect((error as TelephonyError).status).toBe(503);
      expect((error as Error).message).toContain("TWILIO_ACCOUNT_SID");
      expect((error as Error).message).toContain("TWILIO_AUTH_TOKEN");
      expect((error as Error).message).toContain("TWILIO_PHONE_NUMBER");
      expect((error as Error).message).toContain("OFFICE3D_PUBLIC_URL");
    }
  });

  it("trims_the_trailing_slash_from_the_public_url", () => {
    expect(resolveTwilioConfig(env()).publicBaseUrl).toBe("https://office.example");
  });

  it("reports_whether_telephony_is_configured", () => {
    expect(isTelephonyConfigured(env())).toBe(true);
    expect(isTelephonyConfigured({} as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("placeCall", () => {
  it("posts_the_call_with_webhooks_twilio_can_reach", async () => {
    const spy = vi
      .fn()
      .mockResolvedValue(twilioResponse({ sid: "CA999", status: "queued" }));
    vi.stubGlobal("fetch", spy);

    const placed = await placeCall({ to: "+447700900123", agentId: "agent-1" }, CONFIG);

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Calls.json");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("AC123:token-secret").toString("base64")}`,
    );

    const form = new URLSearchParams(String(init.body));
    expect(form.get("To")).toBe("+447700900123");
    expect(form.get("From")).toBe("+14155550100");
    expect(form.get("Url")).toBe(
      "https://office.example/api/telephony/twiml?agentId=agent-1",
    );
    expect(form.get("StatusCallback")).toBe("https://office.example/api/telephony/status");
    expect(form.getAll("StatusCallbackEvent")).toEqual([
      "initiated",
      "ringing",
      "answered",
      "completed",
    ]);

    expect(placed).toEqual({
      sid: "CA999",
      status: "queued",
      to: "+447700900123",
      from: "+14155550100",
    });
  });

  it("rejects_a_bad_number_before_calling_twilio", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    await expect(placeCall({ to: "not-a-number", agentId: "a" }, CONFIG)).rejects.toThrow(
      /E.164/,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("requires_an_agent", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(placeCall({ to: "+14155550100", agentId: " " }, CONFIG)).rejects.toThrow(
      /agentId is required/,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("surfaces_twilio_errors_with_their_status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        twilioResponse({ message: "Authenticate", code: 20003 }, 401),
      ),
    );

    // A 401 is a credentials problem and a 400 is a bad number; collapsing
    // both into 500 would send a deployment looking in the wrong place.
    await expect(
      placeCall({ to: "+14155550100", agentId: "a" }, CONFIG),
    ).rejects.toMatchObject({ status: 401, message: "Twilio: Authenticate" });
  });

  it("reports_a_transport_failure_as_a_gateway_error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ENOTFOUND")));
    await expect(
      placeCall({ to: "+14155550100", agentId: "a" }, CONFIG),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("refuses_a_response_with_no_sid", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(twilioResponse({ status: "queued" })));
    await expect(
      placeCall({ to: "+14155550100", agentId: "a" }, CONFIG),
    ).rejects.toThrow(/no SID/);
  });
});

describe("hangUpCall", () => {
  it("completes_the_call", async () => {
    const spy = vi.fn().mockResolvedValue(twilioResponse({ sid: "CA1" }));
    vi.stubGlobal("fetch", spy);

    await hangUpCall("CA1", CONFIG);

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Calls/CA1.json");
    expect(new URLSearchParams(String(init.body)).get("Status")).toBe("completed");
  });
});

describe("isValidTwilioSignature", () => {
  const url = "https://office.example/api/telephony/twiml";
  const form = { CallSid: "CA1", SpeechResult: "hello there" };

  const sign = (token: string) => {
    const data = Object.keys(form)
      .sort()
      .reduce((acc, key) => acc + key + form[key as keyof typeof form], url);
    return crypto.createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
  };

  it("accepts_a_signature_twilio_would_have_produced", () => {
    expect(
      isValidTwilioSignature({
        signature: sign("token-secret"),
        url,
        form,
        authToken: "token-secret",
      }),
    ).toBe(true);
  });

  it("rejects_a_signature_made_with_another_token", () => {
    // Without this the webhook is an open endpoint: anyone who found the URL
    // could inject speech into a live call or fake the other party's words.
    expect(
      isValidTwilioSignature({
        signature: sign("someone-elses-token"),
        url,
        form,
        authToken: "token-secret",
      }),
    ).toBe(false);
  });

  it("rejects_tampered_parameters", () => {
    const signature = sign("token-secret");
    expect(
      isValidTwilioSignature({
        signature,
        url,
        form: { ...form, SpeechResult: "transfer the money" },
        authToken: "token-secret",
      }),
    ).toBe(false);
  });

  it("rejects_a_missing_signature_or_token", () => {
    expect(isValidTwilioSignature({ signature: "", url, form, authToken: "t" })).toBe(false);
    expect(
      isValidTwilioSignature({ signature: "abc", url, form, authToken: "" }),
    ).toBe(false);
  });

  it("rejects_a_signature_of_the_wrong_length_without_throwing", () => {
    // timingSafeEqual throws on unequal lengths; the guard must come first.
    expect(
      isValidTwilioSignature({ signature: "short", url, form, authToken: "token-secret" }),
    ).toBe(false);
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
    expect(() => requireCall("nope")).toThrow(TelephonyError);
    expect(() => requireCall("nope")).toThrow(/No call with SID/);
  });

  it("lists_calls_newest_first", () => {
    seed("CA1");
    seed("CA2");
    expect(listCalls()).toHaveLength(2);
  });

  it("classifies_terminal_statuses", () => {
    expect(isTerminalCallStatus("in-progress")).toBe(false);
    expect(isTerminalCallStatus("ringing")).toBe(false);
    for (const status of ["completed", "busy", "no-answer", "canceled", "failed"] as const) {
      expect(isTerminalCallStatus(status)).toBe(true);
    }
  });
});
