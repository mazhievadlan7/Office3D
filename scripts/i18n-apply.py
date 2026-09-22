#!/usr/bin/env python3
"""
Applies a batch of translations to one source file.

Usage: python3 scripts/i18n-apply.py <spec.json>

The spec is a list of files, each with entries of the form
  {"key": "area.thing", "ru": "Русский текст", "en": "English text"}
and optional raw replacements
  {"old": "exact snippet", "new": "exact snippet"}.

For each entry, every occurrence of the English text in one of these shapes is
replaced, and nothing else is touched:
  attr="English"        ->  attr={t("key")}
  >English<             ->  >{t("key")}<
  a line that is only English (JSX text)  ->  {t("key")}
  "English" as a string literal           ->  t("key")

The key is added to src/lib/i18n/ru.ts if missing. Entries whose English text
is not found are reported rather than silently skipped, because a phrase that
was never replaced is exactly the kind of gap this pass exists to close.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DICT = ROOT / "src" / "lib" / "i18n" / "ru.ts"


def add_keys(pairs):
    text = DICT.read_text()
    existing = set(re.findall(r'^  "([^"]+)":', text, re.M))
    new_lines = []
    for key, ru in pairs:
        if key in existing:
            continue
        existing.add(key)
        value = json.dumps(ru, ensure_ascii=False)
        line = f"  {json.dumps(key)}: {value},"
        if len(line) > 100:
            line = f"  {json.dumps(key)}:\n    {value},"
        new_lines.append(line)
    if new_lines:
        text = text.replace("} as const;", "\n".join(new_lines) + "\n} as const;")
        DICT.write_text(text)
    return len(new_lines)


def apply_file(spec):
    path = ROOT / spec["file"]
    src = path.read_text()
    missing = []

    for raw in spec.get("raw", []):
        if raw["old"] not in src:
            missing.append(f"raw: {raw['old'][:70]!r}")
            continue
        src = src.replace(raw["old"], raw["new"])

    for entry in spec.get("entries", []):
        key, en = entry["key"], entry["en"]
        call = f't("{key}")'
        before = src
        esc = re.escape(en)
        src = re.sub(rf'(\b[a-zA-Z][\w-]*)="{esc}"', rf"\1={{{call}}}", src)
        src = re.sub(rf">\s*{esc}\s*<", f">{{{call}}}<", src)
        src = re.sub(rf"^(\s+){esc}$", rf"\1{{{call}}}", src, flags=re.M)
        src = re.sub(rf'"{esc}"', call, src)
        if src == before:
            missing.append(f"{key}: {en[:60]!r}")

    if 'from "@/lib/i18n"' not in src and "t(" in src:
        path.write_text(src)
        subprocess.run(
            ["node", str(ROOT / "scripts" / "add-i18n-import.mjs"), str(path),
             spec.get("import", "t")],
            check=True,
        )
    else:
        path.write_text(src)

    return missing


def main():
    specs = json.loads(Path(sys.argv[1]).read_text())
    pairs = [(e["key"], e["ru"]) for s in specs for e in s.get("entries", [])]
    pairs += [(k["key"], k["ru"]) for s in specs for k in s.get("keys", [])]
    added = add_keys(pairs)
    print(f"ключей добавлено: {added}")
    for spec in specs:
        missing = apply_file(spec)
        status = "ok" if not missing else f"не найдено {len(missing)}"
        print(f"{spec['file']}: {status}")
        for item in missing:
            print(f"    {item}")


if __name__ == "__main__":
    main()
