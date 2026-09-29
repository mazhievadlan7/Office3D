import os from "node:os";
import path from "node:path";

type Env = Record<string, string | undefined>;

/**
 * Where scripts/voice-bank.mjs writes the crew's talk: OFFICE3D_VOICE_BANK_DIR,
 * else <speech home>/voice-bank (OFFICE3D_SPEECH_HOME, else the platform's
 * data directory, as scripts/speech-run.mjs resolves it).
 */
export function voiceBankDir(env: Env = process.env): string {
  const explicit = env.OFFICE3D_VOICE_BANK_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const home =
    env.OFFICE3D_SPEECH_HOME?.trim() ||
    (process.platform === "win32"
      ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "office3d-speech")
      : path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "office3d-speech"));
  return path.resolve(home, "voice-bank");
}
