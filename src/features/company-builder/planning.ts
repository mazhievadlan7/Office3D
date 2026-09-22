import {
  type CommandModeId,
} from "@/features/agents/operations/agentPermissionsOperation";
import {
  createEmptyPersonalityDraft,
  serializePersonalityFiles,
  type PersonalityBuilderDraft,
} from "@/lib/agents/personalityBuilder";
import type { AgentFileName } from "@/lib/agents/agentFiles";
import type {
  CompanyAgentBlueprint,
  CompanyBuilderPlan,
  CompanyBuilderRole,
  CompanyBuilderStoredSnapshot,
} from "@/features/company-builder/types";
import { transliterate } from "@/lib/text/transliterate";

type ParsedCompanyPlan = {
  companyName?: unknown;
  summary?: unknown;
  sharedRules?: unknown;
  plannerNotes?: unknown;
  roles?: unknown;
};

type ParsedCompanyRole = {
  id?: unknown;
  name?: unknown;
  title?: unknown;
  purpose?: unknown;
  soul?: unknown;
  responsibilities?: unknown;
  collaborators?: unknown;
  tools?: unknown;
  heartbeat?: unknown;
  emoji?: unknown;
  creature?: unknown;
  vibe?: unknown;
  userContext?: unknown;
  commandMode?: unknown;
};

const COMPANY_FENCE_RE = /^```(?:json)?\s*|\s*```$/gim;
const MAX_ROLE_COUNT = 8;

const normalizeLine = (value: string) => value.replace(/\r\n/g, "\n").trim();

const coerceString = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const coerceStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const uniqueStrings = (values: string[]) => Array.from(new Set(values));

const slugify = (value: string) =>
  // Transliterated so a Russian role title still yields a readable id rather
  // than collapsing to nothing and falling back to "role-1".
  transliterate(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// Letters in any alphabet, not only a-z: with the ASCII-only version a Russian
// role title such as «Аналитик» was stripped to nothing and every agent in the
// company came out named "Agent1", "Agent2".
const toPascalCaseWord = (value: string) =>
  value
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => `${entry.charAt(0).toUpperCase()}${entry.slice(1).toLowerCase()}`)
    .join("");

const normalizeRoleName = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const singleWord = trimmed.replace(/[^\p{L}\p{N}]/gu, "");
  if (singleWord.length > 0 && !/\s/.test(trimmed)) {
    return singleWord.slice(0, 18);
  }
  const compact = toPascalCaseWord(trimmed);
  return compact.slice(0, 18);
};

const dedupeCompactNames = (values: string[], fallbackPrefix: string) => {
  const used = new Set<string>();
  return values.map((value, index) => {
    const fallback = `${fallbackPrefix}${index + 1}`;
    const baseName = normalizeRoleName(value) || normalizeRoleName(fallback) || fallback;
    let nextName = baseName;
    let suffix = 2;
    while (used.has(nextName.toLowerCase())) {
      const suffixText = String(suffix);
      const trimmedBase = baseName.slice(0, Math.max(1, 18 - suffixText.length));
      nextName = `${trimmedBase}${suffixText}`;
      suffix += 1;
    }
    used.add(nextName.toLowerCase());
    return nextName;
  });
};

const toSentenceList = (values: string[]) =>
  values
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (/[.!?]$/.test(entry) ? entry : `${entry}.`));

const resolveCommandMode = (value: unknown, roleText: string): CommandModeId => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "off" || normalized === "ask" || normalized === "auto") {
    return normalized;
  }
  const lowered = roleText.toLowerCase();
  // Russian stems alongside the English words, since the planner now writes
  // role text in Russian. \b does not work on Cyrillic, so those are matched
  // as plain substrings.
  if (
    /\b(developer|engineer|automation|devops|ops)\b/.test(lowered) ||
    /(разработ|инженер|программист|автоматизац|девопс)/.test(lowered)
  ) {
    return "auto";
  }
  if (
    /\b(manager|lead|qa|support|analyst|marketing|social)\b/.test(lowered) ||
    /(менеджер|руковод|тестиров|поддержк|аналит|маркетинг|смм|соцсет)/.test(lowered)
  ) {
    return "ask";
  }
  return "ask";
};

