# Archive Ingestion — AEGIS / Office3D

Загрузка `unified_ai_hacker_mind_v5.json` в **pgvector** (семантический поиск) и
**Neo4j** (граф `Domain → Unit → Level`), плюс выгрузка governance-правил в
системный промпт каждого агента.

> Рамка: только авторизованное тестирование. Пайплайн индексирует справочные
> **метаданные** (названия, домены, уровни, описания процессов) — не содержимое
> книг и не код эксплойтов. Governance (RULE_0…RULE_5) — правила первого уровня.

## Состав
| Файл | Назначение |
|---|---|
| `ingest_archive.py` | парсер units → эмбеддинги в pgvector + узлы/связи в Neo4j |
| `schema.sql` | таблица `archive_units` + HNSW-индекс (pgvector) |
| `neo4j_schema.cypher` | ограничения и примеры запросов графа |
| `agent_system_prompt.md` | системный промпт агента с вшитым governance |
| `emit_system_prompt.py` | рендер промпта из governance JSON (единый источник истины) |
| `requirements.txt` | зависимости |

## Запуск
```bash
pip install -r requirements.txt

# 1) схемы
psql "$PG_DSN" -f schema.sql
cypher-shell -a "$NEO4J_URI" -u "$NEO4J_USER" -p "$NEO4J_PASS" -f neo4j_schema.cypher

# 2) проверка парсинга без записи
python ingest_archive.py --json unified_ai_hacker_mind_v5.json --dry-run

# 3) полная загрузка
export PG_DSN=postgresql://user:pass@localhost:5432/aegis
export NEO4J_URI=bolt://localhost:7687 NEO4J_USER=neo4j NEO4J_PASS=****
python ingest_archive.py --json unified_ai_hacker_mind_v5.json

# 4) системный промпт агента (в CI/деплой рантайма)
python emit_system_prompt.py --json unified_ai_hacker_mind_v5.json > system_prompt.txt
```

## Эмбеддинги
- По умолчанию **локальная** модель `intfloat/multilingual-e5-large` (RU+EN, 1024 dim),
  данные не уходят наружу. Сменить: `EMBED_PROVIDER`, `EMBED_MODEL`, `EMBED_DIM`
  (не забудь синхронизировать `vector(N)` в `schema.sql`).
- Провайдер `openai` (в т.ч. локальный сервер через `OPENAI_BASE_URL`) — опционально.

## Идемпотентность
Повторный прогон безопасен: PG — `UPSERT` по `id`, Neo4j — `MERGE`. Изменившиеся
поля обновляются, дубликатов нет.

---

## Интеграция в Office3D (заметки — отличия от дословного приложения B ТЗ)

Этот каталог извлечён из `TZ_MetaArchitectural_FULL.md` (приложения A и B). Ниже —
единственные осознанные отличия от дословного текста ТЗ:

- **Пути.** Каталог знаний лежит в `platform/archive/unified_ai_hacker_mind_v5.json`,
  скрипты — в `platform/archive_ingestion/`. В dry-run указывайте
  `--json ../archive/unified_ai_hacker_mind_v5.json` (или абсолютный путь).

- **Governance — единый источник.** Источник истины правил RULE_0…RULE_5 в этом
  репозитории — `platform/core/governance.js`, а НЕ governance-блок каталога v5.
  `emit_system_prompt.py` поэтому читает канонический текст из
  `platform/archive/governance.json` (его генерит `platform/core`:
  `npm --prefix platform run emit-governance-json`) и рендерит теми же
  формулировками, что ядро. Каталог `--json` по-прежнему читается (домены,
  единицы и запасной governance). Переопределение: `--governance <path>` или
  env `AEGIS_GOVERNANCE_JSON`; `--no-canonical` — рендерить формулировками v5.

  > Расхождение формулировок (НЕ «тихо»): governance-блок в самом
  > `unified_ai_hacker_mind_v5.json` сформулирован иначе, чем `platform/core`
  > (смысл RULE_0…RULE_5 идентичен, различается текст — напр. v5 rule_0
  > «SCOPE FIRST: … вне верифицированного scope (свои продукты / договор …)»,
  > а platform/core RULE_0 «… только против цели активного, авторизованного
  > engagement; обязателен preflight-запрос; … fail-closed»). Каталог
  > оставлен ДОСЛОВНО (приложение A), а промпт агента берёт каноническую
  > формулировку из `platform/core`.

- **Только метаданные.** Как и требует ТЗ выше, пайплайн индексирует справочные
  МЕТАДАННЫЕ (названия, домены, уровни, описания процессов) — не содержимое книг
  и не код эксплойтов.

- **Расширенный `--dry-run` (без БД).** Валидирует каждую единицу, печатает
  счётчики по доменам/типам, размерность эмбеддинга (без загрузки модели) и план
  «что БЫ записали» в pgvector/Neo4j. Ни к какой БД не подключается. Проверка:
  `python test_dry_run.py` (или `pytest test_dry_run.py`).

- **Эмбеддинги по умолчанию локальные** (`intfloat/multilingual-e5-large`,
  суверенно). Модель не скачивается автоматически; dry-run её не требует.
  Провайдер переключается env `EMBED_PROVIDER`.

- **БД пока не подняты.** pgvector + Neo4j — профиль `archive` в
  `platform/docker-compose.yml`, выключены по умолчанию. До провижена БД
  доступен только dry-run.
