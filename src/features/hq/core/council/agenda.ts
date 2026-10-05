/**
 * Floor 27 — AM7's council. The directorates (from platform/docs/FLOOR_CHARTERS.md),
 * the meeting schedule, and the pure builders that turn structured floor state
 * into a council agenda: the system announcement, the speaking order, each
 * chief's short voiced report and the screen summary shown behind AM7 while
 * they speak, AM7's reply, his closing tasks, and the append-only archive
 * record + task-board items the session produces.
 *
 * Everything here is pure (no DOM, no audio, no clock) so the council state
 * machine (./machine.ts) and the renderer can be tested without either, and so
 * the voice/announcement content is identical whether or not the gateway is up.
 *
 * Content is "voice, not text": the voiced lines are what «Система штаба», the
 * chiefs and AM7 say; the screen summary is a compact visual (metrics /
 * operations / incidents), never an essay. Numbers come from real platform
 * state when available (the aegis core / the demo gateway) and fall back to a
 * deterministic per-floor demo state so a session always has something to say.
 */

export type CouncilKind = "daily" | "evening" | "emergency" | "oneonone";

/** One directorate: the floor it occupies and what its chief owns. */
export type CouncilFloor = {
  /** Tower floor (1..26); 27 is AM7 himself and is not a chief. */
  floor: number;
  /** Directorate name, as the charter names it. */
  name: string;
  /** A short callsign for the screen header (no long text on screen). */
  callsign: string;
  /** One line: what the floor works on, for the report's «над чем работает». */
  mandate: string;
};

/**
 * The 26 chiefs, floor 26 down to floor 1, exactly as the charter's floor
 * table lists them. AM7 (floor 27) chairs the council and is not in this list.
 */
export const COUNCIL_FLOORS: readonly CouncilFloor[] = [
  { floor: 26, name: "Внутренняя СБ", callsign: "ЩИТ", mandate: "железный купол, реакция на атаки, карцер и дисциплина" },
  { floor: 25, name: "ССО", callsign: "КЛИНОК", mandate: "сложнейшие авторизованные миссии, глубокий ред-тим, эмуляция APT" },
  { floor: 24, name: "Хакинг", callsign: "ВЗЛОМ", mandate: "основной авторизованный пентест: recon, эксплуатация, web, сеть, AD, облако" },
  { floor: 23, name: "Кибербез и ИБ", callsign: "БАСТИОН", mandate: "оборона, детект-инжиниринг, SOC 24/7 и управление уязвимостями" },
  { floor: 22, name: "OSINT и разведка", callsign: "ОКО", mandate: "разведка, атрибуция, threat intel и мониторинг утечек" },
  { floor: 21, name: "Контрразведка", callsign: "ТЕНЬ", mandate: "deception, ловля инсайдеров и охрана Теневого Зеркала" },
  { floor: 20, name: "Инфраструктура и OPSEC", callsign: "ОПОРА", mandate: "суверенная инфраструктура, центр обновлений и автоскейл" },
  { floor: 19, name: "ИИ", callsign: "РАЗУМ", mandate: "агент-ядро, дообучение моделей, совет экспертов и LLM-безопасность" },
  { floor: 18, name: "R&D", callsign: "ГОРН", mandate: "новые методики в лаборатории и защитные технологии" },
  { floor: 17, name: "Аналитика и прогноз", callsign: "ПРИЗМА", mandate: "тренды и угрозы, предсказание где сломается" },
  { floor: 16, name: "Сценарии", callsign: "УЧЕНИЯ", mandate: "общеимперские манёвры и red/blue wargaming" },
  { floor: 15, name: "Геополитика", callsign: "МЕРИДИАН", mandate: "внешние риски и комплаенс по юрисдикциям" },
  { floor: 14, name: "Разработка и архитектура", callsign: "ЗОДЧИЙ", mandate: "продукты, архитектура и CI/CD security gate" },
  { floor: 13, name: "Запуск", callsign: "СТАРТ", mandate: "вывод продуктов на рынок и релизы" },
  { floor: 12, name: "Бизнес и стратегия", callsign: "КУРС", mandate: "монетизация, тарифы и юнит-экономика" },
  { floor: 11, name: "Инвестиции", callsign: "КАПИТАЛ", mandate: "инвест-анализ, due diligence и портфель" },
  { floor: 10, name: "Крипто и трейд", callsign: "ПОТОК", mandate: "крипто- и алго-трейдинг и прикладная криптография" },
  { floor: 9, name: "Финансы", callsign: "КАЗНА", mandate: "финаналитика, биллинг и риск-менеджмент" },
  { floor: 8, name: "Юриспруденция", callsign: "ЗАКОН", mandate: "договоры, авторизация и authorization letters" },
  { floor: 7, name: "Ресурсы и логистика", callsign: "ОБОЗ", mandate: "мощности, цепочка поставок и SBOM-риски" },
  { floor: 6, name: "Влияние и информация", callsign: "ГОЛОС", mandate: "коммуникационная стратегия и responsible disclosure" },
  { floor: 5, name: "Репутация", callsign: "ИМЯ", mandate: "мониторинг бренда и кризисные коммуникации" },
  { floor: 4, name: "Маркетинг", callsign: "МАЯК", mandate: "позиционирование, кампании и перформанс" },
  { floor: 3, name: "Соцсети", callsign: "ЭФИР", mandate: "каналы, контент-план и легальный таргет" },
  { floor: 2, name: "Коммуникации и переговоры", callsign: "МОСТ", mandate: "переговоры, саппорт и внутренние коммуникации" },
  { floor: 1, name: "Биомедицина", callsign: "ГЕНОМ", mandate: "ИИ для медицины и биоинформатика" },
] as const;

