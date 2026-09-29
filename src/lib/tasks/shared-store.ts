import crypto from "node:crypto";
import fs from "node:fs";
// import os from "node:os";
import path from "node:path";

import type { TaskBoardCard, TaskBoardStatus } from "@/features/office/tasks/types";
import { resolveStateDir } from "@/lib/clawdbot/paths";
import {
  mergeSharedTaskRecord,
  normalizeTaskRecord,
  trimString,
  type SharedTaskUpsertInput,
} from "@/lib/tasks/shared-task-merge";

export type SharedTaskHistoryEntry = {
  at: string;
  type: "created" | "updated" | "status_changed" | "archived";
  note: string | null;
  fromStatus: TaskBoardStatus | null;
  toStatus: TaskBoardStatus | null;
};

export type SharedTaskRecord = TaskBoardCard & {
  history: SharedTaskHistoryEntry[];
};

type SharedTaskStore = {
  schemaVersion: 1;
  updatedAt: string;
  tasks: SharedTaskRecord[];
};

const STORE_DIR = path.join("office3d", "task-manager");
const STORE_FILE = "tasks.json";

const ensureDirectory = (dirPath: string) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

const resolveStorePath = () => {
  const stateDir = resolveStateDir();
  const dir = path.join(stateDir, STORE_DIR);
  ensureDirectory(dir);
  return path.join(dir, STORE_FILE);
};

const defaultStore = (): SharedTaskStore => ({
  schemaVersion: 1,
  updatedAt: new Date(0).toISOString(),
  tasks: [],
});

const normalizeStore = (value: unknown): SharedTaskStore => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultStore();
  }
  const record = value as Record<string, unknown>;
  const updatedAt = trimString(record.updatedAt) || new Date(0).toISOString();
  const tasks = Array.isArray(record.tasks)
    ? record.tasks
        .map((entry) => normalizeTaskRecord(entry))
        .filter((entry): entry is SharedTaskRecord => Boolean(entry))
    : [];
  return {
    schemaVersion: 1,
    updatedAt,
    tasks,
  };
};

// The parsed store is kept between requests and reused while the file on disk
// is unchanged (same path, file, mtime and size; every write replaces the file
// by rename, so it is a new file), so the office's periodic reads do
// not re-read and re-parse the whole file each time.
type StoreCache = { path: string; ino: number; mtimeMs: number; size: number; store: SharedTaskStore };

const sameFile = (cache: StoreCache, storePath: string, stat: fs.Stats) =>
  cache.path === storePath && cache.ino === stat.ino && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size;
let storeCache: StoreCache | null = null;

const statStore = (storePath: string): fs.Stats | null => {
  try {
    return fs.statSync(storePath);
  } catch {
    return null;
  }
};

// Callers get their own task array; records themselves are never mutated.
const copyStore = (store: SharedTaskStore): SharedTaskStore => ({ ...store, tasks: store.tasks.slice() });

const readStore = (): SharedTaskStore => {
  const storePath = resolveStorePath();
  const stat = statStore(storePath);
  if (!stat) {
    storeCache = null;
    return defaultStore();
  }
  const cache = storeCache;
  if (cache && sameFile(cache, storePath, stat)) {
    return copyStore(cache.store);
  }
  try {
    const raw = fs.readFileSync(storePath, "utf8");
    const store = normalizeStore(JSON.parse(raw));
    storeCache = { path: storePath, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size, store };
    return copyStore(store);
  } catch {
    storeCache = null;
    return defaultStore();
  }
};

const MAX_TASKS = 500;

const writeStore = (store: SharedTaskStore) => {
  const storePath = resolveStorePath();
  const dir = path.dirname(storePath);
  const tmpPath = path.join(dir, `.tasks-${crypto.randomUUID()}.tmp`);
  storeCache = null;
  try {
    // Compact: the file is read by code, not people.
    fs.writeFileSync(tmpPath, JSON.stringify(store), "utf8");
    fs.renameSync(tmpPath, storePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup.
    }
    throw error;
  }
  const stat = statStore(storePath);
  if (stat) {
    storeCache = { path: storePath, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size, store: copyStore(store) };
  }
};

// Upserts one task into an in-memory store (no I/O). The store keeps the
// record as a later read of the file would return it (normalized), so tasks
// applied one after another in memory see what separate requests would have.
const applyUpsert = (store: SharedTaskStore, task: SharedTaskUpsertInput): SharedTaskRecord => {
  const existing = store.tasks.find((entry) => entry.id === task.id) ?? null;
  const next = mergeSharedTaskRecord(task, existing);
  const stored = normalizeTaskRecord(next);
  const index = store.tasks.findIndex((entry) => entry.id === next.id);
  if (index >= 0) {
    if (stored) store.tasks[index] = stored;
    else store.tasks.splice(index, 1);
  } else {
    if (store.tasks.length >= MAX_TASKS) {
      const archivedIndex = store.tasks.findIndex((t) => t.isArchived);
      if (archivedIndex >= 0) {
        store.tasks.splice(archivedIndex, 1);
      } else {
        store.tasks.shift();
      }
    }
    if (stored) store.tasks.push(stored);
  }
  store.updatedAt = next.updatedAt;
  return next;
};

export const listSharedTasks = (): SharedTaskRecord[] => readStore().tasks;

export const upsertSharedTask = (task: SharedTaskUpsertInput): SharedTaskRecord => {
  const store = readStore();
  const next = applyUpsert(store, task);
  writeStore(store);
  return next;
};

/**
 * Upserts several tasks in order, exactly as that many single upserts would,
 * with one read and one atomic write: either all of them are stored or none.
 */
export const upsertSharedTasks = (tasks: SharedTaskUpsertInput[]): SharedTaskRecord[] => {
  if (tasks.length === 0) return [];
  const store = readStore();
  const saved = tasks.map((task) => applyUpsert(store, task));
  writeStore(store);
  return saved;
};

export const archiveSharedTask = (taskId: string): SharedTaskRecord | null => {
  const existing = readStore().tasks.find((entry) => entry.id === taskId.trim()) ?? null;
  if (!existing) return null;
  return upsertSharedTask({
    ...existing,
    isArchived: true,
    updatedAt: new Date().toISOString(),
  });
};

export const resolveSharedTaskStorePath = () => resolveStorePath();
