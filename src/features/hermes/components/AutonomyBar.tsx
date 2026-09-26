"use client";

import { useCallback, useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { useHermesControl } from "@/features/hermes/HermesControlContext";

// The HQ look (black / red / white) shared with the task board around it.
const BUTTON_BASE =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50 disabled:cursor-not-allowed disabled:opacity-50";
const BUTTON_PRIMARY = `${BUTTON_BASE} border-red-500/60 bg-[#e3141c] text-white shadow-[0_0_14px_rgba(255,26,26,0.25)] hover:bg-[#ff2a2a] disabled:hover:bg-[#e3141c]`;
const BUTTON_SECONDARY = `${BUTTON_BASE} border-red-600/35 bg-black/50 text-white/85 hover:border-red-500/50 hover:bg-red-950/40 hover:text-white`;
const TITLE =
  "flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/85 before:h-2.5 before:w-0.5 before:shrink-0 before:rounded-full before:bg-[#e3141c] before:content-['']";
const FIELD =
  "w-full rounded-md border border-red-900/50 bg-black/60 px-2.5 py-1.5 font-mono text-[11px] text-white outline-none scheme-dark transition-colors placeholder:text-white/35 hover:border-red-600/45 focus:border-red-500/70 focus:ring-2 focus:ring-red-500/30 [&>option]:bg-[#0b0707] [&>option]:text-white";
const LABEL = "flex flex-col gap-1.5";
const LABEL_TEXT = "font-mono text-[10px] uppercase tracking-[0.14em] text-white/60";

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
    <div className="mt-2 rounded-md border border-red-900/40 bg-[#0b0707] px-3 py-2.5 text-[12px]" data-testid="autonomy-bar">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={TITLE}>{t("autonomy.title")}</span>
        <span className="font-medium text-white">{modeLabel(settings)}</span>
        <span className="tabular-nums text-white/65">{budgetText}</span>
        {chips.map((chip) => (
          <span
            key={chip.text}
            className={`rounded border px-1.5 py-0.5 text-[11px] leading-4 ${
              chip.tone === "warn"
                ? "border-red-500/50 bg-red-950/40 text-red-300"
                : "border-white/10 bg-white/[0.04] text-white/70"
            }`}
          >
            {chip.text}
          </span>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className={BUTTON_SECONDARY}
            disabled={busy || status.reviewRunning}
            onClick={() => void run(() => control.call<AutonomyStatus>("org.autonomy.runNow"), t("autonomy.reviewStarted"))}
          >
            {t("autonomy.runNow")}
          </button>
          <button
            type="button"
            className={BUTTON_SECONDARY}
            disabled={busy}
            onClick={() => void run(() => control.call<AutonomyStatus>("org.autonomy.pause", { paused: !settings.paused }))}
          >
            {settings.paused ? t("autonomy.resume") : t("autonomy.pause")}
          </button>
          <button
            type="button"
            className={BUTTON_SECONDARY}
            disabled={busy}
            onClick={() => setDraft(draft ? null : { ...settings })}
          >
            {draft ? t("autonomy.close") : t("autonomy.configure")}
          </button>
        </div>
      </div>
      {status.lastReviewAt ? (
        <div className="mt-1.5 font-mono text-[10px] leading-4 text-white/55">
          {t("autonomy.lastReview", { time: time(status.lastReviewAt), reason: status.lastReviewReason ?? "" })}
          {status.nextReviewAt ? ` · ${t("autonomy.nextReview", { time: time(status.nextReviewAt) })}` : ""}
        </div>
      ) : null}
      {draft ? (
        <div className="mt-3 grid grid-cols-1 gap-3 border-t border-red-900/40 pt-3 sm:grid-cols-2">
          <label className={LABEL}>
            <span className={LABEL_TEXT}>{t("autonomy.mode")}</span>
            <select
              className={FIELD}
              value={draft.mode}
              onChange={(event) => setDraft({ ...draft, mode: event.target.value as AutonomySettings["mode"] })}
            >
              <option value="off">{t("autonomy.modeOff")}</option>
              <option value="scheduled">{t("autonomy.modeScheduled")}</option>
              <option value="continuous">{t("autonomy.modeContinuous")}</option>
            </select>
          </label>
          <label className={LABEL}>
            <span className={LABEL_TEXT}>{t("autonomy.interval")}</span>
            <input
              type="number"
              min={15}
              max={1440}
              className={FIELD}
              value={draft.intervalMinutes}
              onChange={(event) => setDraft({ ...draft, intervalMinutes: Number(event.target.value) })}
            />
          </label>
          <label className={LABEL}>
            <span className={LABEL_TEXT}>{t("autonomy.activeFrom")}</span>
            <input
              type="time"
              className={FIELD}
              value={draft.activeFrom ?? ""}
              onChange={(event) => setDraft({ ...draft, activeFrom: event.target.value || null })}
            />
          </label>
          <label className={LABEL}>
            <span className={LABEL_TEXT}>{t("autonomy.activeTo")}</span>
            <input
              type="time"
              className={FIELD}
              value={draft.activeTo ?? ""}
              onChange={(event) => setDraft({ ...draft, activeTo: event.target.value || null })}
            />
          </label>
          <label className={LABEL}>
            <span className={LABEL_TEXT}>{t("autonomy.budget")}</span>
            <input
              type="number"
              min={0}
              step={0.5}
              className={FIELD}
              value={draft.dailyBudgetUsd}
              onChange={(event) => setDraft({ ...draft, dailyBudgetUsd: Number(event.target.value) })}
            />
          </label>
          <label className={LABEL}>
            <span className={LABEL_TEXT}>{t("autonomy.timeZone")}</span>
            <input
              type="text"
              className={FIELD}
              value={draft.timeZone}
              onChange={(event) => setDraft({ ...draft, timeZone: event.target.value })}
            />
          </label>
          <label className="flex cursor-pointer items-start gap-2 text-[12px] leading-4 text-white/85 sm:col-span-2">
            <input
              type="checkbox"
              className="mt-px h-3.5 w-3.5 shrink-0 cursor-pointer accent-[#e3141c] scheme-dark"
              checked={draft.pauseBoardOnBudget}
              onChange={(event) => setDraft({ ...draft, pauseBoardOnBudget: event.target.checked })}
            />
            {t("autonomy.pauseBoardOnBudget")}
          </label>
          <p className="text-[11px] leading-4 text-white/55 sm:col-span-2">{t("autonomy.help")}</p>
          <div className="flex justify-end sm:col-span-2">
            <button type="button" className={BUTTON_PRIMARY} disabled={busy} onClick={() => void save()}>
              {t("autonomy.save")}
            </button>
          </div>
        </div>
      ) : null}
      {message ? <div className="mt-1.5 font-mono text-[10px] leading-4 text-white/70">{message}</div> : null}
    </div>
  );
}