export const COUNCIL_CHIEF_COUNT = COUNCIL_FLOORS.length; // 26

/**
 * The schedule, in the owner's local HQ time (platform/docs/FLOOR_CHARTERS.md
 * «Кабинет AM7 и совещания»). Exposed for increment 2's real-clock scheduler;
 * increment 1 never fires on it — the council is triggered by hand.
 */
export type CouncilScheduleEntry = {
  kind: CouncilKind;
  /** Local time "HH:MM", or null for on-demand kinds. */
  at: string | null;
  label: string;
};

export const COUNCIL_SCHEDULE: readonly CouncilScheduleEntry[] = [
  { kind: "daily", at: "09:00", label: "Ежедневное совещание" },
  { kind: "evening", at: "21:00", label: "Вечернее подведение итогов" },
  { kind: "emergency", at: null, label: "Экстренное совещание" },
  { kind: "oneonone", at: null, label: "Один на один" },
] as const;

/** Live operation on a floor, for the screen's operations list. */
export type CouncilOperation = {
  /** Short name of the operation / work item. */
  label: string;
  /** Work-item status, mirrors the charter's statuses. */
  status: "в работе" | "на проверке" | "доработка" | "проверено" | "закрыто";
};

/** Findings by severity, for the screen's metrics and the report. */
export type CouncilFindings = { critical: number; high: number; medium: number; low: number };

/**
 * The structured state of one floor the report is built from. Supplied by the
 * host (from the aegis core / demo gateway) or filled by demoFloorState.
 */
export type CouncilFloorState = {
  floor: number;
  agentsTotal: number;
  agentsActive: number;
  incidents: number;
  findings: CouncilFindings;
  operations: CouncilOperation[];
};

/** Deterministic small integer in [min, max] from a string seed. */
function seededInt(seed: string, min: number, max: number): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const span = max - min + 1;
  return min + ((h >>> 0) % span);
}

const OPERATION_POOL = [
  "периметр клиента A",
  "ретест находок",
  "харденинг узла",
  "разбор инцидента",
  "сбор доказательств",
  "обновление инструментов",
  "анализ логов",
  "подготовка отчёта",
] as const;
const STATUS_POOL: CouncilOperation["status"][] = ["в работе", "на проверке", "доработка", "проверено"];

/**
 * A deterministic demo state for a floor, so a council always has something to
 * report when real data is not wired yet. Seeded by floor + kind, so the same
 * session replays identically (tests, and a stable look across reloads).
 */
export function demoFloorState(floor: number, kind: CouncilKind): CouncilFloorState {
  const key = `f${floor}:${kind}`;
  const agentsTotal = floor === 26 ? 24 : 16; // СБ has a reinforced roster
  const agentsActive = Math.min(agentsTotal, seededInt(`${key}:active`, agentsTotal - 6, agentsTotal));
  const findings: CouncilFindings = {
    critical: kind === "emergency" ? seededInt(`${key}:crit`, 1, 3) : seededInt(`${key}:crit`, 0, 1),
    high: seededInt(`${key}:high`, 0, 3),
    medium: seededInt(`${key}:med`, 1, 6),
    low: seededInt(`${key}:low`, 2, 9),
  };
  const opCount = seededInt(`${key}:ops`, 2, 3);
  const operations: CouncilOperation[] = Array.from({ length: opCount }, (_, i) => ({
    label: OPERATION_POOL[seededInt(`${key}:op${i}`, 0, OPERATION_POOL.length - 1)],
    status: STATUS_POOL[seededInt(`${key}:st${i}`, 0, STATUS_POOL.length - 1)],
  }));
  const incidents = kind === "emergency" && floor === 26 ? seededInt(`${key}:inc`, 1, 2) : seededInt(`${key}:inc`, 0, 1);
  return { floor, agentsTotal, agentsActive, incidents, findings, operations };
}

