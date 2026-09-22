/**
 * The Russian wording of Office3D.
 *
 * One entry per user-facing phrase, keyed by `<area>.<thing>`. Keep the areas
 * in alphabetical order and the keys inside them too — this file is read far
 * more often than it is written, and a phrase nobody can find gets duplicated
 * instead of reused.
 *
 * Conventions, so the interface reads as one voice rather than 84:
 *   • «ты» is never used; the interface addresses nobody personally.
 *   • Buttons are verbs in the infinitive: «Закрыть», «Отправить», «Позвонить».
 *   • Headings are nouns: «Настройки», «Навыки», «Звонки».
 *   • Ellipsis is the character …, not three dots.
 *   • Quotes are «ёлочки», not "straight" ones.
 *   • Counts that vary by number use plural() rather than a fixed form.
 *   • Product and protocol names stay as they are: Office3D, OpenClaw,
 *     ElevenLabs, WhatsApp, GitHub, ClawHub, Hermes, SIP, API.
 */

export const ru = {
  // --- Общее ---------------------------------------------------------------
  "common.copied": "Скопировано",

  // --- Подключение к шлюзу -------------------------------------------------
  "gateway.approveHint":
    "Если первая попытка подключения не удалась, зайдите на компьютер с OpenClaw и подтвердите это устройство:",
  "gateway.backendCustom": "Свой бэкенд",
  "gateway.backendDemo": "Демо-бэкенд",
  "gateway.backendHermes": "Бэкенд Hermes",
  "gateway.backendLocal": "Локальная среда",
  "gateway.backendOffice3d": "Среда Office3D",
  "gateway.backendOpenClaw": "Бэкенд OpenClaw",
  "gateway.backendsKeepOwnSettings": "У каждого бэкенда свои сохранённые адрес и токен.",
  "gateway.chooseBackend": "Выберите бэкенд и подключитесь к адресу его шлюза.",
  "gateway.connect": "Подключиться",
  "gateway.connecting": "Подключение…",
  "gateway.connectingRemote": "Подключение к удалённому шлюзу…",
  "gateway.copyCommand": "Копировать команду",
  "gateway.copyCommandLabel": "Копировать команду локального шлюза",
  "gateway.copyFailed": "Не удалось скопировать команду.",
  "gateway.detectedLocal": "Локальный шлюз найден на порту {port}. Подключение…",
  "gateway.hideToken": "Скрыть токен",
  "gateway.hintCustom":
    "«Свой бэкенд» — это обычный прямой стык со средой выполнения. Подходит для совместимых оркестраторов, но не для входа через конкретного поставщика.",
  "gateway.hintDemo":
    "Демо работает либо на локальном тестовом агенте, либо на встроенном мок-шлюзе с потоковыми ответами.",
  "gateway.hintHermes":
    "Hermes — среда выполнения агентов со своим потоком поставщиков и учётных записей за шлюзом.",
  "gateway.hintLocal":
    "Локальная среда ожидает прямой HTTP-стык со средой выполнения или оркестратором, а не каталог поставщиков.",
  "gateway.hintOffice3d":
    "Среда Office3D сохраняет соглашения Office3D о стенограммах поверх прямого стыка.",
  "gateway.hintOpenClaw":
    "OpenClaw — путь через шлюз с богатым выбором поставщиков. Берите его, когда маршрутизацией моделей и поставщиков должен управлять сам OpenClaw.",
  "gateway.localDefaultsToken": "Взять токен из {path}.",
  "gateway.localDefaultsUse": "Взять локальные значения",
  "gateway.noLocalFound": "Локальный шлюз не найден.",
  "gateway.notConnected": "Нет подключения к шлюзу.",
  "gateway.remoteTitle": "Удалённый шлюз (рекомендуется)",
  "gateway.runLocallyLead": "Запустите процесс шлюза на этой машине и подключитесь к нему.",
  "gateway.runLocallyTitle": "Запуск локально (необязательно)",
  "gateway.selectedBackend": "Выбранный бэкенд: {selected} | Активный бэкенд: {active}",
  "gateway.showToken": "Показать токен",
  "gateway.sourceCheckoutHint": "В рабочей копии исходников используйте {command}.",
  "gateway.tailscaleTitle": "Используете Tailscale?",
  "gateway.tailscaleUrl": "Адрес:",
  "gateway.tipDemoBody":
    "Выполните {command}, чтобы поднять встроенный мок-шлюз с демо-агентами. Затем выберите «Демо-бэкенд» и подключитесь.",
  "gateway.tipDemoTitle": "Хотите просто посмотреть офис?",
  "gateway.tipHermesBody":
    "Выполните {command}, затем выберите «Бэкенд Hermes». Локальный адрес по умолчанию — {url}.",
  "gateway.tipHermesTitle": "Используете Hermes локально?",
  "gateway.tipRemoteBody":
    "Запустите Studio с {host} (или с конкретным адресом в LAN или Tailscale) и задайте {token}, прежде чем открывать доступ за пределы localhost. Настройки шлюза хранятся на хосте Studio, а подтверждение устройства OpenClaw остаётся отдельным для каждого браузера.",
  "gateway.tipRemoteTitle": "Открываете Office3D с другой машины?",
  "gateway.tipRuntimeBody":
    "Выберите «Локальная среда», «Среда Office3D» или «Свой бэкенд» и укажите адрес своего оркестратора или среды выполнения. Эти профили уже хранят отдельные адреса и токены, но передача чата поверх конкретного транспорта ещё требует доработки.",
  "gateway.tipRuntimeTitle": "Используете локальную или свою среду выполнения?",
  "gateway.tokenPlaceholder": "токен шлюза",
  "gateway.tokenPlaceholderOptional": "необязательный токен",
  "gateway.upstreamToken": "Токен шлюза",
  "gateway.upstreamTokenOptional": "Токен шлюза (необязательно)",
  "gateway.upstreamUrl": "Адрес шлюза",
} as const;