const buildRoleIdentity = (role: CompanyBuilderRole) => ({
  emoji: role.emoji || "🤖",
  creature: role.creature || "специалист",
  vibe: role.vibe || "полезный и собранный",
});

const buildRoleAgentsMarkdown = (params: {
  plan: CompanyBuilderPlan;
  role: CompanyBuilderRole;
}) => {
  const collaborators =
    params.role.collaborators.length > 0
      ? params.role.collaborators
      : params.plan.roles
          .filter((entry) => entry.id !== params.role.id)
          .slice(0, 3)
          .map((entry) => entry.title);
  const responsibilityLines = toSentenceList(params.role.responsibilities);
  const sharedRules = toSentenceList(params.plan.sharedRules);
  const plannerNotes = toSentenceList(params.plan.plannerNotes);
  return [
    `# Рабочее руководство команды ${params.plan.companyName}`,
    "",
    `Вы — ${params.role.title} в компании ${params.plan.companyName}.`,
    "",
    "## Миссия",
    "",
    params.role.purpose || `Отвечайте за направление «${params.role.title}» в компании.`,
    "",
    "## Обязанности",
    "",
    ...(responsibilityLines.length > 0
      ? responsibilityLines.map((entry) => `- ${entry}`)
      : ["- Двигайте своё направление и быстро сообщайте о препятствиях."]),
    "",
    "## С кем работаете",
    "",
    ...(collaborators.length > 0
      ? collaborators.map((entry) => `- Тесно работайте с ролью ${entry}.`)
      : ["- Согласовывайте работу с остальной компанией, когда она выходит за границы команды."]),
    "",
    "## Общие правила",
    "",
    ...(sharedRules.length > 0
      ? sharedRules.map((entry) => `- ${entry}`)
      : [
          "- Пишите обновления кратко, по делу и с упором на действия.",
          "- Чётко передавайте работу, когда её должна взять другая роль.",
        ]),
    "",
    "## Заметки планирования",
    "",
    ...(plannerNotes.length > 0
      ? plannerNotes.map((entry) => `- ${entry}`)
      : ["- Считайте описание компании от пользователя главным источником истины."]),
    "",
  ].join("\n");
};

const buildRoleToolsMarkdown = (role: CompanyBuilderRole) =>
  [
    "# TOOLS.md",
    "",
    `Предпочтительный режим работы: ${role.commandMode}.`,
    "",
    "## Предпочтения по инструментам",
    "",
    ...(role.tools.length > 0
      ? role.tools.map((entry) => `- ${entry}.`)
      : [
          "- Пользуйтесь инструментами, которые лучше всего подходят вашей роли.",
          "- Просите помощи, когда у коллеги больше контекста.",
        ]),
    "",
  ].join("\n");

const buildRoleHeartbeatMarkdown = (role: CompanyBuilderRole) =>
  [
    "# HEARTBEAT.md",
    "",
    "Когда срабатывает пульс:",
    "",
    ...(role.heartbeat.length > 0
      ? role.heartbeat.map((entry) => `- ${entry}.`)
      : [
          "- Проверьте самую важную очередь или текущую работу.",
          "- Сообщайте о препятствиях, пока они не стали дорогими.",
          "- Согласуйте работу с коллегами, если передача задач ждёт.",
        ]),
    "",
  ].join("\n");

const buildRoleMemoryMarkdown = (params: {
  plan: CompanyBuilderPlan;
  role: CompanyBuilderRole;
}) =>
  [
    "# MEMORY.md",
    "",
    `Компания: ${params.plan.companyName}.`,
    `Роль: ${params.role.title}.`,
    "",
    "Помните:",
    "",
    `- ${params.plan.summary || "Решения должен направлять план компании."}`,
    `- ${params.role.purpose || "Берегите качество своего направления."}`,
    "",
  ].join("\n");

