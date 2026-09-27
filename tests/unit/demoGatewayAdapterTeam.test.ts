import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGatewayRuntimeEventHandler } from "@/features/agents/state/gatewayRuntimeEventHandler";
import type { AgentState } from "@/features/agents/state/store";
import type { EventFrame } from "@/lib/gateway/GatewayClient";
import { resolveOfficeIntentSnapshot } from "@/lib/office/deskDirectives";

const adapter = await import("../../server/demo-gateway-adapter.js");
const {
  handleMethod,
  LEAD_AGENT_ID,
  TEAM_ROLES,
  ROLE_LABELS,
  ROLE_PROFILES,
  GENERIC_PROFILE,
  resolveAgentCount,
  buildDemoTeam,
  buildDemoReply,
  isAmbientActivityEnabled,
  startAmbientActivity,
  stopAmbientActivity,
  getAmbientSnapshot,
  subscribeEvents,
  resetDemoState,
} = adapter;

// Frames and payloads are asserted structurally, so they stay loosely typed
// here rather than restating the whole gateway protocol.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
type Stamped = Loose & { at: number };

// Seeded, so a failing run can be replayed exactly.
const mulberry32 = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const noop = () => {};

const call = async (
  method: string,
  params: Record<string, unknown> = {},
  sendEvent: (frame: Loose) => void = noop,
): Promise<Loose> => {
  const res = (await handleMethod(method, params, "req", sendEvent)) as Loose;
  expect(res.ok).toBe(true);
  return res.payload;
};

const frameKind = (frame: Loose): string => {
  if (frame.event === "chat") {
    const role = frame.payload?.message?.role;
    return role ? `chat:${frame.payload.state}:${role}` : `chat:${frame.payload.state}`;
  }
  if (frame.event === "agent") return `agent:${frame.payload.stream}:${frame.payload.data?.phase}`;
  return frame.event;
};

const collect = () => {
  const frames: Stamped[] = [];
  const unsubscribe = subscribeEvents((frame: Loose) => {
    frames.push({ ...frame, at: Date.now() });
  });
  return { frames, unsubscribe };
};

const runsOf = (frames: Stamped[]) => {
  const runs = new Map<string, Stamped[]>();
  for (const frame of frames) {
    const runId = frame.payload?.runId;
    if (typeof runId !== "string") continue;
    const list = runs.get(runId) ?? [];
    list.push(frame);
    runs.set(runId, list);
  }
  return runs;
};

const isLifecycle = (frame: Stamped, phase: string) =>
  frame.event === "agent" && frame.payload.stream === "lifecycle" && frame.payload.data?.phase === phase;

afterEach(() => {
  vi.useRealTimers();
  resetDemoState({ agentCount: 100 });
});

