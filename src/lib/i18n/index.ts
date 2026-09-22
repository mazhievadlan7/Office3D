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

const phrasePatterns = new Map<TranslationKey, RegExp>();

/**
 * Whether a message is this phrase, whatever went into its placeholders.
 *
 * For code that has to recognise one of our own messages after it lost its
 * type — an Error rethrown as text, a JSON error from an API route — and
 * decide something from it, such as a 400 rather than a 500. Matching the
 * dictionary entry keeps that decision working when the wording changes,
 * where a copy of the words in an includes() would silently stop matching.
 */
export const matchesPhrase = (text: string, key: TranslationKey): boolean => {
  let pattern = phrasePatterns.get(key);
  if (!pattern) {
    const source = ru[key]
      .split(PLACEHOLDER)
      // split() with a capture group interleaves the placeholder names: every
      // odd element is one, every even one is literal text.
      .map((part, index) =>
        index % 2 === 1 ? "[\\s\\S]*?" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("");
    pattern = new RegExp(source);
    phrasePatterns.set(key, pattern);
  }
  return pattern.test(text);
};

export { ru };
export * from "@/lib/i18n/plural";
