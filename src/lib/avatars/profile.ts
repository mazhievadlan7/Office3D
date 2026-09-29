/**
 * An agent's avatar profile.
 *
 * Every HQ agent is the same android (black techwear, hood, fabric mask, red
 * eyes), and so is its chat badge: one render of that character
 * (lib/avatars/badge.ts). What the profile still holds per agent is the seed
 * (it offsets the HQ idle clip and keys the badge) and the accent of the ring
 * around the badge, picked from the HQ palette.
 *
 * Profiles saved before the badge carried a 2D human portrait (skin, hair,
 * clothes, hat, glasses). Those fields are ignored on load; the seed survives,
 * and the accent falls back to the one the seed picks.
 */

export const AGENT_BADGE_ACCENTS = ["red", "crimson", "amber", "graphite"] as const;
export type AgentBadgeAccent = (typeof AGENT_BADGE_ACCENTS)[number];

export type AgentAvatarProfile = {
  version: 2;
  seed: string;
  accent: AgentBadgeAccent;
};

const AGENT_AVATAR_VERSION = 2 as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const coerceString = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export const hashAvatarSeed = (seed: string) => {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

/** The accent a seed gets when nobody has picked one. */
export const accentForSeed = (seed: string): AgentBadgeAccent =>
  AGENT_BADGE_ACCENTS[hashAvatarSeed(seed.trim() || "agent") % AGENT_BADGE_ACCENTS.length];

const isAccent = (value: unknown): value is AgentBadgeAccent =>
  typeof value === "string" && (AGENT_BADGE_ACCENTS as readonly string[]).includes(value);

export const createDefaultAgentAvatarProfile = (seed: string): AgentAvatarProfile => {
  const normalizedSeed = seed.trim() || "agent";
  return {
    version: AGENT_AVATAR_VERSION,
    seed: normalizedSeed,
    accent: accentForSeed(normalizedSeed),
  };
};

export const normalizeAgentAvatarProfile = (
  value: unknown,
  fallbackSeed: string,
): AgentAvatarProfile => {
  if (typeof value === "string") {
    return createDefaultAgentAvatarProfile(value);
  }
  if (!isRecord(value)) {
    return createDefaultAgentAvatarProfile(fallbackSeed);
  }
  const base = createDefaultAgentAvatarProfile(coerceString(value.seed) || fallbackSeed);
  const accent = coerceString(value.accent).toLowerCase();
  return isAccent(accent) ? { ...base, accent } : base;
};
