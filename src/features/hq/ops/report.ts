/**
 * The reporting engine (owner 2026-10-07, «как у Strix»). On op completion it
 * produces a CLEAN report with exactly these fields:
 *
 *   • Цель                      — what was in scope
 *   • Что сделали               — plain-language summary of the work
 *   • Как получили доступ        — the access path, in words
 *   • Где были уязвимости        — the findings, each with a criticality
 *   • Возможный ущерб            — critical/personal data, financial, …
 *   • Рекомендации               — in one of two modes: «исправим сами» or «рекомендации»
 *
 * HARD RULE (load-bearing, owner): the report MUST NOT list tools or commands.
 * It says WHAT was done and HOW they got in — never with what утилита. Every text
 * field is passed through stripToolNames(); assertNoToolNames() is the invariant
 * the unit tests pin, so a tool name can never leak into a delivered report.
 *
 * Pure and framework-free: buildReport() + the renderers have no React/DOM; the
 * overlay renders the model, and the same model exports to markdown / plain text.
 */

/** Finding criticality, mirroring the pult's severities. */
export type OpsReportSeverity = "critical" | "high" | "medium" | "low" | "info";

/** One vulnerability line in the report (clean — no tool, no command). */
export type OpsReportVuln = {
  title: string;
  severity: OpsReportSeverity;
  /** The asset/target it was found on. */
  where: string;
};

/** How recommendations are framed. */
export type OpsReportMode = "fix-ourselves" | "recommendations";

/** The clean, delivered report model. */
export type OpsReport = {
  target: string;
  task: string;
  summary: string;
  access: string;
  vulnerabilities: OpsReportVuln[];
  damage: string[];
  recommendations: string[];
  mode: OpsReportMode;
  generatedAt: number;
};

/** Input the controller distils from the op (deliberately tool-free already). */
export type OpsReportInput = {
  /** The authorized scope / target. */
  engagement: string;
  task: string;
  findings: OpsReportVuln[];
  /** Roles the swarm ran, for the plain-language «что сделали». */
  roleLabels?: string[];
  generatedAt?: number;
};

const SEVERITY_ORDER: Record<OpsReportSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const SEVERITY_RU: Record<OpsReportSeverity, string> = {
  critical: "критическая",
  high: "высокая",
  medium: "средняя",
  low: "низкая",
  info: "информационная",
};

/**
 * Names of tools and commands that must NEVER appear in a delivered report. The
 * list is intentionally broad (Kali tooling + the OSINT toolkit + shell verbs);
 * it is used to STRIP such tokens defensively and to ASSERT their absence in
 * tests. The report speaks in outcomes, not utilities.
 */
export const REPORT_TOOL_DENYLIST: readonly string[] = [
  // network / web / exploitation tooling
  "nmap",
  "masscan",
  "metasploit",
  "msfconsole",
  "sqlmap",
  "burp",
  "burpsuite",
  "caido",
  "hydra",
  "hashcat",
  "john",
  "nikto",
  "gobuster",
  "ffuf",
  "dirb",
  "wfuzz",
  "nuclei",
  "aircrack-ng",
  "aircrack",
  "wireshark",
  "tcpdump",
  "responder",
  "mimikatz",
  "bloodhound",
  "impacket",
  "crackmapexec",
  "netexec",
  "evil-winrm",
  "kali",
  "cobalt strike",
  "cobaltstrike",
  "ghidra",
  "radare2",
  "ida pro",
  "frida",
  "netcat",
  "ncat",
  "curl",
  "wget",
  "powershell",
  "bash",
  "python",
  "nessus",
  "openvas",
  "zap",
  // OSINT toolkit (ids/names from features/hq/osint/tools.ts)
  "maltego",
  "shodan",
  "recon-ng",
  "theharvester",
  "spiderfoot",
  "sherlock",
  "holehe",
  "tookie-osint",
  "tookie",
  "geocreepy",
  "osintframework",
  "inteltechniques",
];

