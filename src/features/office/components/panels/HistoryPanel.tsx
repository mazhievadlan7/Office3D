"use client";

import { useMemo, useState } from "react";

import type { AgentState } from "@/features/agents/state/store";
import {
  HQ_BADGE,
  HQ_CARD_BUTTON,
  HQ_DOT_DONE,
  HQ_DOT_ERROR,
  HQ_DOT_LIVE,
  HQ_EMPTY,
  HQ_LABEL,
  HQ_META,
  HQ_PANEL_HEADER,
  HQ_PANEL_LEAD,
  HQ_PANEL_TITLE,
  HQ_SELECT,
  HQ_VALUE,
} from "@/features/office/components/panels/hqPanelStyles";
import type { RunRecord, RunTriggerKind } from "@/features/office/hooks/useRunLog";
import { t } from "@/lib/i18n";
import { formatDurationShort } from "@/lib/text/duration";

const formatClockTime = (timestampMs: number) =>
  new Date(timestampMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

const formatDuration = (startedAt: number, endedAt: number | null) => {
  const deltaMs = Math.max(0, (endedAt ?? Date.now()) - startedAt);
  const seconds = Math.floor(deltaMs / 1000);
  if (!endedAt) return t("history.runningFor", { seconds: Math.max(1, seconds) });
  return formatDurationShort(seconds);
};

const TRIGGER_LABELS: Record<RunTriggerKind, string> = {
  user: t("history.triggerUser"),
  heartbeat: t("history.triggerHeartbeat"),
  cron: t("history.triggerCron"),
};

export function HistoryPanel({
  runs,
  agents,
  onSelectAgent,
}: {
  runs: RunRecord[];
  agents: AgentState[];
  onSelectAgent: (agentId: string) => void;
}) {
  const [agentFilter, setAgentFilter] = useState("all");
  const [triggerFilter, setTriggerFilter] = useState<"all" | RunTriggerKind>("all");

  const filteredRuns = useMemo(() => {
    return runs.filter((run) => {
      if (agentFilter !== "all" && run.agentId !== agentFilter) return false;
      if (triggerFilter !== "all" && run.trigger !== triggerFilter) return false;
      return true;
    });
  }, [agentFilter, runs, triggerFilter]);

  return (
    // A container so the filters and run facts reflow in the narrow rail.
    <section className="@container flex h-full min-h-0 flex-col">
      <div className={HQ_PANEL_HEADER}>
        <div className={HQ_PANEL_TITLE}>{t("history.title")}</div>
        <div className={HQ_PANEL_LEAD}>{t("history.lead")}</div>
      </div>

      <div className="grid shrink-0 grid-cols-1 gap-2 border-b border-red-900/40 px-3 py-3 @2xs:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className={HQ_LABEL}>{t("history.agent")}</span>
          <select
            value={agentFilter}
            onChange={(event) => setAgentFilter(event.target.value)}
            className={HQ_SELECT}
          >
            <option value="all">{t("history.allAgents")}</option>
            {agents.map((agent) => (
              <option key={agent.agentId} value={agent.agentId}>
                {agent.name || agent.agentId}
              </option>
            ))}
          </select>
        </label>

        <label className="flex min-w-0 flex-col gap-1.5">
          <span className={HQ_LABEL}>{t("history.trigger")}</span>
          <select
            value={triggerFilter}
            onChange={(event) => setTriggerFilter(event.target.value as "all" | RunTriggerKind)}
            className={HQ_SELECT}
          >
            <option value="all">{t("history.allTriggers")}</option>
            <option value="user">{t("history.triggerUser")}</option>
            <option value="heartbeat">{t("history.triggerHeartbeat")}</option>
            <option value="cron">{t("history.triggerCron")}</option>
          </select>
        </label>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {filteredRuns.length === 0 ? (
          <div className={HQ_EMPTY}>{t("history.empty")}</div>
        ) : (
          filteredRuns.map((run) => {
            const isRunning = run.endedAt === null;
            const isError = !isRunning && run.outcome === "error";
            return (
              <button
                key={run.runId}
                type="button"
                onClick={() => onSelectAgent(run.agentId)}
                className={`${HQ_CARD_BUTTON} flex flex-col px-3 py-2.5`}
              >
                <div className="flex items-center gap-2">
                  <span className={isRunning ? HQ_DOT_LIVE : isError ? HQ_DOT_ERROR : HQ_DOT_DONE} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-white">
                    {run.agentName}
                  </span>
                  <span className={HQ_BADGE}>{TRIGGER_LABELS[run.trigger]}</span>
                </div>

                <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-2">
                  <div className="min-w-0 max-w-full">
                    <div className={HQ_META}>{t("history.started")}</div>
                    <div className={`mt-1 ${HQ_VALUE}`}>{formatClockTime(run.startedAt)}</div>
                  </div>
                  <div className="min-w-0 max-w-full">
                    <div className={HQ_META}>{t("history.duration")}</div>
                    <div className={`mt-1 truncate ${HQ_VALUE}`}>
                      {formatDuration(run.startedAt, run.endedAt)}
                    </div>
                  </div>
                  <div className="min-w-0 max-w-full">
                    <div className={HQ_META}>{t("history.outcome")}</div>
                    <div
                      className={`mt-1 truncate font-mono text-[11px] ${
                        isRunning ? "text-red-300" : isError ? "text-red-400" : "text-white"
                      }`}
                    >
                      {isRunning
                        ? t("history.outcomeRunning")
                        : isError
                          ? t("history.outcomeError")
                          : t("history.outcomeCompleted")}
                    </div>
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}
