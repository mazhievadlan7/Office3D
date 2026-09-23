// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createFakeHermes, DASHBOARD_TOKEN, DEFAULT_KEY } from "./helpers/fakeHermes";

const { startHermesRuntime } = await import("../../server/hermes/index.js");
const { deriveProfileKey } = await import("../../server/hermes/client.js");
const { deriveMcpToken } = await import("../../server/hermes/mcp.js");
const { slugifyProfileName, scheduleToHermes, parseIdentity, mergePatch } = await import(
  "../../server/hermes/adapter.js"
);

const KEY_SECRET = "office3d-hermes-key-secret-0123456789abcdef";

// Frames are asserted structurally (toMatchObject), so their payloads stay
// loosely typed here rather than restating the whole protocol.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
type Frame = { type: string; id?: string; ok?: boolean; payload?: Loose; error?: Loose; event?: string };

const openClient = async (url: string, token: string) => {
  const ws = new WebSocket(url);
  const events: Frame[] = [];
  const pending = new Map<string, (frame: Frame) => void>();
  let counter = 0;
  ws.on("message", (raw) => {
    const frame = JSON.parse(raw.toString()) as Frame;
    if (frame.type === "res" && frame.id && pending.has(frame.id)) {
      pending.get(frame.id)!(frame);
      pending.delete(frame.id);
    } else if (frame.type === "event") {
      events.push(frame);
    }
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const call = (method: string, params: unknown = {}) =>
    new Promise<Frame>((resolve) => {
      const id = String(++counter);
      pending.set(id, resolve);
      ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  const connect = await call("connect", { auth: { token } });
  const waitForEvent = async (predicate: (frame: Frame) => boolean, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = events.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error("event did not arrive");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return { ws, events, call, connect, waitForEvent, close: () => ws.close() };
};

describe("hermes adapter", () => {
  let fake: Awaited<ReturnType<typeof createFakeHermes>>;
  let runtime: Awaited<ReturnType<typeof startHermesRuntime>>;
  let stateDir: string;

  beforeEach(async () => {
    fake = await createFakeHermes();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "office3d-hermes-test-"));
    runtime = await startHermesRuntime({
      env: {
        HERMES_API_URL: fake.url,
        HERMES_API_KEY: DEFAULT_KEY,
        HERMES_DASHBOARD_URL: fake.url,
        HERMES_DASHBOARD_TOKEN: DASHBOARD_TOKEN,
        OFFICE3D_HERMES_KEY_SECRET: KEY_SECRET,
        OFFICE3D_MCP_PORT: "0",
      },
      stateDir,
      log: () => {},
      logError: () => {},
    });
  });

  afterEach(async () => {
    await runtime?.close();
    await fake.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("refuses_a_connect_without_the_boot_secret", async () => {
    const client = await openClient(runtime!.url, "wrong-secret");
    expect(client.connect).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    client.close();
  });

  it("lists_the_default_profile_as_the_main_agent", async () => {
    const client = await openClient(runtime!.url, runtime!.token);
    expect(client.connect).toMatchObject({ ok: true, payload: { adapterType: "hermes", type: "hello-ok" } });
    const result = await client.call("agents.list");
    expect(result.payload).toMatchObject({ defaultId: "main", agents: [{ id: "main", name: "Hermes" }] });
    client.close();
  });

  it("creates_an_agent_as_a_profile_with_its_own_derived_key", async () => {
    const client = await openClient(runtime!.url, runtime!.token);
    const created = await client.call("agents.create", { name: "Аналитик" });
    expect(created).toMatchObject({ ok: true, payload: { name: "Аналитик" } });
    const agentId = created.payload.agentId as string;
    expect(agentId).toMatch(/^analitik-[0-9a-f]{6}$/);
    const profile = fake.profiles.get(agentId);
    expect(profile?.env.API_SERVER_KEY).toBe(deriveProfileKey(KEY_SECRET, agentId));
    expect(profile?.soul).toContain("Аналитик");

    const listed = await client.call("agents.list");
    expect(listed.payload.agents).toContainEqual(expect.objectContaining({ id: agentId, name: "Аналитик" }));

    // A second hire under the same name never reuses the first one's profile:
    // Hermes keeps a deleted profile's state database open.
    const again = await client.call("agents.create", { name: "Аналитик" });
    expect(again.payload.agentId).toMatch(/^analitik-[0-9a-f]{6}$/);
    expect(again.payload.agentId).not.toBe(agentId);
    client.close();
  });

  it("streams_a_reply_with_tool_calls_and_finishes_it", async () => {
    fake.setNextRun({
      kind: "reply",
      deltas: ["При", "вет!"],
      tools: [{ tool: "web_search", preview: "погода", result: "солнечно" }],
    });
    const client = await openClient(runtime!.url, runtime!.token);
    const sent = await client.call("chat.send", { sessionKey: "agent:main:main", message: "Привет", idempotencyKey: "r1" });
    expect(sent.payload).toEqual({ status: "started", runId: "r1" });

    const final = await client.waitForEvent((f) => f.event === "chat" && f.payload.state === "final");
    expect(final.payload).toMatchObject({ runId: "r1", sessionKey: "agent:main:main", message: { content: "Привет!" } });
    const deltas = client.events.filter((f) => f.event === "chat" && f.payload.state === "delta");
    expect(deltas.at(-1)?.payload.message.content).toBe("Привет!");
    const tools = client.events.filter((f) => f.event === "agent" && f.payload.stream === "tool");
    expect(tools.map((f) => f.payload.data.phase)).toEqual(["start", "result"]);
    expect(tools[1].payload.data).toMatchObject({ name: "web_search", result: { text: "солнечно" }, isError: false });

    const history = await client.call("chat.history", { sessionKey: "agent:main:main" });
    expect(history.payload.messages.map((m: { content: string }) => m.content)).toEqual(["Привет", "Привет!"]);
    client.close();
  });

  it("passes_agent_files_to_every_run_as_instructions", async () => {
    const client = await openClient(runtime!.url, runtime!.token);
    await client.call("agents.files.set", { agentId: "main", name: "IDENTITY.md", content: "- Name: Штаб\n- Emoji: 🧭" });
    await client.call("chat.send", { sessionKey: "agent:main:main", message: "Кто ты?", idempotencyKey: "r2" });
    await client.waitForEvent((f) => f.event === "chat" && f.payload.state === "final");
    const run = [...fake.runs.values()].at(-1);
    expect(run?.instructions).toContain("Штаб");
    const listed = await client.call("agents.list");
    expect(listed.payload.agents[0]).toMatchObject({ name: "Штаб", identity: { emoji: "🧭" } });
    client.close();
  });

  it("relays_an_approval_request_and_the_decision", async () => {
    fake.setNextRun({ kind: "approval", command: "rm -rf build", afterApproval: "Удалил." });
    const client = await openClient(runtime!.url, runtime!.token);
    await client.call("chat.send", { sessionKey: "agent:main:main", message: "Почисти", idempotencyKey: "r3" });
    const requested = await client.waitForEvent((f) => f.event === "exec.approval.requested");
    expect(requested.payload.request).toMatchObject({ command: "rm -rf build", agentId: "main", sessionKey: "agent:main:main" });

    const resolved = await client.call("exec.approval.resolve", { id: requested.payload.id, decision: "allow-once" });
    expect(resolved.ok).toBe(true);
    const final = await client.waitForEvent((f) => f.event === "chat" && f.payload.state === "final");
    expect(final.payload.message.content).toBe("Удалил.");
    client.close();
  });

  it("stops_a_running_turn", async () => {
    fake.setNextRun({ kind: "wait-for-stop" });
    const client = await openClient(runtime!.url, runtime!.token);
    await client.call("chat.send", { sessionKey: "agent:main:main", message: "Думай долго", idempotencyKey: "r4" });
    await client.waitForEvent((f) => f.event === "chat" && f.payload.state === "delta");
    const aborted = await client.call("chat.abort", { runId: "r4" });
    expect(aborted.payload).toEqual({ ok: true, aborted: 1 });
    await client.waitForEvent((f) => f.event === "chat" && f.payload.state === "aborted");
    client.close();
  });

  it("reports_a_failed_run_as_an_error", async () => {
    fake.setNextRun({ kind: "fail", error: "provider refused" });
    const client = await openClient(runtime!.url, runtime!.token);
    await client.call("chat.send", { sessionKey: "agent:main:main", message: "?", idempotencyKey: "r5" });
    const error = await client.waitForEvent((f) => f.event === "chat" && f.payload.state === "error");
    expect(error.payload.errorMessage).toBe("provider refused");
    client.close();
  });

  it("maps_scheduled_jobs_both_ways", async () => {
    const client = await openClient(runtime!.url, runtime!.token);
    const added = await client.call("cron.add", {
      name: "Сводка",
      agentId: "main",
      schedule: { kind: "every", everyMs: 3_600_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Собери сводку" },
    });
    expect(added.payload).toMatchObject({ id: "main~job1", schedule: { kind: "every", everyMs: 3_600_000 }, enabled: true });
    const listed = await client.call("cron.list", {});
    expect(listed.payload.jobs).toHaveLength(1);
    const paused = await client.call("cron.patch", { id: "main~job1", patch: { enabled: false } });
    expect(paused.payload.enabled).toBe(false);
    client.close();
  });

  it("lists_models_of_signed_in_providers_as_provider_slash_model", async () => {
    const client = await openClient(runtime!.url, runtime!.token);
    const result = await client.call("models.list");
    expect(result.payload.models).toEqual([{ id: "custom/test-model", name: "test-model", provider: "custom" }]);
    client.close();
  });

  it("sends_a_chosen_model_to_hermes_as_provider_and_model", async () => {
    const client = await openClient(runtime!.url, runtime!.token);
    await client.call("models.list");
    await client.call("sessions.patch", { key: "agent:main:main", model: "custom/test-model" });
    await client.call("chat.send", { sessionKey: "agent:main:main", message: "?", idempotencyKey: "m1" });
    await client.waitForEvent((f) => f.event === "chat" && f.payload.state === "final");
    const runRequest = fake.requests.filter((r) => r.path === "/v1/runs").at(-1);
    expect(runRequest?.body).toMatchObject({ provider: "custom", model: "test-model" });
    client.close();
  });

  it("starts_a_new_hire_with_a_clean_memory_of_its_own", async () => {
    const client = await openClient(runtime!.url, runtime!.token);
    const created = await client.call("agents.create", { name: "Писатель" });
    expect(fake.memoryResets).toContain(`${created.payload.agentId}:memory`);
    client.close();
  });

  it("reports_providers_sign_ins_and_writable_keys_without_values", async () => {
    const client = await openClient(runtime!.url, runtime!.token);
    const status = await client.call("hermes.providers.status");
    expect(status.payload.providers.map((p: { slug: string }) => p.slug)).toEqual(["custom", "openrouter"]);
    expect(status.payload.signIns[0]).toMatchObject({ id: "nous", signedIn: false });
    const keys = status.payload.keys.map((k: { key: string }) => k.key);
    expect(keys).toEqual(["OPENROUTER_API_KEY", "TAVILY_API_KEY"]);
    expect(keys).not.toContain("API_SERVER_KEY");
    client.close();
  });

  it("writes_a_provider_key_to_every_agent_profile", async () => {
    const client = await openClient(runtime!.url, runtime!.token);
    const created = await client.call("agents.create", { name: "Исследователь" });
    const result = await client.call("hermes.providers.setKey", { key: "OPENROUTER_API_KEY", value: "sk-or-good" });
    expect(result.payload).toMatchObject({ ok: true, verified: true, failed: [] });
    expect(fake.profiles.get("default")?.env.OPENROUTER_API_KEY).toBe("sk-or-good");
    expect(fake.profiles.get(created.payload.agentId)?.env.OPENROUTER_API_KEY).toBe("sk-or-good");
    client.close();
  });

  it("does_not_save_a_key_the_provider_rejects", async () => {
    const client = await openClient(runtime!.url, runtime!.token);
    const result = await client.call("hermes.providers.setKey", { key: "OPENROUTER_API_KEY", value: "bad-key" });
    expect(result.payload).toMatchObject({ ok: false, message: "That API key was rejected." });
    expect(fake.profiles.get("default")?.env.OPENROUTER_API_KEY).toBeUndefined();
    client.close();
  });

  it("refuses_to_touch_keys_outside_provider_tool_and_skill_categories", async () => {
    const client = await openClient(runtime!.url, runtime!.token);
    const result = await client.call("hermes.providers.setKey", { key: "API_SERVER_KEY", value: "hijack-0123456789" });
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(fake.profiles.get("default")?.env.API_SERVER_KEY).toBe(DEFAULT_KEY);
    client.close();
  });

  it("runs_a_device_code_sign_in", async () => {
    const client = await openClient(runtime!.url, runtime!.token);
    const started = await client.call("hermes.signin.start", { provider: "nous" });
    expect(started.payload).toEqual({
      sessionId: "s1", verificationUrl: "https://portal.example/device", userCode: "ABCD-1234", expiresIn: 900, interval: 3,
    });
    const polled = await client.call("hermes.signin.poll", { provider: "nous", sessionId: "s1" });
    expect(polled.payload).toMatchObject({ status: "approved", account: "boss@example.com" });
    client.close();
  });

  it("sets_an_agents_model_on_its_profile", async () => {
    const client = await openClient(runtime!.url, runtime!.token);
    const result = await client.call("hermes.agents.setModel", { agentId: "main", provider: "openrouter", model: "anthropic/claude-sonnet-5" });
    expect(result.ok).toBe(true);
    expect(fake.modelChoices.get("default")).toEqual({ provider: "openrouter", model: "anthropic/claude-sonnet-5" });
    client.close();
  });

  it("serves_the_task_board_from_hermes_kanban_as_the_source_of_truth", async () => {
    const client = await openClient(runtime!.url, runtime!.token);
    const created = await client.call("tasks.create", { title: "Исследовать рынок", description: "Кратко" });
    expect(created.payload).toMatchObject({ title: "Исследовать рынок", status: "todo", assignedAgentId: null });
    // No assignee: the task waits in triage for the main agent or a person.
    expect(fake.kanbanTasks.get(created.payload.id)?.status).toBe("triage");

    const assigned = await client.call("tasks.update", { id: created.payload.id, assignedAgentId: "main", status: "todo" });
    expect(fake.kanbanTasks.get(created.payload.id)).toMatchObject({ assignee: "default", status: "ready" });
    expect(assigned.payload.assignedAgentId).toBe("main");

    const listed = await client.call("tasks.list", { includeArchived: true });
    expect(listed.payload.authoritative).toBe(true);
    expect(listed.payload.tasks).toHaveLength(1);

    await client.call("tasks.update", { id: created.payload.id, archived: true });
    expect(fake.kanbanTasks.get(created.payload.id)?.status).toBe("archived");
    client.close();
  });

  it("maps_hermes_statuses_onto_office_columns", async () => {
    const { taskToRecord, hermesStatusFor } = await import("../../server/hermes/kanban.js");
    expect(taskToRecord({ id: "t1", title: "x", status: "running", assignee: "default", created_at: 1 })).toMatchObject({
      status: "in_progress",
      assignedAgentId: "main",
    });
    expect(taskToRecord({ id: "t2", title: "x", status: "triage", created_at: 1 }).notes[0]).toMatch(/разбора/);
    expect(hermesStatusFor("todo", { assigned: false })).toBe("triage");
    expect(hermesStatusFor("in_progress", { assigned: true })).toBe("ready");
    expect(hermesStatusFor("done", { assigned: true })).toBe("done");
  });

  it("writes_the_mission_and_role_rules_into_every_agents_soul", async () => {
    const client = await openClient(runtime!.url, runtime!.token);
    const hired = await client.call("agents.create", { name: "Аналитик" });
    const result = await client.call("org.setMission", { text: "Сделать лучший сервис доставки в городе" });
    expect(result.payload).toMatchObject({ ok: true, failed: [] });
    const mainSoul = fake.profiles.get("default")!.soul;
    const memberSoul = fake.profiles.get(hired.payload.agentId)!.soul;
    for (const soul of [mainSoul, memberSoul]) {
      expect(soul).toContain("Сделать лучший сервис доставки в городе");
      expect(soul.match(/office3d:organization —/g)).toHaveLength(1);
    }
    expect(mainSoul).toContain("kanban_create");
    expect(memberSoul).toContain("Задачи ставят только главный агент и руководитель");
    expect(memberSoul).toContain("Аналитик");

    // The office edits the persona only; the block survives the save.
    const file = await client.call("agents.files.get", { agentId: hired.payload.agentId, name: "SOUL.md" });
    expect(file.payload.file.content).not.toContain("office3d:organization");
    await client.call("agents.files.set", { agentId: hired.payload.agentId, name: "SOUL.md", content: "# Новый характер" });
    const saved = fake.profiles.get(hired.payload.agentId)!.soul;
    expect(saved.startsWith("# Новый характер")).toBe(true);
    expect(saved).toContain("Сделать лучший сервис доставки в городе");
    client.close();
  });

  it("hands_the_current_mission_to_every_run_of_an_ongoing_conversation", async () => {
    const client = await openClient(runtime!.url, runtime!.token);
    await client.call("chat.send", { sessionKey: "agent:main:main", message: "Привет", idempotencyKey: "m1" });
    await client.waitForEvent((f) => f.event === "chat" && f.payload.runId === "m1" && f.payload.state === "final");
    expect([...fake.runs.values()].at(-1)?.instructions ?? "").not.toContain("Текущая миссия");

    // The session already exists, so Hermes keeps its old system prompt; the
    // new mission has to come with the run.
    await client.call("org.setMission", { text: "Открыть вторую точку" });
    await client.call("chat.send", { sessionKey: "agent:main:main", message: "Что дальше?", idempotencyKey: "m2" });
    await client.waitForEvent((f) => f.event === "chat" && f.payload.runId === "m2" && f.payload.state === "final");
    expect([...fake.runs.values()].at(-1)?.instructions).toContain("Открыть вторую точку");
    client.close();
  });

  it("starts_a_fresh_uniquely_titled_hermes_session_after_a_reset", async () => {
    const client = await openClient(runtime!.url, runtime!.token);
    const talk = async (runId: string) => {
      await client.call("chat.send", { sessionKey: "agent:main:main", message: "Привет", idempotencyKey: runId });
      await client.waitForEvent((f) => f.event === "chat" && f.payload.runId === runId && f.payload.state === "final");
      return [...fake.runs.values()].at(-1)!.sessionId;
    };
    const first = await talk("s1");
    await client.call("sessions.reset", { key: "agent:main:main" });
    const second = await talk("s2");
    await client.call("sessions.reset", { key: "agent:main:main" });
    const third = await talk("s3");
    expect(new Set([first, second, third]).size).toBe(3);
    // Not "…-1", "…-2": an id Hermes may still hold from an earlier install
    // would bring back that conversation and its frozen system prompt.
    expect(second).not.toMatch(/-1$/);
    expect(new Set([...fake.sessions.values()].map((s) => s.title)).size).toBe(fake.sessions.size);
    client.close();
  });

  it("gives_the_main_agent_the_kanban_tools_and_keeps_its_others", async () => {
    await runtime!.adapter.organization.reconcile();
    expect([...fake.toolsets.get("default")!].sort()).toEqual(["kanban", "memory", "terminal", "web"]);
  });

  // --- the team: proposals over MCP, decisions in the office ---------------------------

  const mcp = async (profile: string, method: string, params: Record<string, unknown> = {}) => {
    const res = await fetch(`${runtime!.mcpUrl}/mcp/${profile}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deriveMcpToken(KEY_SECRET, profile)}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return (await res.json()) as Loose;
  };
  const tool = (profile: string, name: string, args: Record<string, unknown>) => mcp(profile, "tools/call", { name, arguments: args });

  it("hires_only_after_the_person_approves_the_main_agents_proposal", async () => {
    const client = await openClient(runtime!.url, runtime!.token);
    const proposed = await tool("default", "office_propose_hire", {
      name: "Маркетолог",
      role: "продвижение",
      reason: "Некому вести соцсети, а это ключ к миссии.",
      instructions: "# Маркетолог\n\nВедёшь соцсети кофейни.",
    });
    expect(proposed.result.isError).toBeFalsy();
    const proposal = proposed.result.structuredContent.proposal;
    expect(proposal).toMatchObject({ kind: "hire", status: "pending", name: "Маркетолог" });
    await client.waitForEvent((f) => f.event === "org.proposal" && f.payload.proposal.id === proposal.id);
    // Nothing happens to the team until the person decides.
    expect([...fake.profiles.keys()]).toEqual(["default"]);

    const decided = await client.call("org.proposals.decide", { id: proposal.id, approve: true, note: "Бери" });
    expect(decided.payload.proposal).toMatchObject({ status: "done", note: "Бери" });
    const hired = fake.profiles.get(decided.payload.proposal.agentId)!;
    expect(hired.soul.startsWith("# Маркетолог")).toBe(true);
    expect(hired.soul).toContain("office3d:organization");

    // The main agent hears the decision in its office chat.
    await client.waitForEvent((f) => f.event === "chat" && f.payload.sessionKey === "agent:main:main" && f.payload.state === "final");
    const told = [...fake.runs.values()].at(-1)!;
    expect(told.profile).toBe("default");
    expect(told.input).toContain("одобрил найм «Маркетолог»");

    const again = await client.call("org.proposals.decide", { id: proposal.id, approve: true });
    expect(again).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    client.close();
  });

  it("tells_the_main_agent_when_the_person_rejects", async () => {
    const client = await openClient(runtime!.url, runtime!.token);
    const proposed = await tool("default", "office_propose_hire", { name: "Юрист", role: "договоры", reason: "Много договоров." });
    const id = proposed.result.structuredContent.proposal.id;
    const decided = await client.call("org.proposals.decide", { id, approve: false, note: "Пока рано" });
    expect(decided.payload.proposal.status).toBe("rejected");
    await client.waitForEvent((f) => f.event === "chat" && f.payload.state === "final");
    expect([...fake.runs.values()].at(-1)!.input).toContain("отклонил найм «Юрист»");
    expect([...fake.profiles.keys()]).toEqual(["default"]);
    const listed = await tool("default", "office_proposals", { status: "rejected" });
    expect(listed.result.structuredContent.proposals).toHaveLength(1);
    client.close();
  });

  it("dismisses_on_approval_and_hands_the_open_tasks_back_to_triage", async () => {
    const client = await openClient(runtime!.url, runtime!.token);
    const hired = await client.call("agents.create", { name: "Курьер" });
    const agentId = hired.payload.agentId;
    const task = await client.call("tasks.create", { title: "Отвезти заказ", assignedAgentId: agentId });
    expect(fake.kanbanTasks.get(task.payload.id)).toMatchObject({ assignee: agentId, status: "ready" });

    const refused = await tool("default", "office_propose_dismiss", { agent_id: "main", reason: "так" });
    expect(refused.result.isError).toBe(true);

    const proposed = await tool("default", "office_propose_dismiss", { agent_id: agentId, reason: "Доставку отдали партнёру." });
    const id = proposed.result.structuredContent.proposal.id;
    const decided = await client.call("org.proposals.decide", { id, approve: true });
    expect(decided.payload.proposal.status).toBe("done");
    expect(fake.profiles.has(agentId)).toBe(false);
    expect(fake.kanbanTasks.get(task.payload.id)).toMatchObject({ assignee: null, status: "triage" });
    expect(JSON.stringify(fake.kanbanTasks.get(task.payload.id)!.comments)).toContain("уволен");
    client.close();
  });

  it("gives_every_agent_its_own_office3d_mcp_access", async () => {
    await runtime!.adapter.organization.reconcile();
    const main = fake.profiles.get("default")!;
    expect(main.mcp.office3d_team).toMatchObject({
      url: `${runtime!.mcpUrl}/mcp/default`,
      headers: { Authorization: "Bearer ${OFFICE3D_MCP_TOKEN}" },
      enabled: true,
    });
    expect(main.env.OFFICE3D_MCP_TOKEN).toBe(deriveMcpToken(KEY_SECRET, "default"));

    // A hire is a clone of the main profile: it must not keep the main
    // agent's entry or token.
    const client = await openClient(runtime!.url, runtime!.token);
    const hired = await client.call("agents.create", { name: "Повар" });
    const member = fake.profiles.get(hired.payload.agentId)!;
    expect(Object.keys(member.mcp)).toEqual(["office3d"]);
    expect(member.mcp.office3d.url).toBe(`${runtime!.mcpUrl}/mcp/${hired.payload.agentId}`);
    expect(member.env.OFFICE3D_MCP_TOKEN).toBe(deriveMcpToken(KEY_SECRET, hired.payload.agentId));
    expect(member.env.OFFICE3D_MCP_TOKEN).not.toBe(main.env.OFFICE3D_MCP_TOKEN);
    client.close();
  });

  it("sets_up_a_profile_created_outside_the_office_when_it_first_appears", async () => {
    await runtime!.adapter.organization.reconcile();
    const main = fake.profiles.get("default")!;
    fake.profiles.set("manual-1", { name: "manual-1", description: "", env: { ...main.env }, soul: "# Ручной", mcp: structuredClone(main.mcp) });
    await runtime!.adapter.listProfiles({ fresh: true });
    const deadline = Date.now() + 3000;
    while (fake.profiles.get("manual-1")!.mcp.office3d_team && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const manual = fake.profiles.get("manual-1")!;
    expect(Object.keys(manual.mcp)).toEqual(["office3d"]);
    expect(manual.env.OFFICE3D_MCP_TOKEN).toBe(deriveMcpToken(KEY_SECRET, "manual-1"));
    await new Promise((r) => setTimeout(r, 100));
    expect(manual.soul).toContain("office3d:organization");
  });

  it("gives_team_tools_to_the_main_agent_only", async () => {
    const client = await openClient(runtime!.url, runtime!.token);
    const hired = await client.call("agents.create", { name: "Бариста" });
    const member = hired.payload.agentId;
    const mainTools = (await mcp("default", "tools/list")).result.tools.map((t: { name: string }) => t.name);
    expect(mainTools).toEqual(["office_team_list", "office_propose_hire", "office_propose_dismiss", "office_proposals"]);
    const memberTools = (await mcp(member, "tools/list")).result.tools.map((t: { name: string }) => t.name);
    expect(memberTools).toEqual(["office_team_list"]);
    const sneaky = await tool(member, "office_propose_hire", { name: "Друг", role: "друг", reason: "хочу" });
    expect(sneaky.error.code).toBe(-32602);
    const team = await tool(member, "office_team_list", {});
    expect(team.result.structuredContent.team.map((m: { name: string }) => m.name)).toEqual(["Hermes", "Бариста"]);
    client.close();
  });

  it("caps_how_many_proposals_can_wait_at_once", async () => {
    for (let i = 0; i < 10; i += 1) {
      const ok = await tool("default", "office_propose_hire", { name: `Сотрудник ${i}`, role: "r", reason: "нужен" });
      expect(ok.result.isError).toBeFalsy();
    }
    const duplicate = await tool("default", "office_propose_hire", { name: "сотрудник 3", role: "r", reason: "нужен" });
    expect(duplicate.result.isError).toBeFalsy();
    expect(duplicate.result.content[0].text).toContain("уже ждёт");
    const over = await tool("default", "office_propose_hire", { name: "Лишний", role: "r", reason: "нужен" });
    expect(over.result.isError).toBe(true);
    expect(over.result.content[0].text).toContain("ждут решения");
  });

  it("answers_unknown_methods_with_not_implemented", async () => {
    const client = await openClient(runtime!.url, runtime!.token);
    const result = await client.call("usage.cost", {});
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_IMPLEMENTED" } });
    client.close();
  });

  it("refuses_to_delete_the_main_agent", async () => {
    const client = await openClient(runtime!.url, runtime!.token);
    const result = await client.call("agents.delete", { agentId: "main" });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    client.close();
  });
});

describe("hermes adapter helpers", () => {
  it("turns_office_names_into_hermes_profile_ids", () => {
    expect(slugifyProfileName("Главный Аналитик")).toBe("glavnyy-analitik");
    expect(slugifyProfileName("Writer 2")).toBe("writer-2");
    expect(slugifyProfileName("!!!")).toBe("agent");
  });

  it("converts_office_schedules_to_hermes_ones", () => {
    expect(scheduleToHermes({ kind: "every", everyMs: 90_000 })).toBe("every 2m");
    expect(scheduleToHermes({ kind: "cron", expr: "0 9 * * *" })).toBe("0 9 * * *");
    expect(scheduleToHermes({ kind: "at", at: "2030-01-01T00:00:00Z" })).toBe("2030-01-01T00:00:00.000Z");
  });

  it("reads_name_and_emoji_from_identity_files", () => {
    expect(parseIdentity("# Identity\n- **Name:** Штаб\n- **Emoji:** 🧭")).toEqual({ name: "Штаб", emoji: "🧭" });
  });

  it("applies_json_merge_patches", () => {
    expect(mergePatch({ a: 1, b: { c: 2 } }, { b: { c: null, d: 3 }, e: 4 })).toEqual({ a: 1, b: { d: 3 }, e: 4 });
  });
});