describe("demo team", () => {
  it("clamps DEMO_AGENT_COUNT to 1..1000 with 300 by default", () => {
    expect(resolveAgentCount(undefined)).toBe(300);
    expect(resolveAgentCount("")).toBe(300);
    expect(resolveAgentCount("many")).toBe(300);
    expect(resolveAgentCount("0")).toBe(1);
    expect(resolveAgentCount("-5")).toBe(1);
    expect(resolveAgentCount("5000")).toBe(1000);
    expect(resolveAgentCount(" 300 ")).toBe(300);
    expect(resolveAgentCount("12.9")).toBe(12);
    expect(resolveAgentCount(42)).toBe(42);
  });

  it("reads the team size from the environment", async () => {
    const previous = process.env.DEMO_AGENT_COUNT;
    try {
      process.env.DEMO_AGENT_COUNT = "2500";
      resetDemoState();
      expect((await call("agents.list")).agents).toHaveLength(1000);
      process.env.DEMO_AGENT_COUNT = "7";
      resetDemoState();
      expect((await call("agents.list")).agents).toHaveLength(7);
      delete process.env.DEMO_AGENT_COUNT;
      resetDemoState();
      expect((await call("agents.list")).agents).toHaveLength(300);
    } finally {
      if (previous === undefined) delete process.env.DEMO_AGENT_COUNT;
      else process.env.DEMO_AGENT_COUNT = previous;
    }
  });

  it("puts the lead AM7 first under the office's main id", async () => {
    const team = buildDemoTeam(5);
    expect(team[0]).toMatchObject({ id: "main", name: "AM7", role: "Lead" });
    expect(LEAD_AGENT_ID).toBe("main");

    resetDemoState({ agentCount: 5 });
    const list = await call("agents.list");
    expect(list.defaultId).toBe("main");
    expect(list.agents[0]).toMatchObject({ id: "main", name: "AM7", role: "Главный хакер" });
    expect(list.agents.slice(1).map((agent: Loose) => agent.role)).toEqual([
      "Разведка",
      "Веб и API",
      "Сеть",
      "Идентификация",
    ]);

    // The office never deletes its main agent; neither does the gateway.
    await call("agents.delete", { agentId: "main" });
    expect((await call("agents.list")).agents[0].id).toBe("main");
  });

  it("gives 1000 agents unique safe ids and unique short call signs", () => {
    const team = buildDemoTeam(1000);
    expect(team).toHaveLength(1000);
    const ids = team.map((agent) => agent.id);
    expect(new Set(ids).size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9_-]+$/);
    expect(ids.slice(1, 3)).toEqual(["agent-001", "agent-002"]);
    expect(ids.at(-1)).toBe("agent-999");

    const names = team.map((agent) => agent.name);
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(1000);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(10);
    // The team's call signs are letters only; the first pass is the plain list.
    for (const name of names.slice(1)) expect(name).toMatch(/^[A-Za-z]+$/);
    expect(names.slice(1, 4)).toEqual(["Nyx", "Vex", "Kade"]);

    team.slice(1).forEach((agent, index) => {
      expect(agent.role).toBe(TEAM_ROLES[index % TEAM_ROLES.length]);
    });
    for (const role of ["Lead", ...TEAM_ROLES]) {
      expect(ROLE_LABELS[role as keyof typeof ROLE_LABELS]).toBeTruthy();
      expect(ROLE_PROFILES[role as keyof typeof ROLE_PROFILES]).toBeTruthy();
    }
  });

  it("answers in Russian, in character", () => {
    resetDemoState({ agentCount: 12 });
    const [lead, recon, , , , , , exploit] = buildDemoTeam(12);
    expect(buildDemoReply(lead, "Привет!")).toContain("AM7, главный хакер штаба");
    expect(buildDemoReply(lead, "привет")).toContain("В строю 12 агентов");
    expect(buildDemoReply(lead, "Подготовь план операции.")).toContain("Задача: Подготовь план операции. Распределю");
    expect(buildDemoReply(recon, "Изучи периметр")).toContain("профиль «Разведка»");
    expect(buildDemoReply(exploit, "Посмотри узел")).toContain("«Эксплуатация»");
    expect(buildDemoReply({ id: "x", name: "Гость", role: "" }, "Помоги")).toContain("Гость на связи.");
  });

  it("reads DEMO_AMBIENT_ACTIVITY as on unless it is 0", () => {
    expect(isAmbientActivityEnabled(undefined)).toBe(true);
    expect(isAmbientActivityEnabled("1")).toBe(true);
    expect(isAmbientActivityEnabled("0")).toBe(false);
    expect(isAmbientActivityEnabled(" off ")).toBe(false);
  });
});

