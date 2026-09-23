"use client";

import { useCallback, useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { useHermesControl } from "@/features/hermes/HermesControlContext";

export type AutonomySettings = {
  mode: "off" | "scheduled" | "continuous";
  intervalMinutes: number;
  activeFrom: string | null;
  activeTo: string | null;
  dailyBudgetUsd: number;
  pauseBoardOnBudget: boolean;
  paused: boolean;
  timeZone: string;
};

export type AutonomyStatus = {
  settings: AutonomySettings;
  spentTodayUsd: number | null;
  spendError: string | null;
  budgetExceeded: boolean;
  boardPaused: boolean;
  withinActiveHours: boolean;
  lastReviewAt: string | null;
  lastReviewReason: string | null;
  nextReviewAt: string | null;
  reviewRunning: boolean;
};

const money = (value: number) => `$${value.toFixed(2)}`;
const time = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "—";

const modeLabel = (settings: AutonomySettings) => {
  if (settings.mode === "scheduled") return t("autonomy.modeScheduledEvery", { minutes: settings.intervalMinutes });
  if (settings.mode === "continuous") return t("autonomy.modeContinuous");
  return t("autonomy.modeOff");
};

/**
 * The organization's autonomy, under the mission: whether the main agent
 * keeps the work going on its own, today's spending against the daily
 * budget, and the pause button that stops autonomous reviews and the board.
 */
export function AutonomyBar() {
  const control = useHermesControl();
  const [status, setStatus] = useState<AutonomyStatus | null>(null);
  const [draft, setDraft] = useState<AutonomySettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!control) return;
    try {
      setStatus(await control.call<AutonomyStatus>("org.autonomy.get"));
    } catch {
      // Adapters without autonomy: the bar stays hidden.
    }
  }, [control]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!control) return;
    return control.onEvent((frame) => {
      if (frame.event !== "org.autonomy") return;
      const payload = frame.payload as AutonomyStatus | undefined;
      if (payload?.settings) setStatus(payload);
    });
  }, [control]);

  if (!control || !status) return null;
  const { settings } = status;

  const run = async (action: () => Promise<AutonomyStatus>, done?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      setStatus(await action());
      if (done) setMessage(done);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    const { paused: _paused, ...rest } = draft;
    void _paused;
    const ok = await run(() => control.call<AutonomyStatus>("org.autonomy.set", { settings: rest }), t("autonomy.saved"));
    if (ok) setDraft(null);
  };

  const budgetText =
    status.spentTodayUsd === null
      ? t("autonomy.spendUnknown")
      : settings.dailyBudgetUsd > 0
        ? t("autonomy.spentOf", { spent: money(status.spentTodayUsd), budget: money(settings.dailyBudgetUsd) })
        : t("autonomy.spentNoLimit", { spent: money(status.spentTodayUsd) });

  const chips: Array<{ text: string; tone: "warn" | "info" }> = [];
  if (settings.paused) chips.push({ text: t("autonomy.paused"), tone: "warn" });
  if (status.budgetExceeded) {
    chips.push({ text: status.boardPaused ? t("autonomy.budgetExceededBoard") : t("autonomy.budgetExceeded"), tone: "warn" });
  }
  if (settings.mode !== "off" && !status.withinActiveHours) chips.push({ text: t("autonomy.outsideHours"), tone: "info" });
  if (status.reviewRunning) chips.push({ text: t("autonomy.reviewing"), tone: "info" });

  return (
    <div className="mt-2 rounded border border-cyan-400/20 bg-cyan-400/[0.05] px-3 py-2 text-[12px]" data-testid="autonomy-bar">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-200/80">{t("autonomy.title")}</span>
        <span className="text-white/85">{modeLabel(settings)}</span>
        <span className="text-white/60">{budgetText}</span>
        {chips.map((chip) => (
          <span
            key={chip.text}
            className={`rounded px-1.5 py-0.5 text-[11px] ${chip.tone === "warn" ? "bg-amber-500/20 text-amber-100" : "bg-white/10 text-white/70"}`}
          >
            {chip.text}
          </span>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="ui-btn-secondary px-2 py-1 text-[11px]"
            disabled={busy || status.reviewRunning}
            onClick={() => void run(() => control.call<AutonomyStatus>("org.autonomy.runNow"), t("autonomy.reviewStarted"))}
          >
            {t("autonomy.runNow")}
          </button>
          <button
            type="button"
            className="ui-btn-secondary px-2 py-1 text-[11px]"
            disabled={busy}
            onClick={() => void run(() => control.call<AutonomyStatus>("org.autonomy.pause", { paused: !settings.paused }))}
          >
            {settings.paused ? t("autonomy.resume") : t("autonomy.pause")}
          </button>
          <button
            type="button"
            className="ui-btn-secondary px-2 py-1 text-[11px]"
            disabled={busy}
            onClick={() => setDraft(draft ? null : { ...settings })}
          >
            {draft ? t("autonomy.close") : t("autonomy.configure")}
          </button>
        </div>
      </div>
      {status.lastReviewAt ? (
        <div className="mt-1 text-[11px] text-white/50">
          {t("autonomy.lastReview", { time: time(status.lastReviewAt), reason: status.lastReviewReason ?? "" })}
          {status.nextReviewAt ? ` · ${t("autonomy.nextReview", { time: time(status.nextReviewAt) })}` : ""}
        </div>
      ) : null}
      {draft ? (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-white/70">
            {t("autonomy.mode")}
            <select
              className="rounded border border-white/15 bg-black/40 px-2 py-1 text-white"
              value={draft.mode}
              onChange={(event) => setDraft({ ...draft, mode: event.target.value as AutonomySettings["mode"] })}
            >
              <option value="off">{t("autonomy.modeOff")}</option>
              <option value="scheduled">{t("autonomy.modeScheduled")}</option>
              <option value="continuous">{t("autonomy.modeContinuous")}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-white/70">
            {t("autonomy.interval")}
            <input
              type="number"
              min={15}
              max={1440}
              className="rounded border border-white/15 bg-black/40 px-2 py-1 text-white"
              value={draft.intervalMinutes}
              onChange={(event) => setDraft({ ...draft, intervalMinutes: Number(event.target.value) })}
            />
          </label>
          <label className="flex flex-col gap-1 text-white/70">
            {t("autonomy.activeFrom")}
            <input
              type="time"
              className="rounded border border-white/15 bg-black/40 px-2 py-1 text-white"
              value={draft.activeFrom ?? ""}
              onChange={(event) => setDraft({ ...draft, activeFrom: event.target.value || null })}
            />
          </label>
          <label className="flex flex-col gap-1 text-white/70">
            {t("autonomy.activeTo")}
            <input
              type="time"
              className="rounded border border-white/15 bg-black/40 px-2 py-1 text-white"
              value={draft.activeTo ?? ""}
              onChange={(event) => setDraft({ ...draft, activeTo: event.target.value || null })}
            />
          </label>
          <label className="flex flex-col gap-1 text-white/70">
            {t("autonomy.budget")}
            <input
              type="number"
              min={0}
              step={0.5}
              className="rounded border border-white/15 bg-black/40 px-2 py-1 text-white"
              value={draft.dailyBudgetUsd}
              onChange={(event) => setDraft({ ...draft, dailyBudgetUsd: Number(event.target.value) })}
            />
          </label>
          <label className="flex flex-col gap-1 text-white/70">
            {t("autonomy.timeZone")}
            <input
              type="text"
              className="rounded border border-white/15 bg-black/40 px-2 py-1 text-white"
              value={draft.timeZone}
              onChange={(event) => setDraft({ ...draft, timeZone: event.target.value })}
            />
          </label>
          <label className="flex items-center gap-2 text-white/70 sm:col-span-2">
            <input
              type="checkbox"
              checked={draft.pauseBoardOnBudget}
              onChange={(event) => setDraft({ ...draft, pauseBoardOnBudget: event.target.checked })}
            />
            {t("autonomy.pauseBoardOnBudget")}
          </label>
          <p className="text-[11px] text-white/50 sm:col-span-2">{t("autonomy.help")}</p>
          <div className="flex justify-end sm:col-span-2">
            <button type="button" className="ui-btn-primary px-3 py-1.5 text-xs font-semibold" disabled={busy} onClick={() => void save()}>
              {t("autonomy.save")}
            </button>
          </div>
        </div>
      ) : null}
      {message ? <div className="mt-1 text-[11px] text-white/70">{message}</div> : null}
    </div>
  );
}
