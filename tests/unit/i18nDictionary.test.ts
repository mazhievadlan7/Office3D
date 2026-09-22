import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { t, tryT } from "@/lib/i18n";
import { ru } from "@/lib/i18n/ru";

/**
 * Guards the dictionary itself.
 *
 * With a thousand phrases in one file, the failure modes are not typos in any
 * single line — they are drift: a key nobody uses any more, a phrase left in
 * English, straight quotes among the «ёлочки». Each of those reads as
 * carelessness to a Russian speaker and none of them breaks a build, so they
 * are checked here instead.
 */

const SRC = path.join(process.cwd(), "src");

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
};

// Everything but the dictionary itself: a key that only ru.ts mentions is unused.
const sourceFiles = walk(SRC).filter(
  (file) => !file.endsWith(path.join("lib", "i18n", "ru.ts")),
);
const allSource = sourceFiles.map((file) => readFileSync(file, "utf8")).join("\n");

const keys = Object.keys(ru) as Array<keyof typeof ru>;

describe("the Russian dictionary", () => {
  it("has_no_empty_phrase", () => {
    const empty = keys.filter((key) => !ru[key].trim());
    expect(empty).toEqual([]);
  });

  it("uses_the_ellipsis_character_rather_than_three_dots", () => {
    // "Загрузка..." and "Загрузка…" look alike in a diff and different on
    // screen; picking one keeps the interface consistent.
    const offenders = keys.filter((key) => ru[key].includes("..."));
    expect(offenders).toEqual([]);
  });

  it("uses_russian_quotation_marks", () => {
    // Straight quotes in Russian text are the clearest sign of a machine
    // translation nobody read.
    const offenders = keys.filter((key) => /"/.test(ru[key]));
    expect(offenders).toEqual([]);
  });

  it("is_actually_in_russian", () => {
    // A phrase with no Cyrillic at all is either untranslated or a bare
    // product name; the latter belongs inline, not in the dictionary.
    const offenders = keys.filter((key) => !/[Ѐ-ӿ]/.test(ru[key]));
    expect(offenders).toEqual([]);
  });

  it("has_no_key_that_nothing_uses", () => {
    // A dictionary that only grows becomes a graveyard, and a dead phrase is
    // indistinguishable from one that is merely hard to find.
    const unused = keys.filter((key) => !allSource.includes(`"${key}"`));
    expect(unused).toEqual([]);
  });

  it("keeps_the_keys_sorted_so_a_phrase_can_be_found", () => {
    expect(keys).toEqual([...keys].sort());
  });
});

describe("t", () => {
  it("returns_the_phrase", () => {
    expect(t("gateway.connect")).toBe("Подключиться");
  });

  it("fills_placeholders", () => {
    expect(t("gateway.detectedLocal", { port: 18789 })).toContain("18789");
  });

  it("leaves_a_placeholder_it_was_given_no_value_for", () => {
    // Visibly wrong beats quietly wrong: "Осталось {count}" gets fixed, while
    // "Осталось " reads like a finished sentence and survives review.
    expect(t("gateway.detectedLocal")).toContain("{port}");
  });

  it("ignores_extra_values", () => {
    expect(t("gateway.connect", { unused: "x" })).toBe("Подключиться");
  });
});

describe("tryT", () => {
  it("looks_up_a_key_known_only_at_runtime", () => {
    expect(tryT("gateway.connect")).toBe("Подключиться");
  });

  it("returns_null_rather_than_rendering_a_raw_key", () => {
    expect(tryT("nothing.like.this")).toBeNull();
  });
});
