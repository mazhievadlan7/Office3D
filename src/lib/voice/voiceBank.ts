// The crew's pre-rendered HQ talk (scripts/voice-bank.mjs): which file says
// which crew line in which voice. Shared by the server route that serves the
// bank and the browser that plays it.

/** `<voice>.<line>.<hash12>.mp3`: content-addressed, so a file never changes. */
export const VOICE_BANK_FILE_RE = /^[a-z0-9-]{1,40}\.[a-z0-9]{1,12}\.[0-9a-f]{12}\.mp3$/;

export const isVoiceBankFile = (name: unknown): name is string =>
  typeof name === "string" && VOICE_BANK_FILE_RE.test(name);

export type VoiceBankLine = { file: string; duration: number };

export type VoiceBankVoice = {
  label: string;
  gender: "male" | "female" | null;
  /** Crew line id to its file. */
  lines: Record<string, VoiceBankLine>;
};

export type VoiceBankManifest = {
  version: number;
  generatedAt: string | null;
  /** Voice id (`voicestudio:crew-m1`) to what it says. */
  voices: Record<string, VoiceBankVoice>;
};

const VOICE_ID_RE = /^(silero|voicestudio):[A-Za-z0-9_.-]{1,80}$/;
const LINE_ID_RE = /^[a-z0-9]{1,12}$/;

/**
 * A manifest from untrusted JSON: bad voices, lines and file names are
 * dropped (never throws). Null when nothing usable is left.
 */
export function parseVoiceBankManifest(body: unknown): VoiceBankManifest | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as { version?: unknown; generatedAt?: unknown; voices?: unknown };
  if (typeof raw.version !== "number" || !raw.voices || typeof raw.voices !== "object") return null;
  const voices: Record<string, VoiceBankVoice> = {};
  for (const [id, value] of Object.entries(raw.voices as Record<string, unknown>)) {
    if (!VOICE_ID_RE.test(id) || !value || typeof value !== "object") continue;
    const entry = value as { label?: unknown; gender?: unknown; lines?: unknown };
    const lines: Record<string, VoiceBankLine> = {};
    if (entry.lines && typeof entry.lines === "object") {
      for (const [lineId, item] of Object.entries(entry.lines as Record<string, unknown>)) {
        const line = item as { file?: unknown; duration?: unknown } | null;
        if (!LINE_ID_RE.test(lineId) || !line || !isVoiceBankFile(line.file)) continue;
        const duration = typeof line.duration === "number" && Number.isFinite(line.duration) ? line.duration : 0;
        lines[lineId] = { file: line.file, duration: Math.max(0, Math.min(30, duration)) };
      }
    }
    if (Object.keys(lines).length === 0) continue;
    voices[id] = {
      label: typeof entry.label === "string" ? entry.label.slice(0, 80) : id,
      gender: entry.gender === "female" ? "female" : entry.gender === "male" ? "male" : null,
      lines,
    };
  }
  if (Object.keys(voices).length === 0) return null;
  return {
    version: raw.version,
    generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : null,
    voices,
  };
}

export const VOICE_BANK_ROUTE = "/api/office/voice/bank";
