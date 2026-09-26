"use client";

import type { ReactNode } from "react";
import { HqClock } from "@/features/hq/hud/HqClock";
import { HQ_HUD_GLASS, hqHudButtonClass } from "@/features/hq/hud/hudStyle";
import { t } from "@/lib/i18n";

export type HQSidebarTab =
  | "inbox"
  | "history"
  | "kanban"
  | "playbooks"
  | "analytics";

type HQSidebarProps = {
  open: boolean;
  activeTab: HQSidebarTab;
  inboxCount: number;
  onToggle: () => void;
  onTabChange: (tab: HQSidebarTab) => void;
  onOpenMarketplace: () => void;
  onAddAgent?: () => void;
  inboxPanel: ReactNode;
  historyPanel: ReactNode;
  kanbanPanel: ReactNode;
  playbooksPanel: ReactNode;
  analyticsPanel: ReactNode;
};

const TAB_LABELS: Record<HQSidebarTab, string> = {
  inbox: t("hq.tabInbox"),
  history: t("hq.tabHistory"),
  kanban: t("hq.tabKanban"),
  playbooks: t("hq.tabPlaybooks"),
  analytics: t("hq.tabAnalytics"),
};

const PRIMARY_TABS: HQSidebarTab[] = ["inbox", "history", "kanban", "playbooks"];

const navButtonClass = (active: boolean): string =>
  `flex h-9 flex-auto items-center justify-center whitespace-nowrap px-2 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] ${hqHudButtonClass(active)}`;

const actionButtonClass =
  "flex h-7 items-center whitespace-nowrap px-2.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em]";

/**
 * The HQ's right column: the local clock and the three HQ buttons (open or
 * collapse the HQ panel, the marketplace, analytics) in one card at the top
 * right, and the open panel under it. The panel stops above the bottom row,
 * where the chat button lives, so nothing in the column collides with the
 * HUD; the chat window moves left of it when both fit (OfficeScreen).
 */
export function HQSidebar({
  open,
  activeTab,
  inboxCount,
  onToggle,
  onTabChange,
  onOpenMarketplace,
  onAddAgent,
  inboxPanel,
  historyPanel,
  kanbanPanel,
  playbooksPanel,
  analyticsPanel,
}: HQSidebarProps) {
  const analyticsOnly = activeTab === "analytics";
  const railOnly = analyticsOnly;
  const activePanel =
    activeTab === "inbox"
      ? inboxPanel
      : activeTab === "history"
        ? historyPanel
        : activeTab === "kanban"
          ? kanbanPanel
        : activeTab === "playbooks"
          ? playbooksPanel
          : analyticsPanel;
  const boardLikeWidth = activeTab === "kanban";

  return (
    <aside className="pointer-events-none fixed bottom-[70px] right-3 top-3 z-20 flex flex-col items-end gap-2">
      <div className={`pointer-events-auto w-[312px] shrink-0 ${HQ_HUD_GLASS}`}>
        <HqClock className="px-3.5 pb-2 pt-2.5" />
        <nav aria-label={t("hq.navLabel")} className="flex gap-1 border-t border-red-900/40 p-1.5">
          <button
            type="button"
            onClick={() => {
              // «Открыть штаб» opens the HQ itself, not analytics left over
              // from the last visit.
              if (!open && analyticsOnly) onTabChange("inbox");
              onToggle();
            }}
            className={navButtonClass(open && !analyticsOnly)}
            aria-expanded={open}
            aria-label={open ? t("hq.collapseLabel") : t("hq.openLabel")}
          >
            {open ? t("hq.collapse") : t("hq.open")}
          </button>
          <button
            type="button"
            onClick={() => {
              onOpenMarketplace();
            }}
            className={navButtonClass(false)}
            aria-label={t("hq.openMarketplaceLabel")}
          >
            {t("hq.marketplace")}
          </button>
          <button
            type="button"
            onClick={() => {
              onTabChange("analytics");
              if (!open) {
                onToggle();
              }
            }}
            className={navButtonClass(open && analyticsOnly)}
            aria-pressed={open && analyticsOnly}
            aria-label={t("hq.openAnalyticsLabel")}
          >
            {t("hq.analyticsTitle")}
          </button>
        </nav>
      </div>

      {open ? (
        <div
          className={`pointer-events-auto flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-red-900/50 bg-[#070404]/90 shadow-2xl backdrop-blur-sm ${
            boardLikeWidth ? "w-[min(calc(100vw-1.5rem),1180px)]" : "w-[312px]"
          }`}
        >
          <div className="border-b border-red-900/40 px-4 py-3">
            <div className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-white">
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full bg-red-500 shadow-[0_0_8px_rgba(255,42,42,0.9)]"
              />
              {analyticsOnly ? t("hq.analyticsTitle") : t("hq.hqTitle")}
            </div>
            <p className="mt-1 font-mono text-[11px] leading-4 text-white/65">
              {analyticsOnly ? t("hq.analyticsLead") : t("hq.hqLead")}
            </p>
            {railOnly || onAddAgent ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {!railOnly && onAddAgent ? (
                  <button
                    type="button"
                    onClick={onAddAgent}
                    className={`${actionButtonClass} rounded-md border border-red-500/60 bg-[#e3141c] text-white shadow-[0_0_14px_rgba(255,26,26,0.25)] transition-colors hover:border-red-400 hover:bg-[#ff2a2a]`}
                  >
                    {t("hq.addAgent")}
                  </button>
                ) : null}
                {railOnly ? (
                  <button
                    type="button"
                    onClick={() => onTabChange("inbox")}
                    className={`${actionButtonClass} ${hqHudButtonClass(false)}`}
                  >
                    {t("hq.backToHq")}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          {!railOnly ? (
            <div
              role="tablist"
              aria-label={t("hq.panelsLabel")}
              className="flex border-b border-red-900/40"
            >
              {PRIMARY_TABS.map((tab) => {
                const isActive = tab === activeTab;
                const showBadge = tab === "inbox" && inboxCount > 0;
                return (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    aria-controls={`hq-panel-${tab}`}
                    id={`hq-tab-${tab}`}
                    onClick={() => onTabChange(tab)}
                    className={`flex h-9 flex-auto items-center justify-center gap-1 whitespace-nowrap border-r border-red-900/40 px-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] transition-colors last:border-r-0 ${
                      isActive
                        ? "bg-red-600/20 text-white shadow-[inset_0_-2px_0_#e3141c]"
                        : "text-white/65 hover:bg-red-950/40 hover:text-white"
                    }`}
                  >
                    <span>{TAB_LABELS[tab]}</span>
                    {showBadge ? (
                      <span
                        className="rounded-sm bg-[#e3141c] px-1 text-[9px] leading-[14px] tabular-nums text-white"
                        aria-label={t("hq.unreadCount", { count: inboxCount })}
                      >
                        {inboxCount > 99 ? "99+" : inboxCount}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}

          <div
            role="tabpanel"
            id={`hq-panel-${activeTab}`}
            aria-labelledby={`hq-tab-${activeTab}`}
            className="min-h-0 flex-1 overflow-hidden"
          >
            {activePanel}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
