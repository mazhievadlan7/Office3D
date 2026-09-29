import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  archiveSharedTask,
  listSharedTasks,
  resolveSharedTaskStorePath,
  upsertSharedTask,
  upsertSharedTasks,
} from "@/lib/tasks/shared-store";

const makeTempDir = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));

describe("shared task store", () => {
  const priorStateDir = process.env.OPENCLAW_STATE_DIR;
  let tempDir: string | null = null;

  afterEach(() => {
    process.env.OPENCLAW_STATE_DIR = priorStateDir;
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("creates and lists persisted tasks", () => {
    tempDir = makeTempDir("shared-task-store-create");
    process.env.OPENCLAW_STATE_DIR = tempDir;

    const created = upsertSharedTask({
      id: "task-1",
      title: "Research mtulsa.com",
      description: "Check site positioning.",
      status: "todo",
      source: "office3d_manual",
    });

    expect(created.history).toHaveLength(1);
    expect(created.history[0]).toEqual(
      expect.objectContaining({
        type: "created",
        toStatus: "todo",
      })
    );

    const stored = listSharedTasks();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.title).toBe("Research mtulsa.com");
    expect(fs.existsSync(resolveSharedTaskStorePath())).toBe(true);
  });

  it("appends history when task status changes and archives instead of deleting", () => {
    tempDir = makeTempDir("shared-task-store-history");
    process.env.OPENCLAW_STATE_DIR = tempDir;

    upsertSharedTask({
      id: "task-1",
      title: "Research mtulsa.com",
      status: "todo",
      source: "office3d_manual",
    });
    const updated = upsertSharedTask({
      id: "task-1",
      title: "Research mtulsa.com",
      status: "in_progress",
      source: "office3d_manual",
    });
    const archived = archiveSharedTask("task-1");

    expect(updated.history.map((entry) => entry.type)).toContain("status_changed");
    expect(archived?.isArchived).toBe(true);
    expect(archived?.history.map((entry) => entry.type)).toContain("archived");
  });

  it("recovers gracefully from corrupted JSON on disk", () => {
    tempDir = makeTempDir("shared-task-store-corrupt");
    process.env.OPENCLAW_STATE_DIR = tempDir;

    upsertSharedTask({ id: "t-1", title: "Valid task", status: "todo", source: "office3d_manual" });
    const storePath = resolveSharedTaskStorePath();
    fs.writeFileSync(storePath, "{invalid json!!!", "utf8");

    const tasks = listSharedTasks();
    expect(tasks).toEqual([]);

    const afterCorrupt = upsertSharedTask({ id: "t-2", title: "After recovery", status: "todo", source: "office3d_manual" });
    expect(afterCorrupt.id).toBe("t-2");
    expect(listSharedTasks()).toHaveLength(1);
  });

  it("performs atomic writes so partial failures don't corrupt the store", () => {
    tempDir = makeTempDir("shared-task-store-atomic");
    process.env.OPENCLAW_STATE_DIR = tempDir;

    upsertSharedTask({ id: "t-1", title: "Safe task", status: "todo", source: "office3d_manual" });
    const storePath = resolveSharedTaskStorePath();
    const original = fs.readFileSync(storePath, "utf8");

    expect(JSON.parse(original)).toEqual(
      expect.objectContaining({ schemaVersion: 1 })
    );
    expect(listSharedTasks()).toHaveLength(1);
  });

  it("coerces invalid status and source to defaults", () => {
    tempDir = makeTempDir("shared-task-store-coerce");
    process.env.OPENCLAW_STATE_DIR = tempDir;

    const task = upsertSharedTask({
      id: "t-coerce",
      title: "Coerce test",
      status: "banana" as never,
      source: "alien" as never,
    });
    expect(task.status).toBe("todo");
    expect(task.source).toBe("office3d_manual");
  });

  it("truncates oversized title and description", () => {
    tempDir = makeTempDir("shared-task-store-truncate");
    process.env.OPENCLAW_STATE_DIR = tempDir;

    const longTitle = "A".repeat(1000);
    const longDesc = "B".repeat(10_000);
    const task = upsertSharedTask({
      id: "t-long",
      title: longTitle,
      description: longDesc,
      status: "todo",
      source: "office3d_manual",
    });

    expect(task.title.length).toBeLessThanOrEqual(500);
    expect(task.description.length).toBeLessThanOrEqual(5000);
  });

  it("returns null when archiving a non-existent task", () => {
    tempDir = makeTempDir("shared-task-store-archive-missing");
    process.env.OPENCLAW_STATE_DIR = tempDir;

    const result = archiveSharedTask("does-not-exist");
    expect(result).toBeNull();
  });

  it("returns an empty list when store file does not exist", () => {
    tempDir = makeTempDir("shared-task-store-missing-file");
    process.env.OPENCLAW_STATE_DIR = tempDir;

    expect(listSharedTasks()).toEqual([]);
  });

  const batch = [
    { id: "t-1", title: "First", status: "todo" as const, source: "openclaw_event" as const, updatedAt: "2026-09-28T10:00:00.000Z" },
    { id: "t-2", title: "Second", status: "todo" as const, source: "openclaw_event" as const, updatedAt: "2026-09-28T10:00:01.000Z" },
    { id: "t-1", title: "First", status: "review" as const, source: "openclaw_event" as const, updatedAt: "2026-09-28T10:00:02.000Z" },
    { id: "t-2", title: " Second ", notes: [" note "], runId: " run-2 ", updatedAt: "2026-09-28T10:00:03.000Z" },
  ];

  it("stores a batch exactly as the same upserts one by one, with one atomic write", () => {
    tempDir = makeTempDir("shared-task-store-batch");
    process.env.OPENCLAW_STATE_DIR = path.join(tempDir, "one-by-one");
    const oneByOne = batch.map((task) => upsertSharedTask(task));
    const oneByOneStored = listSharedTasks();

    process.env.OPENCLAW_STATE_DIR = path.join(tempDir, "batch");
    const writes = vi.spyOn(fs, "writeFileSync");
    const renames = vi.spyOn(fs, "renameSync");
    try {
      const saved = upsertSharedTasks(batch);
      expect(writes).toHaveBeenCalledTimes(1);
      expect(renames).toHaveBeenCalledTimes(1);
      expect(saved).toEqual(oneByOne);
    } finally {
      writes.mockRestore();
      renames.mockRestore();
    }
    expect(listSharedTasks()).toEqual(oneByOneStored);
    expect(listSharedTasks().find((task) => task.id === "t-1")?.history.map((entry) => entry.type)).toEqual([
      "created",
      "status_changed",
    ]);
  });

  it("stores nothing of a batch whose write fails", () => {
    tempDir = makeTempDir("shared-task-store-batch-fail");
    process.env.OPENCLAW_STATE_DIR = tempDir;
    upsertSharedTask({ id: "t-0", title: "Before", status: "todo", source: "office3d_manual" });
    const before = fs.readFileSync(resolveSharedTaskStorePath(), "utf8");

    const renames = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    try {
      expect(() => upsertSharedTasks(batch)).toThrow("disk full");
    } finally {
      renames.mockRestore();
    }

    expect(fs.readFileSync(resolveSharedTaskStorePath(), "utf8")).toBe(before);
    expect(listSharedTasks().map((task) => task.id)).toEqual(["t-0"]);
    const leftovers = fs.readdirSync(path.dirname(resolveSharedTaskStorePath())).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("writes compact JSON and notices when the file changes underneath", () => {
    tempDir = makeTempDir("shared-task-store-compact");
    process.env.OPENCLAW_STATE_DIR = tempDir;
    upsertSharedTask({ id: "t-1", title: "Compact", status: "todo", source: "office3d_manual" });
    const storePath = resolveSharedTaskStorePath();
    expect(fs.readFileSync(storePath, "utf8")).not.toContain("\n");
    expect(listSharedTasks().map((task) => task.title)).toEqual(["Compact"]);

    // Someone else rewrites the file: the next read returns the new content.
    const replaced = JSON.parse(fs.readFileSync(storePath, "utf8")) as { tasks: Array<{ title: string }> };
    replaced.tasks[0].title = "Changed on disk, a longer title";
    fs.writeFileSync(storePath, JSON.stringify(replaced), "utf8");
    expect(listSharedTasks().map((task) => task.title)).toEqual(["Changed on disk, a longer title"]);
  });

  it("does not let a caller's changes to a listed array leak into the store", () => {
    tempDir = makeTempDir("shared-task-store-copy");
    process.env.OPENCLAW_STATE_DIR = tempDir;
    upsertSharedTask({ id: "t-1", title: "Kept", status: "todo", source: "office3d_manual" });
    listSharedTasks().length = 0;
    expect(listSharedTasks()).toHaveLength(1);
  });
});
