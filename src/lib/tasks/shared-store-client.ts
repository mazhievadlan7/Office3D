import type { SharedTaskRecord } from "@/lib/tasks/shared-store";
import {
  isNoopSharedTaskUpsert,
  normalizeTaskRecord,
  type SharedTaskUpsertInput,
} from "@/lib/tasks/shared-task-merge";
import { t } from "@/lib/i18n";

const TASK_STORE_ROUTE = "/api/task-store";
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;

export class TaskStoreRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TaskStoreRequestError";
    this.status = status;
  }
}

const isRetryable = (error: unknown): boolean => {
  if (error instanceof TaskStoreRequestError) {
    return error.status >= 500 || error.status === 429;
  }
  if (error instanceof DOMException && error.name === "AbortError") return false;
  return error instanceof TypeError;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const fetchWithTimeout = (
  input: RequestInfo,
  init?: RequestInit
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(input, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
};

const parseResponse = async <T>(response: Response): Promise<T> => {
  const body = (await response.json().catch(() => null)) as { error?: string } & T;
  if (!response.ok) {
    throw new TaskStoreRequestError(
      body?.error || t("libTasks.storeRequestFailed"),
      response.status,
    );
  }
  return body;
};

const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === MAX_RETRIES) break;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError;
};

export const listSharedTaskRecords = async (): Promise<SharedTaskRecord[]> =>
  withRetry(async () => {
    const response = await fetchWithTimeout(TASK_STORE_ROUTE, {
      method: "GET",
      cache: "no-store",
    });
    const body = await parseResponse<{ tasks: SharedTaskRecord[] }>(response);
    return Array.isArray(body.tasks) ? body.tasks : [];
  });

export const upsertSharedTaskRecord = async (
  task: Partial<SharedTaskRecord> & Pick<SharedTaskRecord, "id" | "title">
): Promise<SharedTaskRecord> =>
  withRetry(async () => {
    const response = await fetchWithTimeout(TASK_STORE_ROUTE, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task }),
    });
    const body = await parseResponse<{ task: SharedTaskRecord }>(response);
    return body.task;
  });

export const archiveSharedTaskRecord = async (
  taskId: string
): Promise<SharedTaskRecord> =>
  withRetry(async () => {
    const response = await fetchWithTimeout(TASK_STORE_ROUTE, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: taskId }),
    });
    const body = await parseResponse<{ task: SharedTaskRecord }>(response);
    return body.task;
  });

/** One entry's outcome in a batch upsert: the stored record, or its own error. */
export type SharedTaskUpsertResult = { task: SharedTaskRecord } | { error: string; status: number };

// Browsers refuse keepalive requests with larger bodies.
const KEEPALIVE_BODY_LIMIT = 60_000;

/** Upserts several tasks, in order, in one request (one read and one write on the server). */
export const upsertSharedTaskRecords = async (
  tasks: SharedTaskUpsertInput[],
  options: { keepalive?: boolean } = {}
): Promise<SharedTaskUpsertResult[]> => {
  const body = JSON.stringify({ tasks });
  // The limit is in bytes (non-Latin titles take more than one byte a character);
  // a keepalive request over it is refused outright.
  const keepalive =
    Boolean(options.keepalive) && new TextEncoder().encode(body).length < KEEPALIVE_BODY_LIMIT;
  return withRetry(async () => {
    const response = await fetchWithTimeout(TASK_STORE_ROUTE, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
      ...(keepalive ? { keepalive: true } : {}),
    });
    const parsed = await parseResponse<{ results: SharedTaskUpsertResult[] }>(response);
    return Array.isArray(parsed.results) ? parsed.results : [];
  });
};

/** How long task upserts are collected before they are sent together. */
export const SHARED_TASK_FLUSH_DELAY_MS = 1_000;

type QueueEntry = {
  id: string;
  task: SharedTaskUpsertInput;
  resolve: (record: SharedTaskRecord) => void;
  reject: (error: unknown) => void;
};

type QueueOutcome = { record: SharedTaskRecord } | { error: unknown };

export type SharedTaskUpsertQueue = {
  /** Queues an upsert; resolves with the stored record once its batch is saved. */
  enqueue: (task: SharedTaskUpsertInput) => Promise<SharedTaskRecord>;
  /** Sends everything queued now (after any batch already in flight). Never rejects. */
  flush: (options?: { keepalive?: boolean }) => Promise<void>;
  /** An upsert for this task is queued or in flight. */
  hasPending: (id: string) => boolean;
  /** Marks the start of a full read of the store; pass the token to the calls below. */
  beginRead: () => number;
  /** The task was queued, or saved, after the read with this token started. */
  isNewerThan: (id: string, token: number) => boolean;
  /** Records what a full read (started with `token`) returned. */
  rememberList: (records: SharedTaskRecord[], token: number) => void;
  /** Records a task the store returned outside the queue. */
  remember: (record: SharedTaskRecord) => void;
  /** Stops the timer and sends what is left now. */
  dispose: () => void;
};

