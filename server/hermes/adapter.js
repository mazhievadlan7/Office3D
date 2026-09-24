// Gateway-protocol adapter for Hermes Agent.
//
// The office speaks one WebSocket protocol to every backend (req/res frames,
// "chat" and "agent" events). This adapter answers that protocol from a
// Hermes installation through its native HTTP APIs:
//
//   office agent        → Hermes profile  ("main" is the default profile)
//   office session key  → Hermes session  (created on first use)
//   chat.send           → POST /v1/runs, then its SSE event stream
//   chat.abort          → POST /v1/runs/{id}/stop
//   exec approvals      → approval.request events, POST /v1/runs/{id}/approval
//   cron.*              → /api/jobs
//   agents.*            → the dashboard's profile API
//
// It runs inside the Office3D server. The browser never talks to it directly:
// the gateway proxy connects to it over loopback with a per-boot secret.

const crypto = require("node:crypto");
const { HermesApiError } = require("./client");
const { createProviderHandlers } = require("./providers");
const { createKanbanHandlers } = require("./kanban");
const { createTeam } = require("./team");
const { createMcpAccess } = require("./mcp-access");
const { createAutonomy } = require("./autonomy");
const { createMeetings } = require("./meetings");
const { createApprovalChain } = require("./approvals");
const { createUpdates } = require("./updates");
const { createSkillHandlers } = require("./skills");
const { createUsageHandlers } = require("./usage");
const { createCapabilityHandlers } = require("./capabilities");
const { createOrganization } = require("./organization");

const MAIN_AGENT_ID = "main";
const DEFAULT_PROFILE = "default";
const MAIN_KEY = "main";
const PROTOCOL_VERSION = 3;
// Hermes' default approvals.timeout; an unanswered request is refused then.
const APPROVAL_TIMEOUT_MS = 300_000;
// A profile created through the dashboard is served by the running gateway
// after its next rescan, which Hermes bounds at 30 s.
const PROFILE_READY_TIMEOUT_MS = 45_000;
const PROFILE_READY_POLL_MS = 1_500;
const RUN_STATUS_POLL_MS = 2_000;
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const SOUL_FILE = "SOUL.md";
// Streaming: at most one chat update per this many ms per run.
const DELTA_EMIT_MS = 50;

const METHODS = [
  "agents.list", "agents.create", "agents.update", "agents.delete",
  "agents.files.get", "agents.files.set",
  "sessions.list", "sessions.preview", "sessions.patch", "sessions.reset",
  "chat.send", "chat.abort", "chat.history", "agent.wait",
  "status", "config.get", "config.set", "config.patch",
  "exec.approvals.get", "exec.approvals.set", "exec.approval.resolve",
  "skills.status", "skills.update", "skills.install", "models.list",
  "usage.cost", "sessions.usage", "wake",
  "cron.list", "cron.add", "cron.remove", "cron.patch", "cron.run",
  "tasks.list", "tasks.create", "tasks.update", "tasks.delete", "tasks.comment",
  "org.get", "org.setMission", "org.proposals.list", "org.proposals.decide",
  "org.autonomy.get", "org.autonomy.set", "org.autonomy.pause", "org.autonomy.runNow",
  "org.meeting.start", "org.meeting.arrivals", "org.meeting.stop", "org.meeting.get", "org.meeting.list",
  "org.approvals.log",
  "hermes.update.status", "hermes.update.start", "hermes.update.later",
  "hermes.skills.list", "hermes.skills.toggle", "hermes.skills.catalog", "hermes.skills.search",
  "hermes.skills.scan", "hermes.skills.install", "hermes.skills.uninstall", "hermes.skills.action",
  "hermes.toolsets.list", "hermes.toolsets.set", "hermes.memory.get", "hermes.memory.set",
  "hermes.mcp.list", "hermes.mcp.add", "hermes.mcp.remove", "hermes.mcp.enable", "hermes.mcp.test",
  "hermes.mcp.catalog", "hermes.mcp.install", "hermes.mcp.action",
  "system.health", "system.testAlert",
  "hermes.endpoints.list", "hermes.endpoints.validate", "hermes.endpoints.save", "hermes.endpoints.activate", "hermes.endpoints.delete",
];
const EVENTS = [
  "chat", "agent", "presence", "exec.approval.requested", "exec.approval.resolved",
  "org.updated", "org.proposal", "org.autonomy", "org.meeting", "org.announcement", "org.approval",
  "hermes.update", "system.health",
];

class AdapterError extends Error {
  constructor(code, message) {
    super(message);
    // Named, so modules that only see the instance (the MCP server) can tell
    // a deliberate refusal, safe to show, from an internal failure.
    this.name = "AdapterError";
    this.code = code;
  }
}

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const str = (value) => (typeof value === "string" ? value.trim() : "");
const toMs = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? Math.round(value * 1000) : value;
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const profileOf = (agentId) => (agentId === MAIN_AGENT_ID ? DEFAULT_PROFILE : agentId);
const agentIdOf = (profile) => (profile === DEFAULT_PROFILE ? MAIN_AGENT_ID : profile);
const mainSessionKey = (agentId) => `agent:${agentId}:${MAIN_KEY}`;

const agentIdFromSessionKey = (sessionKey) => {
  const key = str(sessionKey);
  if (!key.startsWith("agent:")) return MAIN_AGENT_ID;
  const id = key.split(":")[1];
  return id || MAIN_AGENT_ID;
};

// Cyrillic → Latin, so an office name like «Аналитик» becomes a valid Hermes
// profile id ("analitik"). Hermes ids are lowercase [a-z0-9_-].
const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

const slugifyProfileName = (name) => {
  const latin = Array.from(String(name || "").toLowerCase())
    .map((ch) => (TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch))
    .join("");
  const slug = latin.replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 48);
  return slug || "agent";
};

const hashJson = (value) => crypto.createHash("sha256").update(JSON.stringify(value ?? {})).digest("hex").slice(0, 16);

