// The office's voices, as the local speech gateway (services/speech) names them:
// `<engine>:<name>`.
//   - silero:<speaker>    Silero TTS v5 — Russian with exact word stress, fast on
//                         a CPU. The HQ system («Система штаба») speaks with it.
//   - voicestudio:<name>  VoiceStudio — designed voices (VoxCPM2): AM7 and the crew.
//
// The live list comes from the gateway's GET /v1/voices; this copy of
// services/speech/voices.json is what the office offers while the gateway is
// not answering, so settings still show real names.

export type SpeechVoiceRole = "system" | "lead" | "crew" | "any";

export type SpeechVoice = {
  id: string;
  label: string;
  engine: "silero" | "voicestudio";
  role: SpeechVoiceRole;
  /** The Silero voice the gateway speaks with when VoiceStudio is down. */
  fallback?: string;
  /** The office speaks with male voices only. */
  gender?: "male";
};

export const SPEECH_VOICE_ID_RE = /^(silero|voicestudio):[A-Za-z0-9_.-]{1,80}$/;

export const isSpeechVoiceId = (value: unknown): value is string =>
  typeof value === "string" && SPEECH_VOICE_ID_RE.test(value.trim());

/** The retired female crew voices, each to a fixed male crew voice (as the gateway maps them). */
const RETIRED_CREW_VOICES: Record<string, string> = {
  "voicestudio:crew-f1": "voicestudio:crew-m1",
  "voicestudio:crew-f2": "voicestudio:crew-m2",
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
 * The voice to use for a saved voice id: the office speaks with male voices
 * only, so a retired female voice (an old setting) becomes its male stand-in.
 * Any other id is returned trimmed, unchanged.
 */
export const currentSpeechVoiceId = (voiceId: string): string => {
  const id = voiceId.trim();
  const crewReplacement = RETIRED_CREW_VOICES[id];
  if (crewReplacement) return crewReplacement;
  if (id.startsWith("silero:") && RETIRED_SILERO_SPEAKERS.has(id.slice("silero:".length))) return RETIRED_SILERO_REPLACEMENT;
  return id;
};

/** «Система штаба»: Silero's deepest voice (exact stress, instant on a CPU) with the gateway's humanoid FX. */
export const DEFAULT_SYSTEM_VOICE = "silero:system";
export const DEFAULT_LEAD_VOICE = "voicestudio:am7";

const crew = (id: string, label: string, fallback: string): SpeechVoice => ({
  id: `voicestudio:${id}`,
  label,
  engine: "voicestudio",
  role: "crew",
  fallback,
  gender: "male",
});

// The casting: AM7 and six operators (male voices only), each a VoxCPM2-designed voice cloned
// from its own reference clip, each with a different Silero fallback.
export const BUILTIN_SPEECH_VOICES: SpeechVoice[] = [
  { id: "voicestudio:am7", label: "AM7", engine: "voicestudio", role: "lead", fallback: "silero:ru_safarhuja", gender: "male" },
  crew("crew-m1", "Оператор — быстрый, точный", "silero:ru_alexandr"),
  crew("crew-m2", "Аналитик — холодный, ровный", "silero:ru_roman"),
  crew("crew-m3", "Ветеран — спокойный баритон", "silero:aidar"),
  crew("crew-m4", "Инфильтратор — с хрипотцой, тихий", "silero:ru_bogdan"),
  crew("crew-m5", "Взломщик — молодой, энергичный", "silero:ru_dmitriy"),
  crew("crew-m6", "Часовой — глубокий бас, сдержанный", "silero:ru_eduard"),
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
    const engine = id.startsWith("silero:") ? "silero" : "voicestudio";
    const role = ROLES.includes(entry.role as SpeechVoiceRole) ? (entry.role as SpeechVoiceRole) : "any";
    const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim().slice(0, 80) : id;
    const fallback = isSpeechVoiceId(entry.fallback) ? String(entry.fallback) : undefined;
    // Male voices only: a female voice an older gateway still lists is not offered.
    if (entry.gender === "female" || currentSpeechVoiceId(id) !== id) continue;
    const gender = entry.gender === "male" ? "male" : undefined;
    voices.push({ id, label, engine, role, ...(fallback ? { fallback: currentSpeechVoiceId(fallback) } : {}), ...(gender ? { gender } : {}) });
  }
  return voices;
};

/** The voices for one role, in catalogue order. */
export const voicesWithRole = (voices: SpeechVoice[], role: SpeechVoiceRole) =>
  voices.filter((voice) => voice.role === role).map((voice) => voice.id);
