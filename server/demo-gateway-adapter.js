"use strict";

const http = require("http");
const { randomUUID } = require("crypto");
const { WebSocketServer } = require("ws");

const ADAPTER_PORT = parseInt(process.env.DEMO_ADAPTER_PORT || "18789", 10);
const MAIN_KEY = "main";
const MODELS = [{ id: "demo/mock-office", name: "Mock Office", provider: "demo" }];

// The lead keeps the id the office reserves for its main agent: the UI will
// not delete "main", sends push-to-talk to it and has it split work when the
// user addresses the whole team.
const LEAD_AGENT_ID = "main";
const LEAD_AGENT_NAME = "AM7";
const LEAD_ROLE = "Lead";

const DEFAULT_AGENT_COUNT = 300;
const MIN_AGENT_COUNT = 1;
const MAX_AGENT_COUNT = 1000;

// One history per session is enough for a demo; the cap keeps a day-long
// ambient run of 1000 agents at a few megabytes.
const MAX_HISTORY_MESSAGES = 80;
const MAX_PREVIEW_KEYS = 256;
const STATUS_RECENT_LIMIT = 50;

// Ambient activity: the office looks alive without anyone typing.
const AMBIENT_TICK_MIN_MS = 2_000;
const AMBIENT_TICK_MAX_MS = 6_000;
const AMBIENT_FIRST_TICK_MS = 500;
const AMBIENT_WARM_SPREAD_MS = 8_000;
const AMBIENT_RUN_MIN_MS = 20_000;
const AMBIENT_RUN_MAX_MS = 120_000;
const AMBIENT_LEAD_RUN_MIN_MS = 30_000;
const AMBIENT_LEAD_RUN_MAX_MS = 90_000;
const AMBIENT_LEAD_START_CHANCE = 0.35;
// The share of busy agents drifts inside this band, so the room breathes.
const AMBIENT_TARGET_MIN = 0.4;
const AMBIENT_TARGET_MAX = 0.55;
const AMBIENT_TARGET_START = 0.47;
const AMBIENT_TARGET_DRIFT = 0.06;
const AMBIENT_MAX_START_SHARE = 0.08;
// After the user writes to (or stops) an agent, background work leaves it alone for a while.
const AMBIENT_USER_QUIET_MS = 90_000;
// A short break between background runs, so everyone is seen idle now and then.
const AMBIENT_REST_MIN_MS = 4_000;
const AMBIENT_REST_MAX_MS = 15_000;

// A client that connects mid-run has missed the starts of runs already going.
// Its first `status` call comes at the end of hydration; the runs are replayed
// a moment later, in small chunks so a big office is not one burst of frames.
const REPLAY_DELAY_MS = 1_500;
const REPLAY_CHUNK = 25;
const REPLAY_CHUNK_INTERVAL_MS = 120;

const TEAM_ROLES = [
  "Research",
  "Builder",
  "Analyst",
  "Data",
  "Design",
  "DevOps",
  "QA",
  "Writer",
  "Planner",
  "Support",
];

// Roles stay English internally (replies and ambient work branch on them);
// this is what the office shows. A role set through agents.create is shown as given.
const ROLE_LABELS = {
  Lead: "Руководитель",
  Research: "Исследования",
  Builder: "Разработка",
  Analyst: "Аналитика",
  Data: "Данные",
  Design: "Дизайн",
  DevOps: "DevOps-инженер",
  QA: "Тестирование",
  Writer: "Тексты",
  Planner: "Планирование",
  Support: "Поддержка",
};

// Call signs: short, Latin, no trailing digits (a number suffix makes them
// unique past the end of the list), at most 7 letters so "Name12" fits in 10.
const CALL_SIGNS = [
  "Nyx", "Vex", "Kade", "Rune", "Mika", "Juno", "Orion", "Lyra", "Echo", "Nova",
  "Zed", "Ash", "Sol", "Iris", "Pixel", "Byte", "Atlas", "Cleo", "Dex", "Ember",
  "Finn", "Gale", "Halo", "Ion", "Jett", "Kai", "Lumen", "Milo", "Neo", "Onyx",
  "Pax", "Quill", "Rex", "Sage", "Tess", "Uma", "Vega", "Wren", "Xan", "Yuki",
  "Zara", "Arlo", "Blaze", "Cyra", "Drift", "Enzo", "Flux", "Glyph", "Hex", "Indy",
  "Jinx", "Koda", "Lux", "Moss", "Nico", "Opal", "Pike", "Rook", "Skye", "Talon",
  "Umbra", "Volt", "Wisp", "Xeno", "Yara", "Zephyr", "Axel", "Bolt", "Cove", "Dune",
  "Elio", "Fern", "Grit", "Haze", "Ivo", "Jade", "Kit", "Lark", "Mako", "Nash",
  "Otto", "Pip", "Quinn", "Rae", "Shay", "Tao", "Ula", "Vim", "Wynn", "Yves",
  "Zoe", "Aria", "Bram", "Cass", "Dax", "Eos", "Fox",
];

