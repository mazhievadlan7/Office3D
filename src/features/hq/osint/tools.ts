/**
 * The HQ OSINT toolkit registry — the hackers' open-source-recon tools, as data.
 *
 * This is the catalogue the «РАЗВЕДКА / OSINT» view renders and the Execution
 * Plane will later bind real runners to. It lists only PASSIVE, open-source
 * tools, and every entry carries a lawful note: these tools are run only against
 * AUTHORIZED engagement targets, within scope, with no mass profiling of real
 * private individuals (TZ §0, §3.1). Nothing here executes anything — it is a
 * typed description of a tool, its inputs and the output types it yields.
 *
 * The owner's listed toolkit plus the two reference catalogues he named
 * (osintframework.com, inteltechniques.com/tools).
 */

import type { OsintInputKind, OsintProduceKind } from "./types";

/** Stable ids for every tool in the toolkit. */
export type OsintToolId =
  | "maltego"
  | "shodan"
  | "recon-ng"
  | "theharvester"
  | "spiderfoot"
  | "sherlock"
  | "holehe"
  | "tookie-osint"
  | "geocreepy"
  | "public-apis"
  | "osintframework"
  | "inteltechniques";

/** How the toolkit groups the tools in the panel. */
export type OsintToolCategory =
  /** Builds an entity ↔ relation graph (link analysis). */
  | "entity-graph"
  /** Enumerates subdomains and emails of a domain. */
  | "subdomains+emails"
  /** Finds accounts for a username / email across platforms. */
  | "usernames+accounts"
  /** Inventories hosts and the services they expose. */
  | "hosts+services"
  /** Geolocates open-data points. */
  | "geo"
  /** A reference catalogue of tools, not a tool itself. */
  | "reference";

export type OsintTool = {
  id: OsintToolId;
  name: string;
  category: OsintToolCategory;
  /** What the tool is pointed at. */
  inputKind: OsintInputKind;
  /** The output types it yields, in model terms (see types.ts). */
  produces: OsintProduceKind[];
  /** True when the tool needs an API key / paid account to be useful. */
  needsKey: boolean;
  /** The tool's home / docs. Shown as a link; never auto-fetched. */
  link: string;
  /** Short RU description. */
  descRu: string;
  /** The lawful note shown with the tool. */
  lawfulRu: string;
};

/** The HQ's lawful-use note shared by the active tools. */
const PASSIVE_NOTE =
  "Пассивная разведка по открытым источникам. Только в рамках подтверждённого scope авторизованной операции.";

