// Which voice an agent speaks with.
//
// An agent the person gave a voice keeps it. The main agent (AM7) otherwise
// speaks with the office's voice (the one picked in voice settings), else the
// lead voice the speech gateway designates (voicestudio:am7), else the
// server's default. Everyone else gets a crew voice (the gateway's designed
// operator voices) picked by a stable hash of their id — so the same agent
// always sounds the same — skipping the main agent's voice while there are
// others to choose from, so a meeting does not sound like one person talking
// to themselves. The HQ system's voice is never handed to an agent. A retired
// female voice (an old setting) resolves to its male stand-in.

import { currentSpeechVoiceId } from "./voiceCatalog";

export type VoiceOption = { id: string; label: string; role?: string };

export type VoiceSetup = {
  tts: {
    provider: string;
    ready: boolean;
    defaultVoiceId: string;
    options: VoiceOption[];
    /** «Система штаба» — the HQ's own voice (local speech gateway only). */
    systemVoiceId?: string | null;
    /** AM7's voice. */
    leadVoiceId?: string | null;
    /** The voices operators are given. */
    crewVoiceIds?: string[];
  };
  stt: { provider: string; ready: boolean };
};

const hash = (text: string) => {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
};

export const resolveAgentVoice = (params: {
  agentId: string;
  mainAgentId: string;
  officeVoiceId: string | null;
  agentVoices: Record<string, string>;
  setup: VoiceSetup | null;
}): string | null => {
  const { agentId, mainAgentId, officeVoiceId, agentVoices, setup } = params;
  const chosen = agentVoices[agentId];
  if (chosen) return currentSpeechVoiceId(chosen);
  const main =
    agentVoices[mainAgentId] ?? officeVoiceId ?? setup?.tts.leadVoiceId ?? setup?.tts.defaultVoiceId ?? null;
  const mainVoice = main ? currentSpeechVoiceId(main) : null;
  if (agentId === mainAgentId) return mainVoice;
  const crew = setup?.tts.crewVoiceIds ?? [];
  const systemVoice = setup?.tts.systemVoiceId ?? null;
  const options = crew.length
    ? crew
    : (setup?.tts.options ?? []).map((option) => option.id).filter((id) => id !== systemVoice);
  return crewVoiceFor(agentId, options, mainVoice) ?? mainVoice;
};

/**
 * An operator's crew voice: a stable hash of their id over the crew voices,
 * skipping the main agent's voice while there are others. The HQ's ambient
 * talk (render/audio/HqSoundscape) uses it too, so an agent sounds the same
 * across the floor and in chat. Null without crew voices.
 */
export const crewVoiceFor = (agentId: string, crewVoiceIds: readonly string[], mainVoice: string | null): string | null => {
  if (crewVoiceIds.length === 0) return null;
  const pool = crewVoiceIds.length > 1 ? crewVoiceIds.filter((id) => id !== mainVoice) : crewVoiceIds;
  const from = pool.length ? pool : crewVoiceIds;
  return from[hash(agentId) % from.length];
};

/** Session keys whose replies are not spoken as ordinary chat replies. */
export const isBackgroundSessionKey = (sessionKey: string) => /:(meeting|autonomy|approvals)-/.test(sessionKey);
