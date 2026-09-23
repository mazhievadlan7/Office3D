// The office task board on top of Hermes' kanban.
//
// Hermes' board (plugins/kanban, reached through the dashboard) is the source
// of truth: its dispatcher starts the assigned agent, watches it, retries a
// crashed run and keeps the history. The office board is a view and a remote
// control of it, so tasks.list answers `authoritative: true` and the office
// sends every edit here instead of keeping its own copy.
//
// Statuses differ between the two:
//   Hermes  triage · todo · ready · running · blocked · review · done · archived
//   office  todo · in_progress · blocked · review · done   (+ archived flag)

const DEFAULT_PROFILE = "default";
const MAIN_AGENT_ID = "main";

const str = (value) => (typeof value === "string" ? value.trim() : "");
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const iso = (seconds) =>
  typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;

const OFFICE_STATUS = {
  triage: "todo",
  todo: "todo",
  ready: "todo",
  running: "in_progress",
  blocked: "blocked",
  review: "review",
  done: "done",
  archived: "done",
};

/**
 * What an office status asks of Hermes. "In progress" from a person means
 * "start it": the dispatcher, not a person, moves a card to running.
 */
const hermesStatusFor = (officeStatus, { assigned }) => {
  switch (officeStatus) {
    case "todo":
      return assigned ? "ready" : "triage";
    case "in_progress":
      return "ready";
    case "blocked":
      return "blocked";
    case "review":
      return "review";
    case "done":
      return "done";
    default:
      return null;
  }
};

const agentIdOfProfile = (profile) => (profile === DEFAULT_PROFILE ? MAIN_AGENT_ID : profile);
const profileOfAgent = (agentId) => (agentId === MAIN_AGENT_ID ? DEFAULT_PROFILE : agentId);

/** A Hermes kanban task as the office's GatewayTaskRecord. */
const taskToRecord = (task) => {
  const status = str(task.status);
  const createdAt = iso(task.created_at) ?? new Date(0).toISOString();
  const updatedAt = iso(task.completed_at) ?? iso(task.last_heartbeat_at) ?? iso(task.started_at) ?? createdAt;
  const notes = [];
  if (status === "triage") notes.push("Ждёт разбора главным агентом или руководителем.");
  if (str(task.latest_summary)) notes.push(str(task.latest_summary));
  if (str(task.last_failure_error)) notes.push(`Ошибка: ${str(task.last_failure_error)}`);
  return {
    id: str(task.id),
    title: str(task.title) || "(без названия)",
    description: typeof task.body === "string" ? task.body : "",
    status: OFFICE_STATUS[status] ?? "todo",
    source: "openclaw_event",
    sourceEventId: str(task.id),
    assignedAgentId: task.assignee ? agentIdOfProfile(str(task.assignee)) : null,
    createdAt,
    updatedAt,
    lastActivityAt: updatedAt,
    notes,
    archived: status === "archived",
    hermes: {
      status,
      createdBy: str(task.created_by) || null,
      priority: typeof task.priority === "number" ? task.priority : 0,
    },
  };
};

/**
 * @param {object} deps
 * @param {any} deps.client
 * @param {() => boolean} deps.hasDashboard
 * @param {new (code: string, message: string) => Error} deps.AdapterError
 * @param {(event: string, payload: object) => void} [deps.onTaskCreated]  after a person creates a task
 */
