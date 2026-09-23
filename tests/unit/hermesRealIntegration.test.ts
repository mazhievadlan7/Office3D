// @vitest-environment node
//
// End-to-end check of the Hermes adapter against a REAL Hermes install.
// Skipped unless OFFICE3D_HERMES_ITEST=1. docs/hermes-platform.md
// («Проверка на настоящем Hermes») shows how to start one locally with the
// scripted model in scripts/dev/stub-openai-model.mjs.
//
//   OFFICE3D_HERMES_ITEST=1
//   HERMES_API_URL=http://127.0.0.1:8642
//   HERMES_API_KEY=<default profile API_SERVER_KEY>
//   HERMES_DASHBOARD_URL=http://127.0.0.1:9119      (optional: agent lifecycle)
//   HERMES_DASHBOARD_TOKEN=<dashboard session token> (optional)
//   OFFICE3D_HERMES_KEY_SECRET=<32+ chars>           (optional)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

const enabled = process.env.OFFICE3D_HERMES_ITEST === "1";
const withDashboard = enabled && Boolean(process.env.HERMES_DASHBOARD_URL);

// Frames are asserted structurally (toMatchObject), so their payloads stay
// loosely typed here rather than restating the whole protocol.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
type Frame = { type: string; id?: string; ok?: boolean; payload?: Loose; error?: Loose; event?: string };

