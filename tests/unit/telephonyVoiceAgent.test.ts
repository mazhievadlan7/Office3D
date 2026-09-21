import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as telephonyStatus } from "@/app/api/telephony/status/route";
import { createCall, resetCallStore } from "@/lib/telephony/store";
import { TelephonyError } from "@/lib/telephony/types";
import {
  describeVoiceAgentReadiness,
  isVoiceAgentConfigured,
  resolveVoiceAgentConfig,
} from "@/lib/telephony/voiceAgent";

const ORIGINAL_ENV = { ...process.env };

const CARRIER_ENV = {
  TWILIO_ACCOUNT_SID: "AC1",
  TWILIO_AUTH_TOKEN: "tok",
  TWILIO_PHONE_NUMBER: "+14155550100",
  OFFICE3D_PUBLIC_URL: "https://office.example",
};

beforeEach(() => {
  resetCallStore();
  for (const key of [
    "ELEVENLABS_API_KEY",
    "ELEVENLABS_AGENT_ID",
    ...Object.keys(CARRIER_ENV),
  ]) {
    delete process.env[key];
  }
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetCallStore();
});

describe("resolveVoiceAgentConfig", () => {
  it("returns_the_configured_agent", () => {
    const config = resolveVoiceAgentConfig({
      ELEVENLABS_API_KEY: " key ",
      ELEVENLABS_AGENT_ID: " agent_123 ",
    } as unknown as NodeJS.ProcessEnv);

    expect(config).toEqual({
      provider: "elevenlabs",
      apiKey: "key",
      agentId: "agent_123",
    });
  });

  it("names_every_missing_variable_at_once_with_a_503", () => {
    try {
      resolveVoiceAgentConfig({} as unknown as NodeJS.ProcessEnv);
      throw new Error("expected a failure");
    } catch (error) {
      expect((error as TelephonyError).status).toBe(503);
      expect((error as Error).message).toContain("ELEVENLABS_API_KEY");
      expect((error as Error).message).toContain("ELEVENLABS_AGENT_ID");
    }
  });

  it("treats_a_blank_value_as_missing", () => {
    expect(
      isVoiceAgentConfigured({
        ELEVENLABS_API_KEY: "   ",
        ELEVENLABS_AGENT_ID: "agent_123",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});

describe("describeVoiceAgentReadiness", () => {
  it("reports_names_of_what_is_missing_and_never_values", () => {
    const readiness = describeVoiceAgentReadiness({
      ELEVENLABS_API_KEY: "super-secret-key",
    } as unknown as NodeJS.ProcessEnv);

    expect(readiness.configured).toBe(false);
    expect(readiness.missing).toEqual(["ELEVENLABS_AGENT_ID"]);
    expect(JSON.stringify(readiness)).not.toContain("super-secret-key");
  });
});

describe("GET /api/telephony/status", () => {
  it("reports_the_carrier_and_the_voice_agent_apart", async () => {
    // A deployment missing one should see which, not a single unhelpful
    // "not configured".
    Object.assign(process.env, CARRIER_ENV);

    const body = await (await telephonyStatus()).json();

    expect(body.ready).toBe(false);
    expect(body.carrier).toEqual({ provider: "twilio", configured: true });
    expect(body.voiceAgent.configured).toBe(false);
    expect(body.voiceAgent.missing).toEqual([
      "ELEVENLABS_API_KEY",
      "ELEVENLABS_AGENT_ID",
    ]);
  });

  it("is_ready_only_when_both_halves_are_configured", async () => {
    Object.assign(process.env, CARRIER_ENV, {
      ELEVENLABS_API_KEY: "key",
      ELEVENLABS_AGENT_ID: "agent_123",
    });

    expect((await (await telephonyStatus()).json()).ready).toBe(true);
  });

  it("summarises_live_calls_without_the_transcript_body", async () => {
    createCall({
      sid: "CA1",
      to: "+447700900123",
      from: "+14155550100",
      agentId: "agent-1",
      status: "in-progress",
    });

    const body = await (await telephonyStatus()).json();

    expect(body.calls).toEqual([
      expect.objectContaining({ sid: "CA1", status: "in-progress", turnCount: 0 }),
    ]);
    expect(body.calls[0].transcript).toBeUndefined();
  });
});
