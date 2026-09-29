import type { AgentBadgeAccent } from "./profile";

/**
 * The agent's chat badge: one Blender render of the HQ android (hood, fabric
 * mask, red eyes; blender/hacker/tools/badge.py), shared by every agent. Per
 * agent the app adds the accent ring and the callsign mark, so no agent needs
 * a render of its own.
 */

/** 128 px WebP: chat bubbles, lists, the header (up to 64 CSS px on a 2x screen). */
export const AGENT_BADGE_IMAGE_SMALL = "/office-assets/avatars/hacker-badge-128.webp";
/** 512 px PNG for anything drawn larger. */
export const AGENT_BADGE_IMAGE_LARGE = "/office-assets/avatars/hacker-badge.png";

export const agentBadgeImageFor = (size: number) =>
  size > 64 ? AGENT_BADGE_IMAGE_LARGE : AGENT_BADGE_IMAGE_SMALL;

/** Ring colours: the HQ palette, black and graphite with red accents. */
export const AGENT_BADGE_ACCENT_COLORS: Record<AgentBadgeAccent, string> = {
  red: "#ff2a2a",
  crimson: "#b3121b",
  amber: "#f5a524",
  graphite: "#8a8f98",
};

/**
 * The callsign mark on the badge, at most three characters.
 *
 *   "Agent One" -> "AO", "Ghost" -> "GH", "AM7" -> "AM7", "APT28" -> "A28",
 *   "Призрак" -> "ПР"
 */
export const callsignInitials = (name: string): string => {
  const words = name
    .trim()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (words.length === 0) return "";
  if (words.length > 1) {
    return words
      .slice(0, 2)
      .map((word) => Array.from(word)[0] ?? "")
      .join("")
      .toUpperCase();
  }
  const chars = Array.from(words[0]);
  if (chars.length <= 3) return chars.join("").toUpperCase();
  const digits = /\p{N}+$/u.exec(words[0])?.[0];
  if (digits && digits.length < chars.length) {
    return (chars[0] + Array.from(digits).slice(-2).join("")).toUpperCase();
  }
  return chars.slice(0, 2).join("").toUpperCase();
};