// What each role says and does. Ambient tasks arrive in the office as user
// messages, and the office reads user messages as commands (walk to the desk,
// the gym, the QA lab, a meeting, a call). Task wording therefore avoids every
// command word; tests/unit/demoGatewayAdapterTeam.test.ts runs them through the
// office's own parser. Replies and summaries are assistant text and are free.
const ROLE_PROFILES = {
  Lead: {
    action: "Распределю задачу по отделам, прослежу за сроками и соберу общий итог.",
    progress: ["Сверяю статусы отделов…", "Собираю отчёты команды…"],
    scripts: [
      ["Сверь приоритеты отделов на эту неделю", "Приоритеты сверены: три задачи подняты выше, одна отложена до следующего спринта."],
      ["Собери сводку по работе всех отделов", "Сводка готова: отделы идут по плану, два риска вынесены отдельно."],
      ["Распредели новые заявки между отделами", "Заявки распределены: аналитике две, разработке три, поддержке одна."],
      ["Подготовь короткий отчёт для владельца продукта", "Отчёт готов: итоги недели, риски и план на следующую уложились в одну страницу."],
      ["Оцени загрузку команды и найди узкие места", "Загрузка ровная, узкое место — дизайн. Предлагаю усилить его человеком из планирования."],
    ],
  },
  Research: {
    action: "Соберу источники, отмечу ограничения и вернусь с уточняющими вопросами.",
    progress: ["Собираю источники…", "Читаю материалы…"],
    scripts: [
      ["Изучи, как конкуренты устроили онбординг", "Разобрал пять продуктов: у троих онбординг в три шага, у лидера — интерактивный тур."],
      ["Найди свежие работы о векторном поиске", "Нашёл четыре свежие работы; главное — гибридный поиск стабильно выигрывает у чисто векторного."],
      ["Сравни подходы к кешированию ответов", "Сравнил три подхода: нам подходит короткий срок жизни кеша и прогрев популярных запросов."],
      ["Разбери отзывы пользователей за неделю", "Отзывы разобраны: чаще всего просят экспорт и тёмную тему."],
    ],
  },
  Builder: {
    action: "Разложу задачу на шаги реализации, учту крайние случаи и соберу рабочий вариант.",
    progress: ["Пишу код…", "Собираю изменения…"],
    scripts: [
      ["Сделай выгрузку отчёта в таблицу", "Выгрузка готова: отчёт сохраняется в таблицу, большие файлы уходят частями."],
      ["Добавь фильтр по датам в список задач", "Фильтр по датам добавлен и работает вместе с поиском."],
      ["Перенеси расчёт метрик в фоновую очередь", "Расчёт метрик переехал в фоновую очередь, интерфейс больше не подвисает."],
      ["Ускорь загрузку страницы профиля", "Страница профиля грузится вдвое быстрее: убрал лишние запросы и добавил кеш."],
    ],
  },
  Analyst: {
    action: "Посчитаю ключевые метрики и покажу, что сильнее всего влияет на результат.",
    progress: ["Считаю метрики…", "Строю срезы…"],
    scripts: [
      ["Посчитай конверсию воронки за месяц", "Конверсия воронки — 4,2 %, главный провал между корзиной и оплатой."],
      ["Найди, где пользователи бросают регистрацию", "Больше всего уходят на шаге подтверждения телефона — около 30 %."],
      ["Сравни удержание двух последних когорт", "Удержание новой когорты на седьмой день выше на пять пунктов."],
      ["Оцени эффект нового онбординга", "Новый онбординг поднял активацию примерно на 8 %."],
    ],
  },
  Data: {
    action: "Разберусь с источниками, подготовлю чистую выборку и опишу поля.",
    progress: ["Обрабатываю данные…", "Сверяю источники…"],
    scripts: [
      ["Очисти дубликаты в таблице клиентов", "Дубликаты убраны: объединил 312 записей, спорные отложил отдельно."],
      ["Подготовь выборку событий за квартал", "Выборка за квартал готова: 1,2 млн событий без служебных."],
      ["Опиши поля новой витрины данных", "Описал все поля витрины: типы, источники и частоту обновления."],
      ["Обнови справочник регионов", "Справочник регионов обновлён, новые коды добавлены."],
    ],
  },
  Design: {
    action: "Набросаю пару вариантов интерфейса и отмечу места, где пользователю будет трудно.",
    progress: ["Рисую варианты…", "Собираю макет…"],
    scripts: [
      ["Предложи два варианта главного экрана", "Готовы два варианта главного экрана, спокойный и насыщенный, со сравнением."],
      ["Упрости форму регистрации", "Форма стала короче: вместо семи полей — три."],
      ["Подбери иконки для нового меню", "Иконки подобраны в едином стиле и читаются даже в маленьком размере."],
      ["Сделай тёмную тему для панели отчётов", "Тёмная тема для панели отчётов готова, контраст текста в норме."],
    ],
  },
  DevOps: {
    action: "Посмотрю окружение, мониторинг и план отката, потом внесу изменения без простоя.",
    progress: ["Меняю конфигурацию…", "Слежу за метриками…"],
    scripts: [
      ["Обнови конфигурацию балансировщика", "Конфигурация балансировщика обновлена без простоя."],
      ["Настрой оповещения о росте задержек", "Оповещения настроены: порог — 300 мс на 95-м перцентиле."],
      ["Подготовь план отката для релиза", "План отката готов, откат занимает около двух минут."],
      ["Сократи время сборки контейнеров", "Сборка контейнеров ускорилась с девяти до четырёх минут благодаря кешу слоёв."],
    ],
  },
  QA: {
    action: "Составлю сценарии, пройду крайние случаи и заведу найденные ошибки.",
    progress: ["Прохожу сценарии…", "Фиксирую результаты…"],
    scripts: [
      ["Составь сценарии для нового экрана оплаты", "Сценарии готовы: восемнадцать штук, включая отказ банка и повторную оплату."],
      ["Пройди регрессию мобильной версии", "Регрессия пройдена: две мелкие ошибки заведены, блокеров нет."],
      ["Опиши найденные ошибки в трекере", "Ошибки описаны: шаги, ожидаемый и фактический результат, снимки экрана."],
      ["Оцени покрытие сценариями модуля отчётов", "Покрытие модуля отчётов — около 70 %, не хватает сценариев на экспорт."],
    ],
  },
  Writer: {
    action: "Подготовлю короткий понятный текст и отдельно — совсем сжатый вариант.",
    progress: ["Пишу черновик…", "Вычитываю текст…"],
    scripts: [
      ["Подготовь заметки к релизу", "Заметки к релизу готовы: пять пунктов простым языком."],
      ["Перепиши подсказки в форме заказа", "Подсказки переписаны: короче и без канцелярита."],
      ["Сделай черновик статьи для блога", "Черновик статьи готов, около четырёх тысяч знаков."],
      ["Сократи приветственное письмо", "Письмо стало вдвое короче, главное теперь в первой строке."],
    ],
  },
  Planner: {
    action: "Разобью задачу на этапы, оценю сроки и отмечу зависимости.",
    progress: ["Раскладываю по этапам…", "Сверяю сроки…"],
    scripts: [
      ["Разбей квартальную цель на этапы", "Цель разбита на четыре этапа с контрольными точками раз в три недели."],
      ["Оцени сроки по новым задачам", "Оценка готова: основной объём укладывается в два спринта."],
      ["Обнови дорожную карту продукта", "Дорожная карта обновлена, сдвинулся только один пункт."],
      ["Найди зависимости между отделами", "Нашёл три зависимости, самая важная — между данными и аналитикой."],
    ],
  },
  Support: {
    action: "Соберу частые вопросы пользователей и подготовлю понятные ответы.",
    progress: ["Разбираю обращения…", "Отвечаю пользователям…"],
    scripts: [
      ["Разбери новые обращения пользователей", "Обращения разобраны: сорок закрыто, шесть переданы в разработку."],
      ["Обнови ответы в базе знаний", "База знаний обновлена, добавлено семь новых статей."],
      ["Собери частые вопросы за неделю", "Частые вопросы собраны, чаще всего спрашивают про оплату, доступ и экспорт."],
      ["Подготовь инструкцию по восстановлению доступа", "Инструкция готова: пять шагов с картинками."],
    ],
  },
};

