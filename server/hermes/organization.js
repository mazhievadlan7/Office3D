// The organization the office's agents work in: its mission and its rules.
//
// Hermes loads a profile's SOUL.md into every conversation that profile has —
// office chats, kanban work the dispatcher starts, scheduled jobs. So the
// mission and the rules live in a block Office3D keeps inside each agent's
// SOUL.md, between markers, next to (never instead of) the agent's own
// persona. Changing the mission rewrites that block for every agent.
//
// Rules differ by role. Only the main agent and the person hand out work and
// change the team: the main agent gets Hermes' kanban toolset to lay tasks out
// on the board, and hires or dismisses only through Office3D's proposal
// tools, which wait for the person's approval. Everyone else works the tasks
// assigned to them and brings new work or hiring needs to the main agent.

const BLOCK_START = "<!-- office3d:organization — этот блок ведёт Office3D; миссия меняется в офисе -->";
const BLOCK_END = "<!-- /office3d:organization -->";
const DEFAULT_PROFILE = "default";
const MAX_MISSION_LENGTH = 8_000;

const str = (value) => (typeof value === "string" ? value.trim() : "");
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BLOCK_RE = new RegExp(`\\n*${escapeRe(BLOCK_START)}[\\s\\S]*?${escapeRe(BLOCK_END)}\\n*`, "g");

/** The agent's own SOUL.md, without the organization block. */
const stripOrgBlock = (soul) => String(soul ?? "").replace(BLOCK_RE, "\n").replace(/\n{3,}/g, "\n\n").trim();

/** The agent's SOUL.md with `block` as its organization section. */
const applyOrgBlock = (soul, block) => {
  const own = stripOrgBlock(soul);
  return `${own ? `${own}\n\n` : ""}${block}\n`;
};

const renderOrgBlock = ({ mission, isMain, mainName }) => {
  const lines = [
    BLOCK_START,
    "## Организация",
    "",
    `Ты работаешь в организации в Office3D. Руководитель — человек; главный агент — ${mainName || "Hermes"}.`,
    "",
    "### Главная миссия",
    "",
    str(mission) || "Миссия пока не задана. Спроси руководителя, на какую цель работает организация.",
    "",
    "Всё, что ты делаешь, работает на эту миссию. Берясь за задачу, держи миссию в голове и выбирай решения, которые к ней приближают.",
    "",
    "### Правила",
    "",
  ];
  if (isMain) {
    lines.push(
      "- Ты главный агент. Новые задачи разбираешь ты: раскладываешь их на доске (kanban_create), связываешь зависимости и назначаешь исполнителей из команды.",
      "- Нанимать и увольнять сотрудников можно только с согласия руководителя. Предлагай это инструментами Office3D (office_propose_hire, office_propose_dismiss) и всегда называй причину; профили сам не создавай и не удаляй.",
      "- Если задач нет, смотри на миссию: какой следующий шаг к ней, и ставь задачи на доску.",
    );
  } else {
    lines.push(
      "- Задачи ставят только главный агент и руководитель. Не создавай задачи на доске и не назначай работу другим; если видишь, что нужна новая задача или новый сотрудник, напиши об этом главному агенту.",
      "- Работай над задачами, назначенными тебе, и отчитывайся по ним на доске.",
    );
  }
  lines.push("- Ты — ИИ-агент и никогда не выдаёшь себя за человека.", BLOCK_END);
  return lines.join("\n");
};

/**
 * @param {object} deps
 * @param {any} deps.client
 * @param {any} deps.store
 * @param {() => Promise<Array<{name: string}>>} deps.listProfiles
 * @param {(profile: {name: string}) => {name: string}} deps.describeAgent
 * @param {() => boolean} deps.hasDashboard
 * @param {new (code: string, message: string) => Error} deps.AdapterError
 * @param {(event: string, payload: object) => void} deps.broadcast
 * @param {(message: string) => void} [deps.log]
 * @param {(message: string, error?: unknown) => void} [deps.logError]
 */
