import { describe, expect, it } from "vitest";
import { isBackgroundSessionKey, resolveAgentVoice, type VoiceSetup } from "@/lib/voice/agentVoices";
import { mergeStudioSettings, normalizeStudioSettings } from "@/lib/studio/settings";

const setup: VoiceSetup = {
  tts: {
    provider: "local-speech",
    ready: true,
    defaultVoiceId: "silero:am7",
    options: [
      { id: "silero:aidar", label: "Система", role: "system" },
      { id: "silero:am7", label: "AM7", role: "lead" },
      { id: "silero:crew-m1", label: "М1", role: "crew" },
      { id: "silero:crew-m2", label: "М2", role: "crew" },
      { id: "silero:crew-m3", label: "М3", role: "crew" },
      { id: "silero:eugene", label: "Евгений", role: "any" },
    ],
    systemVoiceId: "silero:aidar",
    leadVoiceId: "silero:am7",
    crewVoiceIds: ["silero:am7", "silero:crew-m1", "silero:crew-m2", "silero:crew-m3"],
  },
  stt: { provider: "local-speech", ready: true },
};

const voice = (agentId: string, overrides: Partial<Parameters<typeof resolveAgentVoice>[0]> = {}) =>
  resolveAgentVoice({ agentId, mainAgentId: "main", officeVoiceId: null, agentVoices: {}, setup, ...overrides });

describe("agent voices", () => {
  it("gives_the_main_agent_the_office_voice_else_the_lead_voice", () => {
    expect(voice("main")).toBe("silero:am7");
    expect(voice("main", { officeVoiceId: "silero:eugene" })).toBe("silero:eugene");
    expect(voice("main", { agentVoices: { main: "silero:crew-m3" }, officeVoiceId: "silero:eugene" })).toBe(
      "silero:crew-m3",
    );
  });

  it("gives_everyone_else_a_stable_crew_voice_that_differs_from_the_main_agent", () => {
    const ids = ["wraith-01", "onyx-0f", "zeroday-60", "specter-2a", "raven-11"];
    const crew = ["silero:crew-m1", "silero:crew-m2", "silero:crew-m3"];
    for (const id of ids) {
      expect(crew).toContain(voice(id));
      expect(voice(id)).toBe(voice(id));
    }
    expect(voice("wraith-01", { agentVoices: { "wraith-01": "silero:eugene" } })).toBe("silero:eugene");
  });

  it("never_hands_the_system_voice_to_an_agent_without_a_crew_list", () => {
    const noCrew: VoiceSetup = { ...setup, tts: { ...setup.tts, crewVoiceIds: [] } };
    for (const id of ["a-1", "b-2", "c-3", "d-4", "e-5", "f-6", "g-7", "h-8"]) {
      expect(voice(id, { setup: noCrew })).not.toBe("silero:aidar");
    }
  });

  it("falls_back_to_the_main_voice_without_a_voice_list", () => {
    expect(voice("wraith-01", { setup: null, officeVoiceId: "silero:eugene" })).toBe("silero:eugene");
  });

  it("recognizes_meeting_and_autonomy_sessions", () => {
    expect(isBackgroundSessionKey("agent:main:meeting-mtg_1")).toBe(true);
    expect(isBackgroundSessionKey("agent:main:autonomy-2026-09-23")).toBe(true);
    expect(isBackgroundSessionKey("agent:main:main")).toBe(false);
  });

  it("stores_agent_voices_in_settings_and_drops_bad_ids", () => {
    const base = normalizeStudioSettings({});
    const merged = mergeStudioSettings(base, {
      voiceReplies: {
        "ws://gw": {
          agentVoices: { "wraith-1": "silero:crew-m1", "bad-1": "not a voice!", main: "silero:eugene" },
        },
      },
    });
    expect(merged.voiceReplies["ws://gw"].agentVoices).toEqual({ "wraith-1": "silero:crew-m1", main: "silero:eugene" });
    const replaced = mergeStudioSettings(merged, {
      voiceReplies: { "ws://gw": { agentVoices: { main: "silero:am7" } } },
    });
    expect(replaced.voiceReplies["ws://gw"].agentVoices).toEqual({ main: "silero:am7" });
    expect(normalizeStudioSettings({ voiceReplies: { "ws://gw": { enabled: true } } }).voiceReplies["ws://gw"].agentVoices).toEqual({});
  });

  it("resolves_retired_female_voices_to_male_voices", () => {
    const settings = normalizeStudioSettings({
      voiceReplies: {
        "ws://gw": {
          enabled: true,
          voiceId: "silero:baya",
          agentVoices: {
            main: "silero:kseniya",
            "wraith-1": "voicestudio:crew-f1",
            "onyx-2": "voicestudio:crew-f2",
            "raven-3": "silero:ru_zinaida",
            "specter-4": "voicestudio:crew-m4",
            "ghost-5": "voicestudio:am7",
          },
        },
      },
    });
    expect(settings.voiceReplies["ws://gw"]).toMatchObject({
      voiceId: "silero:aidar",
      agentVoices: {
        main: "silero:aidar",
        "wraith-1": "silero:crew-m1",
        "onyx-2": "silero:crew-m2",
        "raven-3": "silero:aidar",
        "specter-4": "silero:crew-m4",
        "ghost-5": "silero:am7",
      },
    });
    // Unnormalised values (straight from the gateway or old state) resolve too.
    expect(voice("wraith-01", { agentVoices: { "wraith-01": "voicestudio:crew-f2" } })).toBe("silero:crew-m2");
    expect(voice("main", { officeVoiceId: "silero:xenia" })).toBe("silero:aidar");
  });

  it("drops_voices_saved_for_the_retired_provider", () => {
    const settings = normalizeStudioSettings({
      voiceReplies: {
        "ws://gw": {
          enabled: true,
          provider: "elevenlabs",
          voiceId: "EXAVITQu4vr4xnSDxMaL",
          agentVoices: { main: "21m00Tcm4TlvDq8ikWAM", "wraith-1": "silero:crew-m1" },
        },
      },
    });
    expect(settings.voiceReplies["ws://gw"]).toMatchObject({
      enabled: true,
      provider: "local-speech",
      voiceId: null,
      agentVoices: { "wraith-1": "silero:crew-m1" },
    });
  });
});