/** The compact visual the screen wall shows behind AM7 while a chief reports. */
export type CouncilScreen = {
  floor: number;
  /** Directorate name + callsign for the header. */
  title: string;
  callsign: string;
  /** Metric tiles: label + value (findings by severity, agents, incidents). */
  metrics: { label: string; value: string; accent?: boolean }[];
  /** The floor's live operations, as status chips. */
  operations: CouncilOperation[];
  /** Incident count, highlighted when non-zero. */
  incidents: number;
};

export function councilScreen(floor: CouncilFloor, state: CouncilFloorState): CouncilScreen {
  const f = state.findings;
  return {
    floor: floor.floor,
    title: floor.name,
    callsign: floor.callsign,
    metrics: [
      { label: "АГЕНТЫ", value: `${state.agentsActive}/${state.agentsTotal}` },
      { label: "КРИТ.", value: String(f.critical), accent: f.critical > 0 },
      { label: "ВЫС.", value: String(f.high) },
      { label: "СРЕД.", value: String(f.medium) },
      { label: "ИНЦИД.", value: String(state.incidents), accent: state.incidents > 0 },
    ],
    operations: state.operations,
    incidents: state.incidents,
  };
}

/** Numerals read aloud in Russian for the short reports (1..9 cover our ranges). */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/** A chief's short spoken report, built from the floor's structured state. */
export function chiefReport(floor: CouncilFloor, state: CouncilFloorState): string {
  const f = state.findings;
  const crit = f.critical > 0
    ? `${f.critical} ${plural(f.critical, "критическая находка", "критические находки", "критических находок")}, ${f.high} высокого уровня`
    : `без критических, ${f.high} ${plural(f.high, "находка высокого уровня", "находки высокого уровня", "находок высокого уровня")}`;
  const inc = state.incidents > 0
    ? `${state.incidents} ${plural(state.incidents, "инцидент", "инцидента", "инцидентов")} в работе`
    : "инцидентов нет";
  return [
    `${floor.name}, ${floor.callsign}.`,
    `Работаем над: ${floor.mandate}.`,
    `По находкам: ${crit}.`,
    `В строю ${state.agentsActive} из ${state.agentsTotal}, ${inc}.`,
  ].join(" ");
}

/** What «Система штаба» announces when a council is called (voice, no caption). */
export function councilAnnouncement(kind: CouncilKind, chiefCount: number): string {
  switch (kind) {
    case "daily":
      return "Внимание штабу. Созывается ежедневное совещание совета. Шефы управлений — к столу. Докладывает каждое управление.";
    case "evening":
      return "Внимание штабу. Вечернее подведение итогов. Шефы управлений занимают места за столом совета.";
    case "emergency":
      return "Тревога. Экстренный созыв совета. Всем шефам немедленно прибыть к столу. Докладываем по критичности.";
    case "oneonone":
      return "Закрытое совещание. Вызывается один шеф для доклада верховной сущности.";
    default:
      return `Созывается совет. ${chiefCount} шефов — к столу.`;
  }
}

/** AM7's short reply after a chief's report (acknowledges + a direction). */
export function am7Reply(floor: CouncilFloor, state: CouncilFloorState): string {
  if (state.findings.critical > 0) {
    return `Принято, ${floor.callsign}. Критические — в приоритет, ретест под аудитом, держите меня в курсе.`;
  }
  if (state.incidents > 0) {
    return `Принято, ${floor.callsign}. Инцидент — под контроль, доказательства в архив.`;
  }
  return `Принято, ${floor.callsign}. Темп держим, находки — в работу по матрице взаимодействия.`;
}

/** AM7's closing at the end of the council. */
export function am7Closing(kind: CouncilKind): string {
  if (kind === "emergency") {
    return "Совет окончен. Протокол «Кулак»: ресурсы — на критическую задачу. Решения в архив, задачи на доску. Работаем.";
  }
  return "Совет окончен. Решения зафиксированы, задачи уходят в управления и на доску. Отчёт владельцу — через меня. Работаем.";
}

/** A decision taken at the council, pushed to the task board and the archive. */
export type CouncilDecision = {
  floor: number;
  callsign: string;
  title: string;
  detail: string;
  /** True when it came from a critical finding or an incident (higher priority). */
  priority: boolean;
};

/** The decisions AM7 takes from a chief's report (0..1 per chief in increment 1). */
export function decisionsFor(floor: CouncilFloor, state: CouncilFloorState): CouncilDecision[] {
  if (state.findings.critical > 0) {
    return [{
      floor: floor.floor,
      callsign: floor.callsign,
      title: `${floor.name}: приоритет критическим находкам`,
      detail: `${state.findings.critical} крит. находок — ретест под аудитом (Кибербез/ИБ), держать AM7 в курсе.`,
      priority: true,
    }];
  }
  if (state.incidents > 0) {
    return [{
      floor: floor.floor,
      callsign: floor.callsign,
      title: `${floor.name}: взять инцидент под контроль`,
      detail: `${state.incidents} инцидент(ов) — локализация, сбор доказательств в архив.`,
      priority: true,
    }];
  }
  return [];
}
