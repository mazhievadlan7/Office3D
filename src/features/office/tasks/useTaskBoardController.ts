"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import type { AgentState } from "@/features/agents/state/store";
import {
  sortTaskBoardCards,
  taskBoardReducer,
} from "@/features/office/tasks/taskBoardState";
import {
  defaultTaskBoardPreference,
  isTaskBoardStatus,
  type TaskBoardCard,
  type TaskBoardExplicitEvent,
  type TaskBoardSource,
  type TaskBoardStatus,
} from "@/features/office/tasks/types";
import type { RunRecord } from "@/features/office/hooks/useRunLog";
import { type OfficeStandupController } from "@/features/office/hooks/useOfficeStandupController";
import { extractText, isHeartbeatPrompt } from "@/lib/text/message-extract";
import {
  formatCronPayload,
  formatCronSchedule,
  listCronJobs,
  type CronJobSummary,
} from "@/lib/cron/types";
import {
  parseAgentIdFromSessionKey,
  type EventFrame,
  type GatewayClient,
  type GatewayStatus,
} from "@/lib/gateway/GatewayClient";
import {
  resolveTaskBoardPreference,
  type StudioTaskBoardPreference,
} from "@/lib/studio/settings";
import type { StudioSettingsCoordinator } from "@/lib/studio/coordinator";
import {
  createGatewayTask,
  isUnsupportedTaskGatewayError,
  listGatewayTasks,
  updateGatewayTask,
  type GatewayTaskRecord,
} from "@/lib/tasks/gateway";
import {
  archiveSharedTaskRecord,
  createSharedTaskUpsertQueue,
  listSharedTaskRecords,
  TaskStoreRequestError,
  upsertSharedTaskRecord,
} from "@/lib/tasks/shared-store-client";
import type { SharedTaskRecord } from "@/lib/tasks/shared-store";
import { randomUUID } from "@/lib/uuid";
import { LOCALE, t } from "@/lib/i18n";

// How long board changes are collected before they are saved to the studio settings.
const TASK_BOARD_SAVE_DEBOUNCE_MS = 1500;
// The patch is the whole board (hundreds of cards, ~400 KB). A live team changes
// it every second, so it is saved at most once per 15 s, and at the latest 15 s
// after the first unsaved change. A quiet board still saves 1.5 s after an edit.
const TASK_BOARD_SAVE_THROTTLE = { minIntervalMs: 15_000, maxWaitMs: 15_000 } as const;

const TASK_EVENT_NAMES = new Set([
  "task_created",
  "task_updated",
  "task_status_changed",
  "task_assigned",
  "task_linked_to_run",
  "task_deleted",
  "task_archived",
  "playbook_triggered",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const trimOrNull = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
};

const stableIdFragment = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
};

const truncateTitle = (value: string, fallback: string) => {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  const firstLine = trimmed.split("\n")[0]?.trim() ?? trimmed;
  if (firstLine.length <= 96) return firstLine;
  return `${firstLine.slice(0, 93).trimEnd()}...`;
};

