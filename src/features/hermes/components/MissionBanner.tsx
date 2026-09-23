"use client";

import { useCallback, useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { useHermesControl } from "@/features/hermes/HermesControlContext";

type OrgState = { mission: string; missionUpdatedAt: string | null };

/**
 * The organization's main mission, pinned above the task board. Every agent
 * works toward it: saving rewrites the mission block in each agent's SOUL.md,
 * which Hermes loads into all of that agent's work.
 */
export function MissionBanner() {
  const control = useHermesControl();
  const [org, setOrg] = useState<OrgState | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!control) return;
    try {
      setOrg(await control.call<OrgState>("org.get"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [control]);

  useEffect(() => {
    void load();
  }, [load]);

  // Another tab (or window) changed the mission.
  useEffect(() => {
    if (!control) return;
    return control.onEvent((frame) => {
      if (frame.event !== "org.updated") return;
      const payload = frame.payload as Partial<OrgState> | undefined;
      if (typeof payload?.mission === "string") {
        setOrg({ mission: payload.mission, missionUpdatedAt: payload.missionUpdatedAt ?? null });
      }
    });
  }, [control]);

  if (!control) return null;

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await control.call<OrgState & { ok: boolean; failed: Array<{ profile: string }> }>("org.setMission", {
        text: draft,
      });
      setOrg({ mission: result.mission, missionUpdatedAt: result.missionUpdatedAt });
      setEditing(false);
      setMessage(
        result.ok ? t("mission.saved") : t("mission.savedPartly", { agents: result.failed.map((f) => f.profile).join(", ") }),
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2" data-testid="mission-banner">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-amber-200/80">{t("mission.title")}</div>
          {editing ? (
            <textarea
              aria-label={t("mission.title")}
              className="mt-2 min-h-[72px] w-full rounded border border-amber-400/25 bg-black/30 px-2 py-1.5 text-[12px] text-white outline-none focus:border-amber-300/50"
              value={draft}
              maxLength={8000}
              placeholder={t("mission.placeholder")}
              onChange={(event) => setDraft(event.target.value)}
            />
          ) : (
            <div className="mt-1 whitespace-pre-wrap text-[12px] leading-snug text-white/90">
              {org?.mission?.trim() ? org.mission : <span className="text-white/45">{t("mission.empty")}</span>}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {editing ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void save()}
                className="rounded border border-amber-400/40 bg-amber-400/15 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-50 disabled:opacity-50"
              >
                {t("settings.save")}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditing(false)}
                className="rounded border border-white/10 bg-white/5 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-white/70"
              >
                {t("hermesModels.cancel")}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                setDraft(org?.mission ?? "");
                setEditing(true);
                setMessage(null);
              }}
              className="rounded border border-amber-400/30 bg-amber-400/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-100"
            >
              {t("mission.edit")}
            </button>
          )}
        </div>
      </div>
      {message ? <div className="mt-1 text-[10px] text-white/60">{message}</div> : null}
    </div>
  );
}
