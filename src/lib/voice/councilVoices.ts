/**
 * Voices for the Floor 27 council. «Система штаба» announces with the system
 * voice (role "system"), AM7 chairs with his own voice (silero:am7, the id the
 * office still writes as voicestudio:am7), and each of the 26 directorate
 * chiefs has a distinct Silero preset assigned deterministically by floor
 * (voiceCatalog.councilChiefVoiceId → services/speech/voices.json silero:chief-NN,
 * a male speaker with a small per-chief pitch via the gateway FX, fx.py
 * council-hard-*). The gateway bakes the pitch/FX into the preset, so the
 * browser only ever sends the voice id.
 */

import { councilChiefVoiceId, DEFAULT_LEAD_VOICE } from "./voiceCatalog";
import type { CouncilRole } from "@/features/hq/core/council/machine";

/** AM7's own voice at the council (Silero-backed; the office's lead voice). */
export const COUNCIL_AM7_VOICE = DEFAULT_LEAD_VOICE;

/** A request to the speech gateway for one council line. */
export type CouncilVoiceRequest = {
  /** Pass role:"system" so the gateway uses «Система штаба»'s own voice. */
  role: "system" | null;
  /** The Silero voice id (null when role drives the voice). */
  voiceId: string | null;
  /** A touch slower than talk, like the briefing PA. */
  speed: number;
};

/**
 * The gateway request for a council cue: «Система штаба» for the announcement
 * and closing-system lines, AM7 for his replies, and the floor's own chief
 * preset for a chief's report.
 */
export function councilVoiceFor(role: CouncilRole, floor: number | null): CouncilVoiceRequest {
  if (role === "system") return { role: "system", voiceId: null, speed: 0.95 };
  if (role === "am7") return { role: null, voiceId: COUNCIL_AM7_VOICE, speed: 0.95 };
  // A chief: the floor's own voice; fall back to AM7's if the floor is unknown.
  return { role: null, voiceId: floor != null ? councilChiefVoiceId(floor) : COUNCIL_AM7_VOICE, speed: 0.97 };
}

export { councilChiefVoiceId };
