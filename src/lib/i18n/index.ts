import { ru } from "@/lib/i18n/ru";

/**
 * Office3D speaks Russian.
 *
 * Every user-facing string lives in one dictionary rather than scattered
 * through 84 component files: that is what makes the wording reviewable, the
 * terminology consistent, and a wrong or missing phrase findable in one place.
 *
 * There is one locale and no switcher. Adding English later means adding a
 * second dictionary and a lookup, not another pass over the whole codebase —
 * which is the reason the indirection is here at all.
 *
 * Keys are typed: `t("nothing.like.this")` is a compile error, not a string
 * that quietly renders as itself in production.
 */

export type TranslationKey = keyof typeof ru;

export type TranslationVars = Record<string, string | number>;

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Looks a phrase up and fills its {placeholders}.
 *
 * A placeholder with no value is left as written rather than blanked: "Осталось
 * {count}" is visibly wrong and gets fixed, while "Осталось " reads like a
 * finished sentence and survives review.
 */
export const t = (key: TranslationKey, vars?: TranslationVars): string => {
  const template = ru[key];
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : String(value);
  });
};

/**
 * The same lookup for a key only known at runtime — a status code, a provider
 * name. Returns null when there is no such phrase, so the caller decides what
 * to show rather than rendering a raw key.
 */
export const tryT = (key: string, vars?: TranslationVars): string | null =>
  key in ru ? t(key as TranslationKey, vars) : null;

export { ru };
export * from "@/lib/i18n/plural";
