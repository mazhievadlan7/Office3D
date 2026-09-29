import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DELETE, GET, PUT } from "@/app/api/task-store/route";
import type { AgentState } from "@/features/agents/state/store";
import type { OfficeStandupController } from "@/features/office/hooks/useOfficeStandupController";
import type { RunRecord } from "@/features/office/hooks/useRunLog";
import { taskBoardReducer } from "@/features/office/tasks/taskBoardState";
import type { TaskBoardCard, TaskBoardPreference, TaskBoardSource } from "@/features/office/tasks/types";
import {
  buildCardFromSharedTaskRecord,
  matchesExplicitCard,
  planSharedTaskRefresh,
  planSharedTaskResponses,
  useTaskBoardController,
} from "@/features/office/tasks/useTaskBoardController";
import type { GatewayClient } from "@/lib/gateway/GatewayClient";
import type { StudioSettingsCoordinator } from "@/lib/studio/coordinator";
import { listSharedTasks, upsertSharedTask, type SharedTaskRecord } from "@/lib/tasks/shared-store";

const at = (second: number) => new Date(Date.UTC(2026, 8, 28, 10, 0, second)).toISOString();

const card = (id: string, second: number, overrides: Partial<TaskBoardCard> = {}): TaskBoardCard => ({
  id,
  title: `Card ${id}`,
  description: "",
  status: "todo",
  source: "office3d_manual" as TaskBoardSource,
  sourceEventId: null,
  assignedAgentId: null,
  createdAt: at(second),
  updatedAt: at(second),
  playbookJobId: null,
  runId: null,
  channel: null,
  externalThreadId: null,
  lastActivityAt: at(second),
  notes: [],
  isArchived: false,
  isInferred: false,
  ...overrides,
});

const record = (id: string, second: number, overrides: Partial<SharedTaskRecord> = {}): SharedTaskRecord => ({
  ...card(id, second),
  history: [],
  ...overrides,
});

const boardOf = (cards: TaskBoardCard[]): TaskBoardPreference =>
  taskBoardReducer(undefined, { type: "hydrate", preference: { cards, selectedCardId: null } });

// What the board did before: every record upserted on its own, with a scan of
// the board (as it stood before the read) for inferred cards to archive.
const refreshOneByOne = (state: TaskBoardPreference, records: SharedTaskRecord[]) => {
  const snapshot = state.cards;
  let next = state;
  for (const entry of records) {
    const existing = snapshot.find((c) => c.id === entry.id) ?? null;
    const explicit = buildCardFromSharedTaskRecord(entry, existing);
    next = taskBoardReducer(next, { type: "upsert", card: explicit });
    for (const candidate of snapshot) {
      if (!candidate.isInferred || candidate.isArchived) continue;
      if (!matchesExplicitCard(candidate, explicit)) continue;
      next = taskBoardReducer(next, {
        type: "update",
        cardId: candidate.id,
        patch: { isArchived: true, updatedAt: explicit.updatedAt },
      });
    }
  }
  return next;
};

// A board with cards that the store's records match in every way a match is made.
const mixedBoard = () =>
  boardOf([
    card("m-1", 1),
    card("m-2", 2, { status: "in_progress" }),
    card("inf-text", 3, { isInferred: true, source: "fallback_inferred", title: "Card r-3", assignedAgentId: null }),
    card("inf-thread", 4, { isInferred: true, source: "fallback_inferred", externalThreadId: "thread-1" }),
    card("inf-event", 5, { isInferred: true, source: "playbook", sourceEventId: "event-1" }),
    card("r-4", 6, { isInferred: true, source: "openclaw_event" }),
    card("inf-free", 7, { isInferred: true, source: "playbook" }),
  ]);

const mixedRecords = () => [
  record("m-1", 1),
  record("m-2", 12, { status: "review" }),
  record("r-3", 13, { externalThreadId: "thread-1" }),
  record("r-4", 14, { source: "openclaw_event", sourceEventId: "event-1" }),
  record("r-5", 15, { title: "Card r-3" }),
];

