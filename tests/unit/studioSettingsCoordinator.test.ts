import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultStudioSettings, sanitizeStudioSettings, type StudioSettingsPatch } from "@/lib/studio/settings";
import { StudioSettingsCoordinator } from "@/lib/studio/coordinator";

describe("StudioSettingsCoordinator", () => {
  const createResponse = () => ({
    settings: sanitizeStudioSettings(defaultStudioSettings()),
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces multiple scheduled patches into one update", async () => {
    const fetchSettings = vi.fn(async () => createResponse());
    const updateSettings = vi.fn(async () => createResponse());
    const coordinator = new StudioSettingsCoordinator({ fetchSettings, updateSettings }, 300);

    coordinator.schedulePatch({
      gateway: { url: "ws://localhost:18789", token: "abc" },
    });
    coordinator.schedulePatch({
      focused: {
        "ws://localhost:18789": {
          mode: "focused",
          filter: "running",
          selectedAgentId: null,
        },
      },
    });

    await vi.advanceTimersByTimeAsync(300);

    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({
      gateway: { url: "ws://localhost:18789", token: "abc" },
      focused: {
        "ws://localhost:18789": {
          mode: "focused",
          filter: "running",
          selectedAgentId: null,
        },
      },
    });

    coordinator.dispose();
  });

  it("merges queued gateway patches field-by-field before flushing", async () => {
    const fetchSettings = vi.fn(async () => createResponse());
    const updateSettings = vi.fn(async () => createResponse());
    const coordinator = new StudioSettingsCoordinator({ fetchSettings, updateSettings }, 300);

    coordinator.schedulePatch(
      {
        gateway: {
          lastKnownGood: {
            url: "ws://localhost:18789",
            token: undefined,
            adapterType: "openclaw",
          },
        },
      },
      300,
    );
    coordinator.schedulePatch(
      {
        gateway: {
          url: "http://localhost:7770",
          adapterType: "local",
          profiles: {
            local: {
              url: "http://localhost:7770",
              token: undefined,
            },
          },
        },
      },
      300,
    );

    await vi.advanceTimersByTimeAsync(300);

    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({
      gateway: {
        url: "http://localhost:7770",
        adapterType: "local",
        profiles: {
          local: {
            url: "http://localhost:7770",
            token: undefined,
          },
        },
        lastKnownGood: {
          url: "ws://localhost:18789",
          token: undefined,
          adapterType: "openclaw",
        },
      },
    });

    coordinator.dispose();
  });

  it("merges queued gateway profile and last-known-good subpatches", async () => {
    const fetchSettings = vi.fn(async () => createResponse());
    const updateSettings = vi.fn(async () => createResponse());
    const coordinator = new StudioSettingsCoordinator({ fetchSettings, updateSettings }, 300);

    coordinator.schedulePatch({
      gateway: {
        profiles: {
          hermes: {
            url: "ws://localhost:18888",
            token: undefined,
          },
        },
        lastKnownGood: {
          url: "ws://localhost:18789",
          token: "stored-token",
        },
      },
    });
    coordinator.schedulePatch({
      gateway: {
        profiles: {
          hermes: {
            token: "new-token",
          },
        },
        lastKnownGood: {
          adapterType: "openclaw",
        },
      },
    });

    await vi.advanceTimersByTimeAsync(300);

    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({
      gateway: {
        profiles: {
          hermes: {
            url: "ws://localhost:18888",
            token: "new-token",
          },
        },
        lastKnownGood: {
          url: "ws://localhost:18789",
          token: "stored-token",
          adapterType: "openclaw",
        },
      },
    });

    coordinator.dispose();
  });

  it("flushPending persists queued patch immediately", async () => {
    const fetchSettings = vi.fn(async () => createResponse());
    const updateSettings = vi.fn(async () => createResponse());
    const coordinator = new StudioSettingsCoordinator({ fetchSettings, updateSettings }, 1000);

    coordinator.schedulePatch({
      gateway: { url: "ws://localhost:18789", token: "session-a" },
    });

    await coordinator.flushPending();

    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({
      gateway: { url: "ws://localhost:18789", token: "session-a" },
    });

    await vi.advanceTimersByTimeAsync(2000);
    expect(updateSettings).toHaveBeenCalledTimes(1);

    coordinator.dispose();
  });

  const BOARD_KEY = "ws://localhost:18789";
  const THROTTLE = { minIntervalMs: 15_000, maxWaitMs: 15_000 };
  const boardPatch = (revision: number) => ({
    taskBoard: {
      [BOARD_KEY]: {
        cards: [
          {
            id: `card-${revision}`,
            title: `Card ${revision}`,
            description: "",
            status: "todo" as const,
            source: "fallback_inferred" as const,
            sourceEventId: null,
            assignedAgentId: null,
            createdAt: "2026-09-29T00:00:00.000Z",
            updatedAt: "2026-09-29T00:00:00.000Z",
            playbookJobId: null,
            runId: null,
            channel: null,
            externalThreadId: null,
            lastActivityAt: null,
            notes: [],
            isArchived: false,
            isInferred: true,
          },
        ],
        selectedCardId: null,
      },
    },
  });

  // Two minutes of a live team: the board changes in batches every 1-3 s.
  const simulateBusyBoard = async (throttle?: typeof THROTTLE) => {
    const fetchSettings = vi.fn(async () => createResponse());
    const updateSettings = vi.fn(async (_patch: StudioSettingsPatch) => createResponse());
    const coordinator = new StudioSettingsCoordinator({ fetchSettings, updateSettings }, 300);
    const gaps = [1000, 2000, 1000, 3000, 1000, 2000];
    let elapsed = 0;
    let revision = 0;
    while (elapsed < 120_000) {
      coordinator.schedulePatch(boardPatch(revision), 1500, throttle);
      revision += 1;
      const gap = gaps[revision % gaps.length]!;
      await vi.advanceTimersByTimeAsync(gap);
      elapsed += gap;
    }
    return { coordinator, updateSettings, lastRevision: revision - 1 };
  };

  it("saves a busy board at most once per throttle interval", async () => {
    // Baseline: a plain 1.5 s trailing debounce fires in every gap longer than 1.5 s.
    const baseline = await simulateBusyBoard();
    const baselineSaves = baseline.updateSettings.mock.calls.length;
    baseline.coordinator.dispose();
    expect(baselineSaves).toBeGreaterThanOrEqual(30);

    const { coordinator, updateSettings, lastRevision } = await simulateBusyBoard(THROTTLE);
    // At most one save per 15 s: <= 8 in two minutes.
    expect(updateSettings.mock.calls.length).toBeGreaterThanOrEqual(7);
    expect(updateSettings.mock.calls.length).toBeLessThanOrEqual(8);

    // Nothing is lost: the last change goes out with the final flush.
    await coordinator.flushPending();
    const lastPatch = updateSettings.mock.calls.at(-1)?.[0];
    expect(lastPatch?.taskBoard?.[BOARD_KEY]?.cards?.[0]?.id).toBe(`card-${lastRevision}`);

    coordinator.dispose();
  });

  it("still saves a single board edit on a quiet board after the debounce", async () => {
    const fetchSettings = vi.fn(async () => createResponse());
    const updateSettings = vi.fn(async (_patch: StudioSettingsPatch) => createResponse());
    const coordinator = new StudioSettingsCoordinator({ fetchSettings, updateSettings }, 300);

    coordinator.schedulePatch(boardPatch(1), 1500, THROTTLE);
    await vi.advanceTimersByTimeAsync(1499);
    expect(updateSettings).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(updateSettings).toHaveBeenCalledTimes(1);

    // A second edit right after waits for the interval, then goes out.
    coordinator.schedulePatch(boardPatch(2), 1500, THROTTLE);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(updateSettings).toHaveBeenCalledTimes(2);

    coordinator.dispose();
  });

  it("does not hold other settings back behind a throttled board", async () => {
    const fetchSettings = vi.fn(async () => createResponse());
    const updateSettings = vi.fn(async (_patch: StudioSettingsPatch) => createResponse());
    const coordinator = new StudioSettingsCoordinator({ fetchSettings, updateSettings }, 300);

    coordinator.schedulePatch(boardPatch(1), 1500, THROTTLE);
    await vi.advanceTimersByTimeAsync(1500);
    coordinator.schedulePatch(boardPatch(2), 1500, THROTTLE);
    coordinator.schedulePatch({ activeFloorId: "openclaw-ground" }, 0);
    await vi.advanceTimersByTimeAsync(0);

    expect(updateSettings).toHaveBeenCalledTimes(2);
    // The waiting board rides along with the urgent save.
    expect(updateSettings.mock.calls[1]?.[0]).toMatchObject({
      activeFloorId: "openclaw-ground",
      taskBoard: boardPatch(2).taskBoard,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(updateSettings).toHaveBeenCalledTimes(2);

    coordinator.dispose();
  });

  it("skips a board save when the board did not change since the last save", async () => {
    const fetchSettings = vi.fn(async () => createResponse());
    const updateSettings = vi.fn(async (_patch: StudioSettingsPatch) => createResponse());
    const coordinator = new StudioSettingsCoordinator({ fetchSettings, updateSettings }, 300);

    coordinator.schedulePatch(boardPatch(1), 0);
    await coordinator.flushPending();
    coordinator.schedulePatch(boardPatch(1), 0);
    await coordinator.flushPending();
    expect(updateSettings).toHaveBeenCalledTimes(1);

    // Other settings still go out, without the unchanged board.
    coordinator.schedulePatch(boardPatch(1), 0);
    coordinator.schedulePatch({ activeFloorId: "openclaw-ground" }, 0);
    await coordinator.flushPending();
    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(updateSettings.mock.calls[1]?.[0]).toEqual({ activeFloorId: "openclaw-ground" });

    coordinator.schedulePatch(boardPatch(2), 0);
    await coordinator.flushPending();
    expect(updateSettings).toHaveBeenCalledTimes(3);

    coordinator.dispose();
  });

  it("does not restart the throttle interval on a board save that was skipped as unchanged", async () => {
    const fetchSettings = vi.fn(async () => createResponse());
    const updateSettings = vi.fn(async (_patch: StudioSettingsPatch) => createResponse());
    const coordinator = new StudioSettingsCoordinator({ fetchSettings, updateSettings }, 300);

    coordinator.schedulePatch(boardPatch(1), 1500, THROTTLE);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(updateSettings).toHaveBeenCalledTimes(1);

    // Same board again: nothing is sent...
    coordinator.schedulePatch(boardPatch(1), 1500, THROTTLE);
    await vi.advanceTimersByTimeAsync(1500);
    expect(updateSettings).toHaveBeenCalledTimes(1);

    // ...so a real edit right after still goes out after the debounce alone.
    coordinator.schedulePatch(boardPatch(2), 1500, THROTTLE);
    await vi.advanceTimersByTimeAsync(1500);
    expect(updateSettings).toHaveBeenCalledTimes(2);

    coordinator.dispose();
  });

  it("re-sends an identical board when the previous save failed", async () => {
    const fetchSettings = vi.fn(async () => createResponse());
    const updateSettings = vi
      .fn<(patch: unknown) => Promise<ReturnType<typeof createResponse>>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async () => createResponse());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const coordinator = new StudioSettingsCoordinator({ fetchSettings, updateSettings }, 300);

    coordinator.schedulePatch(boardPatch(1), 0);
    await expect(coordinator.flushPending()).rejects.toThrow("offline");
    coordinator.schedulePatch(boardPatch(1), 0);
    await coordinator.flushPending();
    expect(updateSettings).toHaveBeenCalledTimes(2);

    errorSpy.mockRestore();
    coordinator.dispose();
  });

  it("dispose clears pending timer without writing", async () => {
    const fetchSettings = vi.fn(async () => createResponse());
    const updateSettings = vi.fn(async () => createResponse());
    const coordinator = new StudioSettingsCoordinator({ fetchSettings, updateSettings }, 200);

    coordinator.schedulePatch({
      focused: {
        "ws://localhost:18789": {
          mode: "focused",
          filter: "approvals",
          selectedAgentId: null,
        },
      },
    });
    coordinator.dispose();

    await vi.advanceTimersByTimeAsync(500);

    expect(updateSettings).not.toHaveBeenCalled();
  });
});
