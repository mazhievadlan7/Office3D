# Интеграция с Agent Bus

> Визуализация сессий ИИ-программирования в ретро-офисе Office3D — без OpenClaw.

[Agent Bus](https://github.com/emiliovos/agent-bus) — система маршрутизации событий с открытым исходным кодом, которая связывает ИИ-агентов для программирования (Claude Code, Gemini, Codex и др.) с Office3D. Агенты появляются в 3D-офисе, анимируются во время работы и простаивают между задачами. Никаких затрат на инференс — только маршрутизация данных.

## Как это работает

```
AI coding session → hook fires → Agent Bus hub → gateway :18789 → Office3D renders in 3D
```

В Agent Bus есть **шлюз, совместимый с OpenClaw**, который говорит на том же WebSocket-протоколе, что уже использует Office3D. Менять код Office3D не нужно — достаточно направить `GATEWAY_URL` на шлюз Agent Bus.

### Архитектура

```
┌───────────────────────────────────────────┐
│ Producers (any machine)                    │
│                                            │
│ Claude Code → PostToolUse hook → POST :4000│
│ Gemini CLI  → hook/script    → POST :4000 │
│ Any agent   → curl           → POST :4000 │
└────────────────────┬──────────────────────┘
                     │ HTTP POST /events
                     ▼
┌──────────────────────────────────────────┐
│ Agent Bus Hub (:4000)                     │
│ Validates → broadcasts → logs to JSONL   │
└────────────────────┬─────────────────────┘
                     │ WebSocket
                     ▼
┌──────────────────────────────────────────┐
│ Agent Bus Gateway (:18789)               │
│ OpenClaw protocol v2                     │
│ In-memory agent registry                 │
│ 10 RPC methods (connect, agents.list...) │
└────────────────────┬─────────────────────┘
                     │ WebSocket (OpenClaw frames)
                     ▼
┌──────────────────────────────────────────┐
│ Office3D (:3000)                           │
│ Connects via GATEWAY_URL                 │
│ Renders agents in 3D retro office        │
└──────────────────────────────────────────┘
```

## Быстрый старт

### Требования

- Node.js 18+
- Office3D, запущенный на `:3000`

### Установка (5 минут)

```bash
# Клонируем Agent Bus
git clone https://github.com/emiliovos/agent-bus.git
cd agent-bus
npm install

# Запускаем хаб и шлюз
npm run dev:all
```

Будут запущены:
- хаб на `:4000` (маршрутизация событий);
- шлюз на `:18789` (протокол OpenClaw).

### Подключение Office3D

Направьте URL шлюза Office3D на Agent Bus:

```bash
# В .env или окружении Office3D:
GATEWAY_URL=ws://localhost:18789
```

Перезапустите Office3D. Он подключится к шлюзу Agent Bus вместо OpenClaw.

### Отправка первого события

```bash
curl -X POST http://localhost:4000/events \
  -H "Content-Type: application/json" \
  -d '{"agent":"my-agent","project":"demo","event":"session_start"}'

# Агент появляется в 3D-офисе!

curl -X POST http://localhost:4000/events \
  -d '{"agent":"my-agent","project":"demo","event":"tool_use","tool":"Edit","file":"app.ts"}'

# Агент 5 секунд показывает анимацию «работы»
```

### Подключение хуков Claude Code

В Agent Bus есть скрипты-хуки, которые срабатывают при каждом использовании инструмента в Claude Code:

```bash
# Копируем хуки
cp agent-bus/scripts/hook-post-tool-use.sh ~/.agent-bus/
cp agent-bus/scripts/hook-session-event.sh ~/.agent-bus/
chmod +x ~/.agent-bus/*.sh

# Задаём окружение
export AGENT_BUS_AGENT="my-name"
export HUB_URL="http://localhost:4000"
```

Добавьте в `.claude/settings.json`:
```json
{
  "hooks": {
    "PostToolUse": [{ "type": "command", "command": "bash ~/.agent-bus/hook-post-tool-use.sh" }],
    "Stop": [{ "type": "command", "command": "bash ~/.agent-bus/hook-session-event.sh end" }]
  }
}
```

Теперь каждое использование инструмента в Claude Code отображается в Office3D как активность агента.

## Совместимость с протоколом шлюза

Шлюз Agent Bus реализует протокол OpenClaw v2:

| RPC-метод | Поддержка | Примечания |
|-----------|-----------|-------|
| `connect` | Да | Возвращает `hello-ok` со снимком агентов |
| `health` | Да | `{ ok: true }` |
| `agents.list` | Да | Возвращает агентов, зарегистрированных по событиям хаба |
| `config.get` | Да | Идентичность и конфигурация агента |
| `sessions.list` | Да | Активные сессии с количеством сообщений |
| `sessions.preview` | Да | Последние сообщения чата (кольцевой буфер, последние 100) |
| `status` | Да | Статус активности агента |
| `exec.approvals.get` | Да | Возвращает пустой ответ (системы одобрения exec нет) |
| `chat.send` | Частично | Записывается в лог, агентам не доставляется (v1) |
| `chat.abort` | Частично | Записывается в лог, не доставляется (v1) |

### Отправляемые события

| Событие | Когда |
|-------|------|
| `agent` (жизненный цикл) | Агент начинает или заканчивает работу |
| `chat` (активность) | Использование инструмента, завершение задачи |
| `presence` | Изменения в реестре агентов |
| `tick` | Keepalive каждые 30 секунд |

## Удалённый доступ

Agent Bus поддерживает Cloudflare Tunnel для безопасного удалённого доступа:

```bash
# Автоматическая настройка
bash scripts/setup-cloudflare-tunnel.sh
```

Хаб и Office3D становятся доступны по HTTPS с аутентификацией по сервисному токену. Агенты на удалённых машинах (VPS, других ПК) могут отправлять события через туннель.

## Схема события

```typescript
interface AgentEvent {
  ts?: number;        // Unix-время в мс (добавляется автоматически, если нет)
  agent: string;      // Идентификатор агента (например, "backend-dev")
  project: string;    // Пространство имён проекта (например, "my-app")
  event: string;      // "session_start" | "session_end" | "tool_use" | "task_complete" | "heartbeat"
  tool?: string;      // Имя инструмента для событий tool_use
  file?: string;      // Путь к файлу для файловых операций
  message?: string;   // Описание для человека
}
```

## Основные отличия от OpenClaw

| Возможность | OpenClaw | Agent Bus |
|---------|----------|-----------|
| Стоимость | API-токены за каждый инференс | $0 (только маршрутизация) |
| Агенты | На основе LLM | Управляются событиями (любой источник) |
| Установка | Шлюз + API-ключи | `npm install && npm run dev:all` |
| Взаимодействие в чате | Двустороннее | Только просмотр (v1) |
| Источники агентов | Только агенты OpenClaw | Любые (Claude Code, Gemini, cron и т. д.) |

## Ссылки

- [Репозиторий Agent Bus](https://github.com/emiliovos/agent-bus)
- [Руководство по началу работы](https://github.com/emiliovos/agent-bus/blob/main/docs/GETTING_STARTED.md)
- [Справочник по API](https://github.com/emiliovos/agent-bus/blob/main/docs/api-reference.md)
- [Руководство по интеграции хуков](https://github.com/emiliovos/agent-bus/blob/main/docs/hook-integration-guide.md)
