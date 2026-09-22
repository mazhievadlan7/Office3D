#!/usr/bin/env node
/**
 * Reports what is wrong with the Russian dictionary, so the checks the test
 * suite enforces can be run while translating rather than after.
 *
 * Usage: node scripts/i18n-check.mjs [--prune] [--sort]
 *   --prune  removes keys nothing uses, instead of only listing them.
 *   --sort   sorts entries inside each section, keeping the comments.
 *   --braces fixes JSX attributes written as attr=t("…") instead of {t("…")}.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "src");
const DICT = path.join(SRC, "lib", "i18n", "ru.ts");

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
};

const source = walk(SRC)
  // Everything but the dictionary itself: a key that only ru.ts mentions is unused.
  .filter((file) => file !== DICT)
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

const raw = readFileSync(DICT, "utf8");
const keys = [...raw.matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]);

const unused = keys.filter((key) => !source.includes(`"${key}"`));
const sorted = [...keys].sort();
const misordered = keys.filter((key, i) => key !== sorted[i]);

// Replacing a bare "…" inside a JSX attribute without braces gives
// `aria-label=t("…")`, which is a syntax error far from where it was made.
const unbraced = [];
for (const file of walk(SRC)) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/^.*[a-zA-Z-]+=t\(".*$/gm)) {
    unbraced.push(`${path.relative(process.cwd(), file)}: ${match[0].trim()}`);
  }
}

if (process.argv.includes("--braces")) {
  let fixed = 0;
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    const next = text.replace(
      /([a-zA-Z-]+)=(t\("[^"]+"(?:, \{[^}]*\})?\))/g,
      (_whole, attr, call) => {
        fixed += 1;
        return `${attr}={${call}}`;
      },
    );
    if (next !== text) writeFileSync(file, next);
  }
  console.log(`скобки исправлены: ${fixed}`);
}

console.log(`ключей: ${keys.length}`);
if (unbraced.length && !process.argv.includes("--braces")) {
  console.log(`атрибут без фигурных скобок: ${unbraced.length}`);
  console.log("  " + unbraced.join("\n  "));
}
console.log(`не используется: ${unused.length}`);
if (unused.length) console.log("  " + unused.join("\n  "));
if (misordered.length) console.log(`не по алфавиту, первый: ${misordered[0]}`);

if (process.argv.includes("--sort")) {
  // Groups every entry by its area (the part before the first dot), sorts
  // globally, and gives each area one "--- … ---" heading. Grouping by prefix
  // rather than by where an entry happens to sit means a key appended at the
  // end still lands in its own area.
  const lines = readFileSync(DICT, "utf8").split("\n");
  const open = lines.findIndex((line) => line.startsWith("export const ru = {"));
  const close = lines.findIndex((line) => line.trim() === "} as const;");

  const headings = new Map();
  const entries = [];
  let pendingHeading = null;
  for (let i = open + 1; i < close; i += 1) {
    const line = lines[i];
    if (/^ {2}\/\/ ---/.test(line)) {
      pendingHeading = line;
      continue;
    }
    const match = /^ {2}"([^"]+)":/.exec(line);
    if (!match) continue;
    const entry = [line];
    while (i + 1 < close && /^ {4}\S/.test(lines[i + 1])) {
      entry.push(lines[i + 1]);
      i += 1;
    }
    const area = match[1].split(".")[0];
    if (pendingHeading && !headings.has(area)) headings.set(area, pendingHeading);
    pendingHeading = null;
    entries.push([match[1], entry]);
  }

  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const body = [];
  let currentArea = null;
  for (const [key, entry] of entries) {
    const area = key.split(".")[0];
    if (area !== currentArea) {
      if (currentArea !== null) body.push("");
      const heading =
        headings.get(area) ?? `  // --- ${area} ${"-".repeat(Math.max(3, 70 - area.length))}`;
      body.push(heading);
      currentArea = area;
    }
    body.push(...entry);
  }

  writeFileSync(
    DICT,
    [...lines.slice(0, open + 1), ...body, ...lines.slice(close)].join("\n"),
  );
  console.log("отсортировано");
}

if (process.argv.includes("--prune") && unused.length) {
  let next = raw;
  for (const key of unused) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    next = next.replace(new RegExp(`^ {2}"${escaped}":[\\s\\S]*?,\\n`, "m"), "");
  }
  writeFileSync(DICT, next);
  console.log(`убрано: ${unused.length}`);
}
