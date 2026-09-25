"use client";

import { useCallback, useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import type { HermesControl } from "@/features/hermes/HermesControlContext";

type CheckRow = {
  id: string;
  label: string;
  status: "ok" | "checking" | "problem" | "unknown";
  detail: string;
  since: string | null;
};

type Health = {
  checkedAt: string | null;
  ok: boolean;
  checks: CheckRow[];
  channels: string[];
  heartbeat: boolean;
  configProblems: string[];
};

const dot: Record<CheckRow["status"], string> = {
  ok: "bg-white/85",
  checking: "animate-pulse bg-red-300/70",
  problem: "bg-red-500",
  unknown: "bg-white/30",
};

const statusText = (status: CheckRow["status"]) =>
  status === "ok"
    ? t("systemHealth.status.ok")
    : status === "checking"
      ? t("systemHealth.status.checking")
      : status === "problem"
        ? t("systemHealth.status.problem")
        : t("systemHealth.status.unknown");

/**
 * How the deployment is doing (Hermes, backups, disk, updates) and where
 * alerts go. The server checks every minute; this shows its latest verdict.
 */
export function SystemHealthSection({ control }: { control: HermesControl }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(
    async (refresh = false) => {
      try {
        setHealth(await control.call<Health>("system.health", refresh ? { refresh: true } : {}));
      } catch (error) {
        setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      }
    },
    [control],
  );

  useEffect(() => {
    void load();
    return control.onEvent((frame) => {
      if (frame.event === "system.health" && frame.payload && typeof frame.payload === "object") setHealth(frame.payload as Health);
    });
  }, [control, load]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const test = () =>
    run(async () => {
      const result = await control.call<{ sent: string[]; failed: Array<{ channel: string; error: string }>; channels: string[] }>("system.testAlert");
      if (result.channels.length === 0) setMessage({ kind: "error", text: t("systemHealth.noChannels") });
      else if (result.failed.length) setMessage({ kind: "error", text: t("systemHealth.testFailed", { failed: result.failed.map((f) => `${f.channel}: ${f.error}`).join("; ") }) });
      else setMessage({ kind: "ok", text: t("systemHealth.testSent", { channels: result.sent.join(", ") }) });
    });

  return (
    <div className="mt-3 rounded-lg border border-red-500/10 bg-black/20 px-4 py-3" data-testid="system-health">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-medium text-white">{t("systemHealth.title")}</div>
          <div className="mt-1 text-[10px] text-white/75">{t("systemHealth.lead")}</div>
        </div>
        <button type="button" className="ui-btn-secondary shrink-0 px-2 py-1 text-[10px]" disabled={busy} onClick={() => void run(() => load(true))}>
          {t("systemHealth.refresh")}
        </button>
      </div>
      <div className="mt-3 space-y-1.5">
        {health === null ? <div className="text-[11px] text-white/50">{t("systemHealth.loading")}</div> : null}
        {health?.checks.map((check) => (
          <div key={check.id} className="flex items-start gap-2 text-[11px]" data-testid={`system-health-${check.id}`}>
            <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${dot[check.status]}`} aria-hidden />
            <span className="min-w-0">
              <span className="text-white/90">{check.label}</span>
              <span className="ml-2 text-white/50">{statusText(check.status)}</span>
              {check.detail ? <span className="block truncate text-white/55">{check.detail}</span> : null}
            </span>
          </div>
        ))}
      </div>
      {health ? (
        <div className="mt-3 text-[10px] text-white/60">
          {health.channels.length ? t("systemHealth.channels", { channels: health.channels.join(", ") }) : t("systemHealth.noChannels")}
          {" "}
          {health.heartbeat ? t("systemHealth.heartbeatOn") : t("systemHealth.heartbeatOff")}
        </div>
      ) : null}
      {health?.configProblems.length ? <div className="mt-1 text-[10px] text-red-200">{health.configProblems.join(" ")}</div> : null}
      <div className="mt-2 flex justify-end">
        <button type="button" className="ui-btn-secondary px-2 py-1 text-[10px]" disabled={busy} onClick={() => void test()}>
          {t("systemHealth.test")}
        </button>
      </div>
      {message ? <div className={`mt-2 text-[11px] ${message.kind === "error" ? "text-red-200" : "text-white/70"}`}>{message.text}</div> : null}
    </div>
  );
}
