/**
 * Russian → Latin transliteration for identifiers.
 *
 * OpenClaw derives an agent's id from its name and accepts only a-z, 0-9, "_"
 * and "-" (see normalizeAgentIdStrict in OpenClaw's agent-id module). A purely
 * Cyrillic name has none of those, so `agents.create` refuses it outright:
 * "has no valid id characters". Transliterating first gives a readable id —
 * «Новый агент» becomes `novyy-agent` rather than being rejected, or reduced
 * to a bare number when the name happens to contain one.
 *
 * The scheme is the everyday one used for passports and URLs, not a
 * reversible academic one: the result only has to be a sensible folder name.
 * The display name stays Russian; only the id is Latin.
 */

const MAP: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh",
  щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  // Ukrainian and Belarusian letters, so a name in either does not fall
  // through to nothing.
  є: "ye", і: "i", ї: "yi", ґ: "g", ў: "u",
};

const CYRILLIC = /[Ѐ-ӿ]/;

export const hasCyrillic = (value: string): boolean => CYRILLIC.test(value);

export const transliterate = (value: string): string => {
  let out = "";
  for (const char of value) {
    const lower = char.toLowerCase();
    const mapped = MAP[lower];
    if (mapped === undefined) {
      out += char;
      continue;
    }
    // Keeps the case of the first letter, so «Иван» reads as "Ivan".
    out += char !== lower && mapped ? mapped[0].toUpperCase() + mapped.slice(1) : mapped;
  }
  return out;
};