// Agents created from the office can carry any role.
const GENERIC_PROFILE = {
  action: "Разберу задачу по шагам и вернусь с результатом и следующим шагом.",
  progress: ["Работаю над задачей…"],
  scripts: [
    ["Разбери входящие задачи", "Входящие разобраны, по каждой задаче есть следующий шаг."],
    ["Подготовь короткий отчёт о работе", "Отчёт готов: что сделано, что в работе и что мешает."],
  ],
};

const GREETING_RE =
  /^(hi|hello|hey|yo|sup|what'?s up|how are you|привет|приветствую|здравствуй|здравствуйте|добрый (день|вечер)|доброе утро|хай|как дела)[!.?, ]*$/iu;

const EMPTY_HISTORY = Object.freeze([]);

const agents = new Map();
const files = new Map();
const sessionSettings = new Map();
const conversationHistory = new Map();
const sessionUpdatedAt = new Map();
/** runId → run (user chats and ambient work alike). */
const activeRuns = new Map();
/** agentId → Set of its active runs; an agent in this map is busy. */
const runsByAgent = new Map();
/** agentId → until when ambient work leaves it to the user. */
const quietUntil = new Map();
/** Connected clients and test subscribers: send function → connection state. */
const connections = new Map();

const ambient = {
  running: false,
  warm: false,
  timer: null,
  random: Math.random,
  target: AMBIENT_TARGET_START,
  /** agentId → timer of a start already picked but not yet announced. */
  pendingStarts: new Map(),
};

function randomId() {
  return randomUUID().replace(/-/g, "");
}

function later(fn, delayMs) {
  const timer = setTimeout(fn, Math.max(0, delayMs));
  timer?.unref?.();
  return timer;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function between(min, max, random = ambient.random) {
  return min + (max - min) * random();
}

function pick(list, random = ambient.random) {
  return list[Math.min(list.length - 1, Math.floor(random() * list.length))];
}

function positiveInt(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : null;
}

function sessionKeyFor(agentId) {
  return `agent:${agentId}:${MAIN_KEY}`;
}

function agentIdFromSessionKey(sessionKey) {
  const match = /^agent:([^:]+):/.exec(sessionKey);
  return match ? match[1] : null;
}

function getHistory(sessionKey) {
  if (!conversationHistory.has(sessionKey)) {
    conversationHistory.set(sessionKey, []);
  }
  return conversationHistory.get(sessionKey);
}

// Read-only access: listing or previewing a session must not create one.
function readHistory(sessionKey) {
  return conversationHistory.get(sessionKey) || EMPTY_HISTORY;
}

function appendHistory(sessionKey, messages, at = Date.now()) {
  const history = getHistory(sessionKey);
  history.push(...messages);
  if (history.length > MAX_HISTORY_MESSAGES) {
    history.splice(0, history.length - MAX_HISTORY_MESSAGES);
  }
  sessionUpdatedAt.set(sessionKey, at);
}

function clearHistory(sessionKey) {
  conversationHistory.delete(sessionKey);
  sessionUpdatedAt.delete(sessionKey);
}

function resOk(id, payload) {
  return { type: "res", id, ok: true, payload: payload ?? {} };
}

function resErr(id, code, message) {
  return { type: "res", id, ok: false, error: { code, message } };
}

function broadcastEvent(frame) {
  for (const send of connections.keys()) {
    try {
      send(frame);
    } catch {}
  }
}

const roleLabel = (role) => ROLE_LABELS[role] || role;

const profileFor = (role) => ROLE_PROFILES[role] || GENERIC_PROFILE;

/**
 * DEMO_AGENT_COUNT as a team size: 300 when unset or unreadable, clamped to 1..1000.
 * @param {unknown} value
 * @returns {number}
 */
function resolveAgentCount(value) {
  const parsed =
    typeof value === "number" ? Math.trunc(value) : parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_AGENT_COUNT;
  return clamp(parsed, MIN_AGENT_COUNT, MAX_AGENT_COUNT);
}

/**
 * The demo team: the lead first, then "agent-001".. with call signs and roles in turn.
 * @param {unknown} count
 * @returns {{ id: string; name: string; role: string; workspace: string }[]}
 */
function buildDemoTeam(count) {
  const total = resolveAgentCount(count);
  const team = [
    { id: LEAD_AGENT_ID, name: LEAD_AGENT_NAME, role: LEAD_ROLE, workspace: `/demo/${LEAD_AGENT_ID}` },
  ];
  // The first pass uses the call signs as they are; later passes pair each one
  // with another (no digits in names), up to 10 letters, never repeating.
  const used = new Set(CALL_SIGNS.map((sign) => sign.toLowerCase()));
  for (let index = 1; index < total; index += 1) {
    const slot = (index - 1) % CALL_SIGNS.length;
    const base = CALL_SIGNS[slot];
    const round = Math.floor((index - 1) / CALL_SIGNS.length);
    let name = base;
    for (let step = round; round > 0; step += 1) {
      const candidate = `${base}${CALL_SIGNS[(slot + step) % CALL_SIGNS.length]}`;
      if (candidate.length <= 10 && !used.has(candidate.toLowerCase())) {
        name = candidate;
        used.add(candidate.toLowerCase());
        break;
      }
    }
    const id = `agent-${String(index).padStart(3, "0")}`;
    team.push({
      id,
      name,
      role: TEAM_ROLES[(index - 1) % TEAM_ROLES.length],
      workspace: `/demo/${id}`,
    });
  }
  return team;
}

/**
 * DEMO_AMBIENT_ACTIVITY: on unless it says "0" (or false/off/no).
 * @param {unknown} value
 */
function isAmbientActivityEnabled(value) {
  if (value === undefined || value === null) return true;
  return !/^(0|false|off|no)$/i.test(String(value).trim());
}

function agentListPayload() {
  return [...agents.values()].map((agent) => ({
    id: agent.id,
    name: agent.name,
    workspace: agent.workspace,
    identity: { name: agent.name, emoji: "🤖" },
    role: roleLabel(agent.role),
  }));
}

function pluralRu(count, one, few, many) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * A short in-character answer in Russian.
 * @param {{ id: string; name: string; role: string }} agent
 * @param {string} message
 */
function buildDemoReply(agent, message) {
  const compactMessage = String(message ?? "").replace(/\s+/g, " ").trim();
  const greetingOnly = GREETING_RE.test(compactMessage);
  const clipped =
    compactMessage.length > 160 ? `${compactMessage.slice(0, 160).trimEnd()}…` : compactMessage;
  const focusLine = clipped.replace(/[.!?]+$/u, "");
  const profile = profileFor(agent.role);

  if (agent.id === LEAD_AGENT_ID || agent.role === LEAD_ROLE) {
    const opening = `На связи ${agent.name}, руководитель штаба.`;
    if (greetingOnly) {
      const total = agents.size;
      const busy = runsByAgent.size;
      return `${opening} Команда: ${total} ${pluralRu(total, "агент", "агента", "агентов")}, сейчас в работе ${busy}. Дайте задачу — распределю её по отделам.`;
    }
    return `${opening} Задача: ${focusLine}. ${profile.action}`;
  }

  const label = roleLabel(agent.role);
  const opening = label ? `${agent.name} на связи, направление «${label}».` : `${agent.name} на связи.`;
  if (greetingOnly) {
    return `${opening} Дайте конкретную задачу — отвечу по своей роли и предложу следующий шаг.`;
  }
  return `${opening} Задача: ${focusLine}. ${profile.action}`;
}

// --- runs ---------------------------------------------------------------------------

function registerRun({ runId, sessionKey, agentId, isAmbient }) {
  let resolveDone = () => {};
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const run = {
    runId,
    sessionKey,
    agentId,
    ambient: isAmbient,
    startedAt: Date.now(),
    finished: false,
    done,
    timers: [],
    abort() {},
    finish() {
      if (run.finished) return;
      run.finished = true;
      for (const timer of run.timers) clearTimeout(timer);
      run.timers.length = 0;
      if (activeRuns.get(runId) === run) activeRuns.delete(runId);
      const agentRuns = runsByAgent.get(agentId);
      if (agentRuns) {
        agentRuns.delete(run);
        if (agentRuns.size === 0) runsByAgent.delete(agentId);
      }
      resolveDone();
    },
  };
  activeRuns.set(runId, run);
  const agentRuns = runsByAgent.get(agentId) || new Set();
  agentRuns.add(run);
  runsByAgent.set(agentId, agentRuns);
  return run;
}

function abortRunsOfAgent(agentId, predicate = () => true) {
  const agentRuns = runsByAgent.get(agentId);
  if (!agentRuns) return 0;
  let aborted = 0;
  for (const run of [...agentRuns]) {
    if (!predicate(run)) continue;
    run.abort();
    aborted += 1;
  }
  return aborted;
}

// --- ambient activity -----------------------------------------------------------------
// Each background run is what a real run looks like to the office, kept small:
// the task as a user message (so the office knows what the agent is on and
// does not have to fetch history to find out), lifecycle start, one short
// progress line, then the summary as the final message and lifecycle end.

const chatFrame = (run, state, extra) => ({
  type: "event",
  event: "chat",
  payload: { runId: run.runId, sessionKey: run.sessionKey, state, ...extra },
});

const agentFrame = (run, stream, data) => ({
  type: "event",
  event: "agent",
  payload: { runId: run.runId, sessionKey: run.sessionKey, stream, data },
});

const progressFrame = (run) =>
  chatFrame(run, "delta", { message: { role: "assistant", content: run.progress } });

function emitRunStart(run, send) {
  send(chatFrame(run, "delta", { message: { role: "user", content: run.task } }));
  send(agentFrame(run, "lifecycle", { phase: "start" }));
  if (run.progressSent) send(progressFrame(run));
}

function endAmbientRun(run, outcome) {
  if (run.finished) return;
  if (outcome === "final") {
    const at = Date.now();
    appendHistory(
      run.sessionKey,
      [
        { role: "user", content: run.task, timestamp: run.startedAt },
        { role: "assistant", content: run.summary, timestamp: at },
      ],
      at,
    );
    broadcastEvent(
      chatFrame(run, "final", {
        stopReason: "end_turn",
        message: { role: "assistant", content: run.summary },
      }),
    );
    broadcastEvent(agentFrame(run, "lifecycle", { phase: "end" }));
    if (run.agentId !== LEAD_AGENT_ID) {
      const restUntil = at + between(AMBIENT_REST_MIN_MS, AMBIENT_REST_MAX_MS);
      quietUntil.set(run.agentId, Math.max(quietUntil.get(run.agentId) ?? 0, restUntil));
    }
  } else {
    broadcastEvent(chatFrame(run, "aborted", {}));
    broadcastEvent(agentFrame(run, "lifecycle", { phase: "end", aborted: true }));
  }
  run.finish();
}

const AMBIENT_RUN_ID_PREFIX = "ambient-";

function startAmbientRun(agent, durationScale = 1) {
  const random = ambient.random;
  const profile = profileFor(agent.role);
  const [task, summary] = pick(profile.scripts, random);
  const isLead = agent.id === LEAD_AGENT_ID;
  const durationMs =
    (isLead
      ? between(AMBIENT_LEAD_RUN_MIN_MS, AMBIENT_LEAD_RUN_MAX_MS, random)
      : between(AMBIENT_RUN_MIN_MS, AMBIENT_RUN_MAX_MS, random)) * durationScale;
  const run = registerRun({
    // The "ambient-" prefix tells the client this is background demo work that
    // a user message may interrupt (chat.send aborts it), not a run to queue behind.
    runId: `${AMBIENT_RUN_ID_PREFIX}${randomUUID()}`,
    sessionKey: sessionKeyFor(agent.id),
    agentId: agent.id,
    isAmbient: true,
  });
  run.task = task;
  run.summary = summary;
  run.progress = pick(profile.progress, random);
  run.progressSent = false;
  run.abort = () => endAmbientRun(run, "aborted");
  emitRunStart(run, broadcastEvent);
  run.timers.push(
    later(() => {
      run.progressSent = true;
      broadcastEvent(progressFrame(run));
    }, durationMs * between(0.3, 0.6, random)),
  );
  run.timers.push(later(() => endAmbientRun(run, "final"), durationMs));
  return run;
}

function isAvailableForAmbient(agentId, now) {
  return (
    !runsByAgent.has(agentId) &&
    !ambient.pendingStarts.has(agentId) &&
    (quietUntil.get(agentId) ?? 0) <= now
  );
}

function queueAmbientStart(agentId, delayMs, durationScale) {
  const timer = later(() => {
    ambient.pendingStarts.delete(agentId);
    if (!ambient.running) return;
    const agent = agents.get(agentId);
    if (!agent || runsByAgent.has(agentId) || (quietUntil.get(agentId) ?? 0) > Date.now()) return;
    startAmbientRun(agent, durationScale);
  }, delayMs);
  ambient.pendingStarts.set(agentId, timer);
}

function ambientTick() {
  ambient.timer = null;
  if (!ambient.running) return;
  const random = ambient.random;
  const now = Date.now();
  const nextDelay = between(AMBIENT_TICK_MIN_MS, AMBIENT_TICK_MAX_MS, random);
  // The first pass fills the room at once, with runs already part-way done,
  // so a fresh office does not open empty and then finish in one wave.
  const warm = ambient.warm;
  ambient.warm = false;
  ambient.target = clamp(
    ambient.target + (random() - 0.5) * AMBIENT_TARGET_DRIFT,
    AMBIENT_TARGET_MIN,
    AMBIENT_TARGET_MAX,
  );

  let busy = runsByAgent.size + ambient.pendingStarts.size;
  if (
    agents.has(LEAD_AGENT_ID) &&
    isAvailableForAmbient(LEAD_AGENT_ID, now) &&
    (warm || random() < AMBIENT_LEAD_START_CHANCE)
  ) {
    queueAmbientStart(LEAD_AGENT_ID, warm ? 0 : random() * nextDelay * 0.5, 1);
    busy += 1;
  }

  const desired = Math.round(ambient.target * agents.size);
  const maxStarts = warm ? desired : Math.max(2, Math.ceil(agents.size * AMBIENT_MAX_START_SHARE));
  let starts = Math.min(desired - busy, maxStarts);
  if (starts > 0) {
    const candidates = [];
    for (const agentId of agents.keys()) {
      if (agentId !== LEAD_AGENT_ID && isAvailableForAmbient(agentId, now)) candidates.push(agentId);
    }
    starts = Math.min(starts, candidates.length);
    // Partial Fisher-Yates: a few random picks without shuffling everyone.
    for (let index = 0; index < starts; index += 1) {
      const swap = index + Math.floor(random() * (candidates.length - index));
      const chosen = candidates[swap];
      candidates[swap] = candidates[index];
      candidates[index] = chosen;
      // Starts are spread over the pause so events never arrive in one burst.
      queueAmbientStart(
        chosen,
        random() * (warm ? AMBIENT_WARM_SPREAD_MS : nextDelay),
        warm ? between(0.15, 1, random) : 1,
      );
    }
  }
  ambient.timer = later(ambientTick, nextDelay);
}

/**
 * Starts background work. Returns false when it is already running.
 * @param {{ random?: () => number }} [options] random: a 0..1 source (seeded in tests).
 */
function startAmbientActivity(options = {}) {
  if (ambient.running) return false;
  ambient.random = typeof options.random === "function" ? options.random : Math.random;
  ambient.running = true;
  ambient.warm = true;
  ambient.target = AMBIENT_TARGET_START;
  ambient.timer = later(ambientTick, AMBIENT_FIRST_TICK_MS);
  return true;
}

/**
 * Stops background work; runs in flight finish at once with their summary,
 * so no office is left showing someone at work.
 */
function stopAmbientActivity() {
  const wasRunning = ambient.running;
  ambient.running = false;
  ambient.warm = false;
  if (ambient.timer) clearTimeout(ambient.timer);
  ambient.timer = null;
  for (const timer of ambient.pendingStarts.values()) clearTimeout(timer);
  ambient.pendingStarts.clear();
  for (const run of [...activeRuns.values()]) {
    if (run.ambient) endAmbientRun(run, "final");
  }
  return wasRunning;
}

function getAmbientSnapshot() {
  let ambientRuns = 0;
  for (const run of activeRuns.values()) {
    if (run.ambient) ambientRuns += 1;
  }
  return {
    running: ambient.running,
    agents: agents.size,
    busyAgents: runsByAgent.size,
    busyAgentIds: [...runsByAgent.keys()],
    ambientRuns,
    pendingStarts: ambient.pendingStarts.size,
    leadBusy: runsByAgent.has(LEAD_AGENT_ID),
    target: ambient.target,
  };
}

// --- connections ------------------------------------------------------------------------

function openConnection(send) {
  connections.set(send, { connectedAt: Date.now(), replayScheduled: false, replayTimer: null });
}

function closeConnection(send) {
  const state = connections.get(send);
  if (state?.replayTimer) clearTimeout(state.replayTimer);
  connections.delete(send);
}

function scheduleReplay(send) {
  const state = connections.get(send);
  if (!state || state.replayScheduled) return;
  state.replayScheduled = true;
  const cutoff = Date.now();
  state.replayTimer = later(() => {
    const runs = [...activeRuns.values()].filter((run) => run.ambient && run.startedAt <= cutoff);
    let index = 0;
    const pump = () => {
      state.replayTimer = null;
      if (connections.get(send) !== state) return;
      const end = Math.min(index + REPLAY_CHUNK, runs.length);
      for (; index < end; index += 1) {
        const run = runs[index];
        if (!run.finished) emitRunStart(run, send);
      }
      if (index < runs.length) state.replayTimer = later(pump, REPLAY_CHUNK_INTERVAL_MS);
    };
    pump();
  }, REPLAY_DELAY_MS);
}

/**
 * Receives every broadcast event as a connected client would (for tests and tools).
 * @param {(frame: any) => void} listener
 * @returns {() => void} unsubscribe
 */
function subscribeEvents(listener) {
  openConnection(listener);
  return () => closeConnection(listener);
}

function replaceTeam(team) {
  agents.clear();
  for (const agent of team) agents.set(agent.id, { ...agent });
}

/**
 * Back to a fresh office: a new team, no history, no runs, ambient work stopped.
 * @param {{ agentCount?: unknown }} [options] agentCount defaults to DEMO_AGENT_COUNT.
 */
function resetDemoState(options = {}) {
  stopAmbientActivity();
  for (const run of [...activeRuns.values()]) run.abort();
  replaceTeam(
    buildDemoTeam(options.agentCount !== undefined ? options.agentCount : process.env.DEMO_AGENT_COUNT),
  );
  files.clear();
  sessionSettings.clear();
  conversationHistory.clear();
  sessionUpdatedAt.clear();
  quietUntil.clear();
  ambient.random = Math.random;
  ambient.target = AMBIENT_TARGET_START;
}

replaceTeam(buildDemoTeam(process.env.DEMO_AGENT_COUNT));

// --- methods ----------------------------------------------------------------------------

function sessionEntryFor(agent) {
  const key = sessionKeyFor(agent.id);
  const settings = sessionSettings.get(key) || {};
  return {
    key,
    agentId: agent.id,
    updatedAt: sessionUpdatedAt.get(key) ?? null,
    displayName: "Main",
    origin: { label: agent.name, provider: "demo" },
    model: settings.model || MODELS[0].id,
    modelProvider: "demo",
  };
}

async function handleMethod(method, params, id, sendEvent) {
  const p = params || {};

  switch (method) {
    case "agents.list":
      return resOk(id, { defaultId: LEAD_AGENT_ID, mainKey: MAIN_KEY, agents: agentListPayload() });

    case "agents.create": {
      const name = typeof p.name === "string" && p.name.trim() ? p.name.trim() : "Демо-агент";
      const role = typeof p.role === "string" ? p.role.trim() : "";
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "demo-agent";
      const agentId = `${slug}-${randomId().slice(0, 6)}`;
      agents.set(agentId, {
        id: agentId,
        name,
        role,
        workspace: `/demo/${slug}`,
      });
      broadcastEvent({
        type: "event",
        event: "presence",
        payload: { sessions: { recent: [], byAgent: [] } },
      });
      return resOk(id, { agentId, name, workspace: `/demo/${slug}` });
    }

    case "agents.update": {
      const agentId = typeof p.agentId === "string" ? p.agentId.trim() : "";
      const agent = agents.get(agentId);
      if (!agent) return resErr(id, "not_found", `Agent ${agentId} not found`);
      if (typeof p.name === "string" && p.name.trim()) agent.name = p.name.trim();
      if (typeof p.role === "string") agent.role = p.role.trim();
      return resOk(id, { ok: true, removedBindings: 0 });
    }

    case "agents.delete": {
      const agentId = typeof p.agentId === "string" ? p.agentId.trim() : "";
      if (agentId && agents.has(agentId) && agentId !== LEAD_AGENT_ID) {
        abortRunsOfAgent(agentId);
        const pending = ambient.pendingStarts.get(agentId);
        if (pending) clearTimeout(pending);
        ambient.pendingStarts.delete(agentId);
        agents.delete(agentId);
        quietUntil.delete(agentId);
        clearHistory(sessionKeyFor(agentId));
      }
      return resOk(id, { ok: true, removedBindings: 0 });
    }

    case "agents.files.get": {
      const key = `${p.agentId || LEAD_AGENT_ID}/${p.name || ""}`;
      const content = files.get(key);
      return resOk(id, { file: content !== undefined ? { content } : { missing: true } });
    }

    case "agents.files.set": {
      const key = `${p.agentId || LEAD_AGENT_ID}/${p.name || ""}`;
      files.set(key, typeof p.content === "string" ? p.content : "");
      return resOk(id, {});
    }

    case "config.get":
      return resOk(id, {
        config: { gateway: { reload: { mode: "hot" } } },
        hash: "demo-gateway",
        exists: true,
        path: "/demo/config.json",
      });

    case "config.patch":
    case "config.set":
      return resOk(id, { hash: "demo-gateway" });

    case "exec.approvals.get":
      return resOk(id, {
        path: "",
        exists: true,
        hash: "demo-approvals",
        file: { version: 1, defaults: { security: "full", ask: "off", autoAllowSkills: true }, agents: {} },
      });

    case "exec.approvals.set":
      return resOk(id, { hash: "demo-approvals" });

    case "exec.approval.resolve":
      return resOk(id, { ok: true });

    case "models.list":
      return resOk(id, { models: MODELS });

    case "skills.status":
      return resOk(id, { skills: [] });

    case "cron.list":
      return resOk(id, { jobs: [] });

    case "cron.add":
    case "cron.run":
    case "cron.remove":
      return resErr(id, "unsupported_method", `Демо-среда не поддерживает метод ${method}.`);

    // No shared task board here: the office keeps its own (task-store) board.
    case "tasks.list":
    case "tasks.create":
    case "tasks.update":
    case "tasks.delete":
      return resErr(id, "METHOD_NOT_FOUND", `unknown method: ${method}`);

    case "sessions.list": {
      // The office asks once per agent while hydrating: answering from the
      // agent map keeps that linear instead of listing the whole team N times.
      const agentFilter = typeof p.agentId === "string" ? p.agentId.trim() : "";
      const search = typeof p.search === "string" ? p.search.trim().toLowerCase() : "";
      const limit = positiveInt(p.limit);
      const pool = agentFilter
        ? agents.has(agentFilter)
          ? [agents.get(agentFilter)]
          : []
        : [...agents.values()];
      let sessions = pool.map(sessionEntryFor);
      if (search) {
        sessions = sessions.filter(
          (entry) =>
            entry.key.toLowerCase().includes(search) ||
            entry.displayName.toLowerCase().includes(search) ||
            entry.origin.label.toLowerCase().includes(search),
        );
      }
      sessions.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
      if (limit) sessions = sessions.slice(0, limit);
      return resOk(id, { sessions });
    }

    case "sessions.preview": {
      const keys = Array.isArray(p.keys)
        ? p.keys.filter((key) => typeof key === "string").slice(0, MAX_PREVIEW_KEYS)
        : [];
      const limit = positiveInt(p.limit) ?? 8;
      const maxChars = positiveInt(p.maxChars) ?? 240;
      const previews = keys.map((key) => {
        const history = readHistory(key);
        if (history.length === 0) return { key, status: "empty", items: [] };
        const items = history.slice(-limit).map((msg) => ({
          role: msg.role === "assistant" ? "assistant" : "user",
          text: String(msg.content || "").slice(0, maxChars),
          timestamp: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
        }));
        return { key, status: "ok", items };
      });
      return resOk(id, { ts: Date.now(), previews });
    }

    case "sessions.patch": {
      const key = typeof p.key === "string" ? p.key : sessionKeyFor(LEAD_AGENT_ID);
      const current = sessionSettings.get(key) || {};
      const next = { ...current };
      if (p.model !== undefined) next.model = p.model;
      if (p.thinkingLevel !== undefined) next.thinkingLevel = p.thinkingLevel;
      sessionSettings.set(key, next);
      return resOk(id, {
        ok: true,
        key,
        entry: { thinkingLevel: next.thinkingLevel },
        resolved: { model: next.model || MODELS[0].id, modelProvider: "demo" },
      });
    }

    case "sessions.reset": {
      const key = typeof p.key === "string" ? p.key : sessionKeyFor(LEAD_AGENT_ID);
      clearHistory(key);
      return resOk(id, { ok: true });
    }

    case "chat.send": {
      const sessionKey =
        typeof p.sessionKey === "string" && p.sessionKey ? p.sessionKey : sessionKeyFor(LEAD_AGENT_ID);
      const agentId = agentIdFromSessionKey(sessionKey) || LEAD_AGENT_ID;
      const agent = agents.get(agentId) || agents.get(LEAD_AGENT_ID);
      const message = typeof p.message === "string" ? p.message.trim() : String(p.message || "").trim();
      const runId = typeof p.idempotencyKey === "string" && p.idempotencyKey ? p.idempotencyKey : randomId();
      if (!message) return resOk(id, { status: "no-op", runId });

      // The user comes first: background work on this agent stops and waits.
      abortRunsOfAgent(agentId, (run) => run.ambient);
      quietUntil.set(agentId, Date.now() + AMBIENT_USER_QUIET_MS);

      const reply = buildDemoReply(agent, message);
      let aborted = false;
      const run = registerRun({ runId, sessionKey, agentId, isAmbient: false });
      run.abort = () => {
        aborted = true;
        run.finish();
      };

      setImmediate(async () => {
        // Each connection numbers its own frames (see startAdapter).
        const emitChat = (state, extra) => {
          sendEvent({
            type: "event",
            event: "chat",
            payload: { runId, sessionKey, state, ...extra },
          });
        };

        try {
          const words = reply.split(" ");
          let partial = "";
          for (const word of words) {
            if (aborted) break;
            partial = partial ? `${partial} ${word}` : word;
            emitChat("delta", { message: { role: "assistant", content: partial } });
            await new Promise((resolve) => setTimeout(resolve, 45));
          }

          if (aborted) {
            emitChat("aborted", {});
            return;
          }

          const at = Date.now();
          appendHistory(
            sessionKey,
            [
              { role: "user", content: message, timestamp: run.startedAt },
              { role: "assistant", content: reply, timestamp: at },
            ],
            at,
          );
          emitChat("final", { stopReason: "end_turn", message: { role: "assistant", content: reply } });
          sendEvent({
            type: "event",
            event: "presence",
            payload: {
              sessions: {
                recent: [{ key: sessionKey, updatedAt: at }],
                byAgent: [{ agentId, recent: [{ key: sessionKey, updatedAt: at }] }],
              },
            },
          });
        } finally {
          run.finish();
        }
      });

      return resOk(id, { status: "started", runId });
    }

    case "chat.abort": {
      const runId = typeof p.runId === "string" ? p.runId.trim() : "";
      const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";
      let aborted = 0;
      const stopped = [];
      if (runId) {
        const handle = activeRuns.get(runId);
        if (handle) stopped.push(handle);
      } else if (sessionKey) {
        for (const handle of activeRuns.values()) {
          if (handle.sessionKey === sessionKey) stopped.push(handle);
        }
      }
      for (const handle of stopped) {
        handle.abort();
        // A stopped agent is not handed new background work straight away.
        quietUntil.set(handle.agentId, Date.now() + AMBIENT_USER_QUIET_MS);
        aborted += 1;
      }
      return resOk(id, { ok: true, aborted });
    }

    case "chat.history": {
      const sessionKey =
        typeof p.sessionKey === "string" && p.sessionKey ? p.sessionKey : sessionKeyFor(LEAD_AGENT_ID);
      const limit = positiveInt(p.limit) ?? MAX_HISTORY_MESSAGES;
      return resOk(id, { sessionKey, messages: readHistory(sessionKey).slice(-limit) });
    }

    case "agent.wait": {
      const run = activeRuns.get(typeof p.runId === "string" ? p.runId : "");
      if (!run) return resOk(id, { status: "done" });
      const timeoutMs = clamp(typeof p.timeoutMs === "number" && Number.isFinite(p.timeoutMs) ? p.timeoutMs : 30_000, 0, 600_000);
      let timer = null;
      const finished = await Promise.race([
        run.done.then(() => true),
        new Promise((resolve) => {
          timer = later(() => resolve(false), timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      return resOk(id, { status: finished ? "done" : "running" });
    }

    case "status": {
      // Linear in the team size; `recent` is capped like a real gateway's.
      const recent = [];
      const byAgent = [];
      for (const agent of agents.values()) {
        const key = sessionKeyFor(agent.id);
        const updatedAt = sessionUpdatedAt.get(key);
        const entries = typeof updatedAt === "number" ? [{ key, updatedAt }] : [];
        if (entries.length > 0) recent.push(entries[0]);
        byAgent.push({ agentId: agent.id, recent: entries });
      }
      recent.sort((left, right) => right.updatedAt - left.updatedAt);
      scheduleReplay(sendEvent);
      return resOk(id, { sessions: { recent: recent.slice(0, STATUS_RECENT_LIMIT), byAgent } });
    }

    case "wake":
      return resOk(id, { ok: true });

    default:
      return resOk(id, {});
  }
}

function startAdapter() {
  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Office3D Demo Gateway Adapter\n");
  });

  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws) => {
    let connected = false;
    let globalSeq = 0;

    const send = (frame) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify(frame));
    };

    // Frames are shared between connections when broadcast, so each gets its
    // own copy with this connection's sequence number: a gap in it makes the
    // office resync everything.
    const sendEventFn = (frame) => {
      send(frame.type === "event" ? { ...frame, seq: globalSeq++ } : frame);
    };

    openConnection(sendEventFn);
    send({ type: "event", event: "connect.challenge", payload: { nonce: randomId() } });

    ws.on("message", async (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object" || frame.type !== "req") return;
      const { id, method, params } = frame;
      if (typeof id !== "string" || typeof method !== "string") return;

      if (method === "connect") {
        connected = true;
        send({
          type: "res",
          id,
          ok: true,
          payload: {
            type: "hello-ok",
            protocol: 3,
            adapterType: "demo",
            features: {
              methods: [
                "agents.list",
                "agents.create",
                "agents.delete",
                "agents.update",
                "sessions.list",
                "sessions.preview",
                "sessions.patch",
                "sessions.reset",
                "chat.send",
                "chat.abort",
                "chat.history",
                "agent.wait",
                "status",
                "config.get",
                "config.set",
                "config.patch",
                "agents.files.get",
                "agents.files.set",
                "exec.approvals.get",
                "exec.approvals.set",
                "exec.approval.resolve",
                "wake",
                "skills.status",
                "models.list",
                "cron.list",
              ],
              events: ["chat", "agent", "presence", "heartbeat"],
            },
            snapshot: {
              health: {
                agents: [...agents.values()].map((agent) => ({
                  agentId: agent.id,
                  name: agent.name,
                  isDefault: agent.id === LEAD_AGENT_ID,
                })),
                defaultAgentId: LEAD_AGENT_ID,
              },
              sessionDefaults: { mainKey: MAIN_KEY },
            },
            auth: { role: "operator", scopes: ["operator.admin"] },
            policy: { tickIntervalMs: 30000 },
          },
        });
        return;
      }

      if (!connected) {
        send(resErr(id, "not_connected", "Сначала отправьте connect."));
        return;
      }

      try {
        send(await handleMethod(method, params, id, sendEventFn));
      } catch (error) {
        send(resErr(id, "internal_error", error instanceof Error ? error.message : "Internal error"));
      }
    });

    ws.on("close", () => closeConnection(sendEventFn));
    ws.on("error", () => closeConnection(sendEventFn));
  });

  const ambientEnabled = isAmbientActivityEnabled(process.env.DEMO_AMBIENT_ACTIVITY);
  if (ambientEnabled) startAmbientActivity();

  httpServer.listen(ADAPTER_PORT, "127.0.0.1", () => {
    console.log(`[demo-gateway] Listening on ws://localhost:${ADAPTER_PORT}`);
    console.log(
      `[demo-gateway] Team: ${agents.size} agents, lead ${LEAD_AGENT_NAME} (${LEAD_AGENT_ID}); ambient activity ${ambientEnabled ? "on" : "off"}.`,
    );
    console.log("[demo-gateway] No OpenClaw or Hermes required.");
  });
}

if (require.main === module) {
  startAdapter();
}

module.exports = {
  handleMethod,
  startAdapter,
  // Everything below is exported for tests and tooling; the server needs only the two above.
  LEAD_AGENT_ID,
  LEAD_AGENT_NAME,
  TEAM_ROLES,
  ROLE_LABELS,
  ROLE_PROFILES,
  GENERIC_PROFILE,
  resolveAgentCount,
  buildDemoTeam,
  buildDemoReply,
  isAmbientActivityEnabled,
  startAmbientActivity,
  stopAmbientActivity,
  getAmbientSnapshot,
  subscribeEvents,
  resetDemoState,
};
