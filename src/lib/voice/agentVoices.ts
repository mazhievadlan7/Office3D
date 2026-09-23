// Which voice an agent speaks with.
//
// An agent the person gave a voice keeps it. The main agent otherwise speaks
// with the office's voice (the one picked in voice settings, else the
// server's default). Everyone else gets a voice picked from the offered ones
// by a stable hash of their id — so the same agent always sounds the same —
// skipping the main agent's voice while there are others to choose from, so a
// meeting does not sound like one person talking to themselves.

export type VoiceOption = { id: string; label: string };

export type VoiceSetup = {
  tts: { provider: string; ready: boolean; defaultVoiceId: string; options: VoiceOption[] };
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
  if (chosen) return chosen;
  const mainVoice = agentVoices[mainAgentId] ?? officeVoiceId ?? setup?.tts.defaultVoiceId ?? null;
  if (agentId === mainAgentId) return mainVoice;
  const options = (setup?.tts.options ?? []).map((option) => option.id);
  if (options.length === 0) return mainVoice;
  const pool = options.length > 1 ? options.filter((id) => id !== mainVoice) : options;
  return pool[hash(agentId) % pool.length];
};

/** Session keys whose replies are not spoken as ordinary chat replies. */
export const isBackgroundSessionKey = (sessionKey: string) => /:(meeting|autonomy|approvals)-/.test(sessionKey);
