// The team: who works in the office, and changes to it that wait for the
// person's decision.
//
// Only the main agent and the person change the team. The person does it
// directly in the office; the main agent proposes — with a reason — and the
// person approves or rejects on a card in the office. An approved proposal is
// carried out by Office3D itself (the same hire and dismissal the office's own
// buttons use), and the main agent hears the decision in its office chat so it
// can act on it: brief the new hire, hand their tasks to someone else.
//
// The tools reach the agents over Office3D's MCP server (see mcp.js). The main
// agent gets the team tools; everyone else sees the team, read-only.

const crypto = require("node:crypto");

const DEFAULT_PROFILE = "default";
const MAIN_AGENT_ID = "main";
const MAX_PENDING = 10;
const MAX_KEPT = 100;
const NAME_MAX = 60;
const ROLE_MAX = 300;
const REASON_MAX = 2_000;
const INSTRUCTIONS_MAX = 8_000;
const NOTE_MAX = 1_000;

const str = (value) => (typeof value === "string" ? value.trim() : "");
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** A proposal as the office and the tools show it. */
const publicProposal = (p) => ({
  id: p.id,
  kind: p.kind,
  status: p.status,
  reason: p.reason,
  requestedBy: p.requestedBy,
  createdAt: p.createdAt,
  decidedAt: p.decidedAt ?? null,
  note: p.note ?? null,
  error: p.error ?? null,
  name: p.name ?? null,
  role: p.role ?? null,
  instructions: p.instructions ?? null,
  agentId: p.agentId ?? null,
});

/**
 * @param {object} deps
 * @param {any} deps.store
 * @param {(opts?: {fresh?: boolean}) => Promise<Array<{name: string}>>} deps.listProfiles
 * @param {(profile: object) => {id: string, name: string, role?: string}} deps.describeAgent
 * @param {(params: {name: string, role?: string, instructions?: string}) => Promise<{agentId: string, name: string}>} deps.hire
 * @param {(agentId: string) => Promise<void>} deps.dismiss
 * @param {(message: string, key: string) => Promise<void>} deps.notifyMain
 * @param {() => boolean} deps.hasDashboard
 * @param {new (code: string, message: string) => Error} deps.AdapterError
 * @param {(event: string, payload: object) => void} deps.broadcast
 * @param {(message: string) => void} [deps.log]
 * @param {(message: string, error?: unknown) => void} [deps.logError]
 */