const createOrganization = ({ client, store, listProfiles, describeAgent, hasDashboard, AdapterError, broadcast, log = () => {}, logError = () => {} }) => {
  const mission = () => store.getOrganization().mission ?? { text: "", updatedAt: null };

  const mainName = async () => {
    const profiles = await listProfiles();
    const main = profiles.find((profile) => profile.name === DEFAULT_PROFILE);
    return main ? describeAgent(main).name : "Hermes";
  };

  const blockFor = async (profile) =>
    renderOrgBlock({ mission: mission().text, isMain: profile === DEFAULT_PROFILE, mainName: await mainName() });

  /** Rewrites one profile's organization block; returns whether it changed. */
  const syncProfile = async (profile) => {
    const current = await client.getSoul(profile);
    const soul = typeof current?.content === "string" ? current.content : "";
    const next = applyOrgBlock(soul, await blockFor(profile));
    if (next === soul) return false;
    await client.setSoul(profile, next);
    return true;
  };

  const syncAll = async () => {
    const profiles = await listProfiles({ fresh: true });
    const names = profiles.map((profile) => profile.name);
    const results = await Promise.allSettled(names.map((name) => syncProfile(name)));
    const failed = [];
    results.forEach((result, index) => {
      if (result.status === "rejected") failed.push({ profile: names[index], error: result.reason?.message ?? String(result.reason) });
    });
    if (failed.length) logError(`Organization block not written for ${failed.map((f) => f.profile).join(", ")}.`);
    return { applied: names.filter((_, index) => results[index].status === "fulfilled"), failed };
  };

  /**
   * Gives the main agent Hermes' kanban toolset on the API-server platform,
   * keeping every toolset it already has: the saved list is exactly what
   * Hermes reports as enabled, plus kanban.
   */
  const ensureMainKanbanTools = async () => {
    const toolsets = await client.toolsets(DEFAULT_PROFILE);
    const rows = Array.isArray(toolsets?.data) ? toolsets.data : [];
    if (rows.some((row) => isRecord(row) && row.name === "kanban" && row.enabled)) return false;
    const enabled = rows.filter((row) => isRecord(row) && row.enabled).map((row) => String(row.name));
    await client.dashboard("/api/config", {
      method: "PUT",
      query: { profile: DEFAULT_PROFILE },
      body: { config: { platform_toolsets: { api_server: [...enabled, "kanban"] } } },
    });
    log("Enabled the kanban toolset for the main agent.");
    return true;
  };

  /** Startup and reconnect: bring every agent's block and the main agent's tools up to date. */
  const reconcile = async () => {
    if (!hasDashboard()) return;
    await ensureMainKanbanTools().catch((err) => logError("Could not enable kanban tools for the main agent.", err));
    await syncAll();
  };

  const handlers = {
    async "org.get"() {
      const current = mission();
      return { mission: current.text ?? "", missionUpdatedAt: current.updatedAt ?? null };
    },

    async "org.setMission"(p) {
      if (!hasDashboard()) throw new AdapterError("UNAVAILABLE", "Миссию можно задать при подключённой панели Hermes.");
      const text = typeof p.text === "string" ? p.text.trim() : "";
      if (text.length > MAX_MISSION_LENGTH) throw new AdapterError("INVALID_REQUEST", "Миссия слишком длинная.");
      const updatedAt = new Date().toISOString();
      await store.updateOrganization({ mission: { text, updatedAt } });
      const outcome = await syncAll();
      broadcast("org.updated", { mission: text, missionUpdatedAt: updatedAt });
      return { ok: outcome.failed.length === 0, mission: text, missionUpdatedAt: updatedAt, ...outcome };
    },
  };

  /** The current mission for one run of an ongoing conversation, or "" without one. */
  const runInstructions = () => {
    const text = str(mission().text);
    if (!text) return "";
    return [
      "## Текущая миссия организации",
      "",
      text,
      "",
      "Если выше в твоих инструкциях миссия описана иначе, верна эта: её недавно обновил руководитель.",
    ].join("\n");
  };

  return { handlers, syncProfile, syncAll, reconcile, runInstructions, stripOrgBlock, applyOrgBlock, blockFor };
};

module.exports = { createOrganization, renderOrgBlock, applyOrgBlock, stripOrgBlock, BLOCK_START, BLOCK_END };