describe("applying the shared task store to the board", () => {
  it("changes nothing, and dispatches nothing, when the store matches the board", () => {
    const records = [record("a", 1), record("b", 2, { status: "done", notes: ["x"] }), record("c", 3)];
    const state = boardOf(records.map((entry) => buildCardFromSharedTaskRecord(entry, null)));
    expect(planSharedTaskRefresh(state.cards, records)).toEqual([]);
  });

  it("returns only the changed cards, to apply in one batch", () => {
    const records = [record("a", 1), record("b", 2), record("c", 3)];
    const state = boardOf(records.map((entry) => buildCardFromSharedTaskRecord(entry, null)));
    const changedRecords = [records[0], record("b", 9, { status: "review" }), records[2], record("d", 4)];
    const changed = planSharedTaskRefresh(state.cards, changedRecords);
    expect(changed.map((c) => [c.id, c.status])).toEqual([
      ["b", "review"],
      ["d", "todo"],
    ]);
    // Cards not changed keep their identity on the board.
    const next = taskBoardReducer(state, { type: "upsertMany", cards: changed });
    expect(next.cards.find((c) => c.id === "a")).toBe(state.cards.find((c) => c.id === "a"));
  });

  it("ends with the same board as applying the records one by one", () => {
    const state = mixedBoard();
    const records = mixedRecords();
    const expected = refreshOneByOne(state, records);
    const actual = taskBoardReducer(state, { type: "upsertMany", cards: planSharedTaskRefresh(state.cards, records) });
    expect(actual.cards).toEqual(expected.cards);
    // Sanity: the inferred cards were archived as before, the unrelated one was not.
    const archived = actual.cards.filter((c) => c.isArchived).map((c) => c.id).sort();
    expect(archived).toEqual(["inf-event", "inf-text", "inf-thread", "r-4"]);
  });

  it("leaves out records named by the skip predicate", () => {
    const state = mixedBoard();
    const changed = planSharedTaskRefresh(state.cards, mixedRecords(), (id) => id !== "m-2");
    expect(changed.map((c) => c.id)).toEqual(["m-2"]);
  });

  it("applies saved records as if each had arrived on its own", () => {
    const state = mixedBoard();
    const records = mixedRecords();
    let expected = state;
    for (const entry of records) {
      // One response at a time, the board re-read in between.
      expected = refreshOneByOne(expected, [entry]);
    }
    const actual = taskBoardReducer(state, { type: "upsertMany", cards: planSharedTaskResponses(state.cards, records) });
    expect(actual.cards).toEqual(expected.cards);
  });
});

