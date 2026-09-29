import { describe, expect, it } from "vitest";
import { CREW_ACKS, CREW_EXCHANGES, CREW_SOLOS, allCrewLines } from "@/features/hq/render/audio/crewScript";
import { CrewTalkPlanner } from "@/features/hq/render/audio/crewTalk";
import { crewVoiceFor, resolveAgentVoice } from "@/lib/voice/agentVoices";
import { beginForegroundSpeech, isForegroundSpeechActive, onForegroundSpeech } from "@/lib/voice/speechDuck";
import { isVoiceBankFile, parseVoiceBankManifest } from "@/lib/voice/voiceBank";
import { BUILTIN_SPEECH_VOICES, DEFAULT_SYSTEM_VOICE } from "@/lib/voice/voiceCatalog";

describe("crew script", () => {
  it("has_stable_unique_ids_and_150_to_220_short_lines", () => {
    const lines = allCrewLines();
    expect(lines.length).toBeGreaterThanOrEqual(150);
    expect(lines.length).toBeLessThanOrEqual(220);
    expect(new Set(lines.map((line) => line.id)).size).toBe(lines.length);
    for (const line of lines) {
      expect(line.id).toMatch(/^[a-z0-9]{1,12}$/);
      expect(line.text.length).toBeLessThanOrEqual(70);
      expect(line.text).toMatch(/[.?!]$/);
    }
    expect(CREW_EXCHANGES.every((x) => x.ask.text.endsWith("?"))).toBe(true);
    expect(CREW_SOLOS.length + CREW_ACKS.length).toBeGreaterThan(40);
  });

  it("is_written_for_male_voices_only", () => {
    expect(CREW_ACKS.some((line) => line.text === "Принял.")).toBe(true);
    expect(allCrewLines().every((line) => Object.keys(line).sort().join() === "id,text")).toBe(true);
  });
});

describe("voice bank format", () => {
  it("accepts_only_bank_file_names", () => {
    expect(isVoiceBankFile("crew-m1.x01a.b7aaa86c9328.mp3")).toBe(true);
    for (const bad of ["../manifest.json", "crew-m1.x01a.b7aaa86c9328.mp3/..", "a.b.c.mp3", "CREW.x01a.b7aaa86c9328.mp3", "crew-m1.x01a.b7aaa86c9328.wav"]) {
      expect(isVoiceBankFile(bad)).toBe(false);
    }
  });

  it("drops_bad_entries_from_the_manifest", () => {
    const manifest = parseVoiceBankManifest({
      version: 1,
      voices: {
        "voicestudio:crew-m1": {
          label: "М1",
          lines: { x01a: { file: "crew-m1.x01a.b7aaa86c9328.mp3", duration: 1.5 }, bad: { file: "../x.mp3" } },
        },
        "evil voice": { lines: { x01a: { file: "crew-m1.x01a.b7aaa86c9328.mp3" } } },
        "voicestudio:empty": { lines: {} },
      },
    });
    expect(Object.keys(manifest!.voices)).toEqual(["voicestudio:crew-m1"]);
    expect(manifest!.voices["voicestudio:crew-m1"].lines).toEqual({ x01a: { file: "crew-m1.x01a.b7aaa86c9328.mp3", duration: 1.5 } });
    expect(parseVoiceBankManifest({ version: 1, voices: {} })).toBeNull();
    expect(parseVoiceBankManifest("nope")).toBeNull();
  });
});

describe("crew talk planner", () => {
  const all = () => true;

  it("answers_a_question_asked_next_to_it_and_takes_turns", () => {
    let seed = 0.1;
    const planner = new CrewTalkPlanner(() => (seed = (seed * 9301 + 0.49297) % 1));
    const ask = planner.pick("a", "pair", 0, 0, 10, all)!;
    expect(ask).not.toBeNull();
    // Force a question.
    const question = { line: CREW_EXCHANGES[3].ask, exchange: 3, role: "ask" as const };
    planner.spoke("a", question, 0, 0, 10, 12);
    expect(planner.waitFor("b", 1, 0, 11)).toBeGreaterThan(0);
    expect(planner.waitFor("far", 20, 0, 11)).toBe(0);
    expect(planner.waitFor("b", 1, 0, 12.5)).toBe(0);
    const answer = planner.pick("b", "pair", 1, 0, 12.5, all)!;
    expect(answer.role).toBe("answer");
    expect(answer.line.id).toBe(CREW_EXCHANGES[3].answer.id);
    planner.spoke("b", answer, 1, 0, 12.5, 14);
    expect(planner.openQuestion("c", 1, 0, 14.5)).toBe(-1);
  });

  it("only_picks_lines_the_voice_has", () => {
    const planner = new CrewTalkPlanner(() => 0.3);
    const only = new Set(["s05"]);
    const pick = planner.pick("a", "group", 0, 0, 0, (id) => only.has(id));
    expect(pick?.line.id).toBe("s05");
    expect(planner.pick("a", "group", 0, 0, 0, () => false)).toBeNull();
  });
});

describe("casting", () => {
  it("gives_each_agent_one_crew_voice_consistently_with_chat_replies", () => {
    const crew = BUILTIN_SPEECH_VOICES.filter((voice) => voice.role === "crew").map((voice) => voice.id);
    expect(crew).toHaveLength(6);
    expect(BUILTIN_SPEECH_VOICES.filter((voice) => voice.role === "crew").every((voice) => voice.gender === "male")).toBe(true);
    const setup = {
      tts: {
        provider: "local-speech",
        ready: true,
        defaultVoiceId: "voicestudio:am7",
        options: [],
        systemVoiceId: DEFAULT_SYSTEM_VOICE,
        leadVoiceId: "voicestudio:am7",
        crewVoiceIds: crew,
      },
      stt: { provider: "local-speech", ready: true },
    };
    const used = new Set<string>();
    for (let n = 0; n < 60; n++) {
      const id = `agent-${n}`;
      const voice = crewVoiceFor(id, crew, "voicestudio:am7");
      expect(voice).toBe(resolveAgentVoice({ agentId: id, mainAgentId: "main", officeVoiceId: null, agentVoices: {}, setup }));
      used.add(voice!);
    }
    expect(used.size).toBe(6);
    const fallbacks = BUILTIN_SPEECH_VOICES.flatMap((voice) => (voice.fallback ? [voice.fallback] : []));
    expect(new Set(fallbacks).size).toBe(fallbacks.length);
  });
});

describe("foreground speech ducking", () => {
  it("is_on_while_any_foreground_speech_plays", () => {
    const seen: boolean[] = [];
    const off = onForegroundSpeech((speaking) => seen.push(speaking));
    const a = beginForegroundSpeech();
    const b = beginForegroundSpeech();
    a();
    a();
    expect(isForegroundSpeechActive()).toBe(true);
    b();
    expect(isForegroundSpeechActive()).toBe(false);
    expect(seen).toEqual([true, false]);
    off();
  });
});