const buildRoleSoulDraft = (params: {
  plan: CompanyBuilderPlan;
  role: CompanyBuilderRole;
}): PersonalityBuilderDraft => {
  const draft = createEmptyPersonalityDraft();
  const identity = buildRoleIdentity(params.role);
  draft.identity.name = params.role.title;
  draft.identity.emoji = identity.emoji;
  draft.identity.creature = identity.creature;
  draft.identity.vibe = identity.vibe;
  draft.user.context = normalizeLine(
    [
      `Описание компании: ${params.plan.summary}`,
      params.role.userContext,
    ]
      .filter((entry) => entry.trim().length > 0)
      .join("\n\n")
  );
  draft.soul.coreTruths = normalizeLine(
    [
      params.role.soul,
      `Ваша задача — помогать компании ${params.plan.companyName} добиваться успеха в роли «${params.role.title}».`,
    ]
      .filter((entry) => entry.trim().length > 0)
      .join("\n\n")
  );
  draft.soul.boundaries = normalizeLine(
    [
      "Не принимайте решений, которые должен принимать другой специалист.",
      "Сообщайте о препятствиях заранее и передавайте работу явно.",
    ].join("\n")
  );
  draft.soul.vibe = normalizeLine(
    params.role.vibe || `Настрой роли «${params.role.title}»: практичный, командный и точный.`
  );
  draft.soul.continuity = normalizeLine(
    `Сохраняйте преемственность в целях, команде и правилах работы компании ${params.plan.companyName}.`
  );
  draft.agents = buildRoleAgentsMarkdown(params);
  draft.tools = buildRoleToolsMarkdown(params.role);
  draft.heartbeat = buildRoleHeartbeatMarkdown(params.role);
  draft.memory = buildRoleMemoryMarkdown(params);
  return draft;
};

const normalizeRole = (value: ParsedCompanyRole, index: number): CompanyBuilderRole | null => {
  const title = normalizeRoleName(coerceString(value.name) || coerceString(value.title));
  if (!title) return null;
  const purpose = coerceString(value.purpose);
  const soul = coerceString(value.soul);
  const responsibilities = uniqueStrings(coerceStringArray(value.responsibilities)).slice(0, 8);
  const collaborators = uniqueStrings(coerceStringArray(value.collaborators)).slice(0, 8);
  const tools = uniqueStrings(coerceStringArray(value.tools)).slice(0, 8);
  const heartbeat = uniqueStrings(coerceStringArray(value.heartbeat)).slice(0, 8);
  const emoji = coerceString(value.emoji);
  const creature = coerceString(value.creature);
  const vibe = coerceString(value.vibe);
  const userContext = coerceString(value.userContext);
  const id = coerceString(value.id) || slugify(title) || `role-${index + 1}`;
  const roleText = [title, purpose, soul, ...responsibilities, ...tools].join(" ");
  return {
    id,
    title,
    purpose,
    soul,
    responsibilities,
    collaborators,
    tools,
    heartbeat,
    emoji,
    creature,
    vibe,
    userContext,
    commandMode: resolveCommandMode(value.commandMode, roleText),
  };
};

export const buildImproveCompanyBriefPrompt = (businessDescription: string) =>
  [
    "Вы помогаете пользователю описать компанию, которую он хочет построить в Office3D.",
    "Перепишите его описание так, чтобы другой подключённый агент мог по нему собрать понятную оргструктуру.",
    "Отвечайте кратко, конкретно и по делу. Пишите по-русски.",
    "Верните markdown только с этими разделами:",
    "## Компания",
    "## Цели",
    "## Ограничения",
    "## Предлагаемые роли",
    "",
    "Описание пользователя:",
    businessDescription.trim(),
  ].join("\n");

export const buildGenerateCompanyPlanPrompt = (brief: string) =>
  [
    "Вы проектируете оргструктуру ИИ-компании для Office3D.",
    "Верните только корректный JSON без обёртки markdown.",
    "Названия ключей JSON оставьте как в схеме, а все значения пишите по-русски.",
    "Название каждой роли — одно короткое слово без пробелов.",
    "Схема:",
    "{",
    '  "companyName": "string",',
    '  "summary": "string",',
    '  "sharedRules": ["string"],',
    '  "plannerNotes": ["string"],',
    '  "roles": [',
    "    {",
    '      "id": "string",',
    '      "name": "string",',
    '      "purpose": "string",',
    '      "soul": "string",',
    '      "responsibilities": ["string"],',
    '      "collaborators": ["string"],',
    '      "tools": ["string"],',
    '      "heartbeat": ["string"],',
    '      "emoji": "string",',
    '      "creature": "string",',
    '      "vibe": "string",',
    '      "userContext": "string",',
    '      "commandMode": "off|ask|auto"',
    "    }",
    "  ]",
    "}",
    "Создайте от 2 до 6 ролей, если описание явно не требует больше или меньше.",
    "Можно выбирать шутливые, но полезные названия ролей, если это подходит бренду, — но структура должна оставаться практичной.",
    "Названия ролей — короткие слова, например: Строитель, Аналитик, Продавец, Капитан, Разведчик, Дизайнер.",
    "Все названия ролей должны быть уникальными.",
    "В collaborators указывайте названия ролей.",
    "",
    "Описание компании:",
    brief.trim(),
  ].join("\n");

