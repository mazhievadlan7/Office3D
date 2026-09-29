import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SharedTaskRecord } from "@/lib/tasks/shared-store";
import {
  createSharedTaskUpsertQueue,
  SHARED_TASK_FLUSH_DELAY_MS,
  TaskStoreRequestError,
  upsertSharedTaskRecords,
  type SharedTaskUpsertResult,
} from "@/lib/tasks/shared-store-client";
import { mergeSharedTaskRecord, type SharedTaskUpsertInput } from "@/lib/tasks/shared-task-merge";

const task = (id: string, overrides: Partial<SharedTaskUpsertInput> = {}): SharedTaskUpsertInput => ({
  id,
  title: `Task ${id}`,
  status: "todo",
  source: "openclaw_event",
  createdAt: "2026-09-28T10:00:00.000Z",
  updatedAt: "2026-09-28T10:00:00.000Z",
  ...overrides,
});

// A fake store: answers each upsert as the real store would, in order.
const makeStoreSend = () => {
  const stored = new Map<string, SharedTaskRecord>();
  const send = vi.fn(async (tasks: SharedTaskUpsertInput[]): Promise<SharedTaskUpsertResult[]> =>
    tasks.map((entry) => {
      const next = mergeSharedTaskRecord(entry, stored.get(entry.id) ?? null);
      stored.set(next.id, next);
      return { task: next };
    })
  );
  return { send, stored };
};

