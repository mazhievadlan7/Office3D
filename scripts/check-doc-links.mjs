#!/usr/bin/env node
/**
 * Checks the links between Markdown documents: that a linked file exists and
 * that a #anchor matches a heading in it.
 *
 * Usage: node scripts/check-doc-links.mjs
 *
 * Anchors are built the way GitHub builds them (github-slugger): lower case,
 * punctuation dropped, spaces to hyphens, Cyrillic kept — «## Быстрый старт»
 * is #быстрый-старт. A translated heading changes its anchor, so a link that
 * still points at the English one is reported rather than left to 404 quietly.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SKIP = new Set(["node_modules", ".git", ".next", "out", "dist", "coverage"]);

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return name.endsWith(".md") ? [full] : [];
  });

const slug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");

const anchorsCache = new Map();
const anchorsOf = (file) => {
  if (anchorsCache.has(file)) return anchorsCache.get(file);
  const seen = new Map();
  const anchors = new Set();
  let inCode = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (/^\s*```/.test(line)) inCode = !inCode;
    if (inCode) continue;
    const match = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const base = slug(match[1]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  for (const m of readFileSync(file, "utf8").matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) anchors.add(m[1]);
  anchorsCache.set(file, anchors);
  return anchors;
};

const problems = [];
for (const file of walk(ROOT)) {
  let inCode = false;
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (/^\s*```/.test(line)) inCode = !inCode;
      if (inCode) return;
      // Inline code shows a link's syntax rather than being one.
      for (const m of line.replace(/`[^`]*`/g, "").matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = m[1];
        if (/^(https?:|mailto:|data:)/.test(target)) continue;
        const [rawPath, rawAnchor] = target.split("#");
        const linked = rawPath ? path.resolve(path.dirname(file), decodeURIComponent(rawPath)) : file;
        const where = `${path.relative(ROOT, file)}:${index + 1}`;
        if (!existsSync(linked)) {
          problems.push(`${where}: нет файла ${rawPath}`);
          continue;
        }
        if (rawAnchor && linked.endsWith(".md")) {
          const anchor = decodeURIComponent(rawAnchor).toLowerCase();
          if (!anchorsOf(linked).has(anchor)) problems.push(`${where}: нет якоря #${rawAnchor} в ${path.relative(ROOT, linked)}`);
        }
      }
    });
}

for (const problem of problems) console.log(problem);
console.log(`проблем: ${problems.length}`);
process.exitCode = problems.length > 0 ? 1 : 0;