const normalizeTaskRequestText = (value: string) =>
  value
    .replace(/^\s*>\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();

const TASK_REQUEST_PREFIX_RE =
  /^(?:please\s+|pls\s+|can you\s+|could you\s+|would you\s+|will you\s+|i need you to\s+|help me\s+|let'?s\s+)/i;

const TASK_REQUEST_VERB_RE =
  /\b(?:re[sc]?[ea]rch|check|find|look up|search|summarize|review|analy[sz]e|investigate|create|build|make|write|draft|plan|prepare|generate|fix|update|implement|refactor|debug|compare|collect|compile|send|schedule|call|message|reply|respond|explain|walk through|show me|give me|tell me|look into|set up|setup|deploy|configure|test|monitor|fetch|download|upload|add|remove|delete|clean|install|run|execute|list|describe|outline|figure out|sort out)\b/i;

const CONVERSATIONAL_MESSAGE_RE =
  /^(?:\?+|hi|hello|hey|yo|sup|ping|test|are you there|you there|still there|ok|okay|k|kk|yes|yeah|yep|no|nope|nah|thanks|thank you|thx|cool|nice|great|awesome|sounds good|got it|understood|roger|lol|what'?s up|how are you|good morning|good afternoon|good evening)[!.? ]*$/i;

const CONVERSATIONAL_QUESTION_RE =
  /^(?:are you there|you there|still there|can you hear me|hello\??|hi\??|how are you|what'?s up)[!.? ]*$/i;

export const isActionableTaskRequest = (value: string): boolean => {
  const text = normalizeTaskRequestText(value);
  if (!text) return false;
  if (isHeartbeatPrompt(text)) return false;

  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();

  if (!/[a-z0-9]/i.test(normalized)) return false;
  if (CONVERSATIONAL_MESSAGE_RE.test(normalized)) return false;
  if (CONVERSATIONAL_QUESTION_RE.test(normalized)) return false;
  if (normalized.length <= 3) return false;

  if (TASK_REQUEST_PREFIX_RE.test(normalized)) return true;
  if (TASK_REQUEST_VERB_RE.test(normalized)) return true;

  const words = normalized.split(" ").filter(Boolean);
  if (words.length <= 2) return false;

  if (
    /^(?:what|which|who|where|when|why|how)\b/.test(normalized) &&
    !/\b(?:status|progress|issue|problem|error|bug|latest|news|docs|documentation|plan|report|summary)\b/.test(
      normalized,
    )
  ) {
    return false;
  }

  // Enough substance to be a real request.
  if (words.length >= 4) return true;

  return /[?.!]$/.test(normalized) && words.length >= 3;
};

const makeCard = (
  input: Partial<TaskBoardCard> & Pick<TaskBoardCard, "id" | "title">,
): TaskBoardCard => {
  const nowIso = new Date().toISOString();
  return {
    id: input.id,
    title: input.title.trim() || t("opsTasks.untitled"),
    description: input.description?.trim() ?? "",
    status: input.status ?? "todo",
    source: input.source ?? "office3d_manual",
    sourceEventId: input.sourceEventId ?? null,
    assignedAgentId: input.assignedAgentId ?? null,
    createdAt: input.createdAt ?? nowIso,
    updatedAt: input.updatedAt ?? nowIso,
    playbookJobId: input.playbookJobId ?? null,
    runId: input.runId ?? null,
    channel: input.channel ?? null,
    externalThreadId: input.externalThreadId ?? null,
    lastActivityAt: input.lastActivityAt ?? null,
    notes: input.notes ? [...input.notes] : [],
    isArchived: input.isArchived ?? false,
    isInferred: input.isInferred ?? false,
  };
};

const resolveAgentIdFromSession = (
  agents: AgentState[],
  sessionKey: string | null,
): string | null => {
  const trimmed = sessionKey?.trim() ?? "";
  if (!trimmed) return null;
  return (
    agents.find((agent) => agent.sessionKey === trimmed)?.agentId ??
    parseAgentIdFromSessionKey(trimmed)
  );
};

export const parseExplicitTaskEvent = (
  event: EventFrame,
): TaskBoardExplicitEvent | null => {
  if (!TASK_EVENT_NAMES.has(event.event)) return null;
  const payload = isRecord(event.payload) ? event.payload : {};
  const taskId =
    trimOrNull(payload.taskId) ??
    trimOrNull(payload.id) ??
    (event.event === "playbook_triggered"
      ? (trimOrNull(payload.playbookJobId) ?? trimOrNull(payload.jobId))
      : null);
  if (!taskId) return null;
  const sourceEventId = `${event.event}:${event.seq ?? stableIdFragment(JSON.stringify(payload))}`;
  return {
    kind: event.event as TaskBoardExplicitEvent["kind"],
    frame: event,
    taskId,
    title: trimOrNull(payload.title) ?? trimOrNull(payload.name),
    description: trimOrNull(payload.description) ?? trimOrNull(payload.text),
    status: isTaskBoardStatus(payload.status) ? payload.status : null,
    assignedAgentId:
      trimOrNull(payload.assignedAgentId) ??
      trimOrNull(payload.agentId) ??
      null,
    playbookJobId:
      trimOrNull(payload.playbookJobId) ?? trimOrNull(payload.jobId) ?? null,
    runId: trimOrNull(payload.runId),
    channel: trimOrNull(payload.channel),
    externalThreadId:
      trimOrNull(payload.externalThreadId) ??
      trimOrNull(payload.threadId) ??
      trimOrNull(payload.conversationId),
    occurredAt:
      trimOrNull(payload.occurredAt) ??
      trimOrNull(payload.timestamp) ??
      new Date().toISOString(),
    sourceEventId,
    archived:
      event.event === "task_archived" || event.event === "task_deleted"
        ? true
        : undefined,
  };
};

const buildCardFromExplicitEvent = (
  explicit: TaskBoardExplicitEvent,
  existing?: TaskBoardCard | null,
): TaskBoardCard => {
  const fallbackTitle =
    explicit.kind === "playbook_triggered" ? t("opsTasks.triggeredPlaybook") : t("opsTasks.task");
  return makeCard({
    ...(existing ?? {}),
    id: explicit.taskId,
    title: explicit.title ?? existing?.title ?? fallbackTitle,
    description: explicit.description ?? existing?.description ?? "",
    status:
      explicit.status ??
      existing?.status ??
      (explicit.kind === "playbook_triggered" ? "todo" : "todo"),
    source:
      explicit.kind === "playbook_triggered" ? "playbook" : "openclaw_event",
    sourceEventId: explicit.sourceEventId,
    assignedAgentId:
      explicit.assignedAgentId ?? existing?.assignedAgentId ?? null,
    createdAt: existing?.createdAt ?? explicit.occurredAt,
    updatedAt: explicit.occurredAt,
    playbookJobId: explicit.playbookJobId ?? existing?.playbookJobId ?? null,
    runId: explicit.runId ?? existing?.runId ?? null,
    channel: explicit.channel ?? existing?.channel ?? null,
    externalThreadId:
      explicit.externalThreadId ?? existing?.externalThreadId ?? null,
    lastActivityAt: explicit.occurredAt,
    notes: existing?.notes ?? [],
    isArchived: explicit.archived ?? existing?.isArchived ?? false,
    isInferred: false,
  });
};

const buildCardFromGatewayTask = (
  task: GatewayTaskRecord,
  existing?: TaskBoardCard | null,
  authoritative = false,
): TaskBoardCard =>
  makeCard({
    ...(existing ?? {}),
    id: task.id,
    title: task.title,
    description: task.description ?? existing?.description ?? "",
    status: task.status,
    source: task.source ?? existing?.source ?? "openclaw_event",
    sourceEventId: task.sourceEventId ?? existing?.sourceEventId ?? null,
    // An authoritative board's "no assignee" is a fact, not a gap to fill
    // from the office's older copy.
    assignedAgentId: authoritative
      ? (task.assignedAgentId ?? null)
      : (task.assignedAgentId ?? existing?.assignedAgentId ?? null),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    playbookJobId: task.playbookJobId ?? existing?.playbookJobId ?? null,
    runId: task.runId ?? existing?.runId ?? null,
    channel: task.channel ?? existing?.channel ?? null,
    externalThreadId:
      task.externalThreadId ?? existing?.externalThreadId ?? null,
    lastActivityAt:
      task.lastActivityAt ?? existing?.lastActivityAt ?? task.updatedAt,
    notes: task.notes ?? existing?.notes ?? [],
    isArchived: task.archived ?? existing?.isArchived ?? false,
    isInferred: false,
  });

export const buildCardFromSharedTaskRecord = (
  task: SharedTaskRecord,
  existing?: TaskBoardCard | null,
): TaskBoardCard =>
  makeCard({
    ...(existing ?? {}),
    id: task.id,
    title: task.title,
    description: task.description ?? existing?.description ?? "",
    status: task.status,
    source: task.source ?? existing?.source ?? "office3d_manual",
    sourceEventId: task.sourceEventId ?? existing?.sourceEventId ?? null,
    assignedAgentId: task.assignedAgentId ?? existing?.assignedAgentId ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    playbookJobId: task.playbookJobId ?? existing?.playbookJobId ?? null,
    runId: task.runId ?? existing?.runId ?? null,
    channel: task.channel ?? existing?.channel ?? null,
    externalThreadId:
      task.externalThreadId ?? existing?.externalThreadId ?? null,
    lastActivityAt:
      task.lastActivityAt ?? existing?.lastActivityAt ?? task.updatedAt,
    notes: task.notes ?? existing?.notes ?? [],
    isArchived: task.isArchived ?? existing?.isArchived ?? false,
    isInferred: false,
  });

const cardTextKey = (card: Pick<TaskBoardCard, "title" | "assignedAgentId">) =>
  `${card.assignedAgentId ?? "-"}:${normalizeTaskRequestText(card.title).toLowerCase()}`;

export const matchesExplicitCard = (
  candidate: TaskBoardCard,
  explicitCard: TaskBoardCard,
) => {
  if (candidate.id === explicitCard.id) return true;
  if (
    candidate.sourceEventId &&
    explicitCard.sourceEventId &&
    candidate.sourceEventId === explicitCard.sourceEventId
  ) {
    return true;
  }
  if (
    candidate.externalThreadId &&
    explicitCard.externalThreadId &&
    candidate.externalThreadId === explicitCard.externalThreadId
  ) {
    return true;
  }
  return cardTextKey(candidate) === cardTextKey(explicitCard);
};

const sameStringList = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/** Field-by-field equality of two cards. */
export const sameTaskBoardCard = (left: TaskBoardCard, right: TaskBoardCard): boolean =>
  left === right ||
  (left.id === right.id &&
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
    sameStringList(left.notes, right.notes));

/**
 * The cards that change when the whole shared store (the periodic read) is
 * applied to the board: each record upserted onto the board's copy, then every
 * active inferred card matching any record's card archived, stamped with the
 * last matching record's time. That is what upserting the records one by one
 * did, computed with lookups instead of a scan of the board per record.
 * Records named by skip are left out. Cards equal to the board's are not
 * returned, so an unchanged store changes nothing.
 */
export const planSharedTaskRefresh = (
  cards: TaskBoardCard[],
  records: SharedTaskRecord[],
  skip: (id: string) => boolean = () => false,
): TaskBoardCard[] => {
  const byId = new Map<string, TaskBoardCard>();
  for (const card of cards) byId.set(card.id, card);
  const changed = new Map<string, TaskBoardCard>();
  const applied: TaskBoardCard[] = [];
  for (const record of records) {
    if (skip(record.id)) continue;
    const existing = byId.get(record.id) ?? null;
    const next = buildCardFromSharedTaskRecord(record, existing);
    if (existing && sameTaskBoardCard(existing, next)) changed.delete(next.id);
    else changed.set(next.id, next);
    applied.push(next);
  }
  const candidates = cards.filter((card) => card.isInferred && !card.isArchived);
  if (candidates.length > 0 && applied.length > 0) {
    // Where each key was last seen among the applied cards.
    const lastById = new Map<string, number>();
    const lastBySourceEvent = new Map<string, number>();
    const lastByThread = new Map<string, number>();
    const lastByText = new Map<string, number>();
    applied.forEach((card, index) => {
      lastById.set(card.id, index);
      if (card.sourceEventId) lastBySourceEvent.set(card.sourceEventId, index);
      if (card.externalThreadId) lastByThread.set(card.externalThreadId, index);
      lastByText.set(cardTextKey(card), index);
    });
    for (const candidate of candidates) {
      let last = lastById.get(candidate.id) ?? -1;
      if (candidate.sourceEventId) {
        last = Math.max(last, lastBySourceEvent.get(candidate.sourceEventId) ?? -1);
      }
      if (candidate.externalThreadId) {
        last = Math.max(last, lastByThread.get(candidate.externalThreadId) ?? -1);
      }
      last = Math.max(last, lastByText.get(cardTextKey(candidate)) ?? -1);
      if (last < 0) continue;
      const target = changed.get(candidate.id) ?? byId.get(candidate.id);
      if (!target) continue;
      changed.set(candidate.id, {
        ...target,
        isArchived: true,
        updatedAt: applied[last].updatedAt,
      });
    }
  }
  return [...changed.values()];
};

/**
 * The cards that change when records the store just saved are applied in
 * order, each as if it had arrived on its own: upserted onto the board, then
 * every active inferred card (as the board stood before that record) matching
 * it archived. Cards equal to the board's are not returned.
 */
export const planSharedTaskResponses = (
  cards: TaskBoardCard[],
  records: SharedTaskRecord[],
): TaskBoardCard[] => {
  const original = new Map<string, TaskBoardCard>();
  for (const card of cards) original.set(card.id, card);
  const working = new Map(original);
  const touched = new Set<string>();
  for (const record of records) {
    const existing = working.get(record.id) ?? null;
    const next = buildCardFromSharedTaskRecord(record, existing);
    const matched: string[] = [];
    for (const card of working.values()) {
      if (!card.isInferred || card.isArchived) continue;
      if (matchesExplicitCard(card, next)) matched.push(card.id);
    }
    working.set(next.id, next);
    touched.add(next.id);
    for (const id of matched) {
      const current = working.get(id);
      if (!current) continue;
      working.set(id, { ...current, isArchived: true, updatedAt: next.updatedAt });
      touched.add(id);
    }
  }
  const changed: TaskBoardCard[] = [];
  for (const id of touched) {
    const card = working.get(id);
    const before = original.get(id);
    if (card && !(before && sameTaskBoardCard(before, card))) changed.push(card);
  }
  return changed;
};

const deriveChatRequestCard = (
  event: EventFrame,
  agents: AgentState[],
  options: {
    source: TaskBoardSource;
    isInferred: boolean;
  },
): TaskBoardCard | null => {
  if (event.event !== "chat") return null;
  const payload = isRecord(event.payload) ? event.payload : {};
  const sessionKey = trimOrNull(payload.sessionKey);
  const message = isRecord(payload.message) ? payload.message : null;
  const role = trimOrNull(message?.role);
  if (role !== "user") return null;
  const text = normalizeTaskRequestText(extractText(message)?.trim() ?? "");
  if (!isActionableTaskRequest(text)) return null;
  const agentId = resolveAgentIdFromSession(agents, sessionKey);
  if (!agentId) return null;
  const sequence = trimOrNull(payload.seq) ?? String(payload.seq ?? "");
  const id = `chat:${sessionKey ?? agentId}:${sequence || stableIdFragment(text)}`;
  const timestamp =
    trimOrNull((message ?? payload).timestamp) ??
    trimOrNull((message ?? payload).createdAt) ??
    new Date().toISOString();
  return makeCard({
    id,
    title: truncateTitle(text, t("opsTasks.incomingRequest")),
    description: text,
    status: "todo",
    sourceEventId: id,
    assignedAgentId: agentId,
    createdAt: timestamp,
    updatedAt: timestamp,
    runId: trimOrNull(payload.runId),
    channel: trimOrNull(payload.channel),
    externalThreadId:
      trimOrNull(payload.threadId) ??
      trimOrNull(payload.conversationId) ??
      sessionKey,
    lastActivityAt: timestamp,
    source: options.source,
    isInferred: options.isInferred,
  });
};

export const deriveRecoveredAgentRequestCard = (
  agent: AgentState,
): TaskBoardCard | null => {
  const transcriptEntries = Array.isArray(agent.transcriptEntries)
    ? agent.transcriptEntries
    : [];
  for (let index = transcriptEntries.length - 1; index >= 0; index -= 1) {
    const entry = transcriptEntries[index];
    if (!entry || entry.role !== "user") continue;
    const text = normalizeTaskRequestText(entry.text);
    if (!isActionableTaskRequest(text)) continue;
    const timestamp =
      typeof entry.timestampMs === "number" &&
      Number.isFinite(entry.timestampMs)
        ? new Date(entry.timestampMs).toISOString()
        : typeof agent.lastActivityAt === "number" &&
            Number.isFinite(agent.lastActivityAt)
          ? new Date(agent.lastActivityAt).toISOString()
          : new Date().toISOString();
    const requestKey = `history:${agent.sessionKey}:${entry.sequenceKey}`;
    return makeCard({
      id: requestKey,
      title: truncateTitle(text, t("opsTasks.recoveredRequest")),
      description: text,
      status: "todo",
      source: "openclaw_event",
      sourceEventId: requestKey,
      assignedAgentId: agent.agentId,
      createdAt: timestamp,
      updatedAt: timestamp,
      runId: entry.runId ?? agent.runId,
      externalThreadId: agent.sessionKey,
      lastActivityAt: timestamp,
      isInferred: false,
    });
  }

  const fallbackText = normalizeTaskRequestText(
    agent.lastUserMessage?.trim() ?? "",
  );
  if (!isActionableTaskRequest(fallbackText)) return null;
  const fallbackTimestamp =
    typeof agent.lastActivityAt === "number" &&
    Number.isFinite(agent.lastActivityAt)
      ? new Date(agent.lastActivityAt).toISOString()
      : new Date().toISOString();
  const fallbackKey = `history:${agent.sessionKey}:fallback:${stableIdFragment(
    `${fallbackText}:${fallbackTimestamp}`,
  )}`;
  return makeCard({
    id: fallbackKey,
    title: truncateTitle(fallbackText, t("opsTasks.recoveredRequest")),
    description: fallbackText,
    status: "todo",
    source: "openclaw_event",
    sourceEventId: fallbackKey,
    assignedAgentId: agent.agentId,
    createdAt: fallbackTimestamp,
    updatedAt: fallbackTimestamp,
    runId: agent.runId,
    externalThreadId: agent.sessionKey,
    lastActivityAt: fallbackTimestamp,
    isInferred: false,
  });
};

export const deriveFallbackChatCard = (
  event: EventFrame,
  agents: AgentState[],
): TaskBoardCard | null =>
  deriveChatRequestCard(event, agents, {
    source: "fallback_inferred",
    isInferred: true,
  });

export const deriveLiveSessionTaskCard = (
  event: EventFrame,
  agents: AgentState[],
): TaskBoardCard | null =>
  deriveChatRequestCard(event, agents, {
    source: "openclaw_event",
    isInferred: false,
  });

export const syncCardWithLinkedRun = (
  card: TaskBoardCard,
  runLog: RunRecord[],
): TaskBoardCard => {
  if (!card.runId) return card;
  const run = runLog.find((entry) => entry.runId === card.runId);
  if (!run) return card;
  const status: TaskBoardStatus =
    run.endedAt === null
      ? "in_progress"
      : run.outcome === "error"
        ? "blocked"
        : card.status === "done"
          ? "done"
          : "review";
  const updatedAt = new Date(run.endedAt ?? run.startedAt).toISOString();
  return {
    ...card,
    assignedAgentId: card.assignedAgentId ?? run.agentId,
    status,
    updatedAt,
    lastActivityAt: updatedAt,
  };
};

const syncCardWithAgent = (
  card: TaskBoardCard,
  agents: AgentState[],
): TaskBoardCard => {
  if (!card.assignedAgentId) return card;
  const agent = agents.find((entry) => entry.agentId === card.assignedAgentId);
  if (!agent) return card;
  if (agent.awaitingUserInput && card.status !== "done") {
    return {
      ...card,
      status: "blocked",
      lastActivityAt: new Date(
        agent.lastActivityAt ?? Date.now(),
      ).toISOString(),
    };
  }
  return card;
};

const compareDuplicatePriority = (
  left: TaskBoardCard,
  right: TaskBoardCard,
) => {
  const leftDone = left.status === "done" ? 1 : 0;
  const rightDone = right.status === "done" ? 1 : 0;
  if (leftDone !== rightDone) return rightDone - leftDone;
  const leftActive = left.status === "in_progress" ? 1 : 0;
  const rightActive = right.status === "in_progress" ? 1 : 0;
  if (leftActive !== rightActive) return rightActive - leftActive;
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
};

const buildPlaybookCards = (
  jobs: CronJobSummary[],
  existingCards: TaskBoardCard[],
): TaskBoardCard[] =>
  jobs.map((job) => {
    const existing =
      existingCards.find((card) => card.playbookJobId === job.id) ??
      existingCards.find((card) => card.id === `playbook:${job.id}`) ??
      null;
    const inferredStatus: TaskBoardStatus = job.state.runningAtMs
      ? "in_progress"
      : job.state.lastStatus === "error"
        ? "blocked"
        : existing?.status === "done"
          ? "done"
          : "todo";
    return makeCard({
      ...(existing ?? {}),
      id: existing?.id ?? `playbook:${job.id}`,
      title: existing?.title ?? job.name,
      description:
        existing?.description ||
        `${formatCronSchedule(job.schedule)}\n${formatCronPayload(job.payload)}`,
      status: inferredStatus,
      source: "playbook",
      sourceEventId: existing?.sourceEventId ?? `cron:${job.id}`,
      assignedAgentId: existing?.assignedAgentId ?? job.agentId ?? null,
      createdAt: existing?.createdAt ?? new Date(job.updatedAtMs).toISOString(),
      updatedAt: new Date(job.updatedAtMs).toISOString(),
      playbookJobId: job.id,
      runId: existing?.runId ?? null,
      channel: existing?.channel ?? null,
      externalThreadId: existing?.externalThreadId ?? null,
      lastActivityAt: new Date(
        job.state.runningAtMs ?? job.state.lastRunAtMs ?? job.updatedAtMs,
      ).toISOString(),
      notes: existing?.notes ?? [],
      isArchived: existing?.isArchived ?? false,
      isInferred: true,
    });
  });

const buildStandupSeedCards = (
  standup: OfficeStandupController,
  existingCards: TaskBoardCard[],
): TaskBoardCard[] => {
  const config = standup.config;
  if (!config) return [];
  return Object.entries(config.manualByAgentId)
    .map(([agentId, entry]) => {
      const title = entry.currentTask.trim();
      const note = entry.note.trim();
      const blockers = entry.blockers.trim();
      if (!title && !note && !blockers) return null;
      const existing =
        existingCards.find((card) => card.id === `standup:${agentId}`) ?? null;
      const notes = [note, ...normalizeNoteLines(existing?.notes ?? [])];
      return makeCard({
        ...(existing ?? {}),
        id: existing?.id ?? `standup:${agentId}`,
        title:
          existing?.title ??
          truncateTitle(title || note || blockers, t("opsTasks.standupTask")),
        description:
          existing?.description ||
          [title, blockers ? t("opsTasks.blockers", { blockers }) : "", note]
            .filter(Boolean)
            .join("\n"),
        status:
          blockers.length > 0
            ? "blocked"
            : existing?.status === "done"
              ? "done"
              : (existing?.status ?? "todo"),
        source: "fallback_inferred",
        sourceEventId: existing?.sourceEventId ?? `standup:${agentId}`,
        assignedAgentId: agentId,
        createdAt:
          existing?.createdAt ?? entry.updatedAt ?? new Date().toISOString(),
        updatedAt:
          entry.updatedAt ?? existing?.updatedAt ?? new Date().toISOString(),
        playbookJobId: existing?.playbookJobId ?? null,
        runId: existing?.runId ?? null,
        channel: existing?.channel ?? null,
        externalThreadId: existing?.externalThreadId ?? null,
        lastActivityAt: entry.updatedAt ?? existing?.lastActivityAt ?? null,
        notes,
        isArchived: existing?.isArchived ?? false,
        isInferred: true,
      });
    })
    .filter((card): card is TaskBoardCard => Boolean(card));
};

const normalizeNoteLines = (notes: string[]) =>
  notes
    .map((note) => note.trim())
    .filter(Boolean)
    .slice(0, 8);

type TaskCaptureDebugState = {
  lastStatus: "idle" | "detected" | "persisted" | "failed" | "unsupported";
  lastUpdatedAt: string | null;
  lastTitle: string | null;
  lastTaskId: string | null;
  lastSessionKey: string | null;
  lastMessage: string | null;
  detectedCount: number;
};

const INITIAL_TASK_CAPTURE_DEBUG: TaskCaptureDebugState = {
  lastStatus: "idle",
  lastUpdatedAt: null,
  lastTitle: null,
  lastTaskId: null,
  lastSessionKey: null,
  lastMessage: null,
  detectedCount: 0,
};

const buildActiveRunOptions = (runs: RunRecord[]) =>
  runs
    .filter((run) => run.endedAt === null)
    .map((run) => ({
      runId: run.runId,
      agentId: run.agentId,
      label: `${run.agentName} · ${run.trigger.toUpperCase()} · ${new Date(
        run.startedAt,
      ).toLocaleTimeString(LOCALE)}`,
    }));

export const useTaskBoardController = ({
  gatewayUrl,
  settingsCoordinator,
  client,
  status,
  cronEnabled = true,
  agents,
  runLog,
  standup,
  captureDebugEnabled = true,
}: {
  gatewayUrl: string;
  settingsCoordinator: StudioSettingsCoordinator;
  client: GatewayClient;
  status: GatewayStatus;
  cronEnabled?: boolean;
  agents: AgentState[];
  runLog: RunRecord[];
  standup: OfficeStandupController;
  /**
   * Whether anything shows taskCaptureDebug (the OpenClaw console). When
   * nothing does, capture updates are tracked without re-rendering the office;
   * the latest values are published as soon as it is turned on.
   */
  captureDebugEnabled?: boolean;
}) => {
  const [state, dispatch] = useReducer(
    taskBoardReducer,
    defaultTaskBoardPreference(),
  );
  const stateRef = useRef(state);
  const hydratedRef = useRef(false);
  const recoveredAgentRequestKeyRef = useRef<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [cronJobs, setCronJobs] = useState<CronJobSummary[]>([]);
  const [cronLoading, setCronLoading] = useState(false);
  const [cronError, setCronError] = useState<string | null>(null);
  const [sharedTasksLoading, setSharedTasksLoading] = useState(false);
  const [sharedTasksError, setSharedTasksError] = useState<string | null>(null);
  const [sharedTasksSupported, setSharedTasksSupported] = useState(true);
  const [taskCaptureDebug, setTaskCaptureDebug] =
    useState<TaskCaptureDebugState>(INITIAL_TASK_CAPTURE_DEBUG);
  const taskCaptureDebugRef = useRef<TaskCaptureDebugState>(
    INITIAL_TASK_CAPTURE_DEBUG,
  );
  const [gatewayTasksLoading, setGatewayTasksLoading] = useState(false);
  const [gatewayTasksError, setGatewayTasksError] = useState<string | null>(
    null,
  );
  const [gatewayTasksSupported, setGatewayTasksSupported] = useState<
    "unknown" | "supported" | "unsupported"
  >("unknown");
  // Hermes' kanban is the source of truth when it says so; edits then go
  // through tasks.* and the office's own task store is not used.
  const [gatewayTasksAuthoritative, setGatewayTasksAuthoritative] = useState(false);
  const gatewayTasksAuthoritativeRef = useRef(false);
  const authoritativeTaskIdsRef = useRef<Set<string>>(new Set());
  const sharedRefreshInFlightRef = useRef(false);
  const lastPersistedTaskBoardRef = useRef<{
    gatewayUrl: string;
    cards: TaskBoardCard[];
    selectedCardId: string | null;
  } | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const updateTaskCaptureDebug = useCallback(
    (update: (current: TaskCaptureDebugState) => TaskCaptureDebugState) => {
      const next = update(taskCaptureDebugRef.current);
      taskCaptureDebugRef.current = next;
      if (captureDebugEnabled) setTaskCaptureDebug(next);
    },
    [captureDebugEnabled],
  );

  useEffect(() => {
    if (captureDebugEnabled) setTaskCaptureDebug(taskCaptureDebugRef.current);
  }, [captureDebugEnabled]);

  // Upserts to the shared store are collected and sent about once a second;
  // the saved records of a batch are applied to the board with one dispatch.
  const [taskWriteQueue] = useState(() => {
    const queue = createSharedTaskUpsertQueue({
      onApplied: (records) => {
        // A card with a newer upsert already queued keeps showing that edit
        // until its own answer arrives. Separate requests answered within
        // milliseconds of each other; with the batching delay the older
        // answer would otherwise put the card back for about a second.
        const cards = planSharedTaskResponses(
          stateRef.current.cards,
          records,
        ).filter((card) => !queue.hasPending(card.id));
        if (cards.length > 0) dispatch({ type: "upsertMany", cards });
      },
    });
    return queue;
  });

  useEffect(() => {
    // Whatever is still queued when the page goes away is sent right then.
    const flushOnHide = () => {
      void taskWriteQueue.flush({ keepalive: true });
    };
    window.addEventListener("pagehide", flushOnHide);
    return () => {
      window.removeEventListener("pagehide", flushOnHide);
      taskWriteQueue.dispose();
    };
  }, [taskWriteQueue]);

  const archiveMatchingInferredCards = useCallback(
    (explicitCard: TaskBoardCard) => {
      for (const card of stateRef.current.cards) {
        if (!card.isInferred || card.isArchived) continue;
        if (!matchesExplicitCard(card, explicitCard)) continue;
        dispatch({
          type: "update",
          cardId: card.id,
          patch: {
            isArchived: true,
            updatedAt: explicitCard.updatedAt,
          },
        });
      }
    },
    [],
  );

  const applyGatewayTaskRecord = useCallback(
    (task: GatewayTaskRecord) => {
      const existing =
        stateRef.current.cards.find((card) => card.id === task.id) ?? null;
      const nextCard = buildCardFromGatewayTask(task, existing, gatewayTasksAuthoritativeRef.current);
      dispatch({ type: "upsert", card: nextCard });
      archiveMatchingInferredCards(nextCard);
      return nextCard;
    },
    [archiveMatchingInferredCards],
  );

  const applySharedTaskRecord = useCallback(
    (task: SharedTaskRecord) => {
      const existing =
        stateRef.current.cards.find((card) => card.id === task.id) ?? null;
      const nextCard = buildCardFromSharedTaskRecord(task, existing);
      dispatch({ type: "upsert", card: nextCard });
      archiveMatchingInferredCards(nextCard);
      return nextCard;
    },
    [archiveMatchingInferredCards],
  );

  const persistLiveSessionTask = useCallback(
    async (task: TaskBoardCard) => {
      if (!sharedTasksSupported) return;
      try {
        // The saved record is applied to the board with the rest of its batch.
        const saved = await taskWriteQueue.enqueue({
          ...task,
          id: task.id,
          title: task.title,
          source: "openclaw_event",
          sourceEventId: task.sourceEventId ?? task.id,
          isInferred: false,
        });
        updateTaskCaptureDebug((current) => ({
          ...current,
          lastStatus: "persisted",
          lastUpdatedAt: saved.updatedAt,
          lastTitle: saved.title,
          lastTaskId: saved.id,
          lastSessionKey: saved.externalThreadId,
          lastMessage: t("opsTasks.debugPersisted"),
        }));
      } catch (error) {
        if (error instanceof TaskStoreRequestError && error.status === 404) {
          setSharedTasksSupported(false);
          setSharedTasksError(
            t("opsTasks.storeRouteUnavailableRestart"),
          );
          updateTaskCaptureDebug((current) => ({
            ...current,
            lastStatus: "unsupported",
            lastUpdatedAt: new Date().toISOString(),
            lastTitle: task.title,
            lastTaskId: task.id,
            lastSessionKey: task.externalThreadId,
            lastMessage: t("opsTasks.storeRouteUnavailable"),
          }));
          return;
        }
        setSharedTasksError(
          error instanceof Error
            ? error.message
            : t("opsTasks.syncLiveFailed"),
        );
        updateTaskCaptureDebug((current) => ({
          ...current,
          lastStatus: "failed",
          lastUpdatedAt: new Date().toISOString(),
          lastTitle: task.title,
          lastTaskId: task.id,
          lastSessionKey: task.externalThreadId,
          lastMessage:
            error instanceof Error
              ? error.message
              : t("opsTasks.syncLiveFailed"),
        }));
      }
    },
    [sharedTasksSupported, taskWriteQueue, updateTaskCaptureDebug],
  );

  useEffect(() => {
    let cancelled = false;
    hydratedRef.current = false;
    setLoading(true);
    const task = async () => {
      // A board save can be held back for up to 15 s (throttle below). Send it,
      // and wait for saves in flight, before reading: otherwise switching back
      // to a gateway within that window hydrates its older board, and the next
      // save overwrites the held-back changes with it.
      await settingsCoordinator.flushPending().catch(() => {});
      if (cancelled) return;
      const settings = await settingsCoordinator.loadSettings({ maxAgeMs: 0 });
      const preference: StudioTaskBoardPreference = settings
        ? resolveTaskBoardPreference(settings, gatewayUrl)
        : defaultTaskBoardPreference();
      if (cancelled) return;
      dispatch({ type: "hydrate", preference });
      hydratedRef.current = true;
      setLoading(false);
    };
    void task().catch((error) => {
      if (cancelled) return;
      console.error("Failed to load task board settings.", error);
      dispatch({ type: "hydrate", preference: defaultTaskBoardPreference() });
      hydratedRef.current = true;
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [gatewayUrl, settingsCoordinator]);

  useEffect(() => {
    if (!hydratedRef.current || !gatewayUrl.trim()) return;
    // The reducer returns new arrays only on change, so identity is enough;
    // serialising a busy board on every change to compare it was the costly part.
    const last = lastPersistedTaskBoardRef.current;
    if (
      last &&
      last.gatewayUrl === gatewayUrl &&
      last.cards === state.cards &&
      last.selectedCardId === state.selectedCardId
    ) {
      return;
    }
    lastPersistedTaskBoardRef.current = {
      gatewayUrl,
      cards: state.cards,
      selectedCardId: state.selectedCardId,
    };
    settingsCoordinator.schedulePatch(
      {
        taskBoard: {
          [gatewayUrl]: {
            cards: state.cards,
            selectedCardId: state.selectedCardId,
          },
        },
      },
      // A live team changes the board several times a second; save it in batches.
      TASK_BOARD_SAVE_DEBOUNCE_MS,
      TASK_BOARD_SAVE_THROTTLE,
    );
  }, [gatewayUrl, settingsCoordinator, state.cards, state.selectedCardId]);

  useEffect(() => {
    // A throttled board save can be waiting up to 15 s. Send it when the tab is
    // hidden, when the page goes away, and when the board unmounts. Switching
    // tabs leaves the page alive, so that request completes. Closing the page
    // also fires "hidden" first, but a plain fetch may be cancelled by the
    // unload, and the ~400 KB board is over the 64 KB keepalive limit, so the
    // last few seconds of automatic cards can still be lost on close.
    const flush = () => {
      void settingsCoordinator.flushPending().catch(() => {});
    };
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", flushWhenHidden);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", flushWhenHidden);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [settingsCoordinator]);

  const refreshCronJobs = useCallback(async () => {
    if (!cronEnabled || status !== "connected") {
      setCronJobs([]);
      setCronError(null);
      setCronLoading(false);
      return;
    }
    setCronLoading(true);
    setCronError(null);
    try {
      const result = await listCronJobs(client, { includeDisabled: true });
      setCronJobs(result.jobs);
    } catch (error) {
      setCronError(
        error instanceof Error ? error.message : t("opsTasks.playbooksLoadFailed"),
      );
    } finally {
      setCronLoading(false);
    }
  }, [client, cronEnabled, status]);

  const refreshSharedTasks = useCallback(async () => {
    if (!sharedTasksSupported || gatewayTasksAuthoritativeRef.current) {
      setSharedTasksLoading(false);
      return;
    }
    if (sharedRefreshInFlightRef.current) return;
    sharedRefreshInFlightRef.current = true;
    setSharedTasksLoading(true);
    setSharedTasksError(null);
    try {
      const readToken = taskWriteQueue.beginRead();
      const tasks = await listSharedTaskRecords();
      setSharedTasksSupported(true);
      taskWriteQueue.rememberList(tasks, readToken);
      // One dispatch for whatever changed, none when nothing did. Tasks with an
      // upsert queued or saved since this read started are left to that
      // upsert's answer, so an older copy never overwrites them meanwhile.
      const cards = planSharedTaskRefresh(stateRef.current.cards, tasks, (id) =>
        taskWriteQueue.isNewerThan(id, readToken),
      );
      if (cards.length > 0) dispatch({ type: "upsertMany", cards });
    } catch (error) {
      if (error instanceof TaskStoreRequestError && error.status === 404) {
        setSharedTasksSupported(false);
        setSharedTasksError(
          t("opsTasks.storeRouteUnavailableRestart"),
        );
        return;
      }
      setSharedTasksError(
        error instanceof Error
          ? error.message
          : t("opsTasks.storeLoadFailed"),
      );
    } finally {
      sharedRefreshInFlightRef.current = false;
      setSharedTasksLoading(false);
    }
  }, [sharedTasksSupported, taskWriteQueue]);

  const refreshRemoteTasks = useCallback(async () => {
    if (status !== "connected") {
      setGatewayTasksLoading(false);
      setGatewayTasksError(null);
      return;
    }
    setGatewayTasksLoading(true);
    setGatewayTasksError(null);
    try {
      const result = await listGatewayTasks(client, { includeArchived: true });
      setGatewayTasksSupported("supported");
      const authoritative = result.authoritative === true;
      gatewayTasksAuthoritativeRef.current = authoritative;
      setGatewayTasksAuthoritative(authoritative);
      for (const task of result.tasks) {
        applyGatewayTaskRecord(task);
      }
      if (authoritative) {
        // A task deleted on the board (by a person or an agent) leaves the
        // office board too.
        const listed = new Set(result.tasks.map((task) => task.id));
        for (const id of authoritativeTaskIdsRef.current) {
          if (listed.has(id)) continue;
          dispatch({ type: "update", cardId: id, patch: { isArchived: true } });
        }
        authoritativeTaskIdsRef.current = listed;
      }
    } catch (error) {
      if (isUnsupportedTaskGatewayError(error)) {
        setGatewayTasksSupported("unsupported");
        setGatewayTasksError(null);
        return;
      }
      setGatewayTasksError(
        error instanceof Error
          ? error.message
          : t("opsTasks.openclawLoadFailed"),
      );
    } finally {
      setGatewayTasksLoading(false);
    }
  }, [applyGatewayTaskRecord, client, status]);

  useEffect(() => {
    void refreshCronJobs();
  }, [refreshCronJobs]);

  useEffect(() => {
    void refreshSharedTasks();
  }, [refreshSharedTasks]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void refreshSharedTasks();
    }, 4_000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [refreshSharedTasks]);

  useEffect(() => {
    void refreshRemoteTasks();
  }, [refreshRemoteTasks]);

  useEffect(() => {
    if (!gatewayTasksAuthoritative) return;
    const intervalId = window.setInterval(() => {
      void refreshRemoteTasks();
    }, 5_000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [gatewayTasksAuthoritative, refreshRemoteTasks]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    const playbookCards = buildPlaybookCards(cronJobs, stateRef.current.cards);
    const standupCards = buildStandupSeedCards(standup, stateRef.current.cards);
    if (playbookCards.length === 0 && standupCards.length === 0) return;
    dispatch({
      type: "upsertMany",
      cards: [...playbookCards, ...standupCards],
    });
  }, [cronJobs, standup]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    const nextCards = stateRef.current.cards.map((card) =>
      syncCardWithAgent(syncCardWithLinkedRun(card, runLog), agents),
    );
    const changed = nextCards.some(
      (card, index) => card !== stateRef.current.cards[index],
    );
    if (!changed) return;
    dispatch({
      type: "hydrate",
      preference: { ...stateRef.current, cards: sortTaskBoardCards(nextCards) },
    });
  }, [agents, runLog]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    for (const agent of agents) {
      const recoveredTask = deriveRecoveredAgentRequestCard(agent);
      if (!recoveredTask) continue;
      const requestKey = recoveredTask.sourceEventId ?? recoveredTask.id;
      if (recoveredAgentRequestKeyRef.current[agent.agentId] === requestKey) {
        continue;
      }
      recoveredAgentRequestKeyRef.current[agent.agentId] = requestKey;
      const hasPersistedMatch = stateRef.current.cards.some(
        (card) =>
          !card.isInferred &&
          !card.isArchived &&
          matchesExplicitCard(recoveredTask, card),
      );
      updateTaskCaptureDebug((current) => ({
        lastStatus: hasPersistedMatch ? current.lastStatus : "detected",
        lastUpdatedAt: recoveredTask.updatedAt,
        lastTitle: recoveredTask.title,
        lastTaskId: recoveredTask.id,
        lastSessionKey: recoveredTask.externalThreadId,
        lastMessage: hasPersistedMatch
          ? t("opsTasks.recoveredExists")
          : t("opsTasks.recoveredLatest"),
        detectedCount: hasPersistedMatch
          ? current.detectedCount
          : current.detectedCount + 1,
      }));
      if (hasPersistedMatch) continue;
      dispatch({ type: "upsert", card: recoveredTask });
      void persistLiveSessionTask(recoveredTask);
    }
  }, [agents, persistLiveSessionTask, updateTaskCaptureDebug]);

  const selectCard = useCallback((cardId: string | null) => {
    dispatch({ type: "select", cardId });
  }, []);

  const createManualCard = useCallback(
    async (input?: Partial<TaskBoardCard>) => {
      const card = makeCard({
        id: `manual:${randomUUID()}`,
        title: input?.title?.trim() || t("opsTasks.newTask"),
        description: input?.description ?? "",
        status: input?.status ?? "todo",
        source: "office3d_manual",
        assignedAgentId: input?.assignedAgentId ?? null,
        playbookJobId: input?.playbookJobId ?? null,
        runId: input?.runId ?? null,
        channel: input?.channel ?? null,
        externalThreadId: input?.externalThreadId ?? null,
        notes: input?.notes ?? [],
        isInferred: false,
      });
      if (gatewayTasksAuthoritativeRef.current) {
        try {
          const created = await createGatewayTask(client, {
            title: card.title,
            description: card.description,
            assignedAgentId: card.assignedAgentId,
          });
          const nextCard = applyGatewayTaskRecord(created);
          authoritativeTaskIdsRef.current.add(nextCard.id);
          dispatch({ type: "select", cardId: nextCard.id });
          return nextCard;
        } catch (error) {
          setGatewayTasksError(error instanceof Error ? error.message : t("opsTasks.createFailed"));
          return null;
        }
      }
      try {
        const saved = await upsertSharedTaskRecord({
          ...card,
          isInferred: false,
        });
        taskWriteQueue.remember(saved);
        const nextCard = applySharedTaskRecord(saved);
        dispatch({ type: "select", cardId: nextCard.id });
        return nextCard;
      } catch (error) {
        setSharedTasksError(
          error instanceof Error
            ? error.message
            : t("opsTasks.createFailed"),
        );
        dispatch({ type: "upsert", card });
        dispatch({ type: "select", cardId: card.id });
        return card;
      }
    },
    [applyGatewayTaskRecord, applySharedTaskRecord, client, taskWriteQueue],
  );

  const updateCard = useCallback(
    async (cardId: string, patch: Partial<TaskBoardCard>) => {
      const existing =
        stateRef.current.cards.find((card) => card.id === cardId) ?? null;
      dispatch({ type: "update", cardId, patch });
      if (!existing || existing.isInferred) return;
      if (gatewayTasksAuthoritativeRef.current) {
        try {
          const updated = await updateGatewayTask(client, cardId, {
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.assignedAgentId !== undefined ? { assignedAgentId: patch.assignedAgentId } : {}),
          });
          applyGatewayTaskRecord(updated);
        } catch (error) {
          dispatch({ type: "upsert", card: existing });
          setGatewayTasksError(error instanceof Error ? error.message : t("opsTasks.updateFailed"));
        }
        return;
      }
      try {
        // Applied to the board with the rest of its batch.
        await taskWriteQueue.enqueue({
          ...existing,
          ...patch,
          id: cardId,
          title: (patch.title ?? existing.title).trim() || existing.title,
          updatedAt: new Date().toISOString(),
          isInferred: false,
        });
      } catch (error) {
        dispatch({ type: "upsert", card: existing });
        setSharedTasksError(
          error instanceof Error
            ? error.message
            : t("opsTasks.updateFailed"),
        );
      }
    },
    [applyGatewayTaskRecord, client, taskWriteQueue],
  );

  const moveCard = useCallback(
    async (cardId: string, nextStatus: TaskBoardStatus) => {
      const existing =
        stateRef.current.cards.find((card) => card.id === cardId) ?? null;
      dispatch({ type: "move", cardId, status: nextStatus });
      if (!existing || existing.isInferred) return;
      if (gatewayTasksAuthoritativeRef.current) {
        try {
          applyGatewayTaskRecord(await updateGatewayTask(client, cardId, { status: nextStatus }));
        } catch (error) {
          dispatch({ type: "upsert", card: existing });
          setGatewayTasksError(error instanceof Error ? error.message : t("opsTasks.moveFailed"));
        }
        return;
      }
      try {
        // Queued with the other upserts so they reach the store in order.
        await taskWriteQueue.enqueue({
          ...existing,
          id: cardId,
          title: existing.title,
          status: nextStatus,
          updatedAt: new Date().toISOString(),
          isInferred: false,
        });
      } catch (error) {
        dispatch({ type: "upsert", card: existing });
        setSharedTasksError(
          error instanceof Error
            ? error.message
            : t("opsTasks.moveFailed"),
        );
      }
    },
    [applyGatewayTaskRecord, client, taskWriteQueue],
  );

  const removeCard = useCallback(
    async (cardId: string) => {
      const existing =
        stateRef.current.cards.find((card) => card.id === cardId) ?? null;
      if (!existing) return;
      if (existing.isInferred) {
        dispatch({
          type: "update",
          cardId,
          patch: {
            isArchived: true,
            updatedAt: new Date().toISOString(),
          },
        });
        return;
      }
      dispatch({ type: "update", cardId, patch: { isArchived: true } });
      if (gatewayTasksAuthoritativeRef.current) {
        try {
          applyGatewayTaskRecord(await updateGatewayTask(client, cardId, { archived: true }));
        } catch (error) {
          dispatch({ type: "upsert", card: existing });
          setGatewayTasksError(error instanceof Error ? error.message : t("opsTasks.archiveFailed"));
        }
        return;
      }
      try {
        // Upserts already queued for this card reach the store first.
        if (taskWriteQueue.hasPending(cardId)) await taskWriteQueue.flush();
        const archived = await archiveSharedTaskRecord(cardId);
        taskWriteQueue.remember(archived);
        applySharedTaskRecord(archived);
      } catch (error) {
        dispatch({ type: "upsert", card: existing });
        setSharedTasksError(
          error instanceof Error
            ? error.message
            : t("opsTasks.archiveFailed"),
        );
      }
    },
    [applyGatewayTaskRecord, applySharedTaskRecord, client, taskWriteQueue],
  );

  const lastDedupeSnapshotRef = useRef<string | null>(null);
  useEffect(() => {
    if (!hydratedRef.current) return;
    // Patch Hermes Phase 2: snapshot guard prevents re-entering the dedupe
    // loop when state.cards is replaced by a structurally-identical array
    // (upstream dispatch churn). Without this, the effect dispatches
    // `upsert` to mark duplicates archived → state.cards new ref →
    // effect re-runs → "Maximum update depth exceeded" in dev mode.
    const snapshot = JSON.stringify(
      stateRef.current.cards
        .filter((card) => !card.isArchived && card.source === "openclaw_event")
        .map((card) => ({
          id: card.id,
          title: card.title,
          assignedAgentId: card.assignedAgentId ?? null,
          externalThreadId: card.externalThreadId ?? null,
        })),
    );
    if (lastDedupeSnapshotRef.current === snapshot) return;
    lastDedupeSnapshotRef.current = snapshot;
    const grouped = new Map<string, TaskBoardCard[]>();
    for (const card of stateRef.current.cards) {
      if (card.isArchived || card.source !== "openclaw_event") continue;
      const titleKey = normalizeTaskRequestText(card.title).toLowerCase();
      if (!titleKey) continue;
      const groupKey = `${card.assignedAgentId ?? "-"}:${card.externalThreadId ?? "-"}:${titleKey}`;
      const cards = grouped.get(groupKey);
      if (cards) {
        cards.push(card);
      } else {
        grouped.set(groupKey, [card]);
      }
    }
    for (const cards of grouped.values()) {
      if (cards.length <= 1) continue;
      const sorted = [...cards].sort(compareDuplicatePriority);
      const keeper = sorted[0];
      for (const duplicate of sorted.slice(1)) {
        if (duplicate.id === keeper.id) continue;
        void updateCard(duplicate.id, {
          isArchived: true,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }, [state.cards, updateCard]);

  const ingestGatewayEvent = useCallback(
    (event: EventFrame) => {
      const explicit = parseExplicitTaskEvent(event);
      if (explicit) {
        setGatewayTasksSupported("supported");
        if (explicit.kind === "task_deleted") {
          dispatch({ type: "remove", cardId: explicit.taskId });
          return;
        }
        const existing =
          stateRef.current.cards.find((card) => card.id === explicit.taskId) ??
          null;
        const nextCard = buildCardFromExplicitEvent(explicit, existing);
        dispatch({
          type: "upsert",
          card: nextCard,
        });
        archiveMatchingInferredCards(nextCard);
        return;
      }

      const liveSessionTask = deriveLiveSessionTaskCard(event, agents);
      if (liveSessionTask) {
        updateTaskCaptureDebug((current) => ({
          lastStatus: "detected",
          lastUpdatedAt: liveSessionTask.updatedAt,
          lastTitle: liveSessionTask.title,
          lastTaskId: liveSessionTask.id,
          lastSessionKey: liveSessionTask.externalThreadId,
          lastMessage:
            t("opsTasks.debugQueued"),
          detectedCount: current.detectedCount + 1,
        }));
        const hasPersistedMatch = stateRef.current.cards.some(
          (card) =>
            !card.isInferred &&
            !card.isArchived &&
            matchesExplicitCard(liveSessionTask, card),
        );
        if (!hasPersistedMatch) {
          dispatch({ type: "upsert", card: liveSessionTask });
        }
        void persistLiveSessionTask(liveSessionTask);
        return;
      }

      if (event.event === "agent") {
        const payload = isRecord(event.payload) ? event.payload : {};
        const sessionKey = trimOrNull(payload.sessionKey);
        const runId = trimOrNull(payload.runId);
        const data = isRecord(payload.data) ? payload.data : {};
        const phase = trimOrNull(data.phase);
        const agentId = resolveAgentIdFromSession(agents, sessionKey);
        if (!agentId || !runId || !phase) return;
        const candidates = stateRef.current.cards
          .filter(
            (card) =>
              card.assignedAgentId === agentId &&
              !card.isArchived &&
              (card.runId === runId || (!card.runId && card.status !== "done")),
          )
          .sort(
            (left, right) =>
              Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
          );
        const candidate = candidates[0];

        if (!candidate && phase === "start") {
          // OpenClaw started an agent run -- trust that as the classification signal.
          const agent = agents.find((a) => a.agentId === agentId);
          const userText = normalizeTaskRequestText(
            agent?.lastUserMessage?.trim() ?? "",
          );
          if (userText) {
            const nowIso = new Date().toISOString();
            const cardId = `run:${sessionKey ?? agentId}:${runId}`;
            const newCard = makeCard({
              id: cardId,
              title: truncateTitle(userText, t("opsTasks.incomingRequest")),
              description: userText,
              status: "in_progress",
              source: "openclaw_event",
              sourceEventId: cardId,
              assignedAgentId: agentId,
              createdAt: nowIso,
              updatedAt: nowIso,
              runId,
              externalThreadId: sessionKey,
              lastActivityAt: nowIso,
              isInferred: true,
            });
            dispatch({ type: "upsert", card: newCard });
            void persistLiveSessionTask(newCard);
          }
          return;
        }

        if (!candidate) return;
        if (phase === "start") {
          void updateCard(candidate.id, {
            runId,
            status: "in_progress",
            lastActivityAt: new Date().toISOString(),
          });
          return;
        }
        if (phase === "error") {
          void updateCard(candidate.id, {
            runId,
            status: "blocked",
            lastActivityAt: new Date().toISOString(),
          });
          return;
        }
        if (phase === "end") {
          void updateCard(candidate.id, {
            runId,
            status: "review",
            lastActivityAt: new Date().toISOString(),
          });
        }
      }
    },
    [
      agents,
      archiveMatchingInferredCards,
      persistLiveSessionTask,
      updateCard,
      updateTaskCaptureDebug,
    ],
  );

  const selectedCard = state.selectedCardId
    ? (state.cards.find((card) => card.id === state.selectedCardId) ?? null)
    : null;

  const cardsByStatus = useMemo(() => {
    const grouped = {
      todo: [] as TaskBoardCard[],
      in_progress: [] as TaskBoardCard[],
      blocked: [] as TaskBoardCard[],
      review: [] as TaskBoardCard[],
      done: [] as TaskBoardCard[],
    };
    for (const card of state.cards) {
      if (card.isArchived) continue;
      grouped[card.status].push(card);
    }
    return grouped;
  }, [state.cards]);

  const activeRuns = useMemo(() => buildActiveRunOptions(runLog), [runLog]);

  const visibleCardCount = useMemo(
    () =>
      Object.values(cardsByStatus).reduce(
        (total, cards) => total + cards.length,
        0,
      ),
    [cardsByStatus],
  );

  const taskCaptureDebugInfo = useMemo(
    () => ({
      ...taskCaptureDebug,
      visibleCardCount,
      totalCardCount: state.cards.length,
      sharedTasksSupported,
      sharedTasksLoading,
      sharedTasksError,
    }),
    [
      sharedTasksError,
      sharedTasksLoading,
      sharedTasksSupported,
      state.cards.length,
      taskCaptureDebug,
      visibleCardCount,
    ],
  );

  return {
    state,
    loading,
    sharedTasksLoading,
    sharedTasksError,
    gatewayTasksLoading,
    gatewayTasksError,
    gatewayTasksSupported,
    cronJobs,
    cronLoading,
    cronError,
    cardsByStatus,
    selectedCard,
    activeRuns,
    taskCaptureDebug: taskCaptureDebugInfo,
    createManualCard,
    updateCard,
    moveCard,
    removeCard,
    selectCard,
    refreshCronJobs,
    refreshSharedTasks,
    refreshRemoteTasks,
    ingestGatewayEvent,
  };
};
