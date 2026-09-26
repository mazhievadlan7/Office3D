"use client";

import { useMemo, useRef } from "react";

import { CalendarDays, RefreshCw } from "lucide-react";

import type { AgentState } from "@/features/agents/state/store";
import {
  HQ_BUTTON_SECONDARY,
  HQ_CARD,
  HQ_EMPTY,
  HQ_FIELD,
  HQ_HINT,
  HQ_INSET,
  HQ_INSET_BUTTON,
  HQ_LABEL,
  HQ_NOTICE_ERROR,
  HQ_NOTICE_OK,
  HQ_NOTICE_WARN,
  HQ_PANEL_HEADER,
  HQ_PANEL_LEAD,
  HQ_PANEL_TITLE,
  HQ_SECTION,
  HQ_SECTION_TITLE,
} from "@/features/office/components/panels/hqPanelStyles";
import { useApprovalMetrics } from "@/features/office/hooks/useApprovalMetrics";
import { useOfficeUsageAnalyticsViewModel } from "@/features/office/hooks/useOfficeUsageAnalyticsViewModel";
import { usePerformanceAnalytics } from "@/features/office/hooks/usePerformanceAnalytics";
import type { RunRecord } from "@/features/office/hooks/useRunLog";
import type { GatewayClient, GatewayStatus } from "@/lib/gateway/GatewayClient";
import {
  formatCurrency,
  formatNumber,
} from "@/lib/office/usageAnalyticsPresentation";
import type { StudioSettingsCoordinator } from "@/lib/studio/coordinator";
import { LOCALE, t } from "@/lib/i18n";
import { formatDurationShort } from "@/lib/text/duration";

const formatPercent = (value: number | null | undefined) => {
  if (value === null || value === undefined) return t("common.notAvailable");
  return `${Math.round(value * 100)}%`;
};

const formatDuration = (valueMs: number | null | undefined) => {
  if (!valueMs) return t("common.notAvailable");
  return formatDurationShort(valueMs / 1000);
};

const formatBudgetInput = (value: number | null) => (value === null ? "" : String(value));

const parseBudgetInput = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
};

/** "2026-09-25" → "25.09", the way a Russian reader writes a day. */
const formatChartDay = (isoDate: string) => `${isoDate.slice(8, 10)}.${isoDate.slice(5, 7)}`;

/**
 * Bar colour on the red → white ramp: small days stay deep red, the peak
 * burns toward white, so the busiest day reads before any label does.
 */
const chartBarFill = (ratio: number) =>
  `linear-gradient(to top, rgba(122, 21, 26, 0.9), color-mix(in oklch, #e3141c, white ${Math.round(
    ratio * 55
  )}%))`;

// Up to a week, every bar gets its value and day; beyond that they would
// overlap, so the chart shows its scale and the range ends instead.
const MAX_LABELLED_BARS = 7;

// The three dollar limits share one field shape; the alert threshold is a percentage.
const BUDGET_FIELDS: Array<{
  key: "dailySpendLimitUsd" | "monthlySpendLimitUsd" | "perAgentSoftLimitUsd";
  label: string;
  placeholder: string;
}> = [
  { key: "dailySpendLimitUsd", label: t("analytics.dailyUsd"), placeholder: t("analytics.noLimit") },
  { key: "monthlySpendLimitUsd", label: t("analytics.monthlyUsd"), placeholder: t("analytics.noLimit") },
  { key: "perAgentSoftLimitUsd", label: t("analytics.perAgentUsd"), placeholder: t("analytics.softLimit") },
];

const StatCard = ({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) => (
  <div className={`${HQ_CARD} min-w-0 px-3 py-2.5`}>
    {/* A row in the narrow rail, a stacked tile once there is room for two columns. */}
    <div className="flex items-baseline justify-between gap-2 @2xs:block">
      <div className={`${HQ_LABEL} min-w-0`}>{label}</div>
      <div className="shrink-0 truncate font-mono text-[16px] font-semibold tabular-nums text-white @2xs:mt-1.5 @2xs:text-[18px]">
        {value}
      </div>
    </div>
    <div className={`mt-1 ${HQ_HINT}`}>{hint}</div>
  </div>
);

/** A thin share-of-total bar under a ranked row. */
const ShareBar = ({ ratio }: { ratio: number }) => (
  <div className="mt-1.5 h-0.5 overflow-hidden rounded-full bg-white/[0.06]">
    <div
      className="h-full rounded-full bg-gradient-to-r from-red-700 via-[#e3141c] to-red-300"
      style={{ width: `${Math.max(2, Math.min(100, ratio * 100))}%` }}
    />
  </div>
);

const openNativeDatePicker = (input: HTMLInputElement | null) => {
  if (!input) return;
  if (typeof input.showPicker === "function") {
    input.showPicker();
    return;
  }
  input.focus();
};

const DatePickerField = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) => {
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className={HQ_LABEL}>{label}</span>
      <div className="relative">
        <input
          ref={inputRef}
          type="date"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => openNativeDatePicker(inputRef.current)}
          // Our calendar button replaces the browser's own indicator.
          className={`${HQ_FIELD} pr-9 tabular-nums [&::-webkit-calendar-picker-indicator]:hidden`}
        />
        <button
          type="button"
          onClick={() => openNativeDatePicker(inputRef.current)}
          className="absolute inset-y-0 right-0 flex w-8 items-center justify-center rounded-r-md text-red-400/80 transition-colors hover:text-white focus-visible:text-white focus-visible:outline-none"
          aria-label={t("analytics.openCalendar", { label: label.toLowerCase() })}
        >
          <CalendarDays className="h-3.5 w-3.5" />
        </button>
      </div>
    </label>
  );
};