describe("task board controller and the shared store", () => {
  const priorStateDir = process.env.OPENCLAW_STATE_DIR;
  let tempDir: string | null = null;

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.OPENCLAW_STATE_DIR = priorStateDir;
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  const agents: AgentState[] = [];
  const runLog: RunRecord[] = [];
  const standup = { config: null } as unknown as OfficeStandupController;
  const client = {} as GatewayClient;

  const setup = () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-board-shared-sync-"));
    process.env.OPENCLAW_STATE_DIR = tempDir;
    for (let index = 1; index <= 3; index += 1) {
      upsertSharedTask({
        id: `task-${index}`,
        title: `Task ${index}`,
        status: "todo",
        source: "office3d_manual",
        updatedAt: at(index),
      });
    }
    const requests: Array<{ method: string; body: unknown }> = [];
    // The office's requests go straight to the route handlers.
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : undefined;
      requests.push({ method, body: body ? JSON.parse(body) : undefined });
      if (method === "GET") return GET();
      const request = new Request("http://localhost/api/task-store", {
        method,
        headers: { "content-type": "application/json" },
        body,
      });
      return method === "PUT" ? PUT(request) : DELETE(request);
    });
    const settingsCoordinator = {
      loadSettings: vi.fn(async () => null),
      schedulePatch: vi.fn(),
      flushPending: vi.fn(async () => {}),
    } as unknown as StudioSettingsCoordinator & { schedulePatch: ReturnType<typeof vi.fn> };
    const hook = renderHook(() =>
      useTaskBoardController({
        gatewayUrl: "ws://gateway.test",
        settingsCoordinator,
        client,
        status: "disconnected",
        cronEnabled: false,
        agents,
        runLog,
        standup,
        captureDebugEnabled: false,
      })
    );
    return { hook, requests, settingsCoordinator };
  };

  it("keeps the board untouched when a periodic read finds nothing new", async () => {
    const { hook, settingsCoordinator } = setup();
    const { result, unmount } = hook;
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(() => result.current.refreshSharedTasks());
    expect(result.current.state.cards.map((c) => c.id).sort()).toEqual(["task-1", "task-2", "task-3"]);

    const cards = result.current.state.cards;
    const saves = settingsCoordinator.schedulePatch.mock.calls.length;
    await act(() => result.current.refreshSharedTasks());
    await act(() => result.current.refreshSharedTasks());
    expect(result.current.state.cards).toBe(cards);
    expect(settingsCoordinator.schedulePatch.mock.calls.length).toBe(saves);
    unmount();
  });

  it("sends the edits of about a second as one request and shows the saved result", async () => {
    const { hook, requests } = setup();
    const { result, unmount } = hook;
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(() => result.current.refreshSharedTasks());
    expect(result.current.state.cards).toHaveLength(3);
    const putsBefore = requests.filter((entry) => entry.method === "PUT").length;

    const pending: Array<Promise<unknown>> = [];
    act(() => {
      pending.push(result.current.updateCard("task-1", { title: "Task 1 renamed" }));
    });
    act(() => {
      pending.push(result.current.updateCard("task-1", { status: "review" }));
    });
    act(() => {
      pending.push(result.current.moveCard("task-2", "done"));
    });
    // Shown at once, before anything is saved.
    expect(result.current.state.cards.find((c) => c.id === "task-2")?.status).toBe("done");

    await act(() => Promise.all(pending));
    const puts = requests.filter((entry) => entry.method === "PUT").slice(putsBefore);
    expect(puts).toHaveLength(1);
    const sent = (puts[0].body as { tasks: Array<{ id: string; title: string; status: string }> }).tasks;
    expect(sent.map((task) => [task.id, task.title, task.status])).toEqual([
      ["task-1", "Task 1 renamed", "todo"],
      ["task-1", "Task 1 renamed", "review"],
      ["task-2", "Task 2", "done"],
    ]);

    const board = result.current.state.cards;
    expect(board.find((c) => c.id === "task-1")).toEqual(
      expect.objectContaining({ title: "Task 1 renamed", status: "review" })
    );
    expect(board.find((c) => c.id === "task-2")?.status).toBe("done");
    const stored = listSharedTasks();
    expect(stored.find((task) => task.id === "task-1")?.status).toBe("review");
    expect(stored.find((task) => task.id === "task-2")?.status).toBe("done");
    unmount();
  });
  it("sends a held-back board save before reading the board of a gateway it switches to", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ tasks: [] }), { status: 200 }));
    const calls: string[] = [];
    const settingsCoordinator = {
      loadSettings: vi.fn(async () => {
        calls.push("load");
        return null;
      }),
      schedulePatch: vi.fn(),
      flushPending: vi.fn(async () => {
        calls.push("flush");
      }),
    } as unknown as StudioSettingsCoordinator;
    const { result, rerender, unmount } = renderHook(
      ({ gatewayUrl }: { gatewayUrl: string }) =>
        useTaskBoardController({
          gatewayUrl,
          settingsCoordinator,
          client,
          status: "disconnected",
          cronEnabled: false,
          agents,
          runLog,
          standup,
          captureDebugEnabled: false,
        }),
      { initialProps: { gatewayUrl: "ws://gateway-a.test" } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    calls.length = 0;

    rerender({ gatewayUrl: "ws://gateway-b.test" });
    await waitFor(() => expect(calls).toContain("load"));
    // The read of the new gateway's board waits for the held-back save.
    expect(calls.indexOf("flush")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("flush")).toBeLessThan(calls.indexOf("load"));
    unmount();
  });
});
