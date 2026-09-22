#!/usr/bin/env python3
"""
Carries a translation into the tests that look the English text up.

Usage: python3 scripts/i18n-tests.py <spec.json> <test-file> [<test-file> …]

Reads the same spec i18n-apply.py used and, in the given test files, swaps
each English phrase for its Russian one wherever it appears as a quoted string
("…" or `…`) or as a regular expression /…/. Only whole phrases are swapped —
a test that builds a label from pieces has to be edited by hand, which is the
point: that is the test worth reading again.
"""
import json
import re
import sys
from pathlib import Path


def main():
    spec_path, *tests = sys.argv[1:]
    specs = json.loads(Path(spec_path).read_text())
    mapping = {e["en"]: e["ru"] for s in specs for e in s.get("entries", [])}
    # Longest first, so "Thinking (internal)" is swapped before "Thinking".
    phrases = sorted(mapping, key=len, reverse=True)
    for test in tests:
        path = Path(test)
        src = path.read_text()
        before = src
        for en in phrases:
            ru = mapping[en]
            esc = re.escape(en)
            src = re.sub(rf'(["`]){esc}\1', lambda m: f"{m.group(1)}{ru}{m.group(1)}", src)
            src = re.sub(rf"/{esc}/(i?)", lambda m: f"/{re.escape(ru).replace('/', '/')}/{m.group(1)}", src)
        if src != before:
            path.write_text(src)
            print(f"обновлён: {test}")


if __name__ == "__main__":
    main()
