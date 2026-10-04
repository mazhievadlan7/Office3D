// The office's voices, as the local speech gateway (services/speech) names them:
// `silero:<name>` — Silero TTS v5 on the CPU (exact Russian stress), each voice
// with its own "humanoid" post-processing: «Система штаба», AM7 and the crew.
//
// The live list comes from the gateway's GET /v1/voices; this copy of
// services/speech/voices.json is what the office offers while the gateway is
// not answering, so settings still show real names.
//
// Ids of the retired VoiceStudio engine (`voicestudio:am7`,
// `voicestudio:crew-m1`…) are still accepted (saved settings, the voice
// bank's manifest) and mean the Silero presets that replaced them.

export type SpeechVoiceRole = "system" | "lead" | "crew" | "any";

export type SpeechVoice = {
  id: string;
  label: string;
  engine: "silero";
  role: SpeechVoiceRole;
  /** The office speaks with male voices only. */
  gender?: "male";
};

export const SPEECH_VOICE_ID_RE = /^(silero|voicestudio):[A-Za-z0-9_.-]{1,80}$/;

export const isSpeechVoiceId = (value: unknown): value is string =>
  typeof value === "string" && SPEECH_VOICE_ID_RE.test(value.trim());

/** The retired VoiceStudio voices, each to the Silero preset that speaks for it (as the gateway maps them). */
const RETIRED_VOICESTUDIO_VOICES: Record<string, string> = {
  "voicestudio:am7": "silero:am7",
  "voicestudio:crew-m1": "silero:crew-m1",
  "voicestudio:crew-m2": "silero:crew-m2",
  "voicestudio:crew-m3": "silero:crew-m3",
  "voicestudio:crew-m4": "silero:crew-m4",
  "voicestudio:crew-m5": "silero:crew-m5",
  "voicestudio:crew-m6": "silero:crew-m6",
  // The retired female crew voices, to fixed male ones.
  "voicestudio:crew-f1": "silero:crew-m1",
  "voicestudio:crew-f2": "silero:crew-m2",
};
/** Female Silero speakers the office no longer offers; they are spoken by Aidar. */
const RETIRED_SILERO_SPEAKERS = new Set([
  "baya", "kseniya", "xenia",
  "ru_aigul", "ru_albina", "ru_alfia", "ru_alfia2", "ru_ekaterina", "ru_karina", "ru_kejilgan", "ru_kermen",
  "ru_miyau", "ru_nurgul", "ru_oksana", "ru_onaoy", "ru_ramilia", "ru_saida", "ru_vika", "ru_zara",
  "ru_zhadyra", "ru_zhazira", "ru_zinaida",
]);
const RETIRED_SILERO_REPLACEMENT = "silero:aidar";

/**
 * The voice to use for a saved voice id: a retired VoiceStudio voice becomes
 * the Silero preset of the same name, a retired female voice its male
 * stand-in. Any other id is returned trimmed, unchanged.
 */
export const currentSpeechVoiceId = (voiceId: string): string => {
  const id = voiceId.trim();
  const replacement = RETIRED_VOICESTUDIO_VOICES[id];
  if (replacement) return replacement;
  if (id.startsWith("silero:") && RETIRED_SILERO_SPEAKERS.has(id.slice("silero:".length))) return RETIRED_SILERO_REPLACEMENT;
  return id;
};

/** «Система штаба»: Silero's deepest voice (exact stress, instant on a CPU) with the gateway's humanoid-heavy FX. */
export const DEFAULT_SYSTEM_VOICE = "silero:system";
/** AM7: another Silero speaker, taken deeper still (humanoid-heavy-lead). */
export const DEFAULT_LEAD_VOICE = "silero:am7";

const crew = (id: string, label: string): SpeechVoice => ({
  id: `silero:${id}`,
  label,
  engine: "silero",
  role: "crew",
  gender: "male",
});

// The casting: the system, AM7 and six operators (male voices only), each a
// different Silero speaker.
export const BUILTIN_SPEECH_VOICES: SpeechVoice[] = [
  { id: "silero:am7", label: "AM7", engine: "silero", role: "lead", gender: "male" },
  crew("crew-m1", "Взломщик — низкий, сухой, резкий"),
  crew("crew-m2", "Аналитик — тёмный баритон, ледяной"),
  crew("crew-m3", "Ветеран — тяжёлый грудной бас"),
  crew("crew-m4", "Инфильтратор — хриплый, угрожающий"),
  crew("crew-m5", "Наёмник — грубый, с хрипотцой"),
  crew("crew-m6", "Часовой — строгий бас-баритон"),
  { id: "silero:system", label: "Система штаба (Silero Евгений)", engine: "silero", role: "system", gender: "male" },
  { id: "silero:aidar", label: "Айдар (Silero)", engine: "silero", role: "any" },
  { id: "silero:eugene", label: "Евгений (Silero)", engine: "silero", role: "any" },
];

const ROLES: SpeechVoiceRole[] = ["system", "lead", "crew", "any"];

/** The gateway's /v1/voices body as office voices; malformed entries are skipped. */
export const parseGatewayVoices = (body: unknown): SpeechVoice[] => {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const voices: SpeechVoice[] = [];
  for (const raw of data) {
    const entry = raw as Record<string, unknown>;
    if (!isSpeechVoiceId(entry?.id)) continue;
    const id = String(entry.id);
    const role = ROLES.includes(entry.role as SpeechVoiceRole) ? (entry.role as SpeechVoiceRole) : "any";
    const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim().slice(0, 80) : id;
    // Male voices only, and no retired voice an older gateway still lists.
    if (!id.startsWith("silero:") || entry.gender === "female" || currentSpeechVoiceId(id) !== id) continue;
    const gender = entry.gender === "male" ? "male" : undefined;
    voices.push({ id, label, engine: "silero", role, ...(gender ? { gender } : {}) });
  }
  return voices;
};

/** The voices for one role, in catalogue order. */
export const voicesWithRole = (voices: SpeechVoice[], role: SpeechVoiceRole) =>
  voices.filter((voice) => voice.role === role).map((voice) => voice.id);