/** RFC 7396 JSON merge patch. */
const mergePatch = (target, patch) => {
  if (!isRecord(patch)) return patch;
  const result = isRecord(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
};

const parseIdentity = (content) => {
  const text = String(content || "");
  const pick = (label) => {
    const match = text.match(new RegExp(`^\\s*[-*]?\\s*\\**${label}\\**\\s*:\\s*(.+)$`, "im"));
    return match ? match[1].replace(/\*+/g, "").trim() : "";
  };
  return { name: pick("name") || pick("имя"), emoji: pick("emoji") || pick("эмодзи") };
};

const defaultSoul = (name) =>
  [
    `# ${name}`,
    "",
    `Ты — ${name}, сотрудник организации в Office3D.`,
    "Отвечай на русском языке, если к тебе не обратились на другом.",
    "Ты — ИИ-агент и никогда не выдаёшь себя за человека.",
    "",
  ].join("\n");

// --- cron ↔ Hermes jobs --------------------------------------------------------

const JOB_ID_SEPARATOR = "~";
const encodeJobId = (agentId, jobId) => `${agentId}${JOB_ID_SEPARATOR}${jobId}`;
const decodeJobId = (value) => {
  const raw = str(value);
  const index = raw.indexOf(JOB_ID_SEPARATOR);
  if (index <= 0) throw new AdapterError("INVALID_REQUEST", `Неизвестная задача по расписанию: ${raw || "(пусто)"}.`);
  return { agentId: raw.slice(0, index), jobId: raw.slice(index + 1) };
};

const scheduleToHermes = (schedule) => {
  if (!isRecord(schedule)) throw new AdapterError("INVALID_REQUEST", "Не задано расписание.");
  if (schedule.kind === "at") {
    const at = toMs(schedule.at);
    if (!at) throw new AdapterError("INVALID_REQUEST", "Неверное время запуска.");
    return new Date(at).toISOString();
  }
  if (schedule.kind === "every") {
    const minutes = Math.max(1, Math.round(Number(schedule.everyMs) / 60_000));
    if (!Number.isFinite(minutes)) throw new AdapterError("INVALID_REQUEST", "Неверный интервал.");
    return `every ${minutes}m`;
  }
  if (schedule.kind === "cron") {
    const expr = str(schedule.expr);
    if (!expr) throw new AdapterError("INVALID_REQUEST", "Пустое cron-выражение.");
    return expr;
  }
  throw new AdapterError("INVALID_REQUEST", `Неизвестный вид расписания: ${schedule.kind}.`);
};

const scheduleFromHermes = (schedule, display) => {
  if (isRecord(schedule)) {
    if (schedule.kind === "once") return { kind: "at", at: String(schedule.run_at ?? "") };
    if (schedule.kind === "interval") return { kind: "every", everyMs: Number(schedule.minutes || 0) * 60_000 };
    if (schedule.kind === "cron") return { kind: "cron", expr: String(schedule.expr ?? "") };
  }
  return { kind: "cron", expr: String(display || "") };
};

const promptFromPayload = (payload) => {
  if (!isRecord(payload)) return "";
  if (payload.kind === "agentTurn") return str(payload.message);
  if (payload.kind === "systemEvent") return str(payload.text);
  return "";
};

const jobToCron = (agentId, job) => {
  const lastStatus = str(job.last_status).toLowerCase();
  return {
    id: encodeJobId(agentId, job.id),
    name: String(job.name || job.id),
    agentId,
    sessionKey: mainSessionKey(agentId),
    enabled: job.enabled !== false && job.state !== "paused",
    deleteAfterRun: isRecord(job.repeat) && job.repeat.times === 1,
    updatedAtMs: toMs(job.updated_at) ?? toMs(job.created_at) ?? Date.now(),
    schedule: scheduleFromHermes(job.schedule, job.schedule_display),
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: String(job.prompt ?? "") },
    state: {
      nextRunAtMs: toMs(job.next_run_at) ?? undefined,
      lastRunAtMs: toMs(job.last_run_at) ?? undefined,
      lastStatus: !lastStatus ? undefined : lastStatus === "ok" || lastStatus === "success" ? "ok" : lastStatus === "skipped" ? "skipped" : "error",
      lastError: job.last_error ? String(job.last_error) : undefined,
    },
  };
};

// --- message mapping -------------------------------------------------------------

const messageText = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : isRecord(part) ? String(part.text ?? "") : ""))
      .join("");
  }
  return "";
};

const historyFromHermes = (messages) =>
  (Array.isArray(messages) ? messages : [])
    .filter((m) => isRecord(m) && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({ role: m.role, content: messageText(m.content), timestamp: toMs(m.timestamp) ?? undefined }))
    .filter((m) => m.content.trim().length > 0);

/**
 * @param {object} deps
 * @param {ReturnType<import("./client").createHermesClient>} deps.client
 * @param {ReturnType<import("./store").createHermesStore>} deps.store
 * @param {(agentId: string) => Promise<string>|string} [deps.buildInstructions]
 *   Extra per-run instructions (organization mission and rules).
 * @param {(info: object) => void} [deps.onRunFinished]  usage accounting hook
 */
