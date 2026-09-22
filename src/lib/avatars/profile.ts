
import { t } from "@/lib/i18n";
export type AgentAvatarHairStyle = "short" | "parted" | "spiky" | "bun";
export type AgentAvatarTopStyle = "tee" | "hoodie" | "jacket";
export type AgentAvatarBottomStyle = "pants" | "shorts" | "cuffed";
export type AgentAvatarHatStyle = "none" | "cap" | "beanie";

export type AgentAvatarProfile = {
  version: 1;
  seed: string;
  body: {
    skinTone: string;
  };
  hair: {
    style: AgentAvatarHairStyle;
    color: string;
  };
  clothing: {
    topStyle: AgentAvatarTopStyle;
    topColor: string;
    bottomStyle: AgentAvatarBottomStyle;
    bottomColor: string;
    shoesColor: string;
  };
  accessories: {
    glasses: boolean;
    headset: boolean;
    hatStyle: AgentAvatarHatStyle;
    backpack: boolean;
  };
};

type ColorOption = {
  id: string;
  label: string;
  color: string;
};

type EnumOption<T extends string> = {
  id: T;
  label: string;
};

export const AGENT_AVATAR_SKIN_TONE_OPTIONS: ColorOption[] = [
  { id: "fair", label: t("libAvatars.skinFair"), color: "#f7d7c2" },
  { id: "light", label: t("libAvatars.skinLight"), color: "#f4c58a" },
  { id: "warm", label: t("libAvatars.skinWarm"), color: "#d8a06e" },
  { id: "tan", label: t("libAvatars.skinTan"), color: "#b7794e" },
  { id: "deep", label: t("libAvatars.skinDeep"), color: "#8a5a3b" },
  { id: "rich", label: t("libAvatars.skinRich"), color: "#5d3a24" },
];

export const AGENT_AVATAR_HAIR_STYLE_OPTIONS: EnumOption<AgentAvatarHairStyle>[] = [
  { id: "short", label: t("libAvatars.hairShort") },
  { id: "parted", label: t("libAvatars.hairParted") },
  { id: "spiky", label: t("libAvatars.hairSpiky") },
  { id: "bun", label: t("libAvatars.hairBun") },
];

export const AGENT_AVATAR_HAIR_COLOR_OPTIONS: ColorOption[] = [
  { id: "ink", label: t("libAvatars.hairInk"), color: "#151515" },
  { id: "espresso", label: t("libAvatars.hairEspresso"), color: "#3e2723" },
  { id: "walnut", label: t("libAvatars.hairWalnut"), color: "#6b4f3a" },
  { id: "auburn", label: t("libAvatars.hairAuburn"), color: "#7b341e" },
  { id: "blonde", label: t("libAvatars.hairBlonde"), color: "#d6b56c" },
  { id: "violet", label: t("libAvatars.colorViolet"), color: "#7c3aed" },
  { id: "cyan", label: t("libAvatars.colorCyan"), color: "#0891b2" },
  { id: "pink", label: t("libAvatars.colorPink"), color: "#db2777" },
];

export const AGENT_AVATAR_TOP_STYLE_OPTIONS: EnumOption<AgentAvatarTopStyle>[] = [
  { id: "tee", label: t("libAvatars.topTee") },
  { id: "hoodie", label: t("libAvatars.topHoodie") },
  { id: "jacket", label: t("libAvatars.topJacket") },
];

export const AGENT_AVATAR_BOTTOM_STYLE_OPTIONS: EnumOption<AgentAvatarBottomStyle>[] = [
  { id: "pants", label: t("libAvatars.bottomPants") },
  { id: "shorts", label: t("libAvatars.bottomShorts") },
  { id: "cuffed", label: t("libAvatars.bottomCuffed") },
];

export const AGENT_AVATAR_HAT_STYLE_OPTIONS: EnumOption<AgentAvatarHatStyle>[] = [
  { id: "none", label: t("libAvatars.hatNone") },
  { id: "cap", label: t("libAvatars.hatCap") },
  { id: "beanie", label: t("libAvatars.hatBeanie") },
];

export const AGENT_AVATAR_CLOTHING_COLOR_OPTIONS: ColorOption[] = [
  { id: "graphite", label: t("libAvatars.colorGraphite"), color: "#2d3748" },
  { id: "sky", label: t("libAvatars.colorSky"), color: "#7090ff" },
  { id: "mint", label: t("libAvatars.colorMint"), color: "#34d399" },
  { id: "amber", label: t("libAvatars.colorAmber"), color: "#f59e0b" },
  { id: "rose", label: t("libAvatars.colorRose"), color: "#f43f5e" },
  { id: "violet", label: t("libAvatars.colorViolet"), color: "#8b5cf6" },
  { id: "cream", label: t("libAvatars.colorCream"), color: "#f5f5f4" },
  { id: "slate", label: t("libAvatars.colorSlate"), color: "#64748b" },
];

export const AGENT_AVATAR_SHOE_COLOR_OPTIONS: ColorOption[] = [
  { id: "black", label: t("libAvatars.colorBlack"), color: "#1a1a1a" },
  { id: "navy", label: t("libAvatars.colorNavy"), color: "#1e3a8a" },
  { id: "brown", label: t("libAvatars.colorBrown"), color: "#7c4a2d" },
  { id: "white", label: t("libAvatars.colorWhite"), color: "#e5e7eb" },
];