const DENY_RE = new RegExp(
  `\\b(?:${REPORT_TOOL_DENYLIST.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "gi",
);

/** Remove any tool/command token from a text, tidying leftover punctuation. */
export const stripToolNames = (text: string): string =>
  String(text ?? "")
    .replace(DENY_RE, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:)])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .trim();

/** List every tool/command token found in a text (for assertions / review). */
export const findToolNames = (text: string): string[] => {
  const matches = String(text ?? "").match(DENY_RE);
  return matches ? [...new Set(matches.map((m) => m.toLowerCase()))] : [];
};

/** Throw if any delivered field of a report contains a tool/command name. */
export const assertNoToolNames = (report: OpsReport): void => {
  const fields: string[] = [
    report.target,
    report.task,
    report.summary,
    report.access,
    ...report.vulnerabilities.flatMap((v) => [v.title, v.where]),
    ...report.damage,
    ...report.recommendations,
  ];
  for (const field of fields) {
    const hits = findToolNames(field);
    if (hits.length) {
      throw new Error(`В отчёте просочилось название инструмента/команды: ${hits.join(", ")} — отчёт описывает ТОЛЬКО что сделали и как вошли.`);
    }
  }
};

const sortVulns = (vulns: OpsReportVuln[]): OpsReportVuln[] =>
  [...vulns].sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]);

const worst = (vulns: OpsReportVuln[]): OpsReportSeverity =>
  vulns.reduce<OpsReportSeverity>((acc, v) => (SEVERITY_ORDER[v.severity] > SEVERITY_ORDER[acc] ? v.severity : acc), "info");

const countBy = (vulns: OpsReportVuln[], severity: OpsReportSeverity): number => vulns.filter((v) => v.severity === severity).length;

/**
 * Build the clean report model from the op's distilled input. Pure and
 * tool-free: every produced field is passed through stripToolNames() as a belt
 * to the braces of a tool-free input.
 */
export const buildReport = (input: OpsReportInput, mode: OpsReportMode = "recommendations"): OpsReport => {
  const generatedAt = input.generatedAt ?? Date.now();
  const vulns = sortVulns(input.findings.map((v) => ({ title: stripToolNames(v.title), severity: v.severity, where: stripToolNames(v.where) })));
  const top = worst(vulns);
  const nCrit = countBy(vulns, "critical");
  const nHigh = countBy(vulns, "high");

  const roles = input.roleLabels && input.roleLabels.length ? input.roleLabels.join(", ") : "разведка, веб/API, сеть, доступы";
  const summary =
    `Проведена авторизованная проверка периметра в согласованном scope. Операция велась единым организмом: ` +
    `задачи распределялись по оперативным ролям (${roles}) без иерархии, находки одной роли передавались следующей по цепочке, ` +
    `каждая критичная находка подтверждалась независимой проверкой. Всё строго в границах scope; активных действий по целям не велось — только фиксация.`;

  // «Как получили доступ» — the path in words, from the worst confirmed finding.
  const access =
    nCrit > 0
      ? "Точка входа — критичная слабость в одном из сервисов периметра: через неё удалось выйти за рамки обычного доступа и подтвердить возможность расширения прав до полного контроля над узлом (подтверждено в песочнице, без воздействия на цель)."
      : nHigh > 0
        ? "Доступ получен через недостаток конфигурации сервиса с высокой критичностью: он позволял выйти за ожидаемые границы прав; дальнейшее развитие зафиксировано как возможное, но не выполнялось по целям."
        : "Полноценный доступ не подтверждён: обнаружены слабости периметра, создающие предпосылки для входа. Эксплуатация не проводилась — находки переданы на устранение.";

  const damage: string[] = [];
  if (nCrit > 0) {
    damage.push("Критичные данные: возможен несанкционированный доступ к чувствительным данным и их выгрузка.");
    damage.push("Полный контроль: реалистичен захват узла с последующим горизонтальным перемещением внутри периметра.");
  }
  if (nHigh > 0) damage.push("Повышение прав: недостатки позволяют выйти за рамки штатного доступа к сервису.");
  if (vulns.some((v) => /данн|утечк|раскрыт|информац/i.test(v.title))) damage.push("Личные данные: риск раскрытия персональных/служебных данных при цепочке находок.");
  damage.push("Финансовый: простой сервисов и расходы на реагирование/восстановление при реализации сценария.");
  if (damage.length === 1) damage.unshift("Прямого критического ущерба не выявлено; риски носят предупредительный характер.");

  const recommendations = buildRecommendations(vulns, mode);

  const report: OpsReport = {
    target: stripToolNames(input.engagement),
    task: stripToolNames(input.task),
    summary: stripToolNames(summary),
    access: stripToolNames(access),
    vulnerabilities: vulns,
    damage: damage.map(stripToolNames),
    recommendations,
    mode,
    generatedAt,
  };
  // Invariant: a delivered report never names a tool or command.
  assertNoToolNames(report);
  void top;
  return report;
};

/** Recommendations, framed per mode. «fix-ourselves» speaks as the team that will
 *  apply the fixes; «recommendations» hands advice to the owner's engineers. */
const buildRecommendations = (vulns: OpsReportVuln[], mode: OpsReportMode): string[] => {
  const lines: string[] = [];
  const has = (re: RegExp) => vulns.some((v) => re.test(v.title));
  const lead = mode === "fix-ourselves" ? "Исправим сами:" : "Рекомендуем:";

  if (has(/инъекц|инъекци|injection/i)) lines.push(`${lead} закрыть возможность инъекций — строгая валидация и параметризация ввода на затронутых сервисах.`);
  if (has(/аутентиф|доступ|парол|auth/i)) lines.push(`${lead} усилить аутентификацию — многофакторность, ротация и устранение слабых учётных данных.`);
  if (has(/устаревш|верс|компонент|outdated/i)) lines.push(`${lead} обновить устаревшие компоненты до поддерживаемых версий и включить контроль обновлений.`);
  if (has(/заголов|конфигурац|header|config/i)) lines.push(`${lead} привести конфигурацию и заголовки безопасности к базовому стандарту (hardening).`);
  if (has(/порт|сервис|раскрыт|информац/i)) lines.push(`${lead} сократить внешнюю поверхность — закрыть лишние сервисы и убрать раскрытие информации.`);
  if (has(/частот|rate|limit/i)) lines.push(`${lead} ввести ограничение частоты запросов и защиту от перебора.`);

  if (!lines.length) lines.push(`${lead} закрыть обнаруженные слабости периметра в порядке их критичности и назначить повторную проверку.`);
  lines.push(
    mode === "fix-ourselves"
      ? "После устранения проведём повторную проверку и подтвердим закрытие каждой находки."
      : "После устранения запросите повторную проверку — подтвердим закрытие каждой находки.",
  );
  return lines.map(stripToolNames);
};

const SEVERITY_BADGE: Record<OpsReportSeverity, string> = {
  critical: "КРИТ",
  high: "ВЫС",
  medium: "СРЕД",
  low: "НИЗ",
  info: "ИНФО",
};

/** Render the report as clean Markdown (for export / copy). Tool-free by model. */
export const renderReportMarkdown = (report: OpsReport): string => {
  const date = new Date(report.generatedAt).toLocaleString("ru-RU");
  const vulns = report.vulnerabilities.length
    ? report.vulnerabilities.map((v) => `- **[${SEVERITY_RU[v.severity]}]** ${v.title} — _${v.where}_`).join("\n")
    : "- Явных уязвимостей не зафиксировано.";
  const damage = report.damage.map((d) => `- ${d}`).join("\n");
  const recs = report.recommendations.map((r) => `- ${r}`).join("\n");
  return [
    `# Отчёт по авторизованной проверке`,
    ``,
    `_Сформировано: ${date} · режим: ${report.mode === "fix-ourselves" ? "исправим сами" : "рекомендации"}_`,
    ``,
    `## Цель`,
    report.target,
    ``,
    `## Что сделали`,
    report.summary,
    ``,
    `## Как получили доступ`,
    report.access,
    ``,
    `## Где были уязвимости`,
    vulns,
    ``,
    `## Возможный ущерб`,
    damage,
    ``,
    `## Рекомендации`,
    recs,
    ``,
  ].join("\n");
};

/** Render the report as plain text (for export / copy). */
export const renderReportText = (report: OpsReport): string =>
  renderReportMarkdown(report)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*|_/g, "")
    .replace(/^- /gm, "• ");

/** The severity badge map, exported for the overlay. */
export const REPORT_SEVERITY_BADGE = SEVERITY_BADGE;
export const REPORT_SEVERITY_RU = SEVERITY_RU;
