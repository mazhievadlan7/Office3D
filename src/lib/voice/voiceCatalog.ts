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
};

export const SPEECH_VOICE_ID_RE = /^(silero|voicestudio):[A-Za-z0-9_.-]{1,80}$/;

export const isSpeechVoiceId = (value: unknown): value is string =>
  typeof value === "string" && SPEECH_VOICE_ID_RE.test(value.trim());

export const DEFAULT_SYSTEM_VOICE = "silero:aidar";
export const DEFAULT_LEAD_VOICE = "voicestudio:am7";

export const BUILTIN_SPEECH_VOICES: SpeechVoice[] = [
  { id: "voicestudio:am7", label: "AM7", engine: "voicestudio", role: "lead", fallback: "silero:eugene" },
  { id: "voicestudio:crew-m1", label: "Оператор М1", engine: "voicestudio", role: "crew", fallback: "silero:aidar" },
  { id: "voicestudio:crew-m2", label: "Оператор М2", engine: "voicestudio", role: "crew", fallback: "silero:eugene" },
  { id: "voicestudio:crew-m3", label: "Оператор М3", engine: "voicestudio", role: "crew", fallback: "silero:aidar" },
  { id: "voicestudio:crew-f1", label: "Оператор Ж1", engine: "voicestudio", role: "crew", fallback: "silero:baya" },
  { id: "voicestudio:crew-f2", label: "Оператор Ж2", engine: "voicestudio", role: "crew", fallback: "silero:kseniya" },
  { id: "silero:aidar", label: "Система штаба (Айдар, Silero)", engine: "silero", role: "system" },
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
    voices.push({ id, label, engine, role, ...(fallback ? { fallback } : {}) });
  }
  return voices;
};

/** The voices for one role, in catalogue order. */
export const voicesWithRole = (voices: SpeechVoice[], role: SpeechVoiceRole) =>
  voices.filter((voice) => voice.role === role).map((voice) => voice.id);
