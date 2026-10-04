#!/usr/bin/env python3
"""
AEGIS / Office3D — Archive Ingestion Pipeline
=============================================
Загружает unified_ai_hacker_mind_v5.json в:
  * PostgreSQL + pgvector — семантический поиск по единицам знаний
  * Neo4j                 — граф: Domain -> Unit -> Level (+ governance, loops)

РАМКА: только авторизованное тестирование. Пайплайн индексирует СПРАВОЧНЫЕ
МЕТАДАННЫЕ (названия книг/инструментов, домены, уровни, описания процессов),
а НЕ содержимое книг и НЕ код эксплойтов. Governance-правила загружаются в граф
и выгружаются в системный промпт каждого агента (см. emit_system_prompt.py / md).

Идемпотентность: PG UPSERT по id, Neo4j MERGE по ключам. Повторный прогон
безопасен и обновляет изменившиеся поля.

Запуск:
    python ingest_archive.py --json unified_ai_hacker_mind_v5.json

Переменные окружения (или флаги):
    PG_DSN            postgresql://user:pass@host:5432/aegis
    NEO4J_URI         bolt://host:7687
    NEO4J_USER        neo4j
    NEO4J_PASS        ****
    EMBED_PROVIDER    local (по умолчанию) | openai
    EMBED_MODEL       по умолчанию intfloat/multilingual-e5-large (RU+EN)
    EMBED_DIM         по умолчанию 1024 (должно совпадать со схемой pgvector)
    OPENAI_BASE_URL   для EMBED_PROVIDER=openai (можно указать локальный сервер)
    OPENAI_API_KEY

OFFICE3D NOTE (отличие от дословного приложения B ТЗ):
    Режим --dry-run расширен: он валидирует КАЖДУЮ единицу, печатает счётчики по
    доменам и типам, размерность эмбеддинга (без загрузки модели) и план «что БЫ
    записали» в pgvector и Neo4j — всё БЕЗ подключения к какой-либо БД. Остальной
    код (парсер, эмбеддер, загрузчики PG/Neo4j) оставлен как в ТЗ.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

log = logging.getLogger("archive.ingest")

# --------------------------------------------------------------------------- #
# Модель данных
# --------------------------------------------------------------------------- #

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slug(text: str) -> str:
    return _SLUG_RE.sub("-", text.lower()).strip("-")[:120] or "x"


@dataclass
class Unit:
    """Нормализованная единица Архива (книга/инструмент/лаба/фреймворк/…)."""
    id: str
    unit_type: str
    name: str
    domain: str | None
    level: int | None
    meta: dict[str, Any] = field(default_factory=dict)
    embed_text: str = ""

    @staticmethod
    def from_raw(section_key: str, raw: dict[str, Any]) -> "Unit":
        name = raw.get("title") or raw.get("name") or "unnamed"
        unit_type = raw.get("type") or section_key.rstrip("s")
        domain = raw.get("domain")
        level = raw.get("level")
        # всё, что не является служебными полями, уходит в meta
        reserved = {"title", "name", "type", "domain", "level"}
        meta = {k: v for k, v in raw.items() if k not in reserved}
        uid = f"{unit_type}:{slug(name)}"
        if domain:
            uid = f"{uid}:{slug(domain)}"
        # текст для эмбеддинга: имя + автор/орг + домен + уровень + вид + описание
        parts = [name]
        for key in ("author", "org", "kind", "category"):
            if raw.get(key):
                parts.append(str(raw[key]))
        if domain:
            parts.append(f"domain:{domain}")
        if level is not None:
            parts.append(f"level:{level}")
        for key in ("desc", "boundary", "freq"):
            if raw.get(key):
                parts.append(str(raw[key]))
        embed_text = " | ".join(parts)
        return Unit(uid, unit_type, name, domain, level, meta, embed_text)


def normalize_units(doc: dict[str, Any]) -> list[Unit]:
    units_obj = doc.get("units", {})
    out: list[Unit] = []
    seen: set[str] = set()
    for section_key, arr in units_obj.items():
        if not isinstance(arr, list):
            continue
        for raw in arr:
            if not isinstance(raw, dict):
                continue
            u = Unit.from_raw(section_key, raw)
            # разрешаем коллизии id (одна книга в двух доменах и т.п.)
            base, n = u.id, 1
            while u.id in seen:
                n += 1
                u.id = f"{base}#{n}"
            seen.add(u.id)
            out.append(u)
    return out


# --------------------------------------------------------------------------- #
# Эмбеддинги (провайдер подключаемый: local | openai-совместимый)
# --------------------------------------------------------------------------- #

class Embedder:
    def __init__(self) -> None:
        self.provider = os.getenv("EMBED_PROVIDER", "local").lower()
        self.model = os.getenv("EMBED_MODEL", "intfloat/multilingual-e5-large")
        self.dim = int(os.getenv("EMBED_DIM", "1024"))
        self._backend = None

    def _local(self):
        if self._backend is None:
            from sentence_transformers import SentenceTransformer  # lazy import
            log.info("Загружаю локальную модель эмбеддингов: %s", self.model)
            self._backend = SentenceTransformer(self.model)
        return self._backend

    def _openai(self):
        if self._backend is None:
            from openai import OpenAI  # lazy import
            self._backend = OpenAI(
                base_url=os.getenv("OPENAI_BASE_URL") or None,
                api_key=os.getenv("OPENAI_API_KEY", "sk-none"),
            )
        return self._backend

    def encode(self, texts: Sequence[str]) -> list[list[float]]:
        if self.provider == "openai":
            client = self._openai()
            resp = client.embeddings.create(model=self.model, input=list(texts))
            return [d.embedding for d in resp.data]
        # local (по умолчанию, суверенное исполнение — данные не уходят наружу)
        model = self._local()
        vecs = model.encode(list(texts), normalize_embeddings=True,
                            show_progress_bar=False)
        return [v.tolist() for v in vecs]


def batched(seq: Sequence[Any], size: int) -> Iterable[Sequence[Any]]:
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


# --------------------------------------------------------------------------- #
# PostgreSQL + pgvector
# --------------------------------------------------------------------------- #

def load_pg(units: list[Unit], embedder: Embedder, dsn: str, batch: int = 64) -> None:
    import psycopg
    from psycopg.types.json import Jsonb

    log.info("PostgreSQL: подключение…")
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            for chunk in batched(units, batch):
                vecs = embedder.encode([u.embed_text for u in chunk])
                for u, vec in zip(chunk, vecs):
                    vec_literal = "[" + ",".join(f"{x:.6f}" for x in vec) + "]"
                    cur.execute(
                        """
                        INSERT INTO archive_units
                            (id, unit_type, name, domain, level, meta, embed_text, embedding, updated_at)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s, now())
                        ON CONFLICT (id) DO UPDATE SET
                            unit_type = EXCLUDED.unit_type,
                            name       = EXCLUDED.name,
                            domain     = EXCLUDED.domain,
                            level      = EXCLUDED.level,
                            meta       = EXCLUDED.meta,
                            embed_text = EXCLUDED.embed_text,
                            embedding  = EXCLUDED.embedding,
                            updated_at = now()
                        """,
                        (u.id, u.unit_type, u.name, u.domain, u.level,
                         Jsonb(u.meta), u.embed_text, vec_literal),
                    )
                conn.commit()
                log.info("PG: залито %d/%d", min(len(units), _pg_done(units, chunk)), len(units))
    log.info("PostgreSQL: готово (%d единиц).", len(units))


def _pg_done(units: list[Unit], chunk: Sequence[Unit]) -> int:
    return units.index(chunk[-1]) + 1


# --------------------------------------------------------------------------- #
# Neo4j: Domain -> Unit -> Level (+ governance, loops)
# --------------------------------------------------------------------------- #

def load_neo4j(doc: dict[str, Any], units: list[Unit],
               uri: str, user: str, password: str) -> None:
    from neo4j import GraphDatabase

    log.info("Neo4j: подключение…")
    driver = GraphDatabase.driver(uri, auth=(user, password))
    with driver.session() as s:
        # домены
        for d in doc.get("domains", []):
            s.run("MERGE (:Domain {name:$n})", n=d)
        # уровни L1..L5
        for n in range(1, 6):
            s.run("MERGE (:Level {n:$n})", n=n)
        # единицы + связи домен→единица→уровень
        for u in units:
            s.run(
                """
                MERGE (u:Unit {id:$id})
                SET u.name=$name, u.unit_type=$ut, u.meta=$meta
                WITH u
                FOREACH (_ IN CASE WHEN $domain IS NULL THEN [] ELSE [1] END |
                    MERGE (d:Domain {name:$domain})
                    MERGE (d)-[:CONTAINS]->(u))
                FOREACH (_ IN CASE WHEN $level IS NULL THEN [] ELSE [1] END |
                    MERGE (l:Level {n:$level})
                    MERGE (u)-[:AT_LEVEL]->(l))
                """,
                id=u.id, name=u.name, ut=u.unit_type,
                meta=json.dumps(u.meta, ensure_ascii=False),
                domain=u.domain, level=u.level,
            )
        # governance — правила первого уровня (также идут в системный промпт)
        for rule_id, text in doc.get("governance", {}).items():
            s.run("MERGE (g:Governance {rule_id:$r}) SET g.text=$t",
                  r=rule_id, t=text)
        # evolution_loops — контуры саморазвития (с границами)
        for lp in doc.get("units", {}).get("evolution_loops", []):
            s.run(
                """MERGE (x:Loop {id:$id})
                   SET x.name=$name, x.desc=$desc, x.freq=$freq, x.boundary=$boundary""",
                id=lp.get("id"), name=lp.get("name"), desc=lp.get("desc"),
                freq=lp.get("freq"), boundary=lp.get("boundary"),
            )
    driver.close()
    log.info("Neo4j: готово (%d единиц, %d доменов).",
             len(units), len(doc.get("domains", [])))


# --------------------------------------------------------------------------- #
# Валидация и план (DB-free dry-run)
# --------------------------------------------------------------------------- #

_VALID_LEVELS = {1, 2, 3, 4, 5}


def validate_units(doc: dict[str, Any], units: list[Unit]) -> list[str]:
    """Проверить каждую единицу. Вернуть список ФАТАЛЬНЫХ ошибок (пустой = всё валидно).

    Расхождение domain с 28-доменным перечнем meta.domains — НЕ ошибка
    (ctf_labs/frameworks используют служебные значения вроде 'cross-domain'/
    'advanced'; загрузчики PG/Neo4j принимают любой domain-текст). Это выводится
    отдельно как предупреждение, см. domain_warnings().
    """
    errors: list[str] = []
    seen: set[str] = set()
    for i, u in enumerate(units):
        where = f"unit[{i}] id={u.id!r}"
        if not u.id:
            errors.append(f"{where}: пустой id")
        if u.id in seen:
            errors.append(f"{where}: дубликат id")
        seen.add(u.id)
        if not u.name or u.name == "unnamed":
            errors.append(f"{where}: отсутствует name")
        if not u.unit_type:
            errors.append(f"{where}: отсутствует unit_type")
        if u.level is not None and u.level not in _VALID_LEVELS:
            errors.append(f"{where}: level={u.level!r} вне диапазона 1..5")
        if not u.embed_text:
            errors.append(f"{where}: пустой embed_text")
    return errors


def domain_warnings(doc: dict[str, Any], units: list[Unit]) -> list[str]:
    """Единицы с domain вне 28-доменного перечня meta.domains (не фатально)."""
    domains = set(doc.get("domains", []))
    extra: dict[str, int] = {}
    for u in units:
        if u.domain is not None and domains and u.domain not in domains:
            extra[u.domain] = extra.get(u.domain, 0) + 1
    return [f"{name}: {n}" for name, n in sorted(extra.items())]


def dry_run_report(doc: dict[str, Any], units: list[Unit]) -> None:
    """Печать плана БЕЗ подключения к БД: валидация + счётчики + «что БЫ записали»."""
    by_type: dict[str, int] = {}
    by_domain: dict[str, int] = {}
    with_level = 0
    for u in units:
        by_type[u.unit_type] = by_type.get(u.unit_type, 0) + 1
        key = u.domain or "(без домена)"
        by_domain[key] = by_domain.get(key, 0) + 1
        if u.level is not None:
            with_level += 1

    domains = doc.get("domains", [])
    governance = doc.get("governance", {})
    loops = doc.get("units", {}).get("evolution_loops", [])

    # размерность эмбеддинга — из конфигурации, без загрузки модели
    emb = Embedder()

    errors = validate_units(doc, units)
    warnings = domain_warnings(doc, units)

    log.info("=== DRY-RUN: АРХИВ (запись в БД НЕ выполняется) ===")
    log.info("meta: %s", doc.get("meta", {}).get("version", "?"))
    log.info("Всего единиц: %d | доменов: %d | governance-правил: %d | loops: %d",
             len(units), len(domains), len(governance), len(loops))
    log.info("Единиц с уровнем L1..L5: %d", with_level)
    log.info("По типам: %s", by_type)
    log.info("По доменам:")
    for d in domains:
        log.info("  %-24s %d", d, by_domain.get(d, 0))
    no_domain = by_domain.get("(без домена)", 0)
    if no_domain:
        log.info("  %-24s %d", "(без домена)", no_domain)
    log.info("Эмбеддинги: provider=%s model=%s dim=%d (модель НЕ загружается в dry-run)",
             emb.provider, emb.model, emb.dim)
    log.info("WOULD WRITE -> pgvector: %d строк в archive_units (embedding vector(%d))",
             len(units), emb.dim)
    nodes = len(units) + len(domains) + len(_VALID_LEVELS) + len(governance) + len(loops)
    log.info("WOULD WRITE -> Neo4j: %d Unit + %d Domain + %d Level + %d Governance + %d Loop = %d узлов",
             len(units), len(domains), len(_VALID_LEVELS), len(governance), len(loops), nodes)
    log.info("WOULD WRITE -> Neo4j связи: Domain-[:CONTAINS]->Unit, Unit-[:AT_LEVEL]->Level")

    if warnings:
        log.info("Домены вне перечня meta.domains (служебные, не фатально): %s",
                 ", ".join(warnings))

    if errors:
        log.error("Валидация: %d фатальных ошибок:", len(errors))
        for e in errors[:50]:
            log.error("  - %s", e)
        if len(errors) > 50:
            log.error("  … ещё %d", len(errors) - 50)
    else:
        log.info("Валидация: OK — все %d единиц валидны.", len(units))


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def main(argv: Sequence[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    ap = argparse.ArgumentParser(description="AEGIS Archive ingestion")
    ap.add_argument("--json", default=os.getenv("ARCHIVE_JSON",
                    "unified_ai_hacker_mind_v5.json"))
    ap.add_argument("--pg-dsn", default=os.getenv("PG_DSN"))
    ap.add_argument("--neo4j-uri", default=os.getenv("NEO4J_URI"))
    ap.add_argument("--neo4j-user", default=os.getenv("NEO4J_USER", "neo4j"))
    ap.add_argument("--neo4j-pass", default=os.getenv("NEO4J_PASS"))
    ap.add_argument("--skip-pg", action="store_true")
    ap.add_argument("--skip-neo4j", action="store_true")
    ap.add_argument("--dry-run", action="store_true",
                    help="только распарсить и посчитать, без записи в БД")
    args = ap.parse_args(argv)

    with open(args.json, "r", encoding="utf-8") as f:
        doc = json.load(f)

    units = normalize_units(doc)
    by_type: dict[str, int] = {}
    for u in units:
        by_type[u.unit_type] = by_type.get(u.unit_type, 0) + 1
    log.info("Распарсено единиц: %d  | по типам: %s", len(units), by_type)
    log.info("Доменов: %d | governance-правил: %d | loops: %d",
             len(doc.get("domains", [])),
             len(doc.get("governance", {})),
             len(doc.get("units", {}).get("evolution_loops", [])))

    if args.dry_run:
        dry_run_report(doc, units)
        errors = validate_units(doc, units)
        log.info("dry-run: выход без записи.")
        return 1 if errors else 0

    t0 = time.time()
    if not args.skip_pg:
        if not args.pg_dsn:
            log.error("PG_DSN не задан (или --skip-pg).")
            return 2
        load_pg(units, Embedder(), args.pg_dsn)
    if not args.skip_neo4j:
        if not (args.neo4j_uri and args.neo4j_pass):
            log.error("NEO4J_URI / NEO4J_PASS не заданы (или --skip-neo4j).")
            return 2
        load_neo4j(doc, units, args.neo4j_uri, args.neo4j_user, args.neo4j_pass)
    log.info("Готово за %.1f c.", time.time() - t0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
