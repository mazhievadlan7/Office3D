# platform — Этаж 27: Security Core (Meta Architectural Authority)

Это бэкенд-фундамент платформы **Meta Architectural Authority** (ТЗ
`TZ_MetaArchitectural_FULL.md`). Здесь живёт **постоянное ядро безопасности**
Этажа 27 — тот самый «замок», который по ТЗ обязан работать раньше любого агента
(§0, §II.8 Phase 0: «агент не стартует без scope-enforcement»).

Репозиторий Office3D — это витрина/фронтенд OpenClaw; `platform/` — отдельная
бэкенд-папка внутри него. Ядро **не содержит наступательных возможностей**: оно
только отвечает «можно/нельзя» и всё записывает. Ничто здесь не действует против
цели.

## Что такое Security Core

Единый источник истины — [`platform/core/`](./core/). Старые пути
`server/aegis/*` стали тонкими шимами (`module.exports = require(... platform/core ...)`),
поэтому Next-сервер (`src/lib/aegis/core.ts`) и юнит-тесты
(`tests/unit/aegis*.test.ts`) работают без изменений.

| Модуль | Роль | ТЗ |
|--------|------|----|
| `ip.js` | Строгий разбор IPv4/IPv6 и CIDR; всё неоднозначное → отказ. | §II.4.2 |
| `scope.js` | Модель активов (domain/ip/cidr/url) + сопоставитель цели, **default-deny**. Домены НЕ резолвятся (это дело egress) → нет DNS-гонки. | §0, §II.4.2 |
| `engagement.js` | Жизненный цикл `draft→authorized→active→stopped/completed`; **ручная** активация заказчиком; kill-switch (глобальный и по engagement); `autoStop`. | §II.4.2, §II.4.3 |
| `preflight.js` | Единый шлюз перед любым действием. Порядок: **Gate-0 → kill-switch → active → scope → rate-limit → destructive-hold → allow**. Deny-by-default, наружу не бросает (баг только «закрывается»). | §0, §II.4.2 |
| `gate0.js` | **Gate-0 канарейка**: приманка вне любого scope; касание = DENY + глобальный kill-switch + аудит `gate0_tripped`. Выкл. по умолчанию. | §II.14 |
| `anomaly.js` | **Авто-стоп**: скользящее окно аномалий на engagement (вне scope / деструктив без одобрения / rate-limit / Gate-0); порог → авто-деактивация + аудит `auto_stop`. Выкл. по умолчанию. | §II.4.2 |
| `egress.js` | Компиляция активного scope в allowlist для egress-firewall (nftables/eBPF, default-deny). | §II.4, §II.4.2 |
| `governance.js` | RULE_0…RULE_5 + `composeSystemPrompt` — единый источник системного промпта агента. | §0, §22 |
| `verify.js` | Authorization Gateway: проверка владения активом (DNS TXT / файл-токен / WHOIS-инфо). Контактирует только с заявленными активами оператора. | §II.4.3 |
| `audit.js` | Неизменяемый **hash-chained** append-only леджер (JSONL) + checkpoint от обрезки хвоста. `verify()` ловит подделку/удаление. | §0, §22 |
| `store.js` | Атомарное хранилище текущего состояния (temp-file + rename, режим 0600). | — |
| `emit-system-prompt.js` | CLI печати системного промпта из `governance.js` (JS-аналог `archive_ingestion/emit_system_prompt.py`). | §22 |

### Gate-0 (канарейка)

Канарейка — это приманочный актив, намеренно **вне любого scope**. Легальному
агенту незачем её трогать, поэтому любой preflight-запрос по канарейке — это
жёсткий сигнал провала: `preflight.check()` возвращает DENY, включается
**глобальный** kill-switch, и пишется отдельное событие аудита `gate0_tripped`.
Канарейка проверяется первой (до kill-switch), чтобы срабатывать независимо от
состояния engagement. По умолчанию выключена; в проде включается конфигом
(`gate0.enabled` / env `PLATFORM_GATE0`), в тестах — включена.

### Авто-стоп по аномалиям

На каждый engagement ведётся скользящее окно аномалий. Счётчик растёт на: попытке
вне scope, деструктиве без одобрения человека, превышении rate-limit, касании
Gate-0. При достижении порога в окне engagement **сам** деактивируется
(`engagements.autoStop`) и пишется `auto_stop`. Глобальный kill-switch остаётся
отдельным, более тяжёлым рычагом. По умолчанию выключен (`threshold = 0`).

## Control plane (Phase 0)

[`platform/control-plane/`](./control-plane/) — маленький HTTP-сервис на Node,
**только loopback (127.0.0.1)** и **токен** (`PLATFORM_TOKEN`). Это тот шлюз,
который будущий Execution Plane обязан звать перед любым инструментом. Он
переиспользует `createAegisCore` — своей логики безопасности не добавляет.

> ТЗ (§II.5) целит в Go для control plane в будущем. Этот Phase-0 сервис — на
> Node, чтобы дословно переиспользовать проверенное JS-ядро; HTTP-контракт ниже
> переносится в будущую Go-реализацию без изменений.

### Запуск

```bash
# из корня репозитория
PLATFORM_TOKEN=$(openssl rand -hex 24) npm --prefix platform run control-plane
# или
cd platform && PLATFORM_TOKEN=... node control-plane/index.js
```

Если `PLATFORM_TOKEN` не задан — генерируется временный токен и печатается в
stderr (только для локальной разработки). Данные (состояние + леджер) — в
`platform/.data` (в `.gitignore`).

### Эндпоинты (JSON)