/**
 * Collects task upserts and sends them about once a second as one batch.
 *
 * Every upsert is kept and sent in order, so the store ends up exactly as it
 * would after separate requests (history included); the batch just costs one
 * request and one file write instead of one per upsert. An upsert that would
 * store exactly the record the store already holds (as this office last saw
 * it) is not sent; it resolves with that record, which is what the store would
 * have answered. A failed batch (after the client's usual retries) fails every
 * upsert sent in it, as the separate requests would have failed.
 *
 * `onApplied` gets the stored records of a batch, in order, before the
 * individual promises settle, so the caller can apply them in one go.
 */
export const createSharedTaskUpsertQueue = ({
  send = upsertSharedTaskRecords,
  onApplied,
  delayMs = SHARED_TASK_FLUSH_DELAY_MS,
}: {
  send?: (tasks: SharedTaskUpsertInput[], options?: { keepalive?: boolean }) => Promise<SharedTaskUpsertResult[]>;
  onApplied?: (records: SharedTaskRecord[]) => void;
  delayMs?: number;
} = {}): SharedTaskUpsertQueue => {
  let queue: QueueEntry[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let writeSeq = 0;
  const pending = new Map<string, number>();
  const lastWrite = new Map<string, number>();
  // Stored records as this office last saw them (normalized, as a read returns them).
  const known = new Map<string, SharedTaskRecord>();

  const isNewer = (id: string, token: number) =>
    (pending.get(id) ?? 0) > 0 || (lastWrite.get(id) ?? 0) > token;

  const rememberRecord = (record: SharedTaskRecord) => {
    const normalized = normalizeTaskRecord(record);
    if (normalized) known.set(normalized.id, normalized);
    else known.delete(record.id);
  };

  const release = (id: string) => {
    const count = (pending.get(id) ?? 1) - 1;
    if (count > 0) pending.set(id, count);
    else pending.delete(id);
  };

  const sendQueued = async (options?: { keepalive?: boolean }) => {
    const entries = queue;
    queue = [];
    if (entries.length === 0) return;
    const outcomes: QueueOutcome[] = new Array(entries.length);
    const sendIndexes: number[] = [];
    const sentIds = new Set<string>();
    entries.forEach((entry, index) => {
      const base = known.get(entry.id) ?? null;
      if (base && !sentIds.has(entry.id) && isNoopSharedTaskUpsert(entry.task, base)) {
        outcomes[index] = { record: base };
        return;
      }
      sentIds.add(entry.id);
      sendIndexes.push(index);
    });
    if (sendIndexes.length > 0) {
      try {
        const results = await send(
          sendIndexes.map((index) => entries[index].task),
          options
        );
        sendIndexes.forEach((index, position) => {
          const result = results[position];
          if (result && "task" in result && result.task) {
            outcomes[index] = { record: result.task };
            return;
          }
          const failed = result && "error" in result ? result : null;
          outcomes[index] = {
            error: new TaskStoreRequestError(
              failed?.error || t("libTasks.storeRequestFailed"),
              failed?.status ?? 500
            ),
          };
        });
      } catch (error) {
        for (const index of sendIndexes) outcomes[index] = { error };
      }
    }
    writeSeq += 1;
    const applied: SharedTaskRecord[] = [];
    entries.forEach((entry, index) => {
      const outcome = outcomes[index];
      lastWrite.set(entry.id, writeSeq);
      if ("record" in outcome) {
        rememberRecord(outcome.record);
        applied.push(outcome.record);
      } else {
        // The store may or may not hold it now; never skip the next upsert.
        known.delete(entry.id);
      }
      release(entry.id);
    });
    if (applied.length > 0 && onApplied) {
      try {
        onApplied(applied);
      } catch (error) {
        console.error("Failed to apply saved tasks.", error);
      }
    }
    entries.forEach((entry, index) => {
      const outcome = outcomes[index];
      if ("record" in outcome) entry.resolve(outcome.record);
      else entry.reject(outcome.error);
    });
  };

  const flush = (options?: { keepalive?: boolean }) => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    chain = chain
      .then(() => sendQueued(options))
      .catch((error) => {
        console.error("Failed to save tasks.", error);
      });
    return chain;
  };

  const schedule = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delayMs);
  };

  return {
    enqueue: (task) =>
      new Promise<SharedTaskRecord>((resolve, reject) => {
        const id = task.id.trim();
        queue.push({ id, task, resolve, reject });
        pending.set(id, (pending.get(id) ?? 0) + 1);
        schedule();
      }),
    flush,
    hasPending: (id) => (pending.get(id.trim()) ?? 0) > 0,
    beginRead: () => writeSeq,
    isNewerThan: isNewer,
    rememberList: (records, token) => {
      const listed = new Set<string>();
      for (const record of records) {
        listed.add(record.id);
        if (!isNewer(record.id, token)) rememberRecord(record);
      }
      for (const id of [...known.keys()]) {
        if (!listed.has(id) && !isNewer(id, token)) known.delete(id);
      }
      // Reads start at or after this token from now on, so writes at or before
      // it can never count as newer again; without this the map kept an entry
      // for every task ever written.
      for (const [id, seq] of lastWrite) {
        if (seq <= token) lastWrite.delete(id);
      }
    },
    remember: (record) => {
      writeSeq += 1;
      lastWrite.set(record.id, writeSeq);
      rememberRecord(record);
    },
    dispose: () => {
      if (timer !== null || queue.length > 0) void flush();
    },
  };
};
