#!/usr/bin/env node
/**
 * Adds the i18n import to a file, after its import block rather than into the
 * middle of one — a multi-line `import type { … }` is easy to cut in half and
 * the result is a syntax error rather than anything obvious.
 *
 * Usage: node scripts/add-i18n-import.mjs <file> [names]
 */
import { readFileSync, writeFileSync } from "node:fs";

const [file, names = "t"] = process.argv.slice(2);
const lines = readFileSync(file, "utf8").split("\n");

if (lines.some((line) => line.includes('from "@/lib/i18n"'))) {
  process.exit(0);
}

let end = -1;
let depth = 0;
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (depth === 0 && !/^import\b/.test(line)) continue;
  depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
  if (depth === 0) end = i;
}

if (end === -1) {
  // A file with no imports at all: the line goes after "use client", which
  // must stay first.
  const directive = lines.findIndex((line) => /^"use (client|server)";/.test(line));
  lines.splice(directive + 1, 0, "", `import { ${names} } from "@/lib/i18n";`);
} else {
  lines.splice(end + 1, 0, `import { ${names} } from "@/lib/i18n";`);
}
writeFileSync(file, lines.join("\n"));
