#!/usr/bin/env node
/**
 * Lists, and optionally replaces, the English text left in a source file.
 *
 * Regular expressions miss JSX text that spans lines or sits next to an
 * expression, so this walks the TypeScript syntax tree instead. Every item is
 * numbered in source order; the numbering is stable as long as the file does
 * not change between listing and applying.
 *
 *   node scripts/i18n-extract.mjs <file> [<file> …]
 *       Prints each candidate as  #id kind line: text
 *         J  JSX text
 *         A  string attribute (title, placeholder, aria-label, …)
 *         S  string literal elsewhere — prose-looking ones only; many are
 *            identifiers or protocol values and must be left alone
 *
 *   node scripts/i18n-extract.mjs --apply <spec.json>
 *       Spec: [{ "file": "…", "items": { "<id>": ["key", "Русский текст"] } }]
 *       Replaces each listed item with t("key") in the right shape for where
 *       it sits, adds the keys to the dictionary and the import to the file.
 *       ["key"] without a translation reuses an existing key; a third element
 *       {"placeholder": "expression"} passes interpolation values; "raw": [{old,
 *       new}] handles what needs an interpolated call, and "keys": [{key, ru}]
 *       adds the keys those raw replacements use.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DICT = path.join(ROOT, "src/lib/i18n/ru.ts");

const TEXT_ATTRS = new Set([
  "title",
  "placeholder",
  "aria-label",
  "aria-description",
  "alt",
  "label",
  "description",
  "tooltip",
  "hint",
  "emptyLabel",
  "subtitle",
  "heading",
]);

// Attributes that hold code rather than words, whatever they look like.
const CODE_ATTRS =
  /^(className|class|href|src|id|key|type|name|role|rel|target|style|htmlFor|method|action|autoComplete|inputMode|pattern|accept|viewBox|d|fill|stroke|xmlns|data-.*|testId|variant|size|align|mode|kind|tone)$/;

const hasLatinWord = (text) => /[A-Za-z]{2,}/.test(text) && !/[А-Яа-яЁё]/.test(text);

// A string that reads like a sentence or a label rather than an identifier,
// a CSS class list, a URL or a path.
const looksLikeProse = (text) => {
  if (!hasLatinWord(text)) return false;
  if (/^(https?:|wss?:|\/|\.|#|@|data:)/.test(text)) return false;
  if (/^[a-z0-9_.:/-]+$/.test(text)) return false; // identifiers, keys, slugs
  if (/^[A-Z0-9_]+$/.test(text)) return false; // CONSTANTS
  if (/\b(flex|grid|px-|py-|text-|bg-|border|rounded|w-|h-|items-|gap-)/.test(text)) return false;
  return /^[A-Z][a-z]/.test(text) || /\s/.test(text);
};

const isTypePosition = (node) => {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isTypeNode(p) && !ts.isTypeQueryNode(p)) return true;
    if (ts.isStatement(p) || ts.isExpression(p) && !ts.isStringLiteral(p)) return false;
  }
  return false;
};

// Inside className={…}, key={…} and the like, or a class-name helper.
const inCodeAttr = (node) => {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isJsxAttribute(p)) return CODE_ATTRS.test(p.name.getText());
    if (ts.isCallExpression(p) && /^(cn|clsx|classNames|twMerge)$/.test(p.expression.getText())) return true;
    if (ts.isStatement(p) || ts.isJsxElement(p)) return false;
  }
  return false;
};

const skipLiteral = (node) => {
  if (inCodeAttr(node)) return true;
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isExpressionStatement(parent)) return true; // "use client" and other directives
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  if (ts.isExternalModuleReference(parent)) return true;
  if (ts.isLiteralTypeNode(parent) || isTypePosition(node)) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isElementAccessExpression(parent)) return true;
  if (ts.isCaseClause(parent)) return true;
  if (ts.isBinaryExpression(parent) && /=|!|<|>/.test(ts.tokenToString(parent.operatorToken.kind) ?? "")) {
    return true;
  }
  if (ts.isJsxAttribute(parent)) return true; // handled as "A" or skipped
  if (ts.isCallExpression(parent)) {
    const callee = parent.expression.getText();
    if (/^(t|tryT|console\.\w+|require|logger\.\w+|describe|it|test|expect)$/.test(callee)) return true;
    if (/\.(querySelector|querySelectorAll|getItem|setItem|removeItem|addEventListener|removeEventListener|startsWith|endsWith|includes|split|join|replace|get|set|has|delete|call)$/.test(callee)) {
      return true;
    }
  }
  return false;
};

export const collect = (file) => {
  const source = readFileSync(file, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const items = [];
  const push = (type, node, text, start, end) => {
    const { line } = sf.getLineAndCharacterOfPosition(start);
    items.push({ id: items.length + 1, type, node, text, start, end, line: line + 1 });
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const raw = node.getFullText(sf);
      const core = raw.trim();
      if (core && hasLatinWord(core)) {
        const offset = node.getFullStart() + raw.indexOf(core);
        push("J", node, core.replace(/\s+/g, " "), offset, offset + core.length);
      }
    } else if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const name = node.name.getText(sf);
      const text = node.initializer.text;
      const prose = TEXT_ATTRS.has(name) ? hasLatinWord(text) : looksLikeProse(text);
      if (!CODE_ATTRS.test(name) && prose && !/^(https?|wss?):/.test(text)) {
        push("A", node.initializer, text, node.initializer.getStart(sf), node.initializer.end);
      }
    } else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      looksLikeProse(node.text) &&
      !skipLiteral(node)
    ) {
      push("S", node, node.text, node.getStart(sf), node.end);
    } else if (ts.isTemplateExpression(node) && !skipLiteral(node)) {
      const text = node.getText(sf).slice(1, -1);
      const literal = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" ");
      const words = literal.trim();
      if (
        hasLatinWord(words) &&
        /(^|[\s·(])[A-Za-z][a-z]{2,}\b/.test(literal) &&
        !/^(https?:|wss?:|\/)/.test(words) &&
        !/\b(flex|grid|px-|py-|text-|bg-|border|rounded|ring-|opacity-|ui-)/.test(words) &&
        !inCodeAttr(node)
      ) {
        push("T", node, text, node.getStart(sf), node.end);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { source, items };
};

const list = (files) => {
  for (const file of files) {
    const { items } = collect(file);
    if (items.length === 0) continue;
    console.log(`== ${path.relative(ROOT, path.resolve(file))} (${items.length})`);
    for (const item of items) {
      console.log(`#${item.id} ${item.type} ${item.line}: ${item.text.slice(0, 160)}`);
    }
  }
};

const addKeys = (pairs) => {
  let text = readFileSync(DICT, "utf8");
  const existing = new Map(
    [...text.matchAll(/^ {2}"([^"]+)":\s*\n?\s*("(?:[^"\\]|\\.)*"),/gm)].map((m) => [m[1], JSON.parse(m[2])]),
  );
  const lines = [];
  for (const [key, ru] of pairs) {
    if (existing.has(key)) {
      if (existing.get(key) !== ru) {
        console.error(`ключ ${key} уже есть с другим текстом: ${existing.get(key)}`);
        process.exitCode = 1;
      }
      continue;
    }
    existing.set(key, ru);
    const line = `  ${JSON.stringify(key)}: ${JSON.stringify(ru)},`;
    lines.push(line.length > 100 ? `  ${JSON.stringify(key)}:\n    ${JSON.stringify(ru)},` : line);
  }
  if (lines.length) {
    text = text.replace("} as const;", `${lines.join("\n")}\n} as const;`);
    writeFileSync(DICT, text);
  }
  return lines.length;
};

const apply = (specPath) => {
  const specs = JSON.parse(readFileSync(specPath, "utf8"));
  const pairs = [];
  // What was replaced, English beside its key, for carrying the translation
  // into the tests that look the old text up (scripts/i18n-tests.py).
  const translated = [];
  for (const spec of specs) {
    const file = path.resolve(ROOT, spec.file);
    const { source, items } = collect(file);
    const edits = [];
    for (const [id, [key, ru, vars]] of Object.entries(spec.items ?? {})) {
      const item = items[Number(id) - 1];
      if (!item) {
        console.error(`${spec.file}: нет элемента #${id}`);
        process.exitCode = 1;
        continue;
      }
      // ["key"] alone reuses a phrase already in the dictionary.
      if (ru != null) pairs.push([key, ru]);
      translated.push({ en: item.text, key });
      // A third element maps placeholders to expressions: {"name": "user.name"}.
      const args = vars
        ? `, { ${Object.entries(vars).map(([k, v]) => (k === v ? k : `${k}: ${v}`)).join(", ")} }`
        : "";
      const call = `t(${JSON.stringify(key)}${args})`;
      const replacement = item.type === "J" || item.type === "A" ? `{${call}}` : call;
      edits.push({ start: item.start, end: item.end, replacement });
    }
    for (const raw of spec.raw ?? []) edits.push({ raw });
    for (const k of spec.keys ?? []) pairs.push([k.key, k.ru]);
    let out = source;
    for (const edit of edits.filter((e) => !e.raw).sort((a, b) => b.start - a.start)) {
      out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
    }
    for (const { raw } of edits.filter((e) => e.raw)) {
      if (!out.includes(raw.old)) {
        console.error(`${spec.file}: не найдено ${JSON.stringify(raw.old.slice(0, 80))}`);
        process.exitCode = 1;
        continue;
      }
      out = out.split(raw.old).join(raw.new);
    }
    writeFileSync(file, out);
    if (/\bt\(/.test(out)) {
      execFileSync("node", [path.join(ROOT, "scripts/add-i18n-import.mjs"), file, spec.import ?? "t"]);
    }
    console.log(`${spec.file}: заменено ${edits.length}`);
  }
  console.log(`ключей добавлено: ${addKeys(pairs)}`);
  const dict = readFileSync(DICT, "utf8");
  const value = (key) => {
    const m = dict.match(new RegExp(`^ {2}"${key.replace(/\./g, "\\.")}":\\s*("(?:[^"\\\\]|\\\\.)*"),`, "m"));
    return m ? JSON.parse(m[1]) : null;
  };
  const entries = translated.map(({ en, key }) => ({ en, ru: value(key), key }));
  writeFileSync(specPath.replace(/\.json$/, ".pairs.json"), JSON.stringify([{ entries }], null, 1));
};

// Only when run directly: other scripts import collect().
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args[0] === "--apply") apply(args[1]);
  else list(args);
}
