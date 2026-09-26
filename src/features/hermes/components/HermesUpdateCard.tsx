"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { useHermesControl } from "@/features/hermes/HermesControlContext";

type UpdateJob = {
  id: string;
  from: string;
  to: string;
  status: "running" | "done" | "rolled_back" | "failed" | "rollback_failed";
  step: string;
  error: string | null;
};

export type HermesUpdateView = {
  available: boolean;
  reachable?: boolean;
  current?: string;
  latest?: string;
  offer?: boolean;
  job?: UpdateJob | null;
  running?: boolean;
};

const DISMISSED_KEY = "office3d.hermesUpdate.dismissedJob";

const readDismissed = () => {
  try {
    return window.localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
};

const stepLabel = (step: string) => {
  switch (step) {
    case "pull":
      return t("hermesUpdate.stepPull");
    case "stop":
      return t("hermesUpdate.stepStop");
    case "backup":
      return t("hermesUpdate.stepBackup");
    case "start":
      return t("hermesUpdate.stepStart");
    case "check":
      return t("hermesUpdate.stepCheck");
    case "rollback":
      return t("hermesUpdate.stepRollback");
    case "check-rollback":
      return t("hermesUpdate.stepCheckRollback");
    default:
      return t("hermesUpdate.stepQueued");
  }
};

/**
 * A newer Hermes: "Обновить" or "Позже" (a day). While it updates, each step;
 * then how it ended — updated, or rolled back to the version that worked.
 */
export function HermesUpdateCard() {
  const control = useHermesControl();
  const [view, setView] = useState<HermesUpdateView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissedJob, setDismissedJob] = useState<string | null>(() => (typeof window === "undefined" ? null : readDismissed()));

  // An event is newer than any answer to the first request still on its way.
  const eventSeenRef = useRef(false);

  const load = useCallback(async () => {
    if (!control) return;
    try {
      const status = await control.call<HermesUpdateView>("hermes.update.status");
      if (!eventSeenRef.current) setView(status);
    } catch {
      // Adapters without updates: nothing to show.
    }
  }, [control]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!control) return;
    return control.onEvent((frame) => {
      if (frame.event === "hermes.update" && frame.payload && typeof frame.payload === "object") {
        eventSeenRef.current = true;
        setView(frame.payload as HermesUpdateView);
      }
    });
  }, [control]);

  if (!control || !view?.available || !view.reachable) return null;
  const job = view.job ?? null;
  const finishedJob = job && job.status !== "running" && job.id !== dismissedJob ? job : null;
  if (!view.offer && !view.running && !finishedJob) return null;

  const act = async (method: string, params: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      setView(await control.call<HermesUpdateView>(method, params));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const dismiss = (id: string) => {
    setDismissedJob(id);
    try {
      window.localStorage.setItem(DISMISSED_KEY, id);
    } catch {
      // The card just comes back after a reload.
    }
  };

  // HQ palette: failure is the error red, a rollback the one orange warning,
  // everything else the resting red edge. The shadow lives here too, so only
  // one shadow utility ever reaches the card.
  const tone =
    finishedJob?.status === "rollback_failed" || finishedJob?.status === "failed"
      ? "border-red-500/60 shadow-[0_0_24px_rgba(255,26,26,0.25)]"
      : finishedJob?.status === "rolled_back"
        ? "border-orange-400/40 shadow-2xl"
        : "border-red-600/35 shadow-2xl";

  return (
    <div className="pointer-events-none fixed right-3 top-[160px] z-40 w-[360px] max-w-[calc(100vw-1.5rem)]" data-testid="hermes-update">
      <section className={`pointer-events-auto rounded-lg border ${tone} bg-black/85 px-4 py-3 backdrop-blur`}>
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-red-400">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full bg-red-500 shadow-[0_0_8px_rgba(255,26,26,0.9)] ${view.running ? "animate-pulse" : ""}`}
            aria-hidden="true"
          />
          {t("hermesUpdate.title")}
        </div>
        {view.running && job ? (
          <div className="mt-1 text-sm text-white">
            {t("hermesUpdate.running", { to: job.to })}
            <div className="mt-1 font-mono text-[11px] text-red-300">{stepLabel(job.step)}</div>
          </div>
        ) : finishedJob ? (
          <div className="mt-1 text-sm text-white">
            {finishedJob.status === "done"
              ? t("hermesUpdate.done", { to: finishedJob.to })
              : finishedJob.status === "rolled_back"
                ? t("hermesUpdate.rolledBack", { to: finishedJob.to, from: finishedJob.from })
                : finishedJob.status === "rollback_failed"
                  ? t("hermesUpdate.rollbackFailed", { error: finishedJob.error ?? "" })
                  : t("hermesUpdate.failed", { error: finishedJob.error ?? "", from: finishedJob.from })}
            <div className="mt-2 flex justify-end">
              <button type="button" className="ui-btn-secondary px-3 py-1.5 text-xs" onClick={() => dismiss(finishedJob.id)}>
                {t("hermesUpdate.ok")}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-1 text-sm text-white">
            {t("hermesUpdate.offer", { latest: view.latest ?? "", current: view.current ?? "" })}
            <div className="mt-1 text-[11px] text-white/55">{t("hermesUpdate.offerNote")}</div>
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                className="ui-btn-secondary px-3 py-1.5 text-xs"
                disabled={busy}
                onClick={() => void act("hermes.update.later", { tag: view.latest })}
              >
                {t("hermesUpdate.later")}
              </button>
              <button
                type="button"
                className="ui-btn-primary px-3 py-1.5 text-xs font-semibold"
                disabled={busy}
                onClick={() => void act("hermes.update.start", { tag: view.latest })}
              >
                {t("hermesUpdate.update")}
              </button>
            </div>
          </div>
        )}
        {error ? (
          <div className="mt-2 rounded-md border border-red-500/50 bg-red-950/40 px-2 py-1 text-[11px] text-red-400">{error}</div>
        ) : null}
      </section>
    </div>
  );
}