describe("demo gateway methods at scale", () => {
  beforeEach(() => {
    resetDemoState({ agentCount: 300 });
  });

  it("filters sessions.list by agent, search and limit", async () => {
    const one = await call("sessions.list", { agentId: "agent-042", includeGlobal: false, limit: 8 });
    expect(one.sessions).toHaveLength(1);
    expect(one.sessions[0]).toMatchObject({ key: "agent:agent-042:main", agentId: "agent-042" });

    const hydration = await call("sessions.list", {
      agentId: "main",
      search: "agent:main:main",
      limit: 4,
    });
    expect(hydration.sessions.map((entry: Loose) => entry.key)).toEqual(["agent:main:main"]);

    expect((await call("sessions.list", { agentId: "nobody" })).sessions).toEqual([]);
    expect((await call("sessions.list", { limit: 5 })).sessions).toHaveLength(5);
    expect((await call("sessions.list", {})).sessions).toHaveLength(300);
    expect((await call("sessions.list", { search: "agent:agent-29" })).sessions).toHaveLength(10);
  });

  it("keeps a chat in history and reports it through status and previews", async () => {
    vi.useFakeTimers();
    const frames: Loose[] = [];
    const started = await call(
      "chat.send",
      { sessionKey: "agent:agent-007:main", message: "Привет", idempotencyKey: "run-7" },
      (frame) => frames.push(frame),
    );
    expect(started).toMatchObject({ status: "started", runId: "run-7" });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(frames.map((frame) => frame.payload.state).filter(Boolean).at(-1)).toBe("final");
    expect(frames.every((frame) => frame.seq === undefined)).toBe(true);

    const history = await call("chat.history", { sessionKey: "agent:agent-007:main", limit: 1 });
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0]).toMatchObject({ role: "assistant" });
    expect(typeof history.messages[0].timestamp).toBe("number");

    const status = await call("status");
    expect(status.sessions.byAgent).toHaveLength(300);
    expect(status.sessions.recent).toEqual([
      { key: "agent:agent-007:main", updatedAt: expect.any(Number) },
    ]);

    const listed = await call("sessions.list", { limit: 1 });
    expect(listed.sessions[0].key).toBe("agent:agent-007:main");

    const previews = await call("sessions.preview", {
      keys: ["agent:agent-007:main", "agent:agent-008:main"],
      limit: 8,
    });
    expect(previews.previews[0].items.map((item: Loose) => item.role)).toEqual(["user", "assistant"]);
    expect(previews.previews[1]).toMatchObject({ status: "empty", items: [] });
    // Previewing or reading an empty session does not create it.
    await call("chat.history", { sessionKey: "agent:agent-009:main" });
    expect((await call("status")).sessions.recent).toHaveLength(1);
  });
});

