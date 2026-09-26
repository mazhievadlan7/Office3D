"use client";

import type { DragEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";

import type { AgentState } from "@/features/agents/state/store";
import {
  HQ_BADGE,
  HQ_BADGE_MUTED,
  HQ_BUTTON_DANGER,
  HQ_BUTTON_PRIMARY,
  HQ_BUTTON_SECONDARY,
  HQ_CARD_BUTTON,
  HQ_CARD_BUTTON_SELECTED,
  HQ_DOT_DONE,
  HQ_DOT_ERROR,
  HQ_DOT_IDLE,
  HQ_DOT_LIVE,
  HQ_DOT_REVIEW,
  HQ_FIELD,
  HQ_FIELD_PROSE,
  HQ_INSET,
  HQ_LABEL,
  HQ_META,
  HQ_NOTICE_ERROR,
  HQ_PANEL_HEADER,
  HQ_PANEL_LEAD,
  HQ_PANEL_TITLE,
  HQ_SELECT,
} from "@/features/office/components/panels/hqPanelStyles";
import type { CronJobSummary } from "@/lib/cron/types";
import type {
  TaskBoardCard,
  TaskBoardSource,
  TaskBoardStatus,
} from "@/features/office/tasks/types";
import { LOCALE, t } from "@/lib/i18n";
import { AutonomyBar } from "@/features/hermes/components/AutonomyBar";
import { MissionBanner } from "@/features/hermes/components/MissionBanner";

const STATUS_LABELS: Record<TaskBoardStatus, string> = {
  todo: t("taskboard.statusTodo"),
  in_progress: t("taskboard.statusInProgress"),
  blocked: t("taskboard.statusBlocked"),
  review: t("taskboard.statusReview"),
  done: t("taskboard.statusDone"),
};

// Each column's dot follows the red → white ramp: live work glows, done is white.
const STATUS_DOTS: Record<TaskBoardStatus, string> = {
  todo: HQ_DOT_IDLE,
  in_progress: HQ_DOT_LIVE,
  blocked: HQ_DOT_ERROR,
  review: HQ_DOT_REVIEW,
  done: HQ_DOT_DONE,
};

const SOURCE_LABELS: Record<TaskBoardSource, string> = {
  openclaw_event: t("taskboard.sourceEvent"),
  office3d_manual: t("taskboard.sourceManual"),
  playbook: t("taskboard.sourcePlaybook"),
  fallback_inferred: t("taskboard.sourceInferred"),
};

// tasks.list comes from the gateway unvalidated: a source we have no phrase
// for still reads as itself instead of leaving an empty badge.
const sourceLabel = (source: string) =>
  (SOURCE_LABELS as Record<string, string | undefined>)[source] ?? source.replaceAll("_", " ");

const STATUS_ORDER: TaskBoardStatus[] = [
  "todo",
  "in_progress",
  "blocked",
  "review",
  "done",
];

const formatRelativeTime = (value: string | null) => {
  if (!value) return t("taskboard.noActivity");
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return t("taskboard.noActivity");
  const delta = Math.max(0, Date.now() - at);
  if (delta < 60_000) return t("taskboard.justNow");
  if (delta < 3_600_000) {
    return t("inbox.minutesAgo", { count: Math.max(1, Math.floor(delta / 60_000)) });
  }
  if (delta < 86_400_000) {
    return t("inbox.hoursAgo", { count: Math.max(1, Math.floor(delta / 3_600_000)) });
  }
  return t("inbox.daysAgo", { count: Math.max(1, Math.floor(delta / 86_400_000)) });
};

const stopAndGetCardId = (event: DragEvent<HTMLElement>) => {
  event.preventDefault();
  event.stopPropagation();
  return event.dataTransfer.getData("text/task-card-id").trim();
};

export function TaskBoardView({
  title,
  subtitle,
  agents,
  cardsByStatus,
  selectedCard,
  activeRuns,
  cronJobs,
  cronLoading,
  cronError,
  taskCaptureDebug,
  onCreateCard,
  onMoveCard,
  onSelectCard,
  onUpdateCard,
  onDeleteCard,
  onRefreshCronJobs,
}: {
  title: string;
  subtitle: string;
  agents: AgentState[];
  cardsByStatus: Record<TaskBoardStatus, TaskBoardCard[]>;
  selectedCard: TaskBoardCard | null;
  activeRuns: Array<{ runId: string; agentId: string; label: string }>;
  cronJobs: CronJobSummary[];
  cronLoading: boolean;
  cronError: string | null;
  taskCaptureDebug?: {
    lastStatus: "idle" | "detected" | "persisted" | "failed" | "unsupported";
    lastUpdatedAt: string | null;
    lastTitle: string | null;
    lastTaskId: string | null;
    lastSessionKey: string | null;
    lastMessage: string | null;
    detectedCount: number;
    visibleCardCount: number;
    totalCardCount: number;
    sharedTasksSupported: boolean;
    sharedTasksLoading: boolean;
    sharedTasksError: string | null;
  };
  onCreateCard: () => void;
  onMoveCard: (cardId: string, status: TaskBoardStatus) => void;
  onSelectCard: (cardId: string | null) => void;
  onUpdateCard: (cardId: string, patch: Partial<TaskBoardCard>) => void;
  onDeleteCard: (cardId: string) => void;
  onRefreshCronJobs: () => void;
}) {
  // Cards name their owner rather than showing a raw agent id.
  const agentNameById = new Map(agents.map((agent) => [agent.agentId, agent.name || agent.agentId]));

  return (
    <section className="flex h-full min-h-0 flex-col bg-transparent text-white">
      <div className={HQ_PANEL_HEADER}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className={HQ_PANEL_TITLE}>{title}</div>
            <div className={HQ_PANEL_LEAD}>{subtitle}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" onClick={onRefreshCronJobs} className={HQ_BUTTON_SECONDARY}>
              <RefreshCw className={`h-3.5 w-3.5 ${cronLoading ? "animate-spin" : ""}`} />
              {t("common.refresh")}
            </button>
            <button type="button" onClick={onCreateCard} className={HQ_BUTTON_PRIMARY}>
              <Plus className="h-3.5 w-3.5" />
              {t("taskboard.newTask")}
            </button>
          </div>
        </div>
        <MissionBanner />
        <AutonomyBar />
        {cronError ? (
          <div className={`mt-2 ${HQ_NOTICE_ERROR}`}>{cronError}</div>
        ) : null}
        {taskCaptureDebug ? (
          <details className={`mt-2 px-3 py-2 font-mono text-[11px] ${HQ_INSET}`}>
            <summary className="cursor-pointer list-none select-none">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] uppercase tracking-[0.14em] text-white/60">
                <span>{t("taskboard.captureDebug")}</span>
                <span>{t("taskboard.statusValue", { value: taskCaptureDebug.lastStatus })}</span>
                <span>{t("taskboard.visibleCards", { count: taskCaptureDebug.visibleCardCount })}</span>
                <span>{t("taskboard.trackedCards", { count: taskCaptureDebug.totalCardCount })}</span>
                <span>{t("taskboard.detected", { count: taskCaptureDebug.detectedCount })}</span>
              </div>
            </summary>
            <div className="mt-2 grid gap-1 text-white/80">
              <div>
                {t("taskboard.lastRequest", {
                  title: taskCaptureDebug.lastTitle ?? t("taskboard.none"),
                })}
              </div>
              <div>
                {t("taskboard.lastTaskId", { id: taskCaptureDebug.lastTaskId ?? "-" })}
              </div>
              <div>
                {t("taskboard.sessionThread", { key: taskCaptureDebug.lastSessionKey ?? "-" })}
              </div>
              <div>
                {t("taskboard.lastUpdate", {
                  when: formatRelativeTime(taskCaptureDebug.lastUpdatedAt),
                })}
              </div>
              <div>
                {t("taskboard.sharedStore")}
                {taskCaptureDebug.sharedTasksSupported
                  ? taskCaptureDebug.sharedTasksLoading
                    ? t("taskboard.syncing")
                    : t("taskboard.available")
                  : t("taskboard.unavailable")}
              </div>
              <div>
                {t("taskboard.note", {
                  text: taskCaptureDebug.lastMessage ?? t("taskboard.waitingDetection"),
                })}
              </div>
              {taskCaptureDebug.sharedTasksError ? (
                <div className="text-red-400">
                  {t("taskboard.storeError", { error: taskCaptureDebug.sharedTasksError })}
                </div>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>

      <div className={`grid min-h-0 flex-1 overflow-hidden ${selectedCard ? "grid-cols-[minmax(0,1fr)_300px]" : "grid-cols-1"}`}>
        <div className="min-h-0 overflow-auto px-4 py-4">
          <div className="grid min-w-[700px] grid-cols-5 gap-3">
            {STATUS_ORDER.map((status) => {
              const cards = cardsByStatus[status];
              return (
                <div
                  key={status}
                  onDragOver={(event) => {
                    event.preventDefault();
                  }}
                  onDrop={(event) => {
                    const cardId = stopAndGetCardId(event);
                    if (!cardId) return;
                    onMoveCard(cardId, status);
                  }}
                  className="flex min-h-[420px] flex-col rounded-lg border border-red-900/40 bg-[#070404]/80"
                >
                  <div className="border-b border-red-900/40 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={STATUS_DOTS[status]} />
                        <span className="truncate font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-white/85">
                          {STATUS_LABELS[status]}
                        </span>
                      </div>
                      <span className={`${HQ_BADGE} tabular-nums`}>{cards.length}</span>
                    </div>
                  </div>
                  <div className="flex-1 space-y-2 overflow-y-auto p-2.5">
                    {cards.length === 0 ? (
                      <div className="rounded-md border border-dashed border-red-900/40 px-3 py-5 text-center font-mono text-[10px] uppercase leading-4 tracking-[0.14em] text-white/40">
                        {t("taskboard.dropHere")}
                      </div>
                    ) : (
                      cards.map((card) => (
                        <button
                          key={card.id}
                          type="button"
                          draggable
                          aria-label={t("taskboard.arrowHint", {
                            title: card.title,
                            status: STATUS_LABELS[card.status],
                          })}
                          onDragStart={(event) => {
                            event.dataTransfer.setData("text/task-card-id", card.id);
                            event.dataTransfer.effectAllowed = "move";
                          }}
                          onClick={() => onSelectCard(selectedCard?.id === card.id ? null : card.id)}
                          onKeyDown={(event: ReactKeyboardEvent) => {
                            const currentIdx = STATUS_ORDER.indexOf(card.status);
                            if (event.key === "ArrowRight" && currentIdx < STATUS_ORDER.length - 1) {
                              event.preventDefault();
                              onMoveCard(card.id, STATUS_ORDER[currentIdx + 1]!);
                            } else if (event.key === "ArrowLeft" && currentIdx > 0) {
                              event.preventDefault();
                              onMoveCard(card.id, STATUS_ORDER[currentIdx - 1]!);
                            }
                          }}
                          className={`flex flex-col px-3 py-2.5 ${
                            selectedCard?.id === card.id ? HQ_CARD_BUTTON_SELECTED : HQ_CARD_BUTTON
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="line-clamp-2 min-w-0 break-words text-[13px] font-medium leading-[18px] text-white">
                              {card.title}
                            </div>
                            <span className={HQ_BADGE_MUTED}>{sourceLabel(card.source)}</span>
                          </div>
                          {card.description ? (
                            <div className="mt-1.5 line-clamp-3 break-words text-[12px] leading-[18px] text-white/60">
                              {card.description}
                            </div>
                          ) : null}
                          <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] uppercase tracking-[0.12em] text-white/65">
                            <span className="max-w-full truncate">
                              {card.assignedAgentId
                                ? (agentNameById.get(card.assignedAgentId) ?? card.assignedAgentId)
                                : t("taskboard.unassigned")}
                            </span>
                            {card.runId ? <span className="text-red-300">{t("taskboard.runLinked")}</span> : null}
                            {card.playbookJobId ? <span className="text-red-300">{t("taskboard.playbookLinked")}</span> : null}
                          </div>
                          <div className={`mt-1.5 ${HQ_META}`}>
                            {formatRelativeTime(card.lastActivityAt ?? card.updatedAt)}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {selectedCard ? (
          <aside className="flex min-h-0 flex-col border-l border-red-900/40 bg-[#070404]/90">
            <div className="flex items-center justify-between gap-2 border-b border-red-900/40 px-4 py-2.5">
              <div className={HQ_PANEL_TITLE}>{t("taskboard.details")}</div>
              <button
                type="button"
                onClick={() => onSelectCard(null)}
                className={HQ_BUTTON_SECONDARY}
              >
                {t("common.close")}
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
              <label className="flex flex-col gap-1.5">
                <span className={HQ_LABEL}>
                  {t("taskboard.title2")}
                </span>
                <input
                  value={selectedCard.title}
                  onChange={(event) =>
                    onUpdateCard(selectedCard.id, { title: event.target.value })
                  }
                  className={HQ_FIELD_PROSE}
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className={HQ_LABEL}>
                  {t("taskboard.description")}
                </span>
                <textarea
                  rows={4}
                  value={selectedCard.description}
                  onChange={(event) =>
                    onUpdateCard(selectedCard.id, { description: event.target.value })
                  }
                  className={`${HQ_FIELD_PROSE} resize-y`}
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className={HQ_LABEL}>
                  {t("taskboard.statusLabel")}
                </span>
                <select
                  value={selectedCard.status}
                  onChange={(event) =>
                    onMoveCard(selectedCard.id, event.target.value as TaskBoardStatus)
                  }
                  className={HQ_SELECT}
                >
                  {STATUS_ORDER.map((status) => (
                    <option key={status} value={status}>
                      {STATUS_LABELS[status]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1.5">
                <span className={HQ_LABEL}>
                  {t("taskboard.assignedAgent")}
                </span>
                <select
                  value={selectedCard.assignedAgentId ?? ""}
                  onChange={(event) =>
                    onUpdateCard(selectedCard.id, {
                      assignedAgentId: event.target.value || null,
                    })
                  }
                  className={HQ_SELECT}
                >
                  <option value="">{t("taskboard.unassigned")}</option>
                  {agents.map((agent) => (
                    <option key={agent.agentId} value={agent.agentId}>
                      {agent.name || agent.agentId}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1.5">
                <span className={HQ_LABEL}>
                  {t("taskboard.linkedRun")}
                </span>
                <select
                  value={selectedCard.runId ?? ""}
                  onChange={(event) =>
                    onUpdateCard(selectedCard.id, { runId: event.target.value || null })
                  }
                  className={HQ_SELECT}
                >
                  <option value="">{t("taskboard.noLinkedRun")}</option>
                  {activeRuns.map((run) => (
                    <option key={run.runId} value={run.runId}>
                      {run.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1.5">
                <span className={HQ_LABEL}>
                  {t("taskboard.linkedPlaybook")}
                </span>
                <select
                  value={selectedCard.playbookJobId ?? ""}
                  onChange={(event) =>
                    onUpdateCard(selectedCard.id, {
                      playbookJobId: event.target.value || null,
                    })
                  }
                  className={HQ_SELECT}
                >
                  <option value="">{t("taskboard.noLinkedPlaybook")}</option>
                  {cronJobs.map((job) => (
                    <option key={job.id} value={job.id}>
                      {job.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1.5">
                <span className={HQ_LABEL}>
                  {t("taskboard.channel")}
                </span>
                <input
                  value={selectedCard.channel ?? ""}
                  onChange={(event) =>
                    onUpdateCard(selectedCard.id, {
                      channel: event.target.value || null,
                    })
                  }
                  className={HQ_FIELD}
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className={HQ_LABEL}>
                  {t("taskboard.notes")}
                </span>
                <textarea
                  rows={3}
                  value={selectedCard.notes.join("\n")}
                  onChange={(event) =>
                    onUpdateCard(selectedCard.id, {
                      notes: event.target.value
                        .split("\n")
                        .map((entry) => entry.trim())
                        .filter(Boolean),
                    })
                  }
                  className={`${HQ_FIELD_PROSE} resize-y`}
                />
              </label>

              <div className={`space-y-1.5 px-3 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-white/55 ${HQ_INSET}`}>
                <div>{t("taskboard.source", { value: sourceLabel(selectedCard.source) })}</div>
                <div>{t("taskboard.created", { value: new Date(selectedCard.createdAt).toLocaleString(LOCALE) })}</div>
                <div>{t("taskboard.updated", { value: new Date(selectedCard.updatedAt).toLocaleString(LOCALE) })}</div>
              </div>

              <button
                type="button"
                onClick={() => onDeleteCard(selectedCard.id)}
                className={`${HQ_BUTTON_DANGER} w-full`}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("taskboard.delete")}
              </button>
            </div>
          </aside>
        ) : null}
      </div>
    </section>
  );
}
