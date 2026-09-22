import { createElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TaskBoardView } from "@/features/office/tasks/TaskBoardView";
import type { TaskBoardCard } from "@/features/office/tasks/types";
import type { AgentState } from "@/features/agents/state/store";
import type { CronJobSummary } from "@/lib/cron/types";

const createCard = (overrides: Partial<TaskBoardCard> = {}): TaskBoardCard => ({
  id: "task-1",
  title: "New task",
  description: "",
  status: "todo",
  source: "office3d_manual",
  sourceEventId: null,
  assignedAgentId: null,
  createdAt: "2026-03-29T10:00:00.000Z",
  updatedAt: "2026-03-29T10:00:00.000Z",
  playbookJobId: null,
  runId: null,
  channel: null,
  externalThreadId: null,
  lastActivityAt: null,
  notes: [],
  isArchived: false,
  isInferred: false,
  ...overrides,
});

const createAgent = (): AgentState => ({
  agentId: "agent-1",
  name: "Agent One",
  sessionKey: "agent:agent-1:main",
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
  model: "openai/gpt-5",
  thinkingLevel: "medium",
  avatarSeed: "seed-1",
  avatarUrl: null,
});

const createCronJob = (): CronJobSummary => ({
  id: "job-1",
  name: "Morning review",
  agentId: "agent-1",
  enabled: true,
  updatedAtMs: Date.now(),
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Review new tasks." },
  state: {},
});

describe("TaskBoardView", () => {
  it("routes task edits through callbacks", () => {
    const onCreateCard = vi.fn();
    const onMoveCard = vi.fn();
    const onSelectCard = vi.fn();
    const onUpdateCard = vi.fn();
    const onDeleteCard = vi.fn();
    const onRefreshCronJobs = vi.fn();
    const selectedCard = createCard();

    render(
      createElement(TaskBoardView, {
        title: "Kanban",
        subtitle: "Track tasks.",
        agents: [createAgent()],
        cardsByStatus: {
          todo: [selectedCard],
          in_progress: [],
          blocked: [],
          review: [],
          done: [],
        },
        selectedCard,
        activeRuns: [{ runId: "run-1", agentId: "agent-1", label: "Agent One" }],
        cronJobs: [createCronJob()],
        cronLoading: false,
        cronError: null,
        onCreateCard,
        onMoveCard,
        onSelectCard,
        onUpdateCard,
        onDeleteCard,
        onRefreshCronJobs,
      })
    );

    // Addressed separately rather than by index: the toolbar button and the
    // card happened to share a name only because the fixture card is called
    // "New task", which made the test read as though it clicked the same
    // control twice.
    fireEvent.click(screen.getByRole("button", { name: /новая задача/i }));
    fireEvent.click(screen.getByRole("button", { name: /обновить/i }));
    fireEvent.click(screen.getByRole("button", { name: /^New task —/ }));
    fireEvent.change(screen.getByLabelText("Заголовок"), {
      target: { value: "Create marketing website" },
    });
    fireEvent.change(screen.getByLabelText("Статус"), {
      target: { value: "in_progress" },
    });
    fireEvent.change(screen.getByLabelText("Назначенный агент"), {
      target: { value: "agent-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /удалить задачу/i }));

    expect(onCreateCard).toHaveBeenCalledTimes(1);
    expect(onRefreshCronJobs).toHaveBeenCalledTimes(1);
    expect(onSelectCard).toHaveBeenCalledWith(null);
    expect(onUpdateCard).toHaveBeenCalledWith("task-1", { title: "Create marketing website" });
    expect(onMoveCard).toHaveBeenCalledWith("task-1", "in_progress");
    expect(onUpdateCard).toHaveBeenCalledWith("task-1", { assignedAgentId: "agent-1" });
    expect(onDeleteCard).toHaveBeenCalledWith("task-1");
  });
});
