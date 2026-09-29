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
  /** Grammatical gender of the voice (the crew's lines are written for it). */
  gender?: "male" | "female";
};

export const SPEECH_VOICE_ID_RE = /^(silero|voicestudio):[A-Za-z0-9_.-]{1,80}$/;

export const isSpeechVoiceId = (value: unknown): value is string =>
  typeof value === "string" && SPEECH_VOICE_ID_RE.test(value.trim());

/** «Система штаба»: Silero's deepest voice (exact stress, instant on a CPU) with the gateway's humanoid FX. */
export const DEFAULT_SYSTEM_VOICE = "silero:system";
export const DEFAULT_LEAD_VOICE = "voicestudio:am7";

const crew = (id: string, label: string, gender: "male" | "female", fallback: string): SpeechVoice => ({
  id: `voicestudio:${id}`,
  label,
  engine: "voicestudio",
  role: "crew",
  fallback,
  gender,
});

// The casting: AM7 and eight operators, each a VoxCPM2-designed voice cloned
// from its own reference clip, each with a different Silero fallback.
export const BUILTIN_SPEECH_VOICES: SpeechVoice[] = [
  { id: "voicestudio:am7", label: "AM7", engine: "voicestudio", role: "lead", fallback: "silero:ru_safarhuja", gender: "male" },
  crew("crew-m1", "Оператор — быстрый, точный", "male", "silero:ru_alexandr"),
  crew("crew-m2", "Аналитик — холодный, ровный", "male", "silero:ru_roman"),
  crew("crew-m3", "Ветеран — спокойный баритон", "male", "silero:aidar"),
  crew("crew-m4", "Инфильтратор — с хрипотцой, тихий", "male", "silero:ru_bogdan"),
  crew("crew-m5", "Взломщик — молодой, энергичный", "male", "silero:ru_dmitriy"),
  crew("crew-m6", "Часовой — глубокий бас, сдержанный", "male", "silero:ru_eduard"),
  crew("crew-f1", "Техлид — точная, собранная (Ж)", "female", "silero:baya"),
  crew("crew-f2", "Разведка — спокойная, негромкая (Ж)", "female", "silero:kseniya"),
  { id: "silero:system", label: "Система штаба (Silero Евгений)", engine: "silero", role: "system", gender: "male" },
  { id: "silero:aidar", label: "Айдар (Silero)", engine: "silero", role: "any" },
  { id: "silero:eugene", label: "Евгений (Silero)", engine: "silero", role: "any" },
  { id: "silero:baya", label: "Бая (Silero)", engine: "silero", role: "any" },
  { id: "silero:kseniya", label: "Ксения (Silero)", engine: "silero", role: "any" },
  { id: "silero:xenia", label: "Ксения (светлый) (Silero)", engine: "silero", role: "any" },
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
    const gender = entry.gender === "male" || entry.gender === "female" ? entry.gender : undefined;
    voices.push({ id, label, engine, role, ...(fallback ? { fallback } : {}), ...(gender ? { gender } : {}) });
  }
  return voices;
};

/** The voices for one role, in catalogue order. */
export const voicesWithRole = (voices: SpeechVoice[], role: SpeechVoiceRole) =>
  voices.filter((voice) => voice.role === role).map((voice) => voice.id);
