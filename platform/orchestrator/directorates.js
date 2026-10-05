// The directorates (управления) — the organizational map the router speaks in.
//
// Единый источник для оркестратора: номера этажей и их управления из
// platform/docs/FLOOR_CHARTERS.md («Этажи (сверху вниз)»). Оркестратор маршрутизирует
// рабочие элементы между этими юнитами; всё — в рамках законной, оборонительной
// рамки (§0 / Часть IV): активные действия только по авторизованным целям, вне
// активного scope — технически невозможно (fail-closed, см. preflight).
//
// Три роли выделены отдельно, потому что на них держится матрица взаимодействия (§26):
//   • AM7 (27)       — оркестратор; крупные межуправленческие операции идут по его санкции;
//                      к нему же уходит эскалация.
//   • Кибербез/ИБ (23) — маршрут технической проверки результатов/продуктов.
//   • Внутренняя СБ (26) — видит всё; обязательна там, где затронута безопасность платформы,
//                      и держит Карцер (§19).
//
// Это справочные метаданные (кто есть кто), без какой-либо наступательной нагрузки.

/** Floor number of AM7 — the orchestrator and the only unit that may sanction
 *  cross-floor operations and receive escalations. */
const AM7_UNIT = 27;
/** Кибербез/ИБ — the technical review route for results/products (§26 «Маршрут проверки»). */
const REVIEW_UNIT = 23;
/** Внутренняя СБ — sees everything; owns the Карцер (§19) and quality/discipline control. */
const SECURITY_UNIT = 26;
/** The Gate — вход и верификация (floor 0); not a directorate chief. */
const GATE_UNIT = 0;

// floor → { name (ru), slug, chief role title }. Taken verbatim in meaning from
// FLOOR_CHARTERS.md so the orchestrator and the HQ speak the same vocabulary.
const DIRECTORATES = Object.freeze({
  27: { name: "AM7", slug: "am7", role: "orchestrator" },
  26: { name: "Внутренняя СБ", slug: "security", role: "chief" },
  25: { name: "ССО", slug: "special-ops", role: "chief" },
  24: { name: "Хакинг", slug: "offense", role: "chief" },
  23: { name: "Кибербез/ИБ", slug: "defense", role: "chief" },
  22: { name: "OSINT/разведка", slug: "osint", role: "chief" },
  21: { name: "Контрразведка", slug: "counterintel", role: "chief" },
  20: { name: "Инфра/OPSEC", slug: "infra", role: "chief" },
  19: { name: "ИИ", slug: "ai-core", role: "chief" },
  18: { name: "R&D", slug: "rnd", role: "chief" },
  17: { name: "Аналитика/прогноз", slug: "analytics", role: "chief" },
  16: { name: "Сценарии", slug: "scenarios", role: "chief" },
  15: { name: "Геополитика", slug: "geopolitics", role: "chief" },
  14: { name: "Разработка/архитектура", slug: "engineering", role: "chief" },
  13: { name: "Запуск", slug: "launch", role: "chief" },
  12: { name: "Бизнес/стратегия", slug: "strategy", role: "chief" },
  11: { name: "Инвестиции", slug: "investments", role: "chief" },
  10: { name: "Крипто/трейд", slug: "crypto", role: "chief" },
  9: { name: "Финансы", slug: "finance", role: "chief" },
  8: { name: "Юриспруденция", slug: "legal", role: "chief" },
  7: { name: "Ресурсы/логистика", slug: "resources", role: "chief" },
  6: { name: "Влияние/информация", slug: "influence", role: "chief" },
  5: { name: "Репутация", slug: "reputation", role: "chief" },
  4: { name: "Маркетинг", slug: "marketing", role: "chief" },
  3: { name: "Соцсети", slug: "social", role: "chief" },
  2: { name: "Коммуникации/переговоры", slug: "comms", role: "chief" },
  1: { name: "Биомедицина", slug: "biomed", role: "chief" },
  0: { name: "The Gate", slug: "gate", role: "gateway" },
});

/** The 26 directorate chiefs (floors 1..26) — AM7 (27) and the Gate (0) excluded. */
const DIRECTORATE_UNITS = Object.freeze(
  Object.keys(DIRECTORATES)
    .map(Number)
    .filter((floor) => floor >= 1 && floor <= 26)
    .sort((a, b) => b - a),
);

/** Coerce a floor-number-ish input to a known unit, or null (default-deny on routing). */
const toUnit = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  return Object.prototype.hasOwnProperty.call(DIRECTORATES, n) ? n : null;
};

const isUnit = (value) => toUnit(value) !== null;

/** Human label for a unit, for audit detail and routing-trail readability. */
const unitLabel = (value) => {
  const unit = toUnit(value);
  return unit === null ? `unit:${value}` : `${unit} ${DIRECTORATES[unit].name}`;
};

module.exports = {
  AM7_UNIT,
  REVIEW_UNIT,
  SECURITY_UNIT,
  GATE_UNIT,
  DIRECTORATES,
  DIRECTORATE_UNITS,
  toUnit,
  isUnit,
  unitLabel,
};
