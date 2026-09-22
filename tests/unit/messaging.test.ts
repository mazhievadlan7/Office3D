import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as listRoute, POST as sendRoute } from "@/app/api/messaging/messages/route";
import { describeMessagingReadiness, resolveMessagingConfig } from "@/lib/messaging/provider";
import { listMessages, resetMessageStore } from "@/lib/messaging/store";
import { MAX_MESSAGE_CHARS, normalizeWhatsAppUserId } from "@/lib/messaging/types";

const ORIGINAL_ENV = { ...process.env };

const ENV = {
  ELEVENLABS_API_KEY: "xi-key",
  ELEVENLABS_AGENT_ID: "agent_abc",
  ELEVENLABS_WHATSAPP_PHONE_NUMBER_ID: "wa_123",
  ELEVENLABS_WHATSAPP_TEMPLATE: "office_notice",
  ELEVENLABS_WHATSAPP_TEMPLATE_LANGUAGE: "en",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const post = (body: unknown) =>
  sendRoute(
    new Request("http://localhost/api/messaging/messages", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const VALID = {
  to: "+447700900123",
  text: "Your invoice is overdue.",
  agentId: "agent-1",
  agentName: "Nova",
};

beforeEach(() => {
  resetMessageStore();
  for (const key of Object.keys(ENV)) delete process.env[key];
  Object.assign(process.env, ENV);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetMessageStore();
});

describe("normalizeWhatsAppUserId", () => {
  it("accepts_a_number_with_or_without_the_plus", () => {
    // An operator will type the plus; WhatsApp identifies users without it.
    expect(normalizeWhatsAppUserId("+44 7700 900123", "to")).toBe("447700900123");
    expect(normalizeWhatsAppUserId("447700900123", "to")).toBe("447700900123");
  });

  it("rejects_something_that_is_not_a_number", () => {
    expect(() => normalizeWhatsAppUserId("my wife", "to")).toThrow(/в международном формате/);
    expect(() => normalizeWhatsAppUserId("0123", "to")).toThrow(/в международном формате/);
  });
});

describe("describeMessagingReadiness", () => {
  it("names_every_missing_variable_and_no_values", () => {
    const readiness = describeMessagingReadiness({
      ELEVENLABS_API_KEY: "super-secret",
    } as unknown as NodeJS.ProcessEnv);

    expect(readiness.configured).toBe(false);
    expect(readiness.missing).toEqual([
      "ELEVENLABS_AGENT_ID",
      "ELEVENLABS_WHATSAPP_PHONE_NUMBER_ID",
      "ELEVENLABS_WHATSAPP_TEMPLATE",
      "ELEVENLABS_WHATSAPP_TEMPLATE_LANGUAGE",
    ]);
    expect(JSON.stringify(readiness)).not.toContain("super-secret");
  });

  it("is_ready_with_everything_set", () => {
    expect(resolveMessagingConfig(ENV as unknown as NodeJS.ProcessEnv).templateName).toBe(
      "office_notice",
    );
  });
});

describe("POST /api/messaging/messages", () => {
  it("sends_the_template_in_the_shape_elevenlabs_expects", async () => {
    const spy = vi.fn().mockResolvedValue(json({ conversation_id: "conv_1" }));
    vi.stubGlobal("fetch", spy);

    const response = await post(VALID);
    const body = await response.json();

    const [url, init] = spy.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("https://api.elevenlabs.io/v1/convai/whatsapp/outbound-message");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("xi-key");

    // Template-only, and snake_case on the wire: both taken from the official
    // SDK's serializers rather than guessed.
    expect(JSON.parse(String(init.body))).toEqual({
      whatsapp_phone_number_id: "wa_123",
      whatsapp_user_id: "447700900123",
      template_name: "office_notice",
      template_language_code: "en",
      template_params: [
        { type: "body", parameters: [{ type: "text", text: "Your invoice is overdue." }] },
      ],
      agent_id: "agent_abc",
    });

    expect(response.status).toBe(201);
    expect(body.message).toMatchObject({
      id: "conv_1",
      channel: "whatsapp",
      to: "447700900123",
      agentName: "Nova",
      template: "office_notice",
      // "sent", never "delivered": the provider accepted it, and only a
      // receipt would say it reached a handset.
      status: "sent",
      errorMessage: null,
    });
  });

  it("records_nothing_when_the_provider_refuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ detail: "Template not approved" }, 422)),
    );

    const response = await post(VALID);

    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain("Template not approved");
    // A row in the log would read like a message that exists.
    expect(listMessages()).toHaveLength(0);
  });

  it("records_nothing_when_the_provider_returns_no_id", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({})));
    expect((await post(VALID)).status).toBe(502);
    expect(listMessages()).toHaveLength(0);
  });

  it("answers_503_naming_what_the_deployment_is_missing", async () => {
    delete process.env.ELEVENLABS_WHATSAPP_TEMPLATE;
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    const response = await post(VALID);

    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("ELEVENLABS_WHATSAPP_TEMPLATE");
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects_a_recipient_that_is_a_name_rather_than_a_number", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect((await post({ ...VALID, to: "my wife" })).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects_empty_and_runaway_text", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect((await post({ ...VALID, text: "   " })).status).toBe(400);
    expect((await post({ ...VALID, text: "x".repeat(MAX_MESSAGE_CHARS + 1) })).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("requires_the_agent_it_is_sent_as", async () => {
    expect((await post({ ...VALID, agentName: "" })).status).toBe(400);
  });
});

describe("GET /api/messaging/messages", () => {
  it("lists_what_went_out_and_reports_readiness", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ conversation_id: "conv_1" })));
    await post(VALID);

    const body = await (await listRoute()).json();

    expect(body.ready).toBe(true);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].text).toBe("Your invoice is overdue.");
  });
});