export const OSINT_TOOLS: readonly OsintTool[] = [
  {
    id: "maltego",
    name: "Maltego",
    category: "entity-graph",
    inputKind: "domain",
    produces: ["graph", "relation", "domain", "email", "person-handle", "org"],
    needsKey: true,
    link: "https://www.maltego.com/",
    descRu: "Связный анализ: домены, почты, персоны и организации в один граф связей.",
    lawfulRu: PASSIVE_NOTE,
  },
  {
    id: "shodan",
    name: "Shodan",
    category: "hosts+services",
    inputKind: "ip",
    produces: ["host", "service", "geo", "finding"],
    needsKey: true,
    link: "https://www.shodan.io/",
    descRu: "Инвентаризация открытых хостов и сервисов: порты, баннеры, geo-IP.",
    lawfulRu: PASSIVE_NOTE + " Опрос — только по хостам в scope.",
  },
  {
    id: "recon-ng",
    name: "recon-ng",
    category: "entity-graph",
    inputKind: "domain",
    produces: ["graph", "relation", "subdomain", "host", "email", "finding"],
    needsKey: false,
    link: "https://github.com/lanmaster53/recon-ng",
    descRu: "Модульный фреймворк разведки: наполняет рабочий граф по домену.",
    lawfulRu: PASSIVE_NOTE,
  },
  {
    id: "theharvester",
    name: "theHarvester",
    category: "subdomains+emails",
    inputKind: "domain",
    produces: ["subdomain", "email", "host", "finding"],
    needsKey: false,
    link: "https://github.com/laramies/theHarvester",
    descRu: "Сбор поддоменов, почт и хостов домена из открытых источников.",
    lawfulRu: PASSIVE_NOTE,
  },
  {
    id: "spiderfoot",
    name: "SpiderFoot",
    category: "entity-graph",
    inputKind: "domain",
    produces: ["graph", "relation", "subdomain", "host", "email", "username", "geo", "finding"],
    needsKey: false,
    link: "https://github.com/smicallef/spiderfoot",
    descRu: "Автоматизированная OSINT-разведка: 200+ источников в единый граф.",
    lawfulRu: PASSIVE_NOTE + " Активные модули держим выключенными вне scope.",
  },
  {
    id: "sherlock",
    name: "Sherlock",
    category: "usernames+accounts",
    inputKind: "username",
    produces: ["username", "finding"],
    needsKey: false,
    link: "https://github.com/sherlock-project/sherlock",
    descRu: "Поиск аккаунтов по нику на сотнях платформ.",
    lawfulRu: PASSIVE_NOTE + " Без профилирования реальных частных лиц.",
  },
  {
    id: "holehe",
    name: "holehe",
    category: "usernames+accounts",
    inputKind: "email",
    produces: ["email", "finding"],
    needsKey: false,
    link: "https://github.com/megadose/holehe",
    descRu: "Проверка, на каких сервисах зарегистрирован email (без сброса пароля).",
    lawfulRu: PASSIVE_NOTE + " Без профилирования реальных частных лиц.",
  },
  {
    id: "tookie-osint",
    name: "Tookie-osint",
    category: "usernames+accounts",
    inputKind: "username",
    produces: ["username", "finding"],
    needsKey: false,
    link: "https://github.com/Alfredredbird/tookie-osint",
    descRu: "Расширенный поиск аккаунтов по нику с фильтрацией результатов.",
    lawfulRu: PASSIVE_NOTE + " Без профилирования реальных частных лиц.",
  },
  {
    id: "geocreepy",
    name: "geocreepy (Creepy)",
    category: "geo",
    inputKind: "username",
    produces: ["geo", "finding"],
    needsKey: false,
    link: "https://github.com/ilektrojohn/creepy",
    descRu: "Сбор геометок из открытых постов по аккаунту на карту.",
    lawfulRu: PASSIVE_NOTE + " Только авторизованные персоны/ассеты; без слежки за частными лицами.",
  },
  {
    id: "public-apis",
    name: "public-apis",
    category: "reference",
    inputKind: "none",
    produces: ["reference"],
    needsKey: false,
    link: "https://github.com/public-apis/public-apis",
    descRu: "Каталог открытых API — источники данных для обогащения находок.",
    lawfulRu: "Только открытые источники данных.",
  },
  {
    id: "osintframework",
    name: "OSINT Framework",
    category: "reference",
    inputKind: "none",
    produces: ["reference"],
    needsKey: false,
    link: "https://osintframework.com/",
    descRu: "Справочное дерево OSINT-инструментов по категориям.",
    lawfulRu: "Справочный каталог инструментов.",
  },
  {
    id: "inteltechniques",
    name: "IntelTechniques Tools",
    category: "reference",
    inputKind: "none",
    produces: ["reference"],
    needsKey: false,
    link: "https://inteltechniques.com/tools/",
    descRu: "Набор онлайн-инструментов и чек-листов OSINT (M. Bazzell).",
    lawfulRu: "Справочный каталог инструментов.",
  },
];

/** Tool lookup by id (for provenance labels in the graph and findings feed). */
export const OSINT_TOOL_BY_ID: Readonly<Record<OsintToolId, OsintTool>> = Object.fromEntries(
  OSINT_TOOLS.map((tool) => [tool.id, tool]),
) as Record<OsintToolId, OsintTool>;

/** The toolkit category order and RU labels for the panel. */
export const OSINT_CATEGORY_LABEL: Readonly<Record<OsintToolCategory, string>> = {
  "entity-graph": "Граф связей",
  "subdomains+emails": "Поддомены и почты",
  "usernames+accounts": "Аккаунты по нику/почте",
  "hosts+services": "Хосты и сервисы",
  geo: "Геолокация",
  reference: "Справочные каталоги",
};

/** The order categories are shown in the toolkit panel. */
export const OSINT_CATEGORY_ORDER: readonly OsintToolCategory[] = [
  "entity-graph",
  "subdomains+emails",
  "usernames+accounts",
  "hosts+services",
  "geo",
  "reference",
];