const AGENT_AVATAR_VERSION = 1 as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const coerceString = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const hashSeed = (seed: string) => {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const pick = <T,>(values: readonly T[], index: number) => values[index % values.length];

const resolveColor = (value: unknown, options: ColorOption[], fallback: string) => {
  const color = coerceString(value).toLowerCase();
  if (!color) return fallback;
  const option =
    options.find((entry) => entry.id === color) ??
    options.find((entry) => entry.color.toLowerCase() === color);
  return option?.color ?? fallback;
};

const resolveEnumOption = <T extends string>(
  value: unknown,
  options: EnumOption<T>[],
  fallback: T,
): T => {
  const normalized = coerceString(value).toLowerCase();
  const match = options.find((entry) => entry.id === normalized);
  return match?.id ?? fallback;
};

export const createAgentAvatarProfileFromSeed = (seed: string): AgentAvatarProfile => {
  const normalizedSeed = seed.trim() || "agent";
  const hash = hashSeed(normalizedSeed);
  const skinTone = pick(AGENT_AVATAR_SKIN_TONE_OPTIONS, hash).color;
  const hairStyle = pick(AGENT_AVATAR_HAIR_STYLE_OPTIONS, hash >>> 3).id;
  const hairColor = pick(AGENT_AVATAR_HAIR_COLOR_OPTIONS, hash >>> 5).color;
  const topStyle = pick(AGENT_AVATAR_TOP_STYLE_OPTIONS, hash >>> 7).id;
  const topColor = pick(AGENT_AVATAR_CLOTHING_COLOR_OPTIONS, hash >>> 9).color;
  const bottomStyle = pick(AGENT_AVATAR_BOTTOM_STYLE_OPTIONS, hash >>> 11).id;
  const bottomColor = pick(AGENT_AVATAR_CLOTHING_COLOR_OPTIONS, hash >>> 13).color;
  const shoesColor = pick(AGENT_AVATAR_SHOE_COLOR_OPTIONS, hash >>> 15).color;
  const hatStyle = pick(AGENT_AVATAR_HAT_STYLE_OPTIONS, hash >>> 17).id;

  return {
    version: AGENT_AVATAR_VERSION,
    seed: normalizedSeed,
    body: {
      skinTone,
    },
    hair: {
      style: hairStyle,
      color: hairColor,
    },
    clothing: {
      topStyle,
      topColor,
      bottomStyle,
      bottomColor,
      shoesColor,
    },
    accessories: {
      glasses: Boolean((hash >>> 19) % 2),
      headset: Boolean((hash >>> 20) % 2),
      hatStyle,
      backpack: Boolean((hash >>> 21) % 2),
    },
  };
};

export const createDefaultAgentAvatarProfile = (seed: string): AgentAvatarProfile =>
  createAgentAvatarProfileFromSeed(seed);

export const normalizeAgentAvatarProfile = (
  value: unknown,
  fallbackSeed: string,
): AgentAvatarProfile => {
  if (typeof value === "string") {
    return createAgentAvatarProfileFromSeed(value);
  }

  const baseProfile = createAgentAvatarProfileFromSeed(fallbackSeed);
  if (!isRecord(value)) {
    return baseProfile;
  }

  const body = isRecord(value.body) ? value.body : {};
  const hair = isRecord(value.hair) ? value.hair : {};
  const clothing = isRecord(value.clothing) ? value.clothing : {};
  const accessories = isRecord(value.accessories) ? value.accessories : {};
  const normalizedSeed = coerceString(value.seed) || baseProfile.seed;

  return {
    version: AGENT_AVATAR_VERSION,
    seed: normalizedSeed,
    body: {
      skinTone: resolveColor(
        body.skinTone,
        AGENT_AVATAR_SKIN_TONE_OPTIONS,
        baseProfile.body.skinTone,
      ),
    },
    hair: {
      style: resolveEnumOption(
        hair.style,
        AGENT_AVATAR_HAIR_STYLE_OPTIONS,
        baseProfile.hair.style,
      ),
      color: resolveColor(
        hair.color,
        AGENT_AVATAR_HAIR_COLOR_OPTIONS,
        baseProfile.hair.color,
      ),
    },
    clothing: {
      topStyle: resolveEnumOption(
        clothing.topStyle,
        AGENT_AVATAR_TOP_STYLE_OPTIONS,
        baseProfile.clothing.topStyle,
      ),
      topColor: resolveColor(
        clothing.topColor,
        AGENT_AVATAR_CLOTHING_COLOR_OPTIONS,
        baseProfile.clothing.topColor,
      ),
      bottomStyle: resolveEnumOption(
        clothing.bottomStyle,
        AGENT_AVATAR_BOTTOM_STYLE_OPTIONS,
        baseProfile.clothing.bottomStyle,
      ),
      bottomColor: resolveColor(
        clothing.bottomColor,
        AGENT_AVATAR_CLOTHING_COLOR_OPTIONS,
        baseProfile.clothing.bottomColor,
      ),
      shoesColor: resolveColor(
        clothing.shoesColor,
        AGENT_AVATAR_SHOE_COLOR_OPTIONS,
        baseProfile.clothing.shoesColor,
      ),
    },
    accessories: {
      glasses:
        typeof accessories.glasses === "boolean"
          ? accessories.glasses
          : baseProfile.accessories.glasses,
      headset:
        typeof accessories.headset === "boolean"
          ? accessories.headset
          : baseProfile.accessories.headset,
      hatStyle: resolveEnumOption(
        accessories.hatStyle,
        AGENT_AVATAR_HAT_STYLE_OPTIONS,
        baseProfile.accessories.hatStyle,
      ),
      backpack:
        typeof accessories.backpack === "boolean"
          ? accessories.backpack
          : baseProfile.accessories.backpack,
    },
  };
};