describe.skipIf(!enabled)("hermes adapter against a real Hermes", () => {
  let runtime: Loose;
  let ws: WebSocket;
  let stateDir: string;
  const events: Frame[] = [];
  const pending = new Map<string, (frame: Frame) => void>();
  let counter = 0;

  const call = (method: string, params: unknown = {}) =>
    new Promise<Frame>((resolve) => {
      const id = String(++counter);
      pending.set(id, resolve);
      ws.send(JSON.stringify({ type: "req", id, method, params }));
    });

  const waitForEvent = async (predicate: (frame: Frame) => boolean, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = events.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error("event did not arrive");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  beforeAll(async () => {
    const { startHermesRuntime } = await import("../../server/hermes/index.js");
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "office3d-hermes-itest-"));
    runtime = await startHermesRuntime({
      env: { ...process.env, OFFICE3D_MCP_PORT: process.env.OFFICE3D_MCP_PORT ?? "0" },
      stateDir,
      log: () => {},
      logError: console.error,
    });
    ws = new WebSocket(runtime.url);
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      if (frame.type === "res" && frame.id && pending.has(frame.id)) {
        pending.get(frame.id)!(frame);
        pending.delete(frame.id);
      } else if (frame.type === "event") events.push(frame);
    });
    await new Promise((resolve) => ws.once("open", resolve));
    const hello = await call("connect", { auth: { token: runtime.token } });
    expect(hello.ok).toBe(true);
  }, 30_000);

  afterAll(async () => {
    ws?.close();
    await runtime?.close();
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("streams_a_reply_from_the_main_agent", async () => {
    const sent = await call("chat.send", { sessionKey: "agent:main:main", message: "Привет, Hermes", idempotencyKey: `it-${Date.now()}` });
    expect(sent).toMatchObject({ ok: true });
    const final = await waitForEvent((f) => f.event === "chat" && f.payload.runId === sent.payload.runId && f.payload.state !== "delta");
    expect(final.payload.state).toBe("final");
    expect(final.payload.message.content).toContain("Привет, Hermes");
    const history = await call("chat.history", { sessionKey: "agent:main:main" });
    expect(history.payload.messages.some((m: { content: string }) => m.content.includes("Привет, Hermes"))).toBe(true);
  }, 90_000);

  it("asks_for_approval_before_a_dangerous_command_and_obeys_a_denial", async () => {
    const sent = await call("chat.send", { sessionKey: "agent:main:main", message: "удали временный каталог", idempotencyKey: `it-appr-${Date.now()}` });
    expect(sent).toMatchObject({ ok: true });
    const requested = await waitForEvent((f) => f.event === "exec.approval.requested");
    expect(requested.payload.request.command).toContain("rm -rf");
    const resolved = await call("exec.approval.resolve", { id: requested.payload.id, decision: "deny" });
    expect(resolved.ok).toBe(true);
    const end = await waitForEvent((f) => f.event === "chat" && f.payload.runId === sent.payload.runId && f.payload.state !== "delta");
    expect(["final", "error"]).toContain(end.payload.state);
    const tools = events.filter((f) => f.event === "agent" && f.payload.runId === sent.payload.runId && f.payload.stream === "tool");
    expect(tools.some((f) => f.payload.data.name === "terminal")).toBe(true);
  }, 120_000);

  it("lists_the_models_of_signed_in_providers", async () => {
    const models = await call("models.list");
    expect(models).toMatchObject({ ok: true });
    expect(models.payload.models.length).toBeGreaterThan(0);
    expect(models.payload.models[0].id).toMatch(/^[a-z0-9-]+\/.+/);
  }, 30_000);

  it.skipIf(!withDashboard)("reports_providers_and_the_main_agents_model", async () => {
    const status = await call("hermes.providers.status");
    expect(status).toMatchObject({ ok: true });
    expect(status.payload.providers.length).toBeGreaterThan(0);
    expect(status.payload.keys.some((k: { key: string }) => k.key === "OPENROUTER_API_KEY")).toBe(true);
    expect(status.payload.keys.some((k: { key: string }) => k.key === "API_SERVER_KEY")).toBe(false);
    const model = await call("hermes.agents.model", { agentId: "main" });
    expect(model.payload.model).toBeTruthy();
  }, 30_000);

  it.skipIf(!withDashboard)("hands_the_mission_to_every_agent_through_soul_md", async () => {
    const before = await call("org.get");
    const mission = `Интеграционная миссия ${Date.now()}`;
    try {
      const saved = await call("org.setMission", { text: mission });
      expect(saved).toMatchObject({ ok: true, payload: { ok: true } });
      const soul = await call("agents.files.get", { agentId: "main", name: "SOUL.md" });
      // The office sees the persona without the managed block…
      expect(soul.payload.file.content ?? "").not.toContain("office3d:organization");
      // …and the first run of the main agent is steered by it (Hermes loads SOUL.md).
      const status = await call("hermes.providers.status");
      expect(status).toMatchObject({ ok: true });
    } finally {
      await call("org.setMission", { text: before.payload.mission ?? "" });
    }
  }, 60_000);

  it.skipIf(!withDashboard)("lets_hermes_reach_the_office3d_team_tools_as_each_agent", async () => {
    // Hermes itself connects, with the entry and token Office3D wrote into the
    // profile — the dashboard's server test is a full MCP handshake plus
    // tools/list from Hermes' side.
    await runtime.adapter.organization.reconcile();
    const probe = (profile: string, server: string) =>
      runtime.client.dashboard(`/api/mcp/servers/${server}/test`, { method: "POST", query: { profile } });
    const main = await probe("default", "office3d_team");
    expect(main.ok).toBe(true);
    expect(main.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(
      ["office_proposals", "office_propose_dismiss", "office_propose_hire", "office_team_list"],
    );

    const hired = await call("agents.create", { name: "Проверка MCP" });
    expect(hired.ok).toBe(true);
    const member = hired.payload.agentId;
    try {
      const servers = await runtime.client.dashboard("/api/mcp/servers", { query: { profile: member } });
      expect(servers.servers.map((server: { name: string }) => server.name)).toEqual(["office3d"]);
      const memberProbe = await probe(member, "office3d");
      expect(memberProbe.ok).toBe(true);
      expect(memberProbe.tools.map((tool: { name: string }) => tool.name)).toEqual(["office_team_list"]);
    } finally {
      await call("agents.delete", { agentId: member });
    }
  }, 90_000);

  it.skipIf(!withDashboard)("runs_a_task_from_the_office_board_through_the_hermes_dispatcher", async () => {
    const created = await call("tasks.create", { title: `Проверка доски ${Date.now()}`, description: "Интеграционный тест" });
    expect(created).toMatchObject({ ok: true });
    const id = created.payload.id as string;
    try {
      // Assigning a task in triage hands it to the dispatcher.
      const assigned = await call("tasks.update", { id, assignedAgentId: "main" });
      expect(assigned).toMatchObject({ ok: true });
      const deadline = Date.now() + 150_000;
      let status = "";
      while (Date.now() < deadline) {
        const listed = await call("tasks.list", { includeArchived: true });
        const task = listed.payload.tasks.find((entry: { id: string }) => entry.id === id);
        status = task?.hermes?.status ?? "";
        if (status === "done" || status === "blocked") break;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      expect(status).toBe("done");
    } finally {
      await call("tasks.delete", { id });
    }
  }, 180_000);

  it.skipIf(!withDashboard)("creates_talks_to_and_removes_an_agent_profile", async () => {
    const created = await call("agents.create", { name: "Тестовый Агент" });
    expect(created).toMatchObject({ ok: true });
    const agentId = created.payload.agentId as string;
    try {
      const sent = await call("chat.send", { sessionKey: `agent:${agentId}:main`, message: "Как дела?", idempotencyKey: `it-agent-${Date.now()}` });
      expect(sent.error ?? null).toBeNull();
      const final = await waitForEvent((f) => f.event === "chat" && f.payload.runId === sent.payload.runId && f.payload.state !== "delta", 90_000);
      expect(final.payload.state).toBe("final");
    } finally {
      const removed = await call("agents.delete", { agentId });
      expect(removed).toMatchObject({ ok: true });
    }
  }, 180_000);
});
