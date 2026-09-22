# Инструкции для агентов

Инструкции в репозитории должны оставаться общими и безопасными для open source.

Этот репозиторий — фронтенд для OpenClaw. Любую рабочую копию среды выполнения OpenClaw держите отдельно от этого репозитория.

Не изменяйте исходный код OpenClaw. Когда пользователь просит внести изменения, он просит изменить это приложение. Ваши решения должны применяться к этому приложению, но, чтобы понять полный контекст реализации решения, вам нужно будет изучать исходный код OpenClaw.

Если вы используете локальные приватные дополнительные инструкции, храните их вне репозитория и не коммитьте их сюда.

Не коммитьте в этот репозиторий личные, привязанные к конкретному окружению или секретные инструкции.

## Инструкции для Cursor Cloud

### Обзор сервиса

Office3D — фронтенд на Next.js 16 (TypeScript, React 19, Three.js, Phaser) для OpenClaw. Он запускает собственный сервер на Node.js (`server/index.js`), в который встроен WebSocket-прокси с того же источника (same-origin) к вышестоящему шлюзу OpenClaw. База данных и Docker не нужны. Единственная обязательная системная зависимость — Node.js 20+ с npm 10+.

### Запуск приложения

- `npm run dev` запускает сервер разработки на порту 3000 через собственный сервер (`node server/index.js --dev`).
- Чтобы показывать данные агентов, приложению нужен запущенный шлюз OpenClaw. Без него интерфейс загружается, но показывает форму подключения к шлюзу. Это ожидаемое поведение, а не ошибка.
- `.env` копируется из `.env.example`; описание переменных — в разделе «Настройка» файла `README.md`.

### Линтер, проверка типов и тесты

- `npm run lint` — ESLint. Ошибок нет; осталось небольшое число предупреждений. Любую новую ошибку считайте своей.
- `npm run typecheck` — `tsc --noEmit`. Чисто.
- `npm run test -- --run` — модульные тесты Vitest (используйте `--run` для однократного запуска). Все проходят; падение теста — это регрессия, а не известная проблема.
- `npm run e2e` — E2E-тесты Playwright; сначала нужно выполнить `npx playwright install`.
- `npm run smoke:dev-server` — запускает сервер разработки на случайном порту и проверяет HTTP-ответ.

### Сборка

- `npm run build` — продакшен-сборка Next.js. Ожидайте неблокирующее предупреждение `Can't resolve 'openclaw'`; npm-пакет `openclaw` подключается опционально во время выполнения и не входит в сборку.

### Подводные камни

- npm-пакет `openclaw` не является зависимостью этого репозитория. Предупреждение сборки о нём безвредно.
- `npm run studio:setup` интерактивен (запросы в TTY) — не запускайте его в неинтерактивных облачных окружениях.
- По умолчанию Vitest запускается в режиме наблюдения (watch); в CI и облачных агентах всегда передавайте `--run`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
