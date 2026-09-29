/**
 * How one upsert is folded into a stored shared task record.
 *
 * Pure (no file system), so the server store applies it and the office can
 * tell, before sending, that an upsert would leave a stored record unchanged.
 */
import type { TaskBoardSource } from "@/features/office/tasks/types";
import { isTaskBoardSource, isTaskBoardStatus } from "@/features/office/tasks/types";
import { t } from "@/lib/i18n";
import type { SharedTaskHistoryEntry, SharedTaskRecord } from "@/lib/tasks/shared-store";

export type SharedTaskUpsertInput = Partial<SharedTaskRecord> & Pick<SharedTaskRecord, "id" | "title">;

export const trimString = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const normalizeStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];

const normalizeHistoryEntry = (value: unknown): SharedTaskHistoryEntry | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const at = trimString(record.at);
  const type = trimString(record.type);
  if (!at) return null;
  if (!["created", "updated", "status_changed", "archived"].includes(type)) return null;
  return {
    at,
    type: type as SharedTaskHistoryEntry["type"],
    note: trimString(record.note) || null,
    fromStatus: isTaskBoardStatus(record.fromStatus) ? record.fromStatus : null,
    toStatus: isTaskBoardStatus(record.toStatus) ? record.toStatus : null,
  };
};

/** A stored record as the store reads it back from disk (or null if unusable). */
export const normalizeTaskRecord = (value: unknown): SharedTaskRecord | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = trimString(record.id);
  const title = trimString(record.title);
  const createdAt = trimString(record.createdAt);
  const updatedAt = trimString(record.updatedAt);
  if (!id || !title || !createdAt || !updatedAt) return null;
  return {
    id,
    title,
    description: trimString(record.description),
    status: isTaskBoardStatus(record.status) ? record.status : "todo",
    source: isTaskBoardSource(record.source) ? record.source : "office3d_manual",
    sourceEventId: trimString(record.sourceEventId) || null,
    assignedAgentId: trimString(record.assignedAgentId) || null,
    createdAt,
    updatedAt,
    playbookJobId: trimString(record.playbookJobId) || null,
    runId: trimString(record.runId) || null,
    channel: trimString(record.channel) || null,
    externalThreadId: trimString(record.externalThreadId) || null,
    lastActivityAt: trimString(record.lastActivityAt) || null,
    notes: normalizeStringArray(record.notes),
    isArchived: Boolean(record.isArchived),
    isInferred: false,
    history: Array.isArray(record.history)
      ? record.history
          .map((entry) => normalizeHistoryEntry(entry))
          .filter((entry): entry is SharedTaskHistoryEntry => Boolean(entry))
      : [],
  };
};

const MAX_TITLE_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 5_000;
const MAX_NOTE_LENGTH = 2_000;
const MAX_NOTES_COUNT = 50;

const truncateField = (value: string, max: number) =>
  value.length <= max ? value : value.slice(0, max);

const appendHistory = (
  existing: SharedTaskRecord | null,
  next: SharedTaskRecord
): SharedTaskHistoryEntry[] => {
  if (!existing) {
    return [
      {
        at: next.updatedAt,
        type: "created",
        note: t("libTasks.historyCreated"),
        fromStatus: null,
        toStatus: next.status,
      },
    ];
  }
  const prior = existing.history ?? [];
  if (existing.isArchived !== next.isArchived && next.isArchived) {
    return [
      ...prior,
      {
        at: next.updatedAt,
        type: "archived",
        note: t("libTasks.historyArchived"),
        fromStatus: existing.status,
        toStatus: existing.status,
      },
    ];
  }
  if (existing.status !== next.status) {
    return [
      ...prior,
      {
        at: next.updatedAt,
        type: "status_changed",
        note: null,
        fromStatus: existing.status,
        toStatus: next.status,
      },
    ];
  }
  if (existing.updatedAt !== next.updatedAt) {
    return [
      ...prior,
      {
        at: next.updatedAt,
        type: "updated",
        note: null,
        fromStatus: existing.status,
        toStatus: next.status,
      },
    ];
  }
  return prior;
};