const createHermesAdapter = ({
  client,
  store,
  buildInstructions,
  onRunFinished,
  onTaskCreated,
  mcpEndpoint = () => null,
  autonomyTimeZone = "UTC",
  meetingGatherTimeoutMs,
  approvalReviewTimeoutMs,
  updater = null,
  log = () => {},
  logError = () => {},
}) => {
  const sockets = new Set();
  const runs = new Map(); // office run id → run record
  const approvals = new Map(); // office approval id → { profile, hermesRunId, requestId, officeRunId }
  const servedProfiles = new Set([DEFAULT_PROFILE]);
  const readiness = new Map(); // profile → Promise<void>
  let dashboardProfilesCache = { at: 0, value: null };
  // Provider slugs Hermes reported last, to read "<provider>/<model>" choices.
  let knownProviderSlugs = new Set();

  /**
   * The office stores a model choice as "<provider>/<model>". Hermes takes the
   * two apart; a model id that itself contains a slash (OpenRouter's
   * "anthropic/…") is only split when its prefix is a provider Hermes knows.
   */
  const splitModelChoice = (choice) => {
    const value = str(choice);
    const slash = value.indexOf("/");
    if (slash > 0 && knownProviderSlugs.has(value.slice(0, slash))) {
      return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
    }
    return { model: value };
  };

  const broadcast = (event, payload) => {
    for (const socket of sockets) socket.sendEvent(event, payload);
  };

  const hasDashboard = () => Boolean(client.config.dashboardUrl);

  // --- profiles ------------------------------------------------------------------

  const knownProfiles = new Set();
  const mcpAccess = createMcpAccess({ client, endpointFor: mcpEndpoint, log });

  const listProfiles = async ({ fresh = false } = {}) => {
    if (!hasDashboard()) return [{ name: DEFAULT_PROFILE, is_default: true, description: "" }];
    if (!fresh && dashboardProfilesCache.value && Date.now() - dashboardProfilesCache.at < 3_000) {
      return dashboardProfilesCache.value;
    }
    const result = await client.listProfiles();
    const profiles = (Array.isArray(result?.profiles) ? result.profiles : []).filter(
      (p) => isRecord(p) && client.isValidProfileName(p.name) && !(p.name !== DEFAULT_PROFILE && p.name === MAIN_AGENT_ID)
    );
    // A profile this office has not set up yet — created in Hermes directly,
    // or before this start — gets its organization block and tool access now
    // rather than at the next sweep.
    const unseen = profiles.filter((p) => !knownProfiles.has(p.name)).map((p) => p.name);
    for (const name of unseen) knownProfiles.add(name);
    if (unseen.length) {
      autonomy.teamChanged();
      queueMicrotask(() => {
        for (const name of unseen) {
          organization.setUpProfile(name).catch((err) => {
            knownProfiles.delete(name);
            logError(`Could not set up profile ${name}.`, err);
          });
        }
      });
    }
    if (!profiles.some((p) => p.name === DEFAULT_PROFILE)) {
      profiles.unshift({ name: DEFAULT_PROFILE, is_default: true, description: "" });
    }
    dashboardProfilesCache = { at: Date.now(), value: profiles };
    return profiles;
  };

  const officeAgentFromProfile = (profile) => {
    const agentId = agentIdOf(profile.name);
    const meta = store.getAgent(agentId) ?? {};
    const name =
      str(meta.name) || str(profile.display_name) || str(profile.bot_title) || (profile.name === DEFAULT_PROFILE ? "Hermes" : profile.name);
    return {
      id: agentId,
      name,
      identity: { name, emoji: str(meta.emoji) || "🤖" },
      role: str(profile.description),
      model: str(profile.model) || undefined,
      modelProvider: str(profile.provider) || undefined,
    };
  };

  const organization = createOrganization({
    client,
    store,
    listProfiles,
    ensureAccess: (profile) => mcpAccess.ensure(profile),
    describeAgent: (profile) => officeAgentFromProfile(profile),
    hasDashboard,
    AdapterError,
    broadcast: (event, payload) => broadcast(event, payload),
    log,
    logError,
  });

  const assertAgentExists = async (agentId) => {
    const profile = profileOf(agentId);
    if (profile === DEFAULT_PROFILE || !hasDashboard()) {
      if (profile !== DEFAULT_PROFILE) throw new AdapterError("NOT_FOUND", `Агент ${agentId} не найден.`);
      return profile;
    }
    const profiles = await listProfiles();
    if (!profiles.some((p) => p.name === profile)) throw new AdapterError("NOT_FOUND", `Агент ${agentId} не найден.`);
    return profile;
  };

  /**
   * Waits until the Hermes gateway serves a profile under /p/<profile>/. A
   * freshly created profile is picked up on the gateway's next rescan. A 401
   * means the profile's .env holds a different key — rewritten once.
   */
  const ensureProfileServed = (profile) => {
    if (servedProfiles.has(profile)) return Promise.resolve();
    const pending = readiness.get(profile);
    if (pending) return pending;
    const attempt = (async () => {
      const deadline = Date.now() + PROFILE_READY_TIMEOUT_MS;
      let rewroteKey = false;
      for (;;) {
        try {
          await client.health(profile, { retry: false, timeoutMs: 5_000 });
          servedProfiles.add(profile);
          return;
        } catch (err) {
          if (err instanceof HermesApiError && err.status === 401 && !rewroteKey && hasDashboard()) {
            rewroteKey = true;
            await client.setProfileEnv(profile, "API_SERVER_KEY", client.profileKey(profile));
          } else if (!(err instanceof HermesApiError) || (err.status !== 404 && err.status !== 401 && !err.retryable)) {
            throw err;
          }
        }
        if (Date.now() >= deadline) {
          throw new AdapterError(
            "UNAVAILABLE",
            `Hermes ещё не подключил агента «${agentIdOf(profile)}». Попробуйте через минуту.`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, PROFILE_READY_POLL_MS));
      }
    })().finally(() => readiness.delete(profile));
    readiness.set(profile, attempt);
    return attempt;
  };

  // --- sessions --------------------------------------------------------------------

  /**
   * The Hermes session behind an office session key. The first one has a
   * stable id, so a reinstalled office finds its conversation again; after a
   * reset the id is random. Hermes keeps sessions longer than the office keeps
   * its state, and a predictable "…-1" could land on an old conversation whose
   * system prompt Hermes froze long ago.
   */
  const hermesSessionIdFor = (sessionKey) => {
    const record = store.getSession(sessionKey);
    if (str(record?.sessionId)) return str(record.sessionId);
    const agentId = agentIdFromSessionKey(sessionKey);
    const suffix = sessionKey === mainSessionKey(agentId) ? MAIN_KEY : hashJson(sessionKey).slice(0, 8);
    return `office3d-${agentId}-${suffix}-0`;
  };

  const ensureSession = async (sessionKey) => {
    const agentId = agentIdFromSessionKey(sessionKey);
    const profile = profileOf(agentId);
    const sessionId = hermesSessionIdFor(sessionKey);
    const record = store.getSession(sessionKey);
    if (record?.createdId === sessionId) return { agentId, profile, sessionId };
    // Hermes wants session titles unique per profile; the id is, so the title
    // carries it. A title taken anyway (by hand, in Hermes) is not worth
    // failing a message over — the session goes without one.
    const create = (title) => client.createSession(profile, title ? { id: sessionId, title } : { id: sessionId });
    try {
      await create(`Office3D · ${sessionId}`).catch((err) => {
        if (err instanceof HermesApiError && err.code === "invalid_title") return create(null);
        throw err;
      });
    } catch (err) {
      if (!(err instanceof HermesApiError && err.status === 409)) throw err;
    }
    await store.upsertSession(sessionKey, { agentId, createdId: sessionId, generation: record?.generation ?? 0 });
    return { agentId, profile, sessionId };
  };

  // --- runs --------------------------------------------------------------------------

  const emitChat = (run, state, extra = {}) =>
    broadcast("chat", { runId: run.officeRunId, sessionKey: run.sessionKey, state, ...extra });
  const emitAgent = (run, stream, data) =>
    broadcast("agent", { runId: run.officeRunId, sessionKey: run.sessionKey, stream, data });

  const finishRun = (run, status, extra = {}) => {
    if (run.finished) return;
    if (run.deltaTimer) clearTimeout(run.deltaTimer);
    run.deltaTimer = null;
    // What was held back by the coalescing goes out before the end.
    if (run.pendingDelta) {
      const chunk = run.pendingDelta;
      run.pendingDelta = "";
      emitChat(run, "delta", { message: { role: "assistant", content: run.text } });
      emitAgent(run, "assistant", { delta: chunk, text: run.text });
    }
    run.finished = true;
    run.status = status;
    for (const [id, approval] of approvals) {
      if (approval.officeRunId !== run.officeRunId) continue;
      approvals.delete(id);
      approvalChain.closed(id);
    }
    if (status === "completed") {
      const text = typeof extra.output === "string" && extra.output.trim() ? extra.output : run.text;
      run.finalText = text;
      emitChat(run, "final", { stopReason: "end_turn", message: { role: "assistant", content: text } });
      emitAgent(run, "lifecycle", { phase: "end" });
    } else if (status === "failed") {
      const message = str(extra.error) || "Hermes не смог выполнить запрос.";
      run.error = message;
      emitChat(run, "error", { errorMessage: message });
      emitAgent(run, "lifecycle", { phase: "error", error: message });
    } else {
      emitChat(run, "aborted", {});
      emitAgent(run, "lifecycle", { phase: "end", aborted: true });
    }
    const now = Date.now();
    store.upsertSession(run.sessionKey, { agentId: run.agentId, lastActivityAt: now }).catch(() => {});
    broadcast("presence", {
      sessions: {
        recent: [{ key: run.sessionKey, updatedAt: now }],
        byAgent: [{ agentId: run.agentId, recent: [{ key: run.sessionKey, updatedAt: now }] }],
      },
    });
    try {
      onRunFinished?.({
        agentId: run.agentId,
        profile: run.profile,
        sessionKey: run.sessionKey,
        status,
        usage: isRecord(extra.usage) ? extra.usage : null,
        runtime: isRecord(extra.runtime) ? extra.runtime : null,
      });
    } catch (err) {
      logError("Run accounting hook failed.", err);
    }
    run.resolveDone(status);
    setTimeout(() => runs.delete(run.officeRunId), 60_000).unref?.();
  };

  const handleRunEvent = (run, event) => {
    const name = str(event.event);
    switch (name) {
      case "message.delta": {
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (!delta) return;
        run.text += delta;
        // Each update carries the whole text so far (the gateway protocol),
        // so updates are coalesced: at most one per DELTA_EMIT_MS.
        run.pendingDelta = (run.pendingDelta ?? "") + delta;
        const flush = () => {
          run.deltaTimer = null;
          if (run.finished || !run.pendingDelta) return;
          const chunk = run.pendingDelta;
          run.pendingDelta = "";
          run.lastDeltaAt = Date.now();
          emitChat(run, "delta", { message: { role: "assistant", content: run.text } });
          emitAgent(run, "assistant", { delta: chunk, text: run.text });
        };
        if (run.deltaTimer) return;
        const wait = DELTA_EMIT_MS - (Date.now() - (run.lastDeltaAt ?? 0));
        if (wait <= 0) flush();
        else {
          run.deltaTimer = setTimeout(flush, wait);
          run.deltaTimer.unref?.();
        }
        return;
      }
      case "message.interim": {
        if (event.already_streamed || !str(event.text)) return;
        emitAgent(run, "reasoning", { text: String(event.text) });
        return;
      }
      case "reasoning.available": {
        if (str(event.text)) emitAgent(run, "reasoning", { text: String(event.text) });
        return;
      }
      case "tool.started": {
        const tool = str(event.tool) || "tool";
        run.toolSeq += 1;
        const toolCallId = `${run.officeRunId}:t${run.toolSeq}`;
        const queue = run.openTools.get(tool) ?? [];
        queue.push(toolCallId);
        run.openTools.set(tool, queue);
        emitAgent(run, "tool", { phase: "start", name: tool, toolCallId, arguments: event.preview ?? null });
        return;
      }
      case "tool.completed": {
        const tool = str(event.tool) || "tool";
        const queue = run.openTools.get(tool) ?? [];
        const toolCallId = queue.shift() ?? `${run.officeRunId}:t${++run.toolSeq}`;
        emitAgent(run, "tool", {
          phase: "result",
          name: tool,
          toolCallId,
          isError: Boolean(event.error),
          result: { text: String(event.preview ?? "") },
        });
        return;
      }
      case "subagent.start":
      case "subagent.complete": {
        emitAgent(run, "tool", {
          phase: name === "subagent.start" ? "start" : "result",
          name: "delegate_task",
          toolCallId: `${run.officeRunId}:${str(event.delegation_id) || str(event.child_session_id) || name}`,
          arguments: event.preview ?? null,
          result: { text: String(event.summary ?? event.preview ?? event.status ?? "") },
          isError: name === "subagent.complete" && str(event.status) !== "" && str(event.status) !== "completed",
        });
        return;
      }
      case "approval.request": {
        const requestId = str(event.request_id);
        const createdAtMs = toMs(event.timestamp) ?? Date.now();
        const id = `${run.officeRunId}:${requestId || createdAtMs}`;
        approvals.set(id, { profile: run.profile, hermesRunId: run.hermesRunId, requestId, officeRunId: run.officeRunId });
        approvalChain.onRequest(id, {
          id,
          request: {
            command: str(event.command) || str(event.description) || "(действие без описания)",
            cwd: null,
            host: "hermes",
            security: null,
            ask: null,
            agentId: run.agentId,
            resolvedPath: null,
            sessionKey: run.sessionKey,
            description: str(event.description) || null,
            choices: Array.isArray(event.choices) ? event.choices : null,
          },
          createdAtMs,
          expiresAtMs: createdAtMs + APPROVAL_TIMEOUT_MS,
        }, run.agentId);
        return;
      }
      case "approval.responded": {
        for (const [id, approval] of approvals) {
          if (approval.officeRunId !== run.officeRunId) continue;
          if (event.request_id && approval.requestId && approval.requestId !== event.request_id) continue;
          approvals.delete(id);
          approvalChain.closed(id);
          const choice = str(event.choice);
          broadcast("exec.approval.resolved", {
            id,
            decision: choice === "deny" ? "deny" : choice === "always" || choice === "session" ? "allow-always" : "allow-once",
            resolvedBy: "hermes",
            ts: Date.now(),
          });
        }
        return;
      }
      default:
        if (name.startsWith("run.")) {
          const status = name.slice(4);
          if (TERMINAL_RUN_STATUSES.has(status)) {
            finishRun(run, status === "interrupted" ? "cancelled" : status, event);
          }
        }
    }
  };

  /**
   * Follows a run to its end. The SSE stream is the fast path. If it drops,
   * the run keeps going in Hermes; the stream is not reopened (a second
   * subscriber could be handed deltas the office already showed, doubling the
   * text), the run status is polled instead and carries the full answer.
   */
  const followRun = async (run) => {
    try {
      for await (const { data } of client.runEvents(run.profile, run.hermesRunId, { signal: run.controller.signal })) {
        if (isRecord(data)) handleRunEvent(run, data);
        if (run.finished) return;
      }
    } catch (err) {
      if (!run.controller.signal.aborted) {
        log(`Hermes run ${run.hermesRunId}: event stream dropped (${err?.code || err?.message}); polling its status.`);
      }
    }
    while (!run.finished && !run.controller.signal.aborted) {
      try {
        const status = await client.getRun(run.profile, run.hermesRunId);
        const state = str(status?.status);
        if (TERMINAL_RUN_STATUSES.has(state)) {
          finishRun(run, state === "interrupted" ? "cancelled" : state, status);
          return;
        }
      } catch (err) {
        if (err instanceof HermesApiError && err.status === 404) {
          finishRun(run, "failed", { error: "Hermes потерял этот запуск (возможно, после перезапуска)." });
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, RUN_STATUS_POLL_MS));
    }
  };

  const instructionsFor = async (agentId) => {
    const parts = [];
    // A running Hermes session keeps the system prompt it started with, so a
    // mission changed since then reaches a long office conversation only here.
    const missionNote = organization.runInstructions();
    if (missionNote) parts.push(missionNote);
    try {
      const extra = await buildInstructions?.(agentId);
      if (str(extra)) parts.push(str(extra));
    } catch (err) {
      logError("Failed to build organization instructions.", err);
    }
    const files = store.getAgent(agentId)?.files ?? {};
    for (const [name, content] of Object.entries(files)) {
      if (name === SOUL_FILE || !str(content)) continue;
      parts.push(`## ${name}\n\n${String(content).trim()}`);
    }
    return parts.length ? parts.join("\n\n") : undefined;
  };

  const startChat = async (params) => {
    const sessionKey = str(params.sessionKey) || mainSessionKey(MAIN_AGENT_ID);
    const message = typeof params.message === "string" ? params.message.trim() : "";
    const officeRunId = str(params.idempotencyKey) || crypto.randomUUID();
    if (!message) return { status: "no-op", runId: officeRunId };
    const existing = runs.get(officeRunId);
    if (existing) return { status: existing.finished ? "done" : "started", runId: officeRunId };

    const { agentId, profile, sessionId } = await (async () => {
      const target = agentIdFromSessionKey(sessionKey);
      await ensureProfileServed(profileOf(target));
      return ensureSession(sessionKey);
    })();
    const sessionSettings = store.getSession(sessionKey) ?? {};
    const body = { input: message, session_id: sessionId };
    const instructions = await instructionsFor(agentId);
    if (instructions) body.instructions = instructions;
    if (str(sessionSettings.model)) Object.assign(body, splitModelChoice(sessionSettings.model));

    const started = await client.startRun(profile, body, { idempotencyKey: `office3d-${officeRunId}` });
    const hermesRunId = str(started?.run_id);
    if (!hermesRunId) throw new AdapterError("UNAVAILABLE", "Hermes не вернул идентификатор запуска.");

    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const run = {
      officeRunId, hermesRunId, profile, agentId, sessionKey,
      text: "", toolSeq: 0, openTools: new Map(), finished: false, status: "running",
      controller: new AbortController(), done, resolveDone,
    };
    runs.set(officeRunId, run);
    emitAgent(run, "lifecycle", { phase: "start" });
    followRun(run).catch((err) => {
      logError(`Following Hermes run ${hermesRunId} failed.`, err);
      finishRun(run, "failed", { error: err?.message });
    });
    return { status: "started", runId: officeRunId };
  };

  const abortRuns = async (predicate) => {
    let aborted = 0;
    for (const run of runs.values()) {
      if (run.finished || !predicate(run)) continue;
      try {
        await client.stopRun(run.profile, run.hermesRunId);
        aborted += 1;
      } catch (err) {
        if (!(err instanceof HermesApiError && err.status === 404)) throw err;
        finishRun(run, "cancelled");
      }
    }
    return aborted;
  };

  // --- method handlers ---------------------------------------------------------------

  const handlers = {
    async "agents.list"() {
      const profiles = await listProfiles();
      return { defaultId: MAIN_AGENT_ID, mainKey: MAIN_KEY, scope: "global", agents: profiles.map(officeAgentFromProfile) };
    },

    async "agents.create"(p) {
      if (!hasDashboard()) {
        throw new AdapterError("UNAVAILABLE", "Создавать агентов можно только при подключённой панели Hermes.");
      }
      const name = str(p.name) || "Агент";
      const profiles = await listProfiles({ fresh: true });
      const taken = new Set(profiles.map((profile) => profile.name));
      // Every hire gets a profile id never used before. A running Hermes
      // gateway keeps the state database of a deleted profile open, and a new
      // profile under the same id then fails every request with "state.db was
      // replaced underneath the gateway" until Hermes restarts. The suffix
      // keeps a re-hired «Аналитик» away from the old one's files.
      const base = slugifyProfileName(name).slice(0, 40);
      let profile = "";
      for (let attempt = 0; attempt < 5 && (!profile || taken.has(profile)); attempt += 1) {
        profile = `${base}-${crypto.randomBytes(4).toString("hex").slice(0, 6)}`;
      }
      if (taken.has(profile)) throw new AdapterError("CONFLICT", "Не удалось подобрать свободное имя профиля.");
      await client.createProfile({ name: profile, clone_from: DEFAULT_PROFILE, description: str(p.role) || undefined });
      knownProfiles.add(profile);
      try {
        // First: the clone carries the main agent's Office3D access; replace
        // it with its own before anything else can use it.
        await mcpAccess.ensure(profile);
        await client.setProfileEnv(profile, "API_SERVER_KEY", client.profileKey(profile));
        const persona = typeof p.instructions === "string" && p.instructions.trim() ? p.instructions.trim() : defaultSoul(name);
        await organization.writeSoul(profile, persona);
      } catch (err) {
        // A profile nobody can reach is worse than none: roll back.
        await client.deleteProfile(profile).catch((cleanupErr) => logError(`Failed to remove half-created profile ${profile}.`, cleanupErr));
        throw err;
      }
      // A clone copies the main agent's own notes (MEMORY.md) along with its
      // config. A new hire starts with a clean memory of its own; what the
      // team knows about the person they work for (USER.md) stays.
      await client
        .dashboard("/api/memory/reset", { method: "POST", query: { profile }, body: { target: "memory" } })
        .catch((err) => logError(`Could not clear the cloned memory of ${profile}.`, err));
      await store.upsertAgent(profile, { name, createdAt: Date.now() });
      dashboardProfilesCache = { at: 0, value: null };
      autonomy.teamChanged();
      ensureProfileServed(profile).catch((err) => log(`Profile ${profile} is not served yet: ${err.message}`));
      return { ok: true, agentId: profile, name, workspace: str(p.workspace) || `profiles/${profile}` };
    },

    async "agents.update"(p) {
      const agentId = str(p.agentId);
      const profile = await assertAgentExists(agentId);
      if (str(p.name)) await store.upsertAgent(agentId, { name: str(p.name) });
      if (typeof p.role === "string" && hasDashboard()) await client.setDescription(profile, p.role.trim());
      dashboardProfilesCache = { at: 0, value: null };
      return { ok: true, removedBindings: 0 };
    },

    async "agents.delete"(p) {
      const agentId = str(p.agentId);
      if (!agentId || agentId === MAIN_AGENT_ID) {
        throw new AdapterError("INVALID_REQUEST", "Главного агента удалить нельзя.");
      }
      const profile = await assertAgentExists(agentId);
      await abortRuns((run) => run.agentId === agentId);
      const name = officeAgentFromProfile({ name: profile }).name;
      await kanban.releaseAssignee(profile, `Сотрудник «${name}» уволен; задача вернулась на разбор.`, logError);
      await client.deleteProfile(profile);
      servedProfiles.delete(profile);
      knownProfiles.delete(profile);
      mcpAccess.forget(profile);
      autonomy.teamChanged();
      await store.removeAgent(agentId);
      dashboardProfilesCache = { at: 0, value: null };
      return { ok: true, removedBindings: 0 };
    },

    async "agents.files.get"(p) {
      const agentId = str(p.agentId) || MAIN_AGENT_ID;
      const name = str(p.name);
      if (name === SOUL_FILE && hasDashboard()) {
        const soul = await client.getSoul(profileOf(agentId));
        // The office shows and edits the agent's own persona; the
        // organization block is Office3D's and is re-added on save.
        return { file: soul?.exists ? { content: organization.stripOrgBlock(soul.content) } : { missing: true } };
      }
      const content = store.getAgentFile(agentId, name);
      return { file: content !== undefined ? { content } : { missing: true } };
    },

    async "agents.files.set"(p) {
      const agentId = str(p.agentId) || MAIN_AGENT_ID;
      const name = str(p.name);
      if (!name) throw new AdapterError("INVALID_REQUEST", "Не указано имя файла.");
      const content = typeof p.content === "string" ? p.content : "";
      if (name === SOUL_FILE && hasDashboard()) {
        const profile = profileOf(agentId);
        await organization.writeSoul(profile, content);
        return {};
      }
      await store.setAgentFile(agentId, name, content);
      if (name === "IDENTITY.md") {
        const identity = parseIdentity(content);
        const patch = {};
        if (identity.name) patch.name = identity.name;
        if (identity.emoji) patch.emoji = identity.emoji;
        if (Object.keys(patch).length) await store.upsertAgent(agentId, patch);
      }
      return {};
    },

    async "sessions.list"() {
      const profiles = await listProfiles();
      const sessions = profiles.map((profile) => {
        const agent = officeAgentFromProfile(profile);
        const key = mainSessionKey(agent.id);
        const record = store.getSession(key) ?? {};
        return {
          key,
          agentId: agent.id,
          updatedAt: record.lastActivityAt ?? null,
          displayName: "Main",
          origin: { label: agent.name, provider: "hermes" },
          model: str(record.model) || agent.model || null,
          modelProvider: agent.modelProvider || "hermes",
        };
      });
      return { sessions };
    },

    async "sessions.preview"(p) {
      const keys = Array.isArray(p.keys) ? p.keys.filter((key) => typeof key === "string") : [];
      const limit = Math.min(Math.max(Number(p.limit) || 8, 1), 50);
      const maxChars = Math.min(Math.max(Number(p.maxChars) || 240, 20), 4000);
      const previews = await Promise.all(
        keys.map(async (key) => {
          const record = store.getSession(key);
          if (!record?.createdId) return { key, status: "empty", items: [] };
          try {
            const agentId = agentIdFromSessionKey(key);
            const result = await client.sessionMessages(profileOf(agentId), record.createdId, { limit, order: "latest" });
            const items = historyFromHermes(result?.data).map((m) => ({
              role: m.role, text: m.content.slice(0, maxChars), timestamp: m.timestamp,
            }));
            return { key, status: items.length ? "ok" : "empty", items };
          } catch (err) {
            if (err instanceof HermesApiError && err.status === 404) return { key, status: "missing", items: [] };
            return { key, status: "error", items: [] };
          }
        })
      );
      return { ts: Date.now(), previews };
    },

    async "sessions.patch"(p) {
      const key = str(p.key) || mainSessionKey(MAIN_AGENT_ID);
      const patch = { agentId: agentIdFromSessionKey(key) };
      if (p.model !== undefined) patch.model = typeof p.model === "string" ? p.model.trim() : null;
      if (p.thinkingLevel !== undefined) patch.thinkingLevel = p.thinkingLevel;
      await store.upsertSession(key, patch);
      const record = store.getSession(key) ?? {};
      return {
        ok: true,
        key,
        entry: { thinkingLevel: record.thinkingLevel },
        resolved: { model: str(record.model) || null, modelProvider: "hermes" },
      };
    },

    async "sessions.reset"(p) {
      const key = str(p.key) || mainSessionKey(MAIN_AGENT_ID);
      const record = store.getSession(key) ?? {};
      const agentId = agentIdFromSessionKey(key);
      if (record.createdId) {
        await client.patchSession(profileOf(agentId), record.createdId, { end_reason: "office3d_reset" }).catch(() => {});
      }
      const suffix = key === mainSessionKey(agentId) ? MAIN_KEY : hashJson(key).slice(0, 8);
      await store.upsertSession(key, {
        agentId,
        generation: Number(record.generation ?? 0) + 1,
        sessionId: `office3d-${agentId}-${suffix}-${crypto.randomBytes(6).toString("hex")}`,
        createdId: null,
      });
      return { ok: true };
    },

    "chat.send": (p) => startChat(p),

    async "chat.abort"(p) {
      const runId = str(p.runId);
      const sessionKey = str(p.sessionKey);
      if (!runId && !sessionKey) return { ok: true, aborted: 0 };
      const aborted = await abortRuns((run) => (runId ? run.officeRunId === runId : run.sessionKey === sessionKey));
      return { ok: true, aborted };
    },

    async "chat.history"(p) {
      const sessionKey = str(p.sessionKey) || mainSessionKey(MAIN_AGENT_ID);
      const record = store.getSession(sessionKey);
      if (!record?.createdId) return { sessionKey, messages: [] };
      const limit = Math.min(Math.max(Number(p.limit) || 200, 1), 500);
      try {
        const result = await client.sessionMessages(profileOf(agentIdFromSessionKey(sessionKey)), record.createdId, {
          limit,
          order: "latest",
        });
        return { sessionKey, messages: historyFromHermes(result?.data) };
      } catch (err) {
        if (err instanceof HermesApiError && err.status === 404) return { sessionKey, messages: [] };
        throw err;
      }
    },

    async "agent.wait"(p) {
      const run = runs.get(str(p.runId));
      if (!run) return { status: "done" };
      const timeoutMs = Math.min(Math.max(Number(p.timeoutMs) || 30_000, 0), 600_000);
      let timer;
      const status = await Promise.race([
        run.done,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
          timer.unref?.();
        }),
      ]).finally(() => clearTimeout(timer));
      return { status: status ? "done" : "running", result: status ?? undefined };
    },

    async status() {
      const profiles = await listProfiles();
      const byAgent = profiles.map((profile) => {
        const agentId = agentIdOf(profile.name);
        const key = mainSessionKey(agentId);
        const updatedAt = store.getSession(key)?.lastActivityAt ?? null;
        return { agentId, recent: updatedAt ? [{ key, updatedAt }] : [] };
      });
      return { sessions: { recent: byAgent.flatMap((entry) => entry.recent), byAgent } };
    },

    async "config.get"() {
      const overlay = store.getConfigOverlay();
      const profiles = await listProfiles();
      const overlayAgents = Array.isArray(overlay?.agents?.list) ? overlay.agents.list : [];
      const list = profiles.map((profile) => {
        const agent = officeAgentFromProfile(profile);
        const extra = overlayAgents.find((entry) => isRecord(entry) && entry.id === agent.id) ?? {};
        return { ...extra, id: agent.id, name: agent.name };
      });
      const config = { ...overlay, agents: { ...(overlay.agents ?? {}), list } };
      return { config, hash: hashJson(overlay), exists: true, path: "/opt/data/office3d/config.json" };
    },

    async "config.patch"(p) {
      const overlay = store.getConfigOverlay();
      if (str(p.baseHash) && str(p.baseHash) !== hashJson(overlay)) {
        throw new AdapterError("CONFLICT", "Настройки изменились; обновите и попробуйте снова.");
      }
      let patch;
      try {
        patch = JSON.parse(String(p.raw ?? "{}"));
      } catch {
        throw new AdapterError("INVALID_REQUEST", "Изменение настроек — не JSON.");
      }
      const next = mergePatch(overlay, patch);
      await store.setConfigOverlay(next);
      return { hash: hashJson(next) };
    },

    async "config.set"(p) {
      const overlay = store.getConfigOverlay();
      if (str(p.baseHash) && str(p.baseHash) !== hashJson(overlay)) {
        throw new AdapterError("CONFLICT", "Настройки изменились; обновите и попробуйте снова.");
      }
      let next;
      try {
        next = JSON.parse(String(p.raw ?? "{}"));
      } catch {
        throw new AdapterError("INVALID_REQUEST", "Настройки — не JSON.");
      }
      if (!isRecord(next)) throw new AdapterError("INVALID_REQUEST", "Настройки должны быть объектом.");
      await store.setConfigOverlay(next);
      return { hash: hashJson(next) };
    },

    async "exec.approvals.get"() {
      const overlay = store.getConfigOverlay();
      const file = isRecord(overlay.execApprovals)
        ? overlay.execApprovals
        : { version: 1, defaults: { security: "full", ask: "on-miss", autoAllowSkills: true }, agents: {} };
      return { path: "", exists: true, hash: hashJson(file), file };
    },

    async "exec.approvals.set"(p) {
      const file = isRecord(p.file) ? p.file : null;
      if (!file) throw new AdapterError("INVALID_REQUEST", "Нет данных об одобрениях.");
      await store.setConfigOverlay({ ...store.getConfigOverlay(), execApprovals: file });
      return { hash: hashJson(file) };
    },

    async "exec.approval.resolve"(p) {
      const id = str(p.id);
      const approval = approvals.get(id);
      if (!approval) throw new AdapterError("NOT_FOUND", "Запрос на одобрение уже закрыт или истёк.");
      const decision = str(p.decision);
      const choice = decision === "deny" ? "deny" : decision === "allow-always" ? "always" : "once";
      await client.resolveApproval(approval.profile, approval.hermesRunId, {
        choice,
        ...(approval.requestId ? { request_id: approval.requestId } : {}),
      });
      approvals.delete(id);
      await approvalChain.personDecided(id, decision);
      broadcast("exec.approval.resolved", { id, decision: decision || "allow-once", resolvedBy: "office3d", ts: Date.now() });
      return { ok: true };
    },

    async "skills.status"(p) {
      const agentId = str(p.agentId) || MAIN_AGENT_ID;
      const profile = profileOf(agentId);
      let result;
      try {
        result = await client.skills(profile);
      } catch (err) {
        // Some Hermes builds fail GET /v1/skills with a 500; the dashboard's
        // skill list reads the same skill tree, so use it when it is there.
        if (!(err instanceof HermesApiError) || err.status < 500 || !hasDashboard()) throw err;
        log(`GET /v1/skills failed (${err.message}); using the dashboard's skill list.`);
        result = await client.dashboardSkills(profile);
      }
      const entries = Array.isArray(result)
        ? result
        : Array.isArray(result?.data)
          ? result.data
          : Array.isArray(result?.skills)
            ? result.skills
            : [];
      return {
        workspaceDir: "",
        managedSkillsDir: "",
        skills: entries.filter(isRecord).map((skill) => ({
          name: String(skill.name ?? ""),
          description: String(skill.description ?? ""),
          source: "hermes",
          bundled: Boolean(skill.bundled) || skill.provenance === "bundled",
          filePath: String(skill.path ?? ""),
          baseDir: "",
          skillKey: String(skill.name ?? ""),
          always: false,
          disabled: skill.enabled === false,
          blockedByAllowlist: false,
          eligible: skill.enabled !== false,
          requirements: { bins: [], anyBins: [], env: [], config: [] },
          missing: { bins: [], anyBins: [], env: [], config: [] },
          configChecks: [],
          install: [],
        })),
      };
    },

    /**
     * The skills panel's "enable/disable everywhere": the skill is turned on
     * or off in every agent's profile. Hermes skills read their keys from the
     * profile's environment, which the credentials section manages.
     */
    async "skills.update"(p) {
      const skillKey = str(p.skillKey);
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(skillKey)) throw new AdapterError("INVALID_REQUEST", "Неверное имя навыка.");
      if (typeof p.apiKey === "string") {
        throw new AdapterError("UNSUPPORTED", "Ключи навыков Hermes задаются в разделе «Ключи и доступы» как переменные окружения.");
      }
      if (typeof p.enabled !== "boolean") throw new AdapterError("INVALID_REQUEST", "Не указано, включить ли навык.");
      if (!hasDashboard()) throw new AdapterError("UNAVAILABLE", "Навыки Hermes доступны при подключённой панели Hermes.");
      const profiles = (await listProfiles()).map((profile) => profile.name);
      for (const profile of profiles) {
        await client.dashboard("/api/skills/toggle", { method: "PUT", query: { profile }, body: { name: skillKey, enabled: p.enabled, profile } });
      }
      log(`Skill ${skillKey} ${p.enabled ? "enabled" : "disabled"} for ${profiles.join(", ")}.`);
      return { ok: true, skillKey, config: { enabled: p.enabled } };
    },

    /** Hermes installs a skill's dependencies itself; there are no installer options to run. */
    async "skills.install"() {
      throw new AdapterError(
        "UNSUPPORTED",
        "В Hermes навыки ставятся из каталога Hermes Skills Hub (настройки агента → «Навыки Hermes»); зависимости Hermes устанавливает сам."
      );
    },

    /**
     * The old "wake now": the main agent looks over the board and the mission
     * right away, as the autonomy "Обзор сейчас" does.
     */
    async wake() {
      if (!hasDashboard()) return { ok: false };
      try {
        await autonomy.handlers["org.autonomy.runNow"]({});
        return { ok: true };
      } catch (err) {
        // A review already under way is what was asked for.
        if (err instanceof AdapterError && err.code === "CONFLICT") return { ok: true };
        throw err;
      }
    },

    async "models.list"() {
      const result = await client.modelOptions(DEFAULT_PROFILE);
      const providers = Array.isArray(result?.providers) ? result.providers : [];
      const models = [];
      for (const provider of providers) {
        if (!isRecord(provider) || !provider.authenticated) continue;
        const slug = str(provider.slug);
        if (!slug || !Array.isArray(provider.models)) continue;
        for (const model of provider.models) {
          const name = str(String(model));
          if (name) models.push({ id: `${slug}/${name}`, name, provider: slug });
        }
      }
      knownProviderSlugs = new Set(providers.filter(isRecord).map((provider) => str(provider.slug)).filter(Boolean));
      return { models };
    },

    async "cron.list"(p) {
      const profiles = await listProfiles();
      const includeDisabled = p.includeDisabled !== false;
      const lists = await Promise.all(
        profiles.map(async (profile) => {
          const agentId = agentIdOf(profile.name);
          try {
            const result = await client.listJobs(profile.name, { include_disabled: includeDisabled });
            const jobs = Array.isArray(result?.jobs) ? result.jobs : Array.isArray(result?.data) ? result.data : [];
            return jobs.filter(isRecord).map((job) => jobToCron(agentId, job));
          } catch (err) {
            if (err instanceof HermesApiError && (err.status === 404 || err.status === 401)) return [];
            throw err;
          }
        })
      );
      const jobs = lists.flat();
      return { jobs: includeDisabled ? jobs : jobs.filter((job) => job.enabled) };
    },

    async "cron.add"(p) {
      const input = isRecord(p.job) ? p.job : p;
      const agentId = str(input.agentId) || MAIN_AGENT_ID;
      const profile = await assertAgentExists(agentId);
      const prompt = promptFromPayload(input.payload);
      if (!prompt) throw new AdapterError("INVALID_REQUEST", "У задачи по расписанию нет текста.");
      const body = {
        name: str(input.name) || "Задача",
        schedule: scheduleToHermes(input.schedule),
        prompt,
        deliver: "local",
      };
      if (input.enabled === false) body.paused = true;
      if (input.deleteAfterRun) body.repeat = 1;
      const result = await client.createJob(profile, body);
      const job = isRecord(result?.job) ? result.job : result;
      return jobToCron(agentId, job);
    },

    async "cron.remove"(p) {
      const { agentId, jobId } = decodeJobId(p.id ?? p.jobId);
      await client.deleteJob(profileOf(agentId), jobId);
      return { ok: true, removed: true };
    },

    async "cron.patch"(p) {
      const { agentId, jobId } = decodeJobId(p.id ?? p.jobId);
      const profile = profileOf(agentId);
      const patch = isRecord(p.patch) ? p.patch : {};
      const update = {};
      if (str(patch.name)) update.name = str(patch.name);
      if (patch.schedule) update.schedule = scheduleToHermes(patch.schedule);
      if (patch.payload) {
        const prompt = promptFromPayload(patch.payload);
        if (prompt) update.prompt = prompt;
      }
      if (Object.keys(update).length) await client.updateJob(profile, jobId, update);
      if (patch.enabled === false) await client.pauseJob(profile, jobId);
      if (patch.enabled === true) await client.resumeJob(profile, jobId);
      const result = await client.getJob(profile, jobId);
      return jobToCron(agentId, isRecord(result?.job) ? result.job : result);
    },

    async "cron.run"(p) {
      const { agentId, jobId } = decodeJobId(p.id ?? p.jobId);
      await client.runJob(profileOf(agentId), jobId);
      return { ok: true, ran: true };
    },
  };

  // Tasks already judged (proposals held, or created by the office itself).
  const MAX_REVIEWED_TASKS = 2_000;
  const reviewedTaskIds = () => new Set(Array.isArray(store.getOrganization().reviewedTasks) ? store.getOrganization().reviewedTasks : []);
  const markTaskReviewed = async (id) => {
    const reviewed = reviewedTaskIds();
    if (reviewed.has(id)) return;
    reviewed.add(id);
    await store.updateOrganization({ reviewedTasks: [...reviewed].slice(-MAX_REVIEWED_TASKS) });
  };
  const kanban = createKanbanHandlers({ client, hasDashboard, AdapterError, onTaskCreated, rememberOfficeTask: markTaskReviewed });

  const waitRun = async (runId, timeoutMs) => {
    const run = runs.get(runId);
    if (!run) return "unknown";
    let timer;
    return Promise.race([
      run.done,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
  };

  // Tasks other agents created go to triage as proposals; see kanban.js.
  // One check at a time: the periodic sweep and a dispatch may ask together.
  let guarding = null;
  const guardBoard = () => {
    if (guarding) return guarding;
    guarding = (async () => {
      const reviewed = reviewedTaskIds();
      const names = new Map((await listProfiles()).map((profile) => [agentIdOf(profile.name), officeAgentFromProfile(profile).name]));
      return kanban.holdProposedTasks({
        reviewed,
        markReviewed: async (id) => {
          reviewed.add(id);
          await markTaskReviewed(id);
        },
        nameOf: (agentId) => names.get(agentId) ?? agentId,
        logError,
      });
    })().finally(() => {
      guarding = null;
    });
    return guarding;
  };
  kanban.setBeforeDispatch(() => guardBoard());

  const team = createTeam({
    store,
    listProfiles,
    describeAgent: (profile) => officeAgentFromProfile(profile),
    hire: ({ name, role, instructions }) => handlers["agents.create"]({ name, role, instructions }),
    dismiss: (agentId) => handlers["agents.delete"]({ agentId }),
    decideApproval: (params) => approvalChain.decide(params),
    callMeeting: async ({ topic, participants }) => {
      const current = await autonomy.status();
      if (current.budgetExceeded) {
        throw new AdapterError("RATE_LIMITED", "Дневной бюджет исчерпан — совещание можно провести завтра или по просьбе руководителя.");
      }
      return meetings.start({ topic, participants, requestedBy: "main" });
    },
    notifyMain: async (message, key) => {
      await startChat({ sessionKey: mainSessionKey(MAIN_AGENT_ID), message, idempotencyKey: key });
    },
    hasDashboard,
    AdapterError,
    broadcast: (event, payload) => broadcast(event, payload),
    log,
    logError,
  });

  const autonomy = createAutonomy({
    client,
    store,
    listProfiles,
    hiredAt: (profile) => {
      const createdAt = Number(store.getAgent(agentIdOf(profile))?.createdAt);
      return Number.isFinite(createdAt) && createdAt > 0 ? createdAt : null;
    },
    readBoard: () => kanban.readBoard(false),
    startRun: (params) => startChat(params),
    isRunActive: (sessionKey) => [...runs.values()].some((run) => run.sessionKey === sessionKey && !run.finished),
    hasDashboard,
    AdapterError,
    broadcast: (event, payload) => broadcast(event, payload),
    defaultTimeZone: autonomyTimeZone,
    log,
    logError,
  });

  const meetings = createMeetings({
    store,
    listProfiles,
    describeAgent: (profile) => officeAgentFromProfile(profile),
    runTurn: async ({ sessionKey, message, timeoutMs, onStarted }) => {
      const started = await startChat({ sessionKey, message, idempotencyKey: `meeting-${crypto.randomUUID()}` });
      const run = runs.get(started.runId);
      if (!run) return { status: "failed", text: "" };
      onStarted?.(run.officeRunId);
      let timer;
      const status = await Promise.race([
        run.done,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
          timer.unref?.();
        }),
      ]).finally(() => clearTimeout(timer));
      if (status === "timeout") await client.stopRun(run.profile, run.hermesRunId).catch(() => {});
      return { status, text: run.finalText ?? run.text, error: run.error };
    },
    abortTurn: async (runId) => {
      const run = runs.get(runId);
      if (run && !run.finished) await client.stopRun(run.profile, run.hermesRunId);
    },
    AdapterError,
    broadcast: (event, payload) => broadcast(event, payload),
    gatherTimeoutMs: meetingGatherTimeoutMs,
    log,
    logError,
  });

  const approvalChain = createApprovalChain({
    store,
    chainAvailable: () => hasDashboard() && Boolean(mcpEndpoint(DEFAULT_PROFILE)),
    nameOf: (agentId) => officeAgentFromProfile({ name: profileOf(agentId) }).name,
    startRun: (params) => startChat(params),
    waitRun,
    askPerson: (payload) => broadcast("exec.approval.requested", payload),
    resolve: async (id, choice) => {
      const approval = approvals.get(id);
      if (!approval) throw new AdapterError("NOT_FOUND", "Запрос уже закрыт или истёк.");
      await client.resolveApproval(approval.profile, approval.hermesRunId, {
        choice,
        ...(approval.requestId ? { request_id: approval.requestId } : {}),
      });
      approvals.delete(id);
      broadcast("exec.approval.resolved", {
        id,
        decision: choice === "deny" ? "deny" : "allow-once",
        resolvedBy: "main-agent",
        ts: Date.now(),
      });
    },
    broadcast: (event, payload) => broadcast(event, payload),
    reviewTimeoutMs: approvalReviewTimeoutMs,
    log,
    logError,
  });

  const updates = createUpdates({
    updater,
    store,
    AdapterError,
    broadcast: (event, payload) => broadcast(event, payload),
    log,
  });

  Object.assign(
    handlers,
    organization.handlers,
    autonomy.handlers,
    meetings.handlers,
    approvalChain.handlers,
    updates.handlers,
    createSkillHandlers({
      client,
      profileFor: (agentId) => assertAgentExists(agentId),
      listProfiles,
      hasDashboard,
      AdapterError,
      log,
    }),
    createProviderHandlers({ client, listProfiles, profileOf, hasDashboard, AdapterError, log }),
    createUsageHandlers({ client, store, listProfiles, agentIdOf, hasDashboard, AdapterError, log }),
    createCapabilityHandlers({
      client,
      profileFor: (agentId) => assertAgentExists(agentId),
      listProfiles,
      hasDashboard,
      HermesApiError,
      AdapterError,
      log,
    }),
    kanban.handlers,
    team.handlers
  );

  const helloPayload = async () => {
    let agents = [];
    try {
      agents = (await listProfiles()).map((profile) => ({
        agentId: agentIdOf(profile.name),
        name: officeAgentFromProfile(profile).name,
        isDefault: profile.name === DEFAULT_PROFILE,
      }));
    } catch (err) {
      logError("Could not list Hermes profiles for the hello snapshot.", err);
      agents = [{ agentId: MAIN_AGENT_ID, name: "Hermes", isDefault: true }];
    }
    return {
      type: "hello-ok",
      protocol: PROTOCOL_VERSION,
      adapterType: "hermes",
      features: { methods: METHODS, events: EVENTS },
      snapshot: { health: { agents, defaultAgentId: MAIN_AGENT_ID }, sessionDefaults: { mainKey: MAIN_KEY } },
      auth: { role: "operator", scopes: ["operator.admin", "operator.approvals"] },
      policy: { tickIntervalMs: 30_000 },
    };
  };

  const errorFrame = (id, err) => {
    if (err instanceof AdapterError) return { type: "res", id, ok: false, error: { code: err.code, message: err.message } };
    if (err instanceof HermesApiError) {
      const code =
        err.status === 404 ? "NOT_FOUND" : err.status === 400 || err.status === 422 ? "INVALID_REQUEST" : err.status === 409 ? "CONFLICT" : "UNAVAILABLE";
      return { type: "res", id, ok: false, error: { code, message: err.message, hermesCode: err.code } };
    }
    logError("Hermes adapter method failed.", err);
    return { type: "res", id, ok: false, error: { code: "INTERNAL", message: "Внутренняя ошибка адаптера Hermes." } };
  };

  /**
   * Serves one gateway connection. `authorize(params)` decides whether the
   * connect frame may proceed.
   */
  const handleSocket = (ws, { authorize }) => {
    let connected = false;
    let seq = 0;
    const send = (frame) => {
      if (ws.readyState !== ws.OPEN) return;
      try {
        ws.send(JSON.stringify(frame));
      } catch (err) {
        logError("Hermes adapter send failed.", err);
      }
    };
    const socket = {
      sendEvent(event, payload) {
        if (connected) send({ type: "event", event, seq: seq++, payload });
      },
    };
    sockets.add(socket);
    send({ type: "event", event: "connect.challenge", payload: { nonce: crypto.randomUUID(), ts: Date.now() } });

    ws.on("message", async (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      if (!isRecord(frame) || frame.type !== "req") return;
      const { id, method } = frame;
      if (typeof id !== "string" || typeof method !== "string") return;
      const params = isRecord(frame.params) ? frame.params : {};
      if (method === "connect") {
        if (!authorize(params)) {
          send({ type: "res", id, ok: false, error: { code: "UNAUTHORIZED", message: "Нет доступа к адаптеру Hermes." } });
          ws.close(1008, "unauthorized");
          return;
        }
        connected = true;
        send({ type: "res", id, ok: true, payload: await helloPayload() });
        return;
      }
      if (!connected) {
        send({ type: "res", id, ok: false, error: { code: "INVALID_REQUEST", message: "Сначала нужно подключиться." } });
        return;
      }
      // Own methods only: "toString" and friends are not gateway methods.
      const handler = typeof method === "string" && Object.hasOwn(handlers, method) ? handlers[method] : null;
      if (typeof handler !== "function") {
        send({
          type: "res",
          id,
          ok: false,
          error: { code: "NOT_IMPLEMENTED", message: `Метод «${method}» не поддерживается бэкендом Hermes (not implemented).` },
        });
        return;
      }
      try {
        const payload = await handler(params);
        send({ type: "res", id, ok: true, payload: payload ?? {} });
      } catch (err) {
        send(errorFrame(id, err));
      }
    });
    const drop = () => sockets.delete(socket);
    ws.on("close", drop);
    ws.on("error", drop);
  };

  const close = () => {
    for (const run of runs.values()) run.controller.abort();
    sockets.clear();
  };

  return {
    handleSocket,
    handlers,
    broadcast,
    close,
    organization,
    team,
    autonomy,
    meetings,
    updates,
    listProfiles,
    guardBoard,
    _runs: runs,
    _approvals: approvals,
  };
};

module.exports = {
  createHermesAdapter,
  slugifyProfileName,
  scheduleToHermes,
  scheduleFromHermes,
  jobToCron,
  historyFromHermes,
  parseIdentity,
  mergePatch,
  MAIN_AGENT_ID,
};