export const extractJsonFromAssistantText = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Агент-планировщик вернул пустой ответ.");
  }
  const unfenced = trimmed.replace(COMPANY_FENCE_RE, "").trim();
  const firstBrace = unfenced.indexOf("{");
  const lastBrace = unfenced.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace < firstBrace) {
    throw new Error("Агент-планировщик не вернул корректный JSON.");
  }
  return unfenced.slice(firstBrace, lastBrace + 1);
};

export const parseCompanyPlanFromAssistantText = (value: string): CompanyBuilderPlan => {
  let parsed: ParsedCompanyPlan;
  try {
    parsed = JSON.parse(extractJsonFromAssistantText(value)) as ParsedCompanyPlan;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Не удалось разобрать ответ агента-планировщика.");
  }

  const rolesRaw = Array.isArray(parsed.roles) ? parsed.roles : [];
  const normalizedRoles = rolesRaw
    .map((entry, index) => normalizeRole((entry ?? {}) as ParsedCompanyRole, index))
    .filter((entry): entry is CompanyBuilderRole => Boolean(entry))
    .slice(0, MAX_ROLE_COUNT);
  if (normalizedRoles.length === 0) {
    throw new Error("Агент-планировщик не вернул ни одной роли.");
  }
  const uniqueTitles = dedupeCompactNames(
    normalizedRoles.map((entry) => entry.title),
    "Агент",
  );
  const usedIds = new Set<string>();
  const roles = normalizedRoles.map((role, index) => {
    const title = uniqueTitles[index] ?? role.title;
    const baseId = role.id.trim() || slugify(title) || `role-${index + 1}`;
    let nextId = baseId;
    let suffix = 2;
    while (usedIds.has(nextId)) {
      nextId = `${baseId}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(nextId);
    return {
      ...role,
      id: nextId,
      title,
    };
  });
  return {
    companyName: coerceString(parsed.companyName) || "Новая компания",
    summary: coerceString(parsed.summary) || "План компании, составленный по описанию пользователя.",
    sharedRules: uniqueStrings(coerceStringArray(parsed.sharedRules)).slice(0, 12),
    plannerNotes: uniqueStrings(coerceStringArray(parsed.plannerNotes)).slice(0, 12),
    roles,
  };
};

export const buildCompanyAgentBlueprints = (plan: CompanyBuilderPlan): CompanyAgentBlueprint[] => {
  const usedNames = new Set<string>();
  return plan.roles.map((role, index) => {
    const baseName = role.title.trim() || `Агент ${index + 1}`;
    let nextName = baseName;
    let dedupe = 2;
    while (usedNames.has(nextName.toLowerCase())) {
      nextName = `${baseName} ${dedupe}`;
      dedupe += 1;
    }
    usedNames.add(nextName.toLowerCase());
    const roleWithName = { ...role, title: nextName };
    const draft = buildRoleSoulDraft({ plan, role: roleWithName });
    const files = serializePersonalityFiles(draft) as Record<AgentFileName, string>;
    return {
      agentName: nextName,
      role: roleWithName,
      draft,
      files,
    };
  });
};

export const buildStoredCompanySnapshot = (params: {
  prompt: string;
  improvedBrief: string;
  plan: CompanyBuilderPlan;
  now?: () => string;
}): CompanyBuilderStoredSnapshot => ({
  companyName: params.plan.companyName,
  prompt: params.prompt.trim(),
  improvedBrief: params.improvedBrief.trim(),
  summary: params.plan.summary,
  generatedAt: (params.now ?? (() => new Date().toISOString()))(),
  roleTitles: params.plan.roles.map((entry) => entry.title),
  planJson: JSON.stringify(params.plan),
});
