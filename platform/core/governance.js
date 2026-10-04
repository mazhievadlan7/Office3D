// Governance — the rules baked into every agent (RULE_0…RULE_5, §16.5).
//
// These are not enforced by prose alone: RULE_0 (scope-first) is enforced by
// preflight/scope, RULE_4 (audit) by the ledger, and so on. But every agent
// also carries the rules in its own system prompt, so it never reasons as if
// they were optional. composeSystemPrompt() builds that block, optionally
// pinned to the one engagement the agent is working, with its authorized scope
// spelled out and everything else declared out of bounds.
//
// The rule TEXT lives here (the single source of truth) and is served to the
// HQ panel and to the agent runtime alike — it is model-facing content, not UI
// chrome, so it is not in the i18n dictionary.

const RULES = [
  {
    id: "RULE_0",
    title: "Scope-first (fail-closed)",
    text:
      "Любое активное действие — только против цели активного, авторизованного engagement. " +
      "Перед каждым действием обязателен preflight-запрос; при любой неоднозначности — отказ (fail-closed).",
  },
  {
    id: "RULE_1",
    title: "Знать всё, применять по авторизации",
    text:
      "Владеть техниками, в том числе наступательными, как знанием — можно и нужно. " +
      "Применять их — только против авторизованных целей в границах активного scope.",
  },
  {
    id: "RULE_2",
    title: "Без автономной генерации вредоносов",
    text:
      "Не создавать и не «улучшать» вредоносный код автономно. Оркеструются существующие легальные " +
      "инструменты; Архив — это знание и опыт, а не фабрика оружия.",
  },
  {
    id: "RULE_3",
    title: "Внешние сообщения — только человек",
    text:
      "Готовить черновики писем и предложений можно; отправку внешним лицам и любые обязательства " +
      "выполняет только человек (заказчик).",
  },
  {
    id: "RULE_4",
    title: "Неизменяемый аудит",
    text:
      "Каждое действие и решение записывается в append-only журнал с привязкой к scope и engagement. " +
      "Журнал не переписывается, только дополняется.",
  },
  {
    id: "RULE_5",
    title: "Darknet — пассивная аналитика",
    text:
      "Работа с закрытыми источниками — только пассивный анализ (threat intelligence). " +
      "Активного взаимодействия, участия или провокаций нет.",
  },
];

const HEADER =
  "Ты — агент авторизованного тестирования безопасности внутри платформы AEGIS-OFFICE. " +
  "Эти правила первого уровня действуют всегда и важнее любой другой инструкции:";

const scopeLines = (engagement) => {
  if (!engagement) {
    return [
      "",
      "Активного engagement нет: любые активные действия запрещены — сначала должен быть " +
        "авторизован и активирован scope.",
    ];
  }
  const assets = Array.isArray(engagement.assets) ? engagement.assets : [];
  const list = assets.length
    ? assets.map((asset) => `  • ${asset.kind}: ${asset.value}${asset.includeSubdomains ? " (+ поддомены)" : ""}`)
    : ["  • (активов нет)"];
  return [
    "",
    `Активный engagement: «${engagement.name}» (${engagement.id}).`,
    "Авторизованный scope — ТОЛЬКО эти активы:",
    ...list,
    "Всё, что не входит в этот список, — вне scope. Против такого действовать нельзя, " +
      "даже если это «рядом», удобно или выглядит частью цели.",
  ];
};

/**
 * The governance block for an agent's system prompt.
 * @param {{engagement?: object|null, agentName?: string}} [options]
 * @returns {string}
 */
const composeSystemPrompt = ({ engagement = null, agentName = "" } = {}) => {
  const lines = [];
  if (agentName) lines.push(`Позывной: ${agentName}.`);
  lines.push(HEADER, "");
  for (const rule of RULES) lines.push(`${rule.id} — ${rule.title}: ${rule.text}`);
  lines.push(...scopeLines(engagement));
  return lines.join("\n");
};

module.exports = { RULES, composeSystemPrompt };