describe("ambient activity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("keeps 35-60 % of the team at work in small, spaced runs", () => {
    resetDemoState({ agentCount: 60 });
    const { frames, unsubscribe } = collect();
    const t0 = Date.now();
    expect(startAmbientActivity({ random: mulberry32(7) })).toBe(true);
    expect(startAmbientActivity()).toBe(false);

    vi.advanceTimersByTime(60_000);
    const shares: number[] = [];
    let leadBusy = 0;
    for (let sample = 0; sample < 240; sample += 1) {
      vi.advanceTimersByTime(5_000);
      const snapshot = getAmbientSnapshot();
      shares.push(snapshot.busyAgents / snapshot.agents);
      if (snapshot.leadBusy) leadBusy += 1;
    }
    unsubscribe();

    const mean = shares.reduce((sum, share) => sum + share, 0) / shares.length;
    expect(mean).toBeGreaterThanOrEqual(0.35);
    expect(mean).toBeLessThanOrEqual(0.6);
    expect(Math.min(...shares)).toBeGreaterThan(0.25);
    expect(Math.max(...shares)).toBeLessThan(0.7);
    expect(leadBusy / shares.length).toBeGreaterThan(0.6);

    const completed = [...runsOf(frames).values()].filter((run) => run.some((f) => isLifecycle(f, "end")));
    expect(completed.length).toBeGreaterThan(100);
    for (const run of completed) {
      // The same shape as a real run, kept small: five frames.
      expect(run.map(frameKind)).toEqual([
        "chat:delta:user",
        "agent:lifecycle:start",
        "chat:delta:assistant",
        "chat:final:assistant",
        "agent:lifecycle:end",
      ]);
      const startedAt = run[0].at;
      const duration = run[run.length - 1].at - startedAt;
      // The first pass starts runs part-way through; later ones run in full.
      if (startedAt - t0 > 30_000) {
        expect(duration).toBeGreaterThanOrEqual(20_000);
        expect(duration).toBeLessThanOrEqual(120_000);
      }
    }
    expect(completed.some((run) => run[0].payload.sessionKey === "agent:main:main")).toBe(true);

    // Light traffic: about two frames per agent per minute.
    const minutes = (60_000 + 240 * 5_000) / 60_000;
    expect(frames.length / minutes / 60).toBeLessThan(4);
  });

  it("stops cleanly: every run in flight ends and nothing follows", () => {
    resetDemoState({ agentCount: 40 });
    const { frames, unsubscribe } = collect();
    startAmbientActivity({ random: mulberry32(21) });
    vi.advanceTimersByTime(45_000);
    expect(getAmbientSnapshot().ambientRuns).toBeGreaterThan(0);

    expect(stopAmbientActivity()).toBe(true);
    expect(getAmbientSnapshot()).toMatchObject({ running: false, ambientRuns: 0, pendingStarts: 0, busyAgents: 0 });
    for (const run of runsOf(frames).values()) {
      expect(isLifecycle(run[run.length - 1], "end")).toBe(true);
    }
    const count = frames.length;
    vi.advanceTimersByTime(300_000);
    expect(frames.length).toBe(count);
    unsubscribe();
  });

  it("replays runs in flight to a client that connects late, once", async () => {
    resetDemoState({ agentCount: 50 });
    const early = collect();
    startAmbientActivity({ random: mulberry32(3) });
    vi.advanceTimersByTime(40_000);

    const late: Loose[] = [];
    const lateListener = (frame: Loose) => late.push(frame);
    const unsubscribeLate = subscribeEvents(lateListener);
    const endedBefore = new Set(
      early.frames.filter((f) => isLifecycle(f, "end")).map((f) => f.payload.runId),
    );
    const inFlight = new Set(
      early.frames
        .filter((f) => isLifecycle(f, "start") && !endedBefore.has(f.payload.runId))
        .map((f) => f.payload.runId),
    );
    expect(inFlight.size).toBeGreaterThan(10);

    await call("status", {}, lateListener);
    await call("status", {}, lateListener);
    vi.advanceTimersByTime(4_000);

    const endedSince = new Set(
      early.frames.filter((f) => isLifecycle(f, "end")).map((f) => f.payload.runId),
    );
    const lateStarts = late.filter((f) => isLifecycle(f, "start")).map((f) => f.payload.runId);
    for (const runId of inFlight) {
      if (!endedSince.has(runId)) expect(lateStarts).toContain(runId);
    }
    expect(new Set(lateStarts).size).toBe(lateStarts.length);
    // Each replayed start comes with its task, as a live one does.
    for (const runId of lateStarts) {
      const own = late.filter((f) => f.payload?.runId === runId).map(frameKind);
      expect(own.indexOf("chat:delta:user")).toBeLessThan(own.indexOf("agent:lifecycle:start"));
    }

    unsubscribeLate();
    early.unsubscribe();
  });

  it("hands an agent over to the user and leaves it alone for a while", async () => {
    resetDemoState({ agentCount: 30 });
    const { frames, unsubscribe } = collect();
    startAmbientActivity({ random: mulberry32(11) });
    vi.advanceTimersByTime(20_000);

    const agentId = getAmbientSnapshot().busyAgentIds.find((id: string) => id !== LEAD_AGENT_ID);
    expect(agentId).toBeTruthy();
    const sessionKey = `agent:${agentId}:main`;
    const ambientRunId = [...runsOf(frames).entries()].find(
      ([, run]) => run[0].payload.sessionKey === sessionKey && !run.some((f) => isLifecycle(f, "end")),
    )?.[0];
    expect(ambientRunId).toBeTruthy();

    const waitRunning = handleMethod("agent.wait", { runId: ambientRunId, timeoutMs: 1 }, "w", noop);
    await vi.advanceTimersByTimeAsync(2);
    await expect(waitRunning).resolves.toMatchObject({ payload: { status: "running" } });

    const own: Loose[] = [];
    await call("chat.send", { sessionKey, message: "Привет", idempotencyKey: "user-run" }, (f) => own.push(f));
    const aborted = runsOf(frames).get(ambientRunId!)!;
    expect(aborted.slice(-2).map(frameKind)).toEqual(["chat:aborted", "agent:lifecycle:end"]);
    await expect(
      handleMethod("agent.wait", { runId: ambientRunId, timeoutMs: 1 }, "w", noop),
    ).resolves.toMatchObject({ payload: { status: "done" } });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(own.at(-2)?.payload).toMatchObject({ state: "final", runId: "user-run" });

    const mark = frames.length;
    vi.advanceTimersByTime(70_000);
    expect(
      frames.slice(mark).some((f) => isLifecycle(f, "start") && f.payload.sessionKey === sessionKey),
    ).toBe(false);
    unsubscribe();
  });

  it("drives the office's own event handler: working while the gateway works, idle after", () => {
    resetDemoState({ agentCount: 24 });
    const baseAgent = (agentId: string, name: string): AgentState => ({
      agentId,
      name,
      sessionKey: `agent:${agentId}:main`,
      status: "idle",
      sessionCreated: true,
      awaitingUserInput: false,
      hasUnseenActivity: false,
      outputLines: [],
      lastResult: null,
      lastDiff: null,
      runId: null,
      runStartedAt: null,
      streamText: null,
      thinkingTrace: null,
      latestOverride: null,
      latestOverrideKind: null,
      lastAssistantMessageAt: null,
      lastActivityAt: null,
      latestPreview: null,
      lastUserMessage: null,
      draft: "",
      sessionSettingsSynced: true,
      historyLoadedAt: null,
      historyFetchLimit: null,
      historyFetchedCount: null,
      historyMaybeTruncated: false,
      toolCallingEnabled: true,
      showThinkingTraces: true,
      model: "demo/mock-office",
      thinkingLevel: "medium",
      avatarSeed: agentId,
      avatarUrl: null,
    });
    let officeAgents = buildDemoTeam(24).map((agent) => baseAgent(agent.id, agent.name));
    const patch = (agentId: string, next: Partial<AgentState>) => {
      officeAgents = officeAgents.map((agent) => (agent.agentId === agentId ? { ...agent, ...next } : agent));
    };
    const requestHistoryRefresh = vi.fn();
    const handler = createGatewayRuntimeEventHandler({
      getStatus: () => "connected",
      getAgents: () => officeAgents,
      dispatch: (action) => {
        if (action.type === "updateAgent") patch(action.agentId, action.patch);
      },
      queueLivePatch: patch,
      clearPendingLivePatch: noop,
      loadSummarySnapshot: async () => {},
      requestHistoryRefresh,
      refreshHeartbeatLatestUpdate: noop,
      bumpHeartbeatTick: noop,
      setTimeout: (fn, delayMs) => window.setTimeout(fn, delayMs),
      clearTimeout: (id) => window.clearTimeout(id),
      isDisconnectLikeError: () => false,
      logWarn: noop,
      updateSpecialLatestUpdate: noop,
    });
    const unsubscribe = subscribeEvents((frame: Loose) => handler.handleEvent(frame as EventFrame));
    startAmbientActivity({ random: mulberry32(5) });

    let sawLeadWorking = false;
    for (let sample = 0; sample < 60; sample += 1) {
      vi.advanceTimersByTime(5_000);
      const busy = new Set(getAmbientSnapshot().busyAgentIds);
      const working = new Set(
        officeAgents.filter((agent) => agent.status === "running").map((agent) => agent.agentId),
      );
      expect([...working].sort()).toEqual([...busy].sort());
      if (working.has(LEAD_AGENT_ID)) {
        sawLeadWorking = true;
        const lead = officeAgents.find((agent) => agent.agentId === LEAD_AGENT_ID)!;
        expect(lead.lastUserMessage).toBeTruthy();
      }
    }
    expect(sawLeadWorking).toBe(true);
    // Each run brings its task along, so the office never has to fetch
    // history just to learn that a run started.
    expect(requestHistoryRefresh).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "run-start-no-chat" }),
    );
    unsubscribe();
    handler.dispose();
  });
});

describe("ambient task wording", () => {
  it("never reads as an office command", () => {
    const profiles = [...Object.values(ROLE_PROFILES), GENERIC_PROFILE];
    const tasks = profiles.flatMap((profile) => profile.scripts.map(([task]) => task));
    expect(tasks.length).toBeGreaterThan(40);
    for (const task of tasks) {
      const intent = resolveOfficeIntentSnapshot(task);
      expect({
        task,
        desk: intent.desk,
        github: intent.github,
        gym: intent.gym,
        qa: intent.qa,
        standup: intent.standup,
        call: intent.call,
        text: intent.text,
      }).toEqual({ task, desk: null, github: null, gym: null, qa: null, standup: null, call: null, text: null });
      // "heartbeat" and "cron" switch the office's latest-update panel.
      expect(task).not.toMatch(/heartbeat|cron/i);
    }
  });
});
