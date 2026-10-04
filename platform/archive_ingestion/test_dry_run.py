#!/usr/bin/env python3
"""
Крошечный DB-free тест пайплайна Архива (pytest ИЛИ standalone).

Проверяет:
  * каталог unified_ai_hacker_mind_v5.json парсится;
  * число единиц = 655, доменов = 28, governance-правил = 6 (как в приложении A);
  * --dry-run завершается кодом 0 без подключения к какой-либо БД;
  * нет фатальных ошибок валидации;
  * emit_system_prompt рендерит governance текстом из platform/core (единый источник).

Запуск:
    pytest platform/archive_ingestion/test_dry_run.py
    python  platform/archive_ingestion/test_dry_run.py      # standalone, без pytest
"""
from __future__ import annotations
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOG = os.path.normpath(os.path.join(HERE, "..", "archive", "unified_ai_hacker_mind_v5.json"))
sys.path.insert(0, HERE)

import ingest_archive as ing          # noqa: E402
import emit_system_prompt as emit     # noqa: E402

EXPECTED_UNITS = 655     # приложение A: «655 единиц»
EXPECTED_DOMAINS = 28    # приложение A: «28 доменов»
EXPECTED_GOV = 6         # RULE_0..RULE_5


def _load() -> dict:
    with open(CATALOG, encoding="utf-8") as f:
        return json.load(f)


def test_catalog_parses_and_counts() -> None:
    doc = _load()
    units = ing.normalize_units(doc)
    assert len(units) == EXPECTED_UNITS, f"units={len(units)} != {EXPECTED_UNITS}"
    assert len(doc["domains"]) == EXPECTED_DOMAINS
    assert len(doc["governance"]) == EXPECTED_GOV
    assert doc["meta"]["version"] == "5.0-AEGIS"


def test_dry_run_exit_zero() -> None:
    rc = ing.main(["--json", CATALOG, "--dry-run"])
    assert rc == 0, f"dry-run exit={rc}"


def test_no_fatal_validation_errors() -> None:
    doc = _load()
    units = ing.normalize_units(doc)
    errs = ing.validate_units(doc, units)
    assert errs == [], f"фатальные ошибки валидации: {errs[:5]}"


def test_emit_uses_platform_core_wording() -> None:
    doc = _load()
    out = emit.render(doc)  # по умолчанию предпочитает platform/core governance.json
    assert "Scope-first" in out                              # заголовок RULE_0 из platform/core
    assert "активного, авторизованного engagement" in out    # текст RULE_0 из platform/core
    assert "platform/core" in out                            # метка источника


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as e:
                failures += 1
                print(f"FAIL {name}: {e}")
    print("OK" if failures == 0 else f"{failures} FAILED")
    raise SystemExit(1 if failures else 0)
