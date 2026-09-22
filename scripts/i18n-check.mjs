#!/usr/bin/env node
/**
 * Reports what is wrong with the Russian dictionary, so the checks the test
 * suite enforces can be run while translating rather than after.
 *
 * Usage: node scripts/i18n-check.mjs [--prune]
 *   --prune  removes keys nothing uses, instead of only listing them.
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
  .filter((file) => !file.includes(path.join("lib", "i18n")))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

const raw = readFileSync(DICT, "utf8");
const keys = [...raw.matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]);

const unused = keys.filter((key) => !source.includes(`"${key}"`));
const sorted = [...keys].sort();
const misordered = keys.filter((key, i) => key !== sorted[i]);

console.log(`ключей: ${keys.length}`);
console.log(`не используется: ${unused.length}`);
if (unused.length) console.log("  " + unused.join("\n  "));
if (misordered.length) console.log(`не по алфавиту, первый: ${misordered[0]}`);

if (process.argv.includes("--prune") && unused.length) {
  let next = raw;
  for (const key of unused) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    next = next.replace(new RegExp(`^ {2}"${escaped}":[\\s\\S]*?,\\n`, "m"), "");
  }
  writeFileSync(DICT, next);
  console.log(`убрано: ${unused.length}`);
}
