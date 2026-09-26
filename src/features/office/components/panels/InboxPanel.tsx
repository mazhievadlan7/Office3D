"use client";

import { useMemo } from "react";

import type { AgentState } from "@/features/agents/state/store";
import {
  HQ_BADGE_ACCENT,
  HQ_CARD_BUTTON,
  HQ_DOT_IDLE,
  HQ_DOT_LIVE,
  HQ_EMPTY,
  HQ_META,
  HQ_PANEL_HEADER,
  HQ_PANEL_LEAD,
  HQ_PANEL_TITLE,
} from "@/features/office/components/panels/hqPanelStyles";
import { t } from "@/lib/i18n";

const formatRelativeTime = (timestampMs: number | null) => {
  if (!timestampMs) return t("inbox.noOutput");
  const deltaMs = Date.now() - timestampMs;
  if (deltaMs < 60_000) return t("inbox.justNow");
  if (deltaMs < 3_600_000) {
    return t("inbox.minutesAgo", { count: Math.max(1, Math.floor(deltaMs / 60_000)) });
  }
  if (deltaMs < 86_400_000) {
    return t("inbox.hoursAgo", { count: Math.max(1, Math.floor(deltaMs / 3_600_000)) });
  }
  return t("inbox.daysAgo", { count: Math.max(1, Math.floor(deltaMs / 86_400_000)) });
};

export function InboxPanel({
  agents,
  onSelectAgent,
}: {
  agents: AgentState[];
  onSelectAgent: (agentId: string) => void;
}) {
  const sortedAgents = useMemo(
    () =>
      [...agents].sort(
        (left, right) =>
          (right.lastAssistantMessageAt ?? 0) - (left.lastAssistantMessageAt ?? 0) ||
          left.name.localeCompare(right.name)
      ),
    [agents]
  );

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className={HQ_PANEL_HEADER}>
        <div className={HQ_PANEL_TITLE}>{t("inbox.title")}</div>
        <div className={HQ_PANEL_LEAD}>{t("inbox.lead")}</div>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {sortedAgents.length === 0 ? (
          <div className={HQ_EMPTY}>{t("inbox.noAgents")}</div>
        ) : (
          sortedAgents.map((agent) => {
            const preview = agent.latestPreview?.trim() || t("inbox.empty");
            const isRunning = agent.status === "running";
            return (
              <button
                key={agent.agentId}
                type="button"
                onClick={() => onSelectAgent(agent.agentId)}
                // Unread replies get a red edge so they stand out in a long list.
                className={`${HQ_CARD_BUTTON} flex flex-col px-3 py-2.5 ${
                  agent.hasUnseenActivity ? "border-l-2 border-l-[#e3141c]" : ""
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={isRunning ? HQ_DOT_LIVE : HQ_DOT_IDLE} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-white">
                    {agent.name || agent.agentId}
                  </span>
                  {agent.hasUnseenActivity ? (
                    <span className={HQ_BADGE_ACCENT}>{t("inbox.new")}</span>
                  ) : null}
                </div>
                <div className="mt-1.5 line-clamp-3 break-words text-[12px] leading-[18px] text-white/75">
                  {preview}
                </div>
                <div className={`mt-2 ${HQ_META}`}>
                  {formatRelativeTime(agent.lastAssistantMessageAt)}
                </div>
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}
