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
      "- Сотрудники не ставят задачи сами: их задачи-предложения ждут в разборе (triage). Разбирай их — назначай исполнителя, объединяй или архивируй.",
      "- Запросы сотрудников на опасные действия приходят тебе («[Office3D · запрос на действие]»). Решай сам (office_decide_approval): обычные рабочие шаги одобряй, лишнее отклоняй, а важное — необратимое, деньги, удаление данных, доступы, публикации, сообщения от имени организации — передавай руководителю с объяснением.",
      "- Когда руководитель ставит задачу (текстом или голосом): уточни всё неясное, перескажи план коротко и спроси согласия. После согласия поставь задачи на доску и сообщи команде — объявлением (office_announce) или совещанием (office_call_meeting), если нужно обсудить.",
      "- Если задач нет, смотри на миссию: какой следующий шаг к ней, и ставь задачи на доску.",
    );
  } else {
    lines.push(
      "- Задачи ставят только главный агент и руководитель; ты не назначаешь работу другим. Если видишь, что нужна новая задача или новый сотрудник, создай задачу-предложение с объяснением: она не пойдёт в работу, пока её не разберёт главный агент или руководитель.",
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
 * @param {(opts?: {fresh?: boolean}) => Promise<Array<{name: string}>>} deps.listProfiles
 * @param {(profile: string) => Promise<boolean>} [deps.ensureAccess]  the profile's way into Office3D's MCP server
 * @param {(profile: {name: string}) => {name: string}} deps.describeAgent
 * @param {() => boolean} deps.hasDashboard
 * @param {new (code: string, message: string) => Error} deps.AdapterError
 * @param {(event: string, payload: object) => void} deps.broadcast
 * @param {(message: string) => void} [deps.log]
 * @param {(message: string, error?: unknown) => void} [deps.logError]
 */
const createOrganization = ({
  client,
  store,
  listProfiles,
  ensureAccess = async () => false,
  describeAgent,
  hasDashboard,
  AdapterError,
  broadcast,
  log = () => {},
  logError = () => {},
}) => {
  const mission = () => store.getOrganization().mission ?? { text: "", updatedAt: null };

  const mainName = async () => {
    const profiles = await listProfiles();
    const main = profiles.find((profile) => profile.name === DEFAULT_PROFILE);
    return main ? describeAgent(main).name : "Hermes";
  };

  const blockFor = async (profile) =>
    renderOrgBlock({ mission: mission().text, isMain: profile === DEFAULT_PROFILE, mainName: await mainName() });

  // SOUL.md is read, changed and written back from several places — a sweep,
  // a hire, the office's editor. One chain per profile keeps them from
  // overwriting each other (a sweep that read the file before a hire wrote
  // the new agent's character must not put the old text back).
  const soulChains = new Map();
  const withSoulLock = (profile, fn) => {
    const previous = soulChains.get(profile) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    const tail = next.catch(() => {});
    soulChains.set(profile, tail);
    tail.then(() => {
      if (soulChains.get(profile) === tail) soulChains.delete(profile);
    });
    return next;
  };

  /** Writes `persona` as the agent's own SOUL.md, with the organization block. */
  const writeSoul = (profile, persona) =>
    withSoulLock(profile, async () => client.setSoul(profile, applyOrgBlock(persona, await blockFor(profile))));

  /** Rewrites one profile's organization block; returns whether it changed. */
  const syncProfile = (profile) =>
    withSoulLock(profile, async () => {
      const current = await client.getSoul(profile);
      const soul = typeof current?.content === "string" ? current.content : "";
      const next = applyOrgBlock(soul, await blockFor(profile));
      if (next === soul) return false;
      await client.setSoul(profile, next);
      return true;
    });

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

  /**
   * The office's board rules in Hermes: tasks in triage wait for the main
   * agent or the person, so Hermes' own decomposer (an LLM that would split
   * and assign them on its own) stays off. Read on every dispatcher tick.
   */
  const ensureBoardPolicy = async () => {
    const current = await client.dashboard("/api/config", { query: { profile: DEFAULT_PROFILE } });
    if (current?.kanban?.auto_decompose === false) return false;
    await client.dashboard("/api/config", {
      method: "PUT",
      query: { profile: DEFAULT_PROFILE },
      body: { config: { kanban: { auto_decompose: false } } },
    });
    log("Turned Hermes' automatic triage decomposer off: the main agent sorts triage.");
    return true;
  };

  /** Everything a profile needs from the office: tool access, then its block. */
  const setUpProfile = async (profile) => {
    if (!hasDashboard()) return;
    await ensureAccess(profile);
    await syncProfile(profile);
  };

  /**
   * Startup, then a periodic sweep: every agent's Office3D tool access, its
   * organization block and the main agent's board tools, up to date.
   */
  // One pass at a time. A call made while a pass runs gets one more pass
  // after it (shared by every caller that asked meanwhile), so it still sees
  // what changed since the running pass read Hermes — and two passes never
  // both read a stale setting and both write it.
  let running = null;
  let next = null;
  const reconcile = () => {
    if (!running) {
      running = reconcileOnce().finally(() => {
        running = null;
      });
      return running;
    }
    if (!next) {
      next = running.catch(() => {}).then(() => {
        next = null;
        return reconcile();
      });
    }
    return next;
  };

  const reconcileOnce = async () => {
    if (!hasDashboard()) return;
    await ensureMainKanbanTools().catch((err) => logError("Could not enable kanban tools for the main agent.", err));
    await ensureBoardPolicy().catch((err) => logError("Could not set the board policy in Hermes.", err));
    const names = (await listProfiles({ fresh: true })).map((profile) => profile.name);
    const access = await Promise.allSettled(names.map((name) => ensureAccess(name)));
    access.forEach((result, index) => {
      if (result.status === "rejected") logError(`Office3D MCP access not set up for ${names[index]}.`, result.reason);
    });
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

  return { handlers, syncProfile, syncAll, setUpProfile, reconcile, runInstructions, writeSoul, stripOrgBlock, applyOrgBlock, blockFor };
};

module.exports = { createOrganization, renderOrgBlock, applyOrgBlock, stripOrgBlock, BLOCK_START, BLOCK_END };
