import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The HQ is the app's only theme: <html class="dark hq-theme">, with the
 * .hq-theme block in globals.css declared after .dark so its tokens win.
 * Nothing breaks a build when that drifts, it just looks wrong: a token added
 * to :root/.dark without an HQ value leaks the old blue look into some panel,
 * and a stray teal or amber literal breaks the black/red/white palette.
 */

const ROOT = process.cwd();
const css = readFileSync(path.join(ROOT, "src", "app", "globals.css"), "utf8");
const layout = readFileSync(path.join(ROOT, "src", "app", "layout.tsx"), "utf8");
// Imported by globals.css; it has no theme blocks, so all of it is live.
const markdown = readFileSync(path.join(ROOT, "src", "app", "styles", "markdown.css"), "utf8");

const blockRange = (selector: string): [number, number] => {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`globals.css has no top-level ${selector} block`);
  return [start, css.indexOf("\n}", start) + 2];
};

const block = (selector: string): string => css.slice(...blockRange(selector));

const tokenNames = (body: string): string[] =>
  [...body.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((match) => match[1]);

// Shared by every theme and carrying no colour.
const NON_COLOUR = /^--(radius|font-|space-|spacing|tracking|letter-spacing|shadow-(blur|spread|offset))/;

type Rgb = [number, number, number];

const parseColour = (literal: string): Rgb => {
  if (literal.startsWith("#")) {
    const hex = literal.slice(1);
    const full = hex.length <= 4 ? [...hex.slice(0, 3)].map((c) => c + c).join("") : hex.slice(0, 6);
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb;
  }
  return literal
    .replace(/^rgba?\(|\)$/g, "")
    .split(/[\s,/]+/)
    .slice(0, 3)
    .map(Number) as Rgb;
};

/** Hue in degrees, or null for a grey (black, white and anything between). */
const hueOf = ([r, g, b]: Rgb): number | null => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 3) return null;
  const d = max - min;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};

// Reds (magenta side up to 345°) and oranges up to 35° — orange-300 (31°) is
// the one warning colour; amber (38°+), yellow, green, teal, blue, violet are out.
const isHqHue = (hue: number | null): boolean => hue === null || hue >= 345 || hue <= 35;

describe("the HQ theme", () => {
  it("is_set_on_the_html_element_with_no_theme_switching", () => {
    expect(layout).toMatch(/<html[^>]*className="dark hq-theme"/);
    expect(layout).not.toMatch(/localStorage|prefers-color-scheme/);
  });

  it("is_declared_after_dark_so_its_tokens_win", () => {
    expect(blockRange(".hq-theme")[0]).toBeGreaterThan(blockRange(".dark")[0]);
  });

  it("gives_every_colour_token_of_root_and_dark_an_hq_value", () => {
    const hq = new Set(tokenNames(block(".hq-theme")));
    const inherited = new Set([...tokenNames(block(":root")), ...tokenNames(block(".dark"))]);
    const missing = [...inherited].filter((name) => !NON_COLOUR.test(name) && !hq.has(name));
    expect(missing).toEqual([]);
  });

  it("uses_only_black_red_white_and_one_orange_outside_the_legacy_blocks", () => {
    // :root and .dark are the dormant light/blue sets the HQ overrides; every
    // other literal in the stylesheet is live and must be on the palette.
    const [rootStart, rootEnd] = blockRange(":root");
    const [darkStart, darkEnd] = blockRange(".dark");
    const live = css.slice(0, rootStart) + css.slice(rootEnd, darkStart) + css.slice(darkEnd) + markdown;
    const literals = live.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) ?? [];
    expect(literals.length).toBeGreaterThan(20);
    const offenders = literals.filter((literal) => !isHqHue(hueOf(parseColour(literal))));
    expect(offenders).toEqual([]);
    // HQ colours are written as hex or rgb(); a colour-function literal would
    // slip past the hue check above ("in oklch," inside color-mix is fine).
    expect(live.match(/\b(?:oklch|oklab|lch|lab|hsla?|hwb)\(/g) ?? []).toEqual([]);
  });

  it("recognises_off_palette_hues", () => {
    // The checker itself: teal, amber, blue and green are caught; red, the
    // warning orange and greys pass.
    for (const bad of ["#21888f", "#f59e0b", "#22a8cc", "rgb(32 170 104 / 0.2)"]) {
      expect(isHqHue(hueOf(parseColour(bad))), bad).toBe(false);
    }
    for (const good of ["#e3141c", "#ffb86a", "#0b0707", "#ffffff", "rgb(130 24 26 / 0.4)"]) {
      expect(isHqHue(hueOf(parseColour(good))), good).toBe(true);
    }
  });
});