const createKanbanHandlers = ({ client, hasDashboard, AdapterError, onTaskCreated }) => {
  const requireDashboard = () => {
    if (!hasDashboard()) throw new AdapterError("NOT_IMPLEMENTED", "Доска задач доступна при подключённой панели Hermes (not implemented).");
  };

  const readBoard = async (includeArchived) => {
    const board = await client.kanban("/board", { query: { include_archived: includeArchived ? "true" : undefined } });
    const tasks = [];
    for (const column of Array.isArray(board?.columns) ? board.columns : []) {
      for (const task of Array.isArray(column?.tasks) ? column.tasks : []) {
        if (isRecord(task) && task.id) tasks.push(task);
      }
    }
    return tasks;
  };

  // The dispatcher also picks ready work up on its own tick (60 s by
  // default); nudging it right after a person hands out work starts the agent
  // at once. Best effort: the tick still runs if the nudge fails.
  const nudgeDispatcher = () => {
    client.kanban("/dispatch", { method: "POST", query: { max: 8 } }).catch(() => {});
  };

  const getTask = async (id) => {
    const result = await client.kanban(`/tasks/${encodeURIComponent(id)}`);
    if (!isRecord(result?.task)) throw new AdapterError("NOT_FOUND", "Задача не найдена.");
    return result.task;
  };

  return {
    readBoard,

    async "tasks.list"(p) {
      requireDashboard();
      const tasks = await readBoard(p.includeArchived !== false);
      return { tasks: tasks.map(taskToRecord), authoritative: true };
    },

    async "tasks.create"(p) {
      requireDashboard();
      const title = str(p.title);
      if (!title) throw new AdapterError("INVALID_REQUEST", "У задачи нет названия.");
      const assignee = str(p.assignedAgentId) ? profileOfAgent(str(p.assignedAgentId)) : null;
      const body = { title, body: typeof p.description === "string" ? p.description : undefined };
      if (assignee) body.assignee = assignee;
      // Without an assignee the task waits in triage for the main agent (or a
      // person) to decide who takes it, instead of an automatic decomposer.
      else body.triage = true;
      const created = await client.kanban("/tasks", { method: "POST", body });
      const task = isRecord(created?.task) ? created.task : null;
      if (!task) throw new AdapterError("UNAVAILABLE", "Hermes не вернул созданную задачу.");
      const record = taskToRecord(task);
      if (task.status === "ready") nudgeDispatcher();
      try {
        onTaskCreated?.(record);
      } catch {
        // A notification hook must never undo the create.
      }
      return record;
    },

    async "tasks.update"(p) {
      requireDashboard();
      const id = str(p.id);
      if (!id) throw new AdapterError("INVALID_REQUEST", "Нет идентификатора задачи.");
      const current = await getTask(id);
      const patch = {};
      if (typeof p.title === "string" && p.title.trim()) patch.title = p.title.trim();
      if (typeof p.description === "string") patch.body = p.description;
      let assigned = Boolean(current.assignee);
      if (p.assignedAgentId !== undefined) {
        patch.assignee = p.assignedAgentId ? profileOfAgent(str(p.assignedAgentId)) : "";
        assigned = Boolean(p.assignedAgentId);
      }
      if (p.archived === true) patch.status = "archived";
      else if (typeof p.status === "string") {
        const next = hermesStatusFor(p.status, { assigned });
        if (next && next !== current.status) patch.status = next;
      } else if (patch.assignee && current.status === "triage") {
        // Giving a task in triage an assignee is the decision to do it.
        patch.status = "ready";
      }
      if (Object.keys(patch).length === 0) return taskToRecord(current);
      const updated = await client.kanban(`/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
      const task = isRecord(updated?.task) ? updated.task : current;
      if (task.status === "ready") nudgeDispatcher();
      return taskToRecord(task);
    },

    async "tasks.delete"(p) {
      requireDashboard();
      const id = str(p.id);
      if (!id) throw new AdapterError("INVALID_REQUEST", "Нет идентификатора задачи.");
      await client.kanban(`/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
      return { ok: true, removed: true };
    },

    /** Adds a comment to a task's thread (visible to the agent working it). */
    async "tasks.comment"(p) {
      requireDashboard();
      const id = str(p.id);
      const text = str(p.text);
      if (!id || !text) throw new AdapterError("INVALID_REQUEST", "Нужны задача и текст.");
      await client.kanban(`/tasks/${encodeURIComponent(id)}/comments`, { method: "POST", body: { body: text, author: "руководитель" } });
      return { ok: true };
    },
  };
};

module.exports = { createKanbanHandlers, taskToRecord, hermesStatusFor };