| Метод | Путь | Назначение |
|-------|------|-----------|
| GET | `/health` | Живость + security-posture (без токена, только loopback). |
| POST | `/v1/preflight` | **Шлюз** перед любым действием Execution Plane. |
| GET/POST | `/v1/engagements` | Список / создание engagement. |
| GET | `/v1/engagements/:id` | Один engagement. |
| POST | `/v1/engagements/:id/assets` | Добавить актив (только в draft). |
| DELETE | `/v1/engagements/:id/assets/:assetId` | Удалить актив (только в draft). |
| POST | `/v1/engagements/:id/authorize` | Записать authorization letter + подписанта. |
| POST | `/v1/engagements/:id/activate` | **Ручная** активация заказчиком (`confirm:true`). |
| POST | `/v1/engagements/:id/deactivate` | Остановить (per-engagement kill). |
| POST | `/v1/engagements/:id/reactivate` | Возобновить остановленный. |
| POST | `/v1/engagements/:id/complete` | Завершить. |
| GET/POST | `/v1/killswitch` | Прочитать / переключить глобальный kill-switch. |
| GET | `/v1/egress/:engagementId` | Allowlist + рендер nftables. |
| GET | `/v1/audit?engagementId=&limit=` | Чтение леджера. |
| GET | `/v1/audit/verify` | Проверка целостности hash-chain. |
| GET | `/v1/governance/system-prompt?engagementId=&agent=` | Системный промпт из единого источника. |

Пример отказа (`POST /v1/preflight`, цель вне scope / нет активного engagement):

```json
{ "allowed": false, "decision": "deny", "reason": "engagement не найден: missing", "assetId": null }
```

## Тесты (негативная сеть, §II.9)

[`core/__tests__/`](./core/__tests__/) на `node:test`:

```bash
npm --prefix platform test          # или: node --test "platform/core/__tests__/**/*.test.js"
npm run platform:core-test          # из корня репозитория
```

Покрыто: цель вне scope отклоняется preflight И отсутствует в egress-allowlist;
DNS-гонка (домен не резолвится в матчере); Gate-0 включает kill-switch; авто-стоп
после N аномалий деактивирует engagement; fail-closed при внутренней ошибке;
kill-switch глобальный и по engagement; деструктив требует одобрения; шимы
`server/aegis` экспортируют тот же API.

## План по этажам (сверху вниз, §I.3/§I.5)

Строим по одному этажу, каждый полностью, затем ниже. Security Core — сквозной и
обязателен для каждого следующего этажа (§II.11).

1. **27 — AM7 + фундамент** (этот Security Core, Phase 0). ← мы здесь
2. 26 — ССО · 25 — Внутренняя СБ · 24 — Хакинг · 23 — Кибербез/ИБ · 22 — OSINT
3. 21 → 1 — по таблице §I.3 · 0 — The Gate.

Архив (память платформы, pgvector + Neo4j, §II.3.3/§II.3.4/§22) заложен как
floor-piece в [`archive_ingestion/`](./archive_ingestion/) и профиль `archive`
в `docker-compose.yml` — **выключен по умолчанию**, пока БД не провижены (см.
ниже). Остальные этажи строятся по таблице §I.3.

## Архив — память платформы (`archive_ingestion/`, §II.3.4 / §22)

Каталог знаний [`archive/unified_ai_hacker_mind_v5.json`](./archive/) (655 единиц,
28 доменов, governance RULE_0…RULE_5) загружается пайплайном
[`archive_ingestion/`](./archive_ingestion/) в **pgvector** (семантический поиск)
и **Neo4j** (граф `Domain → Unit → Level`). Индексируются только справочные
**метаданные** (названия, домены, уровни, описания) — **не** содержимое книг и
**не** код эксплойтов. Рамка — только авторизованное тестирование.

**Governance — единый источник.** Правила RULE_0…RULE_5 берутся из
[`core/governance.js`](./core/governance.js); `emit_system_prompt.py` рендерит их
из `archive/governance.json` (генерится ядром: `npm --prefix platform run
emit-governance-json`), а не из governance-блока каталога v5 (его формулировки
отличаются по тексту при том же смысле — подробности в
[`archive_ingestion/README.md`](./archive_ingestion/README.md)).

**Эмбеддинги** по умолчанию локальные/суверенные (`intfloat/multilingual-e5-large`,
1024 dim); провайдер переключается env `EMBED_PROVIDER`. Модель не скачивается
автоматически.

**БД ещё не подняты — только dry-run** (ничего не пишется, подключения к БД нет):

```bash
python platform/archive_ingestion/ingest_archive.py \
    --json platform/archive/unified_ai_hacker_mind_v5.json --dry-run
python platform/archive_ingestion/test_dry_run.py      # или: pytest …/test_dry_run.py
```

Dry-run валидирует все единицы и печатает план (счётчики по доменам, dim,
«что БЫ записали» в pgvector/Neo4j). Поднимать стор-сервисы — только при
провижене: `docker compose -f platform/docker-compose.yml --profile archive up
pgvector neo4j`, затем применить `schema.sql` / `neo4j_schema.cypher`.

**Dev LLM (Ollama).** Для будущей оркестрации предусмотрена заглушка
`OLLAMA_BASE_URL` / `OLLAMA_MODEL` в [`.env.example`](./.env.example) — **вызовов
пока нет**. Переменные Архива тоже описаны в `.env.example`.

## Границы (Часть IV ТЗ — обязательны для любого модуля)

Платформа **НЕ**: атакует третьих лиц, не ведёт hack-back, не вторгается в чужие
системы, не саботирует чужую инфраструктуру; не ведёт дезинформацию/компромат;
не заметает следы на чужих системах; **не генерирует автономно вредоносный код**.
Действует **только** по авторизованным целям; внешние коммуникации отправляет
**человек**; полный **append-only** аудит каждого действия. Это ядро только
отвечает «можно/нельзя» и записывает — оно ни по какой цели не действует.
