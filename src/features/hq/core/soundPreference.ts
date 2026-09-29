/**
 * The viewer's choice for the HQ's sound (keyboards, talk, the system voice),
 * kept in this browser only. On unless turned off; storage that is blocked
 * (a private window) just means the choice lasts for this visit.
 */
const SOUND_KEY = "office3d.hq.sound";

export function hqSoundOn(): boolean {
  try {
    return window.localStorage.getItem(SOUND_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveHqSoundOn(on: boolean): void {
  try {
    window.localStorage.setItem(SOUND_KEY, on ? "on" : "off");
  } catch {
    // Storage blocked: the choice lasts for this visit.
  }
}
