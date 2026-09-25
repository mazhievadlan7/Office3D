import { describe, expect, it } from "vitest";

import { taskBoardReducer } from "@/features/office/tasks/taskBoardState";
import type { TaskBoardCard, TaskBoardSource } from "@/features/office/tasks/types";
import { MAX_AUTOMATIC_TASK_CARDS, capAutomaticTaskCards } from "@/lib/tasks/taskBoardCap";

const card = (index: number, source: TaskBoardSource, overrides: Partial<TaskBoardCard> = {}): TaskBoardCard => {
  const at = new Date(Date.UTC(2026, 8, 25, 0, 0, index)).toISOString();
  return {
    id: `${source}-${index}`,
    title: `Card ${index}`,
    description: "",
    status: "review",
    source,
    sourceEventId: null,
    assignedAgentId: null,
    createdAt: at,
    updatedAt: at,
    playbookJobId: null,
    runId: null,
    channel: null,
    externalThreadId: null,
    lastActivityAt: at,
    notes: [],
    isArchived: false,
    isInferred: false,
    ...overrides,
  };
};

describe("the task board's cap on automatic cards", () => {
  it("keeps a live team's board bounded: every run adds a card, the oldest go", () => {
    let state = taskBoardReducer(undefined, { type: "select", cardId: null });
    for (let i = 0; i < MAX_AUTOMATIC_TASK_CARDS + 400; i++) {
      state = taskBoardReducer(state, { type: "upsert", card: card(i, "openclaw_event", { isArchived: i % 3 !== 0 }) });
    }
    state = taskBoardReducer(state, { type: "upsert", card: card(0, "office3d_manual") });
    const automatic = state.cards.filter((c) => c.source === "openclaw_event");
    expect(automatic).toHaveLength(MAX_AUTOMATIC_TASK_CARDS);
    // Active cards survive before archived ones; the manual card always stays.
    const active = automatic.filter((c) => !c.isArchived).length;
    expect(active).toBe(Math.ceil((MAX_AUTOMATIC_TASK_CARDS + 400) / 3));
    expect(state.cards.some((c) => c.source === "office3d_manual")).toBe(true);
  });

  it("trims an oversized saved board when it is read back", () => {
    const saved = [
      ...Array.from({ length: 5000 }, (_, i) => card(i, "openclaw_event", { isArchived: true })),
      ...Array.from({ length: 20 }, (_, i) => card(i, "fallback_inferred", { isInferred: true })),
      ...Array.from({ length: 30 }, (_, i) => card(i, "office3d_manual")),
      ...Array.from({ length: 10 }, (_, i) => card(i, "playbook")),
    ];
    const kept = capAutomaticTaskCards(saved);
    expect(kept.filter((c) => c.source === "office3d_manual")).toHaveLength(30);
    expect(kept.filter((c) => c.source === "playbook")).toHaveLength(10);
    expect(kept.length).toBe(MAX_AUTOMATIC_TASK_CARDS + 40);
    // The 20 active inferred cards are kept ahead of the archived run cards,
    // and the archived ones kept are the newest.
    expect(kept.filter((c) => c.source === "fallback_inferred")).toHaveLength(20);
    const archivedKept = kept.filter((c) => c.source === "openclaw_event").map((c) => Number(c.id.split("-").pop()));
    expect(Math.min(...archivedKept)).toBe(5000 - (MAX_AUTOMATIC_TASK_CARDS - 20));
    // Hydrating the board does the same.
    const state = taskBoardReducer(undefined, { type: "hydrate", preference: { cards: saved, selectedCardId: null } });
    expect(state.cards.length).toBe(MAX_AUTOMATIC_TASK_CARDS + 40);
  });

  it("leaves a board under the cap untouched", () => {
    const cards = Array.from({ length: 50 }, (_, i) => card(i, "openclaw_event"));
    expect(capAutomaticTaskCards(cards)).toBe(cards);
  });
});
