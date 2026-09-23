import { describe, expect, it } from "vitest";
import { isBackgroundSessionKey, resolveAgentVoice, type VoiceSetup } from "@/lib/voice/agentVoices";
import { mergeStudioSettings, normalizeStudioSettings } from "@/lib/studio/settings";

const setup: VoiceSetup = {
  tts: {
    provider: "elevenlabs",
    ready: true,
    defaultVoiceId: "rachel",
    options: ["rachel", "bella", "elli", "antoni"].map((id) => ({ id, label: id })),
  },
  stt: { provider: "elevenlabs", ready: true },
};

const voice = (agentId: string, overrides: Partial<Parameters<typeof resolveAgentVoice>[0]> = {}) =>
  resolveAgentVoice({ agentId, mainAgentId: "main", officeVoiceId: null, agentVoices: {}, setup, ...overrides });

describe("agent voices", () => {
  it("gives_the_main_agent_the_office_voice", () => {
    expect(voice("main")).toBe("rachel");
    expect(voice("main", { officeVoiceId: "bella" })).toBe("bella");
    expect(voice("main", { agentVoices: { main: "elli" }, officeVoiceId: "bella" })).toBe("elli");
  });

  it("picks_a_stable_voice_for_everyone_else_that_differs_from_the_main_agent", () => {
    const ids = ["barista-1a2b3c", "cashier-4d5e6f", "courier-777777", "chef-abcdef"];
    for (const id of ids) {
      expect(voice(id)).not.toBe("rachel");
      expect(voice(id)).toBe(voice(id));
    }
    expect(voice("barista-1a2b3c", { agentVoices: { "barista-1a2b3c": "rachel" } })).toBe("rachel");
  });

  it("falls_back_to_the_main_voice_without_a_voice_list", () => {
    expect(voice("barista-1a2b3c", { setup: null, officeVoiceId: "bella" })).toBe("bella");
  });

  it("recognizes_meeting_and_autonomy_sessions", () => {
    expect(isBackgroundSessionKey("agent:main:meeting-mtg_1")).toBe(true);
    expect(isBackgroundSessionKey("agent:main:autonomy-2026-09-23")).toBe(true);
    expect(isBackgroundSessionKey("agent:main:main")).toBe(false);
  });

  it("stores_agent_voices_in_settings_and_drops_bad_ids", () => {
    const base = normalizeStudioSettings({});
    const merged = mergeStudioSettings(base, {
      voiceReplies: { "ws://gw": { agentVoices: { "barista-1": "bella", "bad-1": "not a voice!", main: "elli" } } },
    });
    expect(merged.voiceReplies["ws://gw"].agentVoices).toEqual({ "barista-1": "bella", main: "elli" });
    const replaced = mergeStudioSettings(merged, { voiceReplies: { "ws://gw": { agentVoices: { main: "rachel" } } } });
    expect(replaced.voiceReplies["ws://gw"].agentVoices).toEqual({ main: "rachel" });
    expect(normalizeStudioSettings({ voiceReplies: { "ws://gw": { enabled: true } } }).voiceReplies["ws://gw"].agentVoices).toEqual({});
  });
});
