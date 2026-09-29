import { isTaskBoardSource, isTaskBoardStatus } from "@/features/office/tasks/types";
import {
  archiveSharedTask,
  listSharedTasks,
  upsertSharedTask,
  upsertSharedTasks,
  type SharedTaskRecord,
} from "@/lib/tasks/shared-store";
import { t } from "@/lib/i18n";

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const errorJson = (message: string, status: number) =>
  json({ error: message }, status);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

export async function GET() {
  try {
    return json({ tasks: listSharedTasks() });
  } catch (error) {
    console.error("[task-store] GET failed:", error);
    return errorJson(t("apiTasks.readFailed"), 500);
  }
}

type TaskValidation =
  | { ok: true; task: Record<string, unknown> & { id: string; title: string } }
  | { ok: false; error: string };

const validateTask = (task: Record<string, unknown>): TaskValidation => {
  const id = typeof task.id === "string" ? task.id.trim() : "";
  const title = typeof task.title === "string" ? task.title.trim() : "";
  if (!id || !title) {
    return { ok: false, error: t("apiTasks.idAndTitleRequired") };
  }
  if (task.status !== undefined && !isTaskBoardStatus(task.status)) {
    return { ok: false, error: t("apiTasks.invalidStatus", { status: String(task.status) }) };
  }
  if (task.source !== undefined && !isTaskBoardSource(task.source)) {
    return { ok: false, error: t("apiTasks.invalidSource", { source: String(task.source) }) };
  }
  return { ok: true, task: { ...task, id, title } };
};

// `{ tasks: [...] }` upserts several tasks in order with one read and one
// write, as that many `{ task }` requests would. Each entry gets its own
// result: `{ task }`, or `{ error, status: 400 }` for an invalid entry (the
// others are still stored).
const putBatch = (entries: unknown[]) => {
  const results: Array<{ task: SharedTaskRecord } | { error: string; status: number }> = [];
  const valid: Array<{ index: number; task: Record<string, unknown> & { id: string; title: string } }> = [];
  entries.forEach((entry, index) => {
    if (!isRecord(entry)) {
      results[index] = { error: t("apiTasks.payloadRequired"), status: 400 };
      return;
    }
    const validation = validateTask(entry);
    if (!validation.ok) {
      results[index] = { error: validation.error, status: 400 };
      return;
    }
    valid.push({ index, task: validation.task });
  });
  try {
    const saved = upsertSharedTasks(valid.map((entry) => entry.task));
    valid.forEach((entry, position) => {
      results[entry.index] = { task: saved[position] };
    });
    return json({ results });
  } catch (error) {
    console.error("[task-store] PUT failed:", error);
    return errorJson(t("apiTasks.writeFailed"), 500);
  }
};

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorJson(t("apiCommon.invalidJsonBody"), 400);
  }
  if (isRecord(body) && Array.isArray(body.tasks)) {
    return putBatch(body.tasks);
  }
  if (!isRecord(body) || !isRecord(body.task)) {
    return errorJson(t("apiTasks.payloadRequired"), 400);
  }
  const validation = validateTask(body.task);
  if (!validation.ok) {
    return errorJson(validation.error, 400);
  }
  try {
    return json({
      task: upsertSharedTask(validation.task),
    });
  } catch (error) {
    console.error("[task-store] PUT failed:", error);
    return errorJson(t("apiTasks.writeFailed"), 500);
  }
}

export async function DELETE(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorJson(t("apiCommon.invalidJsonBody"), 400);
  }
  if (!isRecord(body)) {
    return errorJson(t("apiTasks.idRequired"), 400);
  }
  const taskId = typeof body.id === "string" ? body.id.trim() : "";
  if (!taskId) {
    return errorJson(t("apiTasks.idRequired"), 400);
  }
  try {
    const task = archiveSharedTask(taskId);
    if (!task) {
      return errorJson(t("apiTasks.notFound"), 404);
    }
    return json({ task });
  } catch (error) {
    console.error("[task-store] DELETE failed:", error);
    return errorJson(t("apiTasks.archiveFailed"), 500);
  }
}