describe("shared task upsert queue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the upserts of about a second as one batch, in order, the latest winning", async () => {
    const { send, stored } = makeStoreSend();
    const onApplied = vi.fn();
    const queue = createSharedTaskUpsertQueue({ send, onApplied });

    const first = queue.enqueue(task("a", { status: "in_progress", updatedAt: "2026-09-28T10:00:01.000Z" }));
    const second = queue.enqueue(task("a", { status: "review", updatedAt: "2026-09-28T10:00:02.000Z" }));
    const other = queue.enqueue(task("b"));

    await vi.advanceTimersByTimeAsync(SHARED_TASK_FLUSH_DELAY_MS - 1);
    expect(send).not.toHaveBeenCalled();
    expect(queue.hasPending("a")).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].map((entry) => [entry.id, entry.status])).toEqual([
      ["a", "in_progress"],
      ["a", "review"],
      ["b", "todo"],
    ]);

    await expect(first).resolves.toEqual(expect.objectContaining({ id: "a", status: "in_progress" }));
    await expect(second).resolves.toEqual(expect.objectContaining({ id: "a", status: "review" }));
    await expect(other).resolves.toEqual(expect.objectContaining({ id: "b" }));
    // The store saw both upserts of "a", so its history is what two requests leave.
    expect(stored.get("a")?.status).toBe("review");
    expect(stored.get("a")?.history.map((entry) => entry.type)).toEqual([
      "created",
      "status_changed",
    ]);
    // All saved records are handed over once, before the promises settle.
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onApplied.mock.calls[0][0].map((record: SharedTaskRecord) => record.status)).toEqual([
      "in_progress",
      "review",
      "todo",
    ]);
    expect(queue.hasPending("a")).toBe(false);
  });

  it("does not send an upsert that would store exactly what the store holds", async () => {
    const { send } = makeStoreSend();
    const onApplied = vi.fn();
    const queue = createSharedTaskUpsertQueue({ send, onApplied });
    const storedRecord = mergeSharedTaskRecord(task("a"), null);
    queue.rememberList([storedRecord], queue.beginRead());

    const same = queue.enqueue({ ...storedRecord });
    await vi.advanceTimersByTimeAsync(SHARED_TASK_FLUSH_DELAY_MS);

    expect(send).not.toHaveBeenCalled();
    await expect(same).resolves.toEqual(storedRecord);
    expect(onApplied).toHaveBeenCalledWith([storedRecord]);

    // A real change is sent.
    const changed = queue.enqueue({ ...storedRecord, status: "done", updatedAt: "2026-09-28T11:00:00.000Z" });
    await vi.advanceTimersByTimeAsync(SHARED_TASK_FLUSH_DELAY_MS);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(changed).resolves.toEqual(expect.objectContaining({ status: "done" }));
  });

  it("fails every upsert of a failed batch and never skips the next one", async () => {
    const send = vi.fn(async (): Promise<SharedTaskUpsertResult[]> => {
      throw new TaskStoreRequestError("down", 503);
    });
    const queue = createSharedTaskUpsertQueue({ send });
    const storedRecord = mergeSharedTaskRecord(task("a"), null);
    queue.rememberList([storedRecord], queue.beginRead());

    const first = queue.enqueue({ ...storedRecord, status: "done", updatedAt: "2026-09-28T11:00:00.000Z" });
    const second = queue.enqueue(task("b"));
    const settled = Promise.allSettled([first, second]);
    await vi.advanceTimersByTimeAsync(SHARED_TASK_FLUSH_DELAY_MS);
    const [firstResult, secondResult] = await settled;
    expect(firstResult.status).toBe("rejected");
    expect(secondResult.status).toBe("rejected");
    expect((firstResult as PromiseRejectedResult).reason).toBeInstanceOf(TaskStoreRequestError);
    expect(send).toHaveBeenCalledTimes(1);

    // After a failure the store's copy is unknown, so even a "same" upsert goes out.
    const again = queue.enqueue({ ...storedRecord });
    const againSettled = again.catch(() => null);
    await vi.advanceTimersByTimeAsync(SHARED_TASK_FLUSH_DELAY_MS);
    await againSettled;
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("rejects only the entry the store refused", async () => {
    const send = vi.fn(async (tasks: SharedTaskUpsertInput[]): Promise<SharedTaskUpsertResult[]> => [
      { error: "bad status", status: 400 },
      { task: mergeSharedTaskRecord(tasks[1], null) },
    ]);
    const queue = createSharedTaskUpsertQueue({ send });
    const bad = queue.enqueue(task("a"));
    const badSettled = bad.catch((error: unknown) => error);
    const good = queue.enqueue(task("b"));
    await vi.advanceTimersByTimeAsync(SHARED_TASK_FLUSH_DELAY_MS);
    const error = await badSettled;
    expect(error).toBeInstanceOf(TaskStoreRequestError);
    expect((error as TaskStoreRequestError).status).toBe(400);
    await expect(good).resolves.toEqual(expect.objectContaining({ id: "b" }));
  });

  it("keeps one batch in flight at a time", async () => {
    let release: (() => void) | null = null;
    const send = vi.fn(
      (tasks: SharedTaskUpsertInput[]) =>
        new Promise<SharedTaskUpsertResult[]>((resolve) => {
          release = () => resolve(tasks.map((entry) => ({ task: mergeSharedTaskRecord(entry, null) })));
        })
    );
    const queue = createSharedTaskUpsertQueue({ send });
    const first = queue.enqueue(task("a"));
    await vi.advanceTimersByTimeAsync(SHARED_TASK_FLUSH_DELAY_MS);
    expect(send).toHaveBeenCalledTimes(1);

    const second = queue.enqueue(task("b"));
    await vi.advanceTimersByTimeAsync(SHARED_TASK_FLUSH_DELAY_MS * 3);
    expect(send).toHaveBeenCalledTimes(1);

    release!();
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
    release!();
    await expect(second).resolves.toEqual(expect.objectContaining({ id: "b" }));
  });

  it("tells a full read which tasks were written after it started", async () => {
    const { send } = makeStoreSend();
    const queue = createSharedTaskUpsertQueue({ send });
    const token = queue.beginRead();
    const saved = queue.enqueue(task("a"));
    expect(queue.isNewerThan("a", token)).toBe(true);
    await vi.advanceTimersByTimeAsync(SHARED_TASK_FLUSH_DELAY_MS);
    await saved;
    expect(queue.isNewerThan("a", token)).toBe(true);
    expect(queue.isNewerThan("b", token)).toBe(false);
    expect(queue.isNewerThan("a", queue.beginRead())).toBe(false);
  });

  it("still reports a newer upsert queued while a batch was in flight when that batch is applied", async () => {
    let release: (() => void) | null = null;
    const send = vi.fn(
      (tasks: SharedTaskUpsertInput[]) =>
        new Promise<SharedTaskUpsertResult[]>((resolve) => {
          release = () => resolve(tasks.map((entry) => ({ task: mergeSharedTaskRecord(entry, null) })));
        })
    );
    const pendingDuringApply: boolean[] = [];
    const queue = createSharedTaskUpsertQueue({
      send,
      onApplied: () => {
        pendingDuringApply.push(queue.hasPending("a"));
      },
    });
    const first = queue.enqueue(task("a", { status: "in_progress" }));
    await vi.advanceTimersByTimeAsync(SHARED_TASK_FLUSH_DELAY_MS);
    expect(send).toHaveBeenCalledTimes(1);
    // A newer edit of the same task, queued while the first batch is in flight.
    const second = queue.enqueue(task("a", { status: "done", updatedAt: "2026-09-28T10:00:05.000Z" }));
    release!();
    await first;
    await vi.advanceTimersByTimeAsync(SHARED_TASK_FLUSH_DELAY_MS);
    release!();
    await second;
    expect(pendingDuringApply).toEqual([true, false]);
  });

  it("sends a keepalive batch only when its body fits the browser's byte limit", async () => {
    vi.useRealTimers();
    const keepalives: Array<boolean | undefined> = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      keepalives.push(init?.keepalive);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    try {
      await upsertSharedTaskRecords([task("a")], { keepalive: true });
      // About 40k characters, but twice as many bytes.
      await upsertSharedTaskRecords([task("b", { description: "ж".repeat(40_000) })], { keepalive: true });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(keepalives).toEqual([true, undefined]);
  });

  it("sends what is left right away when disposed", async () => {
    const { send } = makeStoreSend();
    const queue = createSharedTaskUpsertQueue({ send });
    const saved = queue.enqueue(task("a"));
    queue.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(saved).resolves.toEqual(expect.objectContaining({ id: "a" }));
  });
});