export function AnalyticsPanel({
  client,
  status,
  approvalsEnabled = true,
  agents,
  runLog,
  gatewayUrl,
  settingsCoordinator,
  onSelectAgent,
}: {
  client: GatewayClient;
  status: GatewayStatus;
  approvalsEnabled?: boolean;
  agents: AgentState[];
  runLog: RunRecord[];
  gatewayUrl: string;
  settingsCoordinator: StudioSettingsCoordinator;
  onSelectAgent: (agentId: string) => void;
}) {
  const {
    startDate,
    setStartDate,
    endDate,
    setEndDate,
    budgets,
    settingsLoaded,
    usage,
    updateBudget,
  } = useOfficeUsageAnalyticsViewModel({
    client,
    status,
    agents,
    gatewayUrl,
    settingsCoordinator,
  });

  const approvalMetrics = useApprovalMetrics({
    client,
    status,
    enabled: approvalsEnabled,
    agents,
  });
  const performance = usePerformanceAnalytics({
    agents,
    runLog,
    approvalByAgent: approvalMetrics.byAgent,
  });

  const dailyChartMax = useMemo(() => {
    return usage.costDaily.reduce((max, entry) => Math.max(max, entry.totalCost), 0);
  }, [usage.costDaily]);

  const topAgents = usage.aggregates.byAgent.slice(0, 6);
  const topModels = usage.aggregates.byModel.slice(0, 6);
  const topAgentCost = topAgents.reduce((max, entry) => Math.max(max, entry.totals.totalCost), 0);
  const topModelCost = topModels.reduce((max, entry) => Math.max(max, entry.totals.totalCost), 0);
  const labelEveryBar = usage.costDaily.length <= MAX_LABELLED_BARS;
  const firstDay = usage.costDaily[0];
  const lastDay = usage.costDaily[usage.costDaily.length - 1];

  const alertBannerClass = usage.budgetAlerts.some((alert) => alert.severity === "danger")
    ? HQ_NOTICE_ERROR
    : HQ_NOTICE_WARN;

  return (
    // A container, so tiles and fields reflow to the width the rail gives them.
    <section className="@container flex h-full min-h-0 flex-col">
      <div className={HQ_PANEL_HEADER}>
        <div className={HQ_PANEL_TITLE}>{t("analytics.title")}</div>
        <div className={HQ_PANEL_LEAD}>{t("analytics.lead")}</div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <div>
          <div className="grid grid-cols-1 gap-2 @2xs:grid-cols-2">
            <DatePickerField label={t("analytics.start")} value={startDate} onChange={setStartDate} />
            <DatePickerField label={t("analytics.end")} value={endDate} onChange={setEndDate} />
          </div>

          <div className="mt-2 flex items-center justify-between gap-2">
            <div className={`min-w-0 ${HQ_HINT}`}>
              {usage.lastRefreshedAt
                ? t("analytics.lastRefresh", {
                    time: new Date(usage.lastRefreshedAt).toLocaleTimeString(LOCALE),
                  })
                : t("analytics.noSnapshot")}
            </div>
            <button type="button" onClick={() => void usage.refresh()} className={HQ_BUTTON_SECONDARY}>
              <RefreshCw className={`h-3 w-3 ${usage.loading ? "animate-spin" : ""}`} />
              {t("common.refresh")}
            </button>
          </div>

          {usage.error ? <div className={`mt-3 ${HQ_NOTICE_ERROR}`}>{usage.error}</div> : null}

          {usage.budgetAlerts.length > 0 ? (
            <div className={`mt-3 space-y-0.5 ${alertBannerClass}`}>
              {usage.budgetAlerts.map((alert) => (
                <div key={alert.key}>
                  {alert.label}: {formatCurrency(alert.currentUsd)} / {formatCurrency(alert.limitUsd)}.
                </div>
              ))}
            </div>
          ) : settingsLoaded ? (
            <div className={`mt-3 ${HQ_NOTICE_OK}`}>{t("analytics.budgetsOk")}</div>
          ) : null}
        </div>

        <div className="grid grid-cols-1 gap-2 @2xs:grid-cols-2">
          <StatCard
            label={t("analytics.totalSpend")}
            value={formatCurrency(usage.totals.totalCost)}
            hint={t("analytics.totalSpendHint")}
          />
          <StatCard
            label={t("analytics.totalTokens")}
            value={formatNumber(usage.totals.totalTokens)}
            hint={t("analytics.totalTokensHint")}
          />
          <StatCard
            label={t("analytics.successRate")}
            value={formatPercent(performance.fleet.successRate)}
            hint={t("analytics.successRateHint")}
          />
          <StatCard
            label={t("analytics.avgRuntime")}
            value={formatDuration(performance.fleet.avgRuntimeMs)}
            hint={t("analytics.avgRuntimeHint")}
          />
        </div>

        <div className={HQ_SECTION}>
          <div className={HQ_SECTION_TITLE}>{t("analytics.budgetLimits")}</div>
          <div className="mt-3 grid grid-cols-1 gap-2 @2xs:grid-cols-2">
            {BUDGET_FIELDS.map((field) => (
              <label key={field.key} className="flex min-w-0 flex-col gap-1.5">
                <span className={HQ_LABEL}>{field.label}</span>
                <input
                  value={formatBudgetInput(budgets[field.key])}
                  onChange={(event) => updateBudget(field.key, parseBudgetInput(event.target.value))}
                  placeholder={field.placeholder}
                  inputMode="decimal"
                  className={`${HQ_FIELD} tabular-nums`}
                />
              </label>
            ))}
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className={HQ_LABEL}>{t("analytics.alertThreshold")}</span>
              <input
                value={String(budgets.alertThresholdPct)}
                onChange={(event) =>
                  updateBudget(
                    "alertThresholdPct",
                    Math.min(100, Math.max(1, parseBudgetInput(event.target.value) ?? 80))
                  )
                }
                inputMode="numeric"
                className={`${HQ_FIELD} tabular-nums`}
              />
            </label>
          </div>
        </div>

        <div className={HQ_SECTION}>
          <div className={HQ_SECTION_TITLE}>{t("analytics.dailyCost")}</div>
          {usage.loading ? (
            <div className={`mt-3 ${HQ_EMPTY}`}>{t("analytics.loading")}</div>
          ) : usage.costDaily.length === 0 ? (
            <div className={`mt-3 ${HQ_EMPTY}`}>{t("analytics.noCostInRange")}</div>
          ) : (
            <div className="mt-3">
              {labelEveryBar ? (
                // Inset by the plot's border + padding so each label sits over its bar.
                <div className="mb-1 flex gap-1 px-[7px]">
                  {usage.costDaily.map((entry) => (
                    <div
                      key={entry.date}
                      className="min-w-0 flex-1 truncate text-center font-mono text-[9px] tabular-nums text-white/70"
                    >
                      {formatCurrency(entry.totalCost)}
                    </div>
                  ))}
                </div>
              ) : null}
              {/* Gridlines tile the content box, so they mark 25/50/75/100% of the bar scale. */}
              <div className="relative flex h-28 items-end gap-1 rounded-md border border-red-900/30 bg-black/40 bg-[linear-gradient(to_top,rgba(255,255,255,0.05)_1px,transparent_1px)] bg-[length:100%_25%] bg-origin-content px-1.5 pt-4">
                {labelEveryBar ? null : (
                  <div className="pointer-events-none absolute left-1.5 top-1 font-mono text-[9px] tabular-nums text-white/55">
                    {formatCurrency(dailyChartMax)}
                  </div>
                )}
                {usage.costDaily.map((entry) => {
                  const ratio = dailyChartMax > 0 ? entry.totalCost / dailyChartMax : 0;
                  return (
                    <div
                      key={entry.date}
                      className="min-w-0 flex-1 rounded-t-sm"
                      style={{ height: `${Math.max(4, ratio * 100)}%`, background: chartBarFill(ratio) }}
                      title={`${formatChartDay(entry.date)} · ${formatCurrency(entry.totalCost)}`}
                    />
                  );
                })}
              </div>
              {labelEveryBar ? (
                <div className="mt-1 flex gap-1 px-[7px]">
                  {usage.costDaily.map((entry) => (
                    <div
                      key={entry.date}
                      className="min-w-0 flex-1 truncate text-center font-mono text-[9px] tabular-nums text-white/50"
                    >
                      {formatChartDay(entry.date)}
                    </div>
                  ))}
                </div>
              ) : firstDay && lastDay ? (
                <div className="mt-1 flex justify-between px-[7px] font-mono text-[9px] tabular-nums text-white/50">
                  <span>{formatChartDay(firstDay.date)}</span>
                  <span>{formatChartDay(lastDay.date)}</span>
                </div>
              ) : null}
            </div>
          )}

          <div className={`mt-3 px-3 py-2.5 ${HQ_INSET}`}>
            <div className={HQ_LABEL}>{t("analytics.costBreakdown")}</div>
            <div className="mt-2 space-y-1 font-mono text-[11px] tabular-nums text-white/85">
              <div>{t("analytics.input", { value: formatCurrency(usage.totals.inputCost) })}</div>
              <div>{t("analytics.output", { value: formatCurrency(usage.totals.outputCost) })}</div>
              <div>{t("analytics.cacheRead", { value: formatCurrency(usage.totals.cacheReadCost) })}</div>
              <div>{t("analytics.cacheWrite", { value: formatCurrency(usage.totals.cacheWriteCost) })}</div>
            </div>
          </div>
        </div>

        <div className={HQ_SECTION}>
          <div className={HQ_SECTION_TITLE}>{t("analytics.topAgents")}</div>
          <div className="mt-3 space-y-1.5">
            {topAgents.map((entry) => (
              <button
                key={entry.agentId}
                type="button"
                onClick={() => onSelectAgent(entry.agentId)}
                className={`${HQ_INSET_BUTTON} px-3 py-2`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-mono text-[11px] text-white">{entry.agentName}</span>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-white">
                    {formatCurrency(entry.totals.totalCost)}
                  </span>
                </div>
                <ShareBar ratio={topAgentCost > 0 ? entry.totals.totalCost / topAgentCost : 0} />
              </button>
            ))}
            {topAgents.length === 0 ? (
              <div className={HQ_EMPTY}>{t("analytics.noAgentSpend")}</div>
            ) : null}
          </div>
        </div>

        <div className={HQ_SECTION}>
          <div className={HQ_SECTION_TITLE}>{t("analytics.modelBreakdown")}</div>
          <div className="mt-3 space-y-1.5">
            {topModels.map((entry) => (
              <div
                key={`${entry.provider ?? "unknown"}:${entry.model ?? "unknown"}`}
                className={`px-3 py-2 ${HQ_INSET}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-mono text-[11px] text-white">
                    {entry.provider ?? t("atm.unknown")} / {entry.model ?? t("atm.unknown")}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-white">
                    {formatCurrency(entry.totals.totalCost)}
                  </span>
                </div>
                <ShareBar ratio={topModelCost > 0 ? entry.totals.totalCost / topModelCost : 0} />
              </div>
            ))}
            {topModels.length === 0 ? (
              <div className={HQ_EMPTY}>{t("analytics.noModelUsage")}</div>
            ) : null}
          </div>
        </div>

        <div className={HQ_SECTION}>
          <div className={HQ_SECTION_TITLE}>{t("analytics.performance")}</div>
          <div className="mt-3 grid grid-cols-1 gap-2 @2xs:grid-cols-2">
            <StatCard
              label={t("analytics.approvals")}
              value={formatNumber(approvalMetrics.totals.requestedCount)}
              hint={t("analytics.approvalsHint")}
            />
            <StatCard
              label={t("analytics.interventionRate")}
              value={formatPercent(performance.fleet.interventionRate)}
              hint={t("analytics.interventionRateHint")}
            />
            <StatCard
              label={t("analytics.toolCalls")}
              value={formatNumber(performance.fleet.totalToolCalls)}
              hint={t("analytics.toolCallsHint")}
            />
            <StatCard
              label={t("analytics.completedRuns")}
              value={formatNumber(performance.fleet.completedRuns)}
              hint={t("analytics.completedRunsHint")}
            />
          </div>

          <div className="mt-3 space-y-1.5">
            {performance.rows.map((row) => (
              <button
                key={row.agentId}
                type="button"
                onClick={() => onSelectAgent(row.agentId)}
                className={`${HQ_INSET_BUTTON} px-3 py-2.5`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-white">
                    {row.agentName}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-white/60">
                    {t("analytics.runsCount", { count: row.totalRuns })}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-1 gap-x-2 gap-y-1 font-mono text-[10px] tabular-nums text-white/70 @2xs:grid-cols-2">
                  <div>{t("analytics.rowSuccess", { value: formatPercent(row.successRate) })}</div>
                  <div>{t("analytics.rowAvgRuntime", { value: formatDuration(row.avgRuntimeMs) })}</div>
                  <div>{t("analytics.rowToolCalls", { value: formatNumber(row.toolCalls) })}</div>
                  <div>{t("analytics.rowApprovals", { value: formatNumber(row.approvalRequestedCount) })}</div>
                </div>
              </button>
            ))}
            {performance.rows.length === 0 ? (
              <div className={HQ_EMPTY}>{t("analytics.noPerformance")}</div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