const createTeam = ({
  store,
  listProfiles,
  describeAgent,
  hire,
  dismiss,
  notifyMain,
  hasDashboard,
  AdapterError,
  broadcast,
  log = () => {},
  logError = () => {},
}) => {
  const proposals = () => {
    const list = store.getOrganization().proposals;
    return Array.isArray(list) ? list.filter(isRecord) : [];
  };

  const save = async (list) => {
    // Keep every pending proposal and the most recent decisions.
    const pending = list.filter((p) => p.status === "pending" || p.status === "executing");
    const decided = list
      .filter((p) => p.status !== "pending" && p.status !== "executing")
      .sort((a, b) => String(b.decidedAt ?? b.createdAt).localeCompare(String(a.decidedAt ?? a.createdAt)))
      .slice(0, MAX_KEPT);
    await store.updateOrganization({ proposals: [...pending, ...decided] });
  };

  const update = async (id, patch) => {
    const list = proposals();
    const index = list.findIndex((p) => p.id === id);
    if (index === -1) return null;
    list[index] = { ...list[index], ...patch };
    await save(list);
    broadcast("org.proposal", { proposal: publicProposal(list[index]) });
    return list[index];
  };

  const team = async () => {
    const profiles = await listProfiles();
    return profiles.map((profile) => {
      const agent = describeAgent(profile);
      return {
        agent_id: agent.id,
        name: agent.name,
        role: agent.role || null,
        main: profile.name === DEFAULT_PROFILE,
      };
    });
  };

  const propose = async (entry) => {
    const list = proposals();
    if (list.filter((p) => p.status === "pending").length >= MAX_PENDING) {
      throw new AdapterError(
        "RATE_LIMITED",
        `Уже ${MAX_PENDING} предложений ждут решения руководителя. Дождись решения по ним, прежде чем предлагать новые.`,
      );
    }
    const proposal = {
      id: `prop_${crypto.randomBytes(6).toString("hex")}`,
      status: "pending",
      createdAt: new Date().toISOString(),
      requestedBy: MAIN_AGENT_ID,
      ...entry,
    };
    await save([...list, proposal]);
    log(`Team proposal ${proposal.id}: ${proposal.kind} ${proposal.name ?? proposal.agentId}.`);
    broadcast("org.proposal", { proposal: publicProposal(proposal) });
    return proposal;
  };

  const describeDecision = (p) => {
    const who = p.kind === "hire" ? `найм «${p.name}»` : `увольнение «${p.name ?? p.agentId}»`;
    const note = p.note ? ` Комментарий руководителя: ${p.note}` : "";
    if (p.status === "done" && p.kind === "hire") {
      return `[Office3D] Руководитель одобрил ${who}. Новый сотрудник уже в команде (agent_id: ${p.agentId}).${note} Введи его в курс дела и дай задачи на доске.`;
    }
    if (p.status === "done") {
      return `[Office3D] Руководитель одобрил ${who}; сотрудник уволен. Его незавершённые задачи вернулись на разбор — распредели их.${note}`;
    }
    if (p.status === "rejected") return `[Office3D] Руководитель отклонил ${who}.${note}`;
    return `[Office3D] Руководитель одобрил ${who}, но выполнить не удалось: ${p.error}. Предложение закрыто.`;
  };

  const decide = async ({ id, approve, note }) => {
    const current = proposals().find((p) => p.id === id);
    if (!current) throw new AdapterError("NOT_FOUND", "Предложение не найдено.");
    if (current.status !== "pending") throw new AdapterError("CONFLICT", "По этому предложению уже есть решение.");
    const decidedAt = new Date().toISOString();
    const comment = str(note).slice(0, NOTE_MAX) || null;
    if (!approve) {
      const rejected = await update(id, { status: "rejected", decidedAt, note: comment });
      notify(rejected);
      return rejected;
    }
    // Claim it before the slow part, so a second click cannot run it twice.
    await update(id, { status: "executing", decidedAt, note: comment });
    let final;
    try {
      if (current.kind === "hire") {
        const hired = await hire({ name: current.name, role: current.role, instructions: current.instructions });
        final = await update(id, { status: "done", agentId: hired.agentId });
      } else {
        await dismiss(current.agentId);
        final = await update(id, { status: "done" });
      }
    } catch (err) {
      logError(`Team proposal ${id} failed.`, err);
      final = await update(id, { status: "failed", error: err?.message || "неизвестная ошибка" });
    }
    notify(final);
    return final;
  };

  // The main agent hears every decision in its office chat. Best effort: the
  // decision stands even if the message cannot be delivered, and the main
  // agent can always look it up with office_proposals.
  const notify = (proposal) => {
    if (!proposal) return;
    notifyMain(describeDecision(proposal), `proposal-${proposal.id}-${proposal.status}`).catch((err) =>
      logError(`Could not tell the main agent about proposal ${proposal.id}.`, err),
    );
  };

  /** Proposals left mid-execution by a restart cannot be trusted as done. */
  const recover = async () => {
    const list = proposals();
    const stuck = list.filter((p) => p.status === "executing");
    if (stuck.length === 0) return;
    for (const p of stuck) {
      p.status = "failed";
      p.error = "Office3D перезапустился во время выполнения; проверьте состав команды и при необходимости повторите.";
    }
    await save(list);
  };

  // --- tools (served over MCP) ---------------------------------------------------------

  const teamListTool = {
    name: "office_team_list",
    description:
      "Список сотрудников офиса: agent_id, имя, роль и кто главный. agent_id — это же имя профиля Hermes и исполнителя на доске задач.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    handler: async () => {
      const members = await team();
      return { text: JSON.stringify({ team: members }, null, 2), data: { team: members } };
    },
  };

  const mainTools = [
    teamListTool,
    {
      name: "office_propose_hire",
      description:
        "Предложить руководителю нанять нового сотрудника. Сам найм делает Office3D после одобрения руководителя; результат придёт тебе сообщением в чат. Обязательно объясни причину: зачем этот сотрудник миссии и почему текущая команда не справится.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", maxLength: NAME_MAX, description: "Имя сотрудника, как его будут звать в офисе." },
          role: { type: "string", maxLength: ROLE_MAX, description: "Роль в одной фразе, например «аналитик рынка»." },
          reason: { type: "string", maxLength: REASON_MAX, description: "Почему он нужен — это прочитает руководитель." },
          instructions: {
            type: "string",
            maxLength: INSTRUCTIONS_MAX,
            description: "Характер и обязанности нового сотрудника (станут его SOUL.md). Необязательно.",
          },
        },
        required: ["name", "role", "reason"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const name = str(args.name);
        const duplicate = proposals().find(
          (p) => p.status === "pending" && p.kind === "hire" && str(p.name).toLowerCase() === name.toLowerCase(),
        );
        if (duplicate) {
          return { text: `Такое предложение уже ждёт решения руководителя (${duplicate.id}).`, data: { proposal: publicProposal(duplicate) } };
        }
        const proposal = await propose({
          kind: "hire",
          name,
          role: str(args.role),
          reason: str(args.reason),
          instructions: str(args.instructions) || null,
        });
        return {
          text: `Предложение ${proposal.id} отправлено руководителю и ждёт решения. Не считай сотрудника нанятым, пока не придёт ответ.`,
          data: { proposal: publicProposal(proposal) },
        };
      },
    },
    {
      name: "office_propose_dismiss",
      description:
        "Предложить руководителю уволить сотрудника. Увольняет Office3D после одобрения руководителя; незавершённые задачи сотрудника вернутся на разбор. Обязательно объясни причину.",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string", maxLength: 80, description: "agent_id сотрудника из office_team_list." },
          reason: { type: "string", maxLength: REASON_MAX, description: "Почему — это прочитает руководитель." },
        },
        required: ["agent_id", "reason"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const agentId = str(args.agent_id);
        if (agentId === MAIN_AGENT_ID || agentId === DEFAULT_PROFILE) {
          throw new AdapterError("INVALID_REQUEST", "Главного агента уволить нельзя.");
        }
        const member = (await team()).find((m) => m.agent_id === agentId);
        if (!member) throw new AdapterError("NOT_FOUND", `Сотрудника ${agentId} нет в команде; проверь office_team_list.`);
        const duplicate = proposals().find((p) => p.status === "pending" && p.kind === "dismiss" && p.agentId === agentId);
        if (duplicate) {
          return { text: `Такое предложение уже ждёт решения руководителя (${duplicate.id}).`, data: { proposal: publicProposal(duplicate) } };
        }
        const proposal = await propose({ kind: "dismiss", agentId, name: member.name, role: member.role, reason: str(args.reason) });
        return {
          text: `Предложение ${proposal.id} отправлено руководителю и ждёт решения.`,
          data: { proposal: publicProposal(proposal) },
        };
      },
    },
    {
      name: "office_proposals",
      description: "Твои предложения по команде и решения руководителя по ним, новые сначала.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["pending", "done", "rejected", "failed"], description: "Только с этим статусом." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        const list = proposals()
          .filter((p) => !args.status || p.status === args.status)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          .slice(0, 30)
          .map(publicProposal);
        return { text: JSON.stringify({ proposals: list }, null, 2), data: { proposals: list } };
      },
    },
  ];

  const memberTools = [teamListTool];

  const toolsFor = (profile) => (profile === DEFAULT_PROFILE ? mainTools : memberTools);

  // --- office methods ------------------------------------------------------------------

  const handlers = {
    async "org.proposals.list"() {
      const list = proposals()
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map(publicProposal);
      return { proposals: list };
    },

    async "org.proposals.decide"(p) {
      if (!hasDashboard()) throw new AdapterError("UNAVAILABLE", "Решения по команде доступны при подключённой панели Hermes.");
      const id = str(p.id);
      if (!id) throw new AdapterError("INVALID_REQUEST", "Нет идентификатора предложения.");
      if (typeof p.approve !== "boolean") throw new AdapterError("INVALID_REQUEST", "Нужно решение: одобрить или отклонить.");
      const result = await decide({ id, approve: p.approve, note: p.note });
      return { proposal: publicProposal(result) };
    },
  };

  return { handlers, toolsFor, recover, decide, proposals };
};

module.exports = { createTeam, publicProposal };