/** The record the store keeps after `task` is upserted onto `existing`. */
export const mergeSharedTaskRecord = (
  task: SharedTaskUpsertInput,
  existing: SharedTaskRecord | null
): SharedTaskRecord => {
  const nowIso = task.updatedAt?.trim() || new Date().toISOString();
  const rawStatus = task.status ?? existing?.status ?? "todo";
  const rawSource = (task.source as TaskBoardSource | undefined) ?? existing?.source ?? "office3d_manual";
  const notes = (task.notes ? [...task.notes] : [...(existing?.notes ?? [])])
    .slice(0, MAX_NOTES_COUNT)
    .map((n) => truncateField(n, MAX_NOTE_LENGTH));

  const next: SharedTaskRecord = {
    id: task.id.trim(),
    title: truncateField(task.title.trim() || existing?.title || t("libTasks.untitled"), MAX_TITLE_LENGTH),
    description: truncateField(task.description?.trim() ?? existing?.description ?? "", MAX_DESCRIPTION_LENGTH),
    status: isTaskBoardStatus(rawStatus) ? rawStatus : "todo",
    source: isTaskBoardSource(rawSource) ? rawSource : "office3d_manual",
    sourceEventId: task.sourceEventId ?? existing?.sourceEventId ?? null,
    assignedAgentId: task.assignedAgentId ?? existing?.assignedAgentId ?? null,
    createdAt: task.createdAt?.trim() || existing?.createdAt || nowIso,
    updatedAt: nowIso,
    playbookJobId: task.playbookJobId ?? existing?.playbookJobId ?? null,
    runId: task.runId ?? existing?.runId ?? null,
    channel: task.channel ?? existing?.channel ?? null,
    externalThreadId: task.externalThreadId ?? existing?.externalThreadId ?? null,
    lastActivityAt: task.lastActivityAt ?? existing?.lastActivityAt ?? nowIso,
    notes,
    isArchived: task.isArchived ?? existing?.isArchived ?? false,
    isInferred: false,
    history: [],
  };
  next.history = appendHistory(existing, next);
  return next;
};

const sameStrings = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const sameHistory = (left: readonly SharedTaskHistoryEntry[], right: readonly SharedTaskHistoryEntry[]) =>
  left.length === right.length &&
  left.every((entry, index) => {
    const other = right[index];
    return (
      entry.at === other.at &&
      entry.type === other.type &&
      entry.note === other.note &&
      entry.fromStatus === other.fromStatus &&
      entry.toStatus === other.toStatus
    );
  });

/** Field-by-field equality of two stored records (history included). */
export const sameSharedTaskRecord = (left: SharedTaskRecord, right: SharedTaskRecord): boolean =>
  left.id === right.id &&
  left.title === right.title &&
  left.description === right.description &&
  left.status === right.status &&
  left.source === right.source &&
  left.sourceEventId === right.sourceEventId &&
  left.assignedAgentId === right.assignedAgentId &&
  left.createdAt === right.createdAt &&
  left.updatedAt === right.updatedAt &&
  left.playbookJobId === right.playbookJobId &&
  left.runId === right.runId &&
  left.channel === right.channel &&
  left.externalThreadId === right.externalThreadId &&
  left.lastActivityAt === right.lastActivityAt &&
  left.isArchived === right.isArchived &&
  left.isInferred === right.isInferred &&
  sameStrings(left.notes ?? [], right.notes ?? []) &&
  sameHistory(left.history ?? [], right.history ?? []);

/**
 * True when upserting `task` onto the stored `existing` record would store
 * exactly the same record, so the request can be skipped. A task without its
 * own updatedAt is stamped with "now" by the store, so it is never a no-op.
 */
export const isNoopSharedTaskUpsert = (task: SharedTaskUpsertInput, existing: SharedTaskRecord | null): boolean => {
  if (!existing || !task.updatedAt?.trim()) return false;
  // Whatever the route would reject must still reach it.
  if (!task.id.trim() || !task.title.trim()) return false;
  if (task.status !== undefined && !isTaskBoardStatus(task.status)) return false;
  if (task.source !== undefined && !isTaskBoardSource(task.source)) return false;
  return sameSharedTaskRecord(mergeSharedTaskRecord(task, existing), existing);
};
