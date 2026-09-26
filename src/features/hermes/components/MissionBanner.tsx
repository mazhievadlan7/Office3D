"use client";

import { useCallback, useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { useHermesControl } from "@/features/hermes/HermesControlContext";

type OrgState = { mission: string; missionUpdatedAt: string | null };

// The HQ look (black / red / white) shared with the task board around it.
const BUTTON_BASE =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50 disabled:cursor-not-allowed disabled:opacity-50";
const BUTTON_PRIMARY = `${BUTTON_BASE} border-red-500/60 bg-[#e3141c] text-white shadow-[0_0_14px_rgba(255,26,26,0.25)] hover:bg-[#ff2a2a] disabled:hover:bg-[#e3141c]`;
const BUTTON_SECONDARY = `${BUTTON_BASE} border-red-600/35 bg-black/50 text-white/85 hover:border-red-500/50 hover:bg-red-950/40 hover:text-white`;
const TITLE =
  "flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/85 before:h-2.5 before:w-0.5 before:shrink-0 before:rounded-full before:bg-[#e3141c] before:content-['']";

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
    <div
      className="mt-3 rounded-md border border-red-600/35 border-l-2 border-l-[#e3141c] bg-[#0b0707] px-3 py-2.5 shadow-[inset_0_0_24px_rgba(255,26,26,0.05)]"
      data-testid="mission-banner"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className={TITLE}>{t("mission.title")}</div>
          {editing ? (
            <textarea
              aria-label={t("mission.title")}
              className="mt-2 min-h-[72px] w-full resize-y rounded-md border border-red-900/50 bg-black/60 px-2.5 py-2 text-[13px] leading-5 text-white outline-none scheme-dark transition-colors placeholder:text-white/35 focus:border-red-500/70 focus:ring-2 focus:ring-red-500/30"
              value={draft}
              maxLength={8000}
              placeholder={t("mission.placeholder")}
              onChange={(event) => setDraft(event.target.value)}
            />
          ) : (
            <div className="mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-5 text-white">
              {org?.mission?.trim() ? org.mission : <span className="text-white/50">{t("mission.empty")}</span>}
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
                className={BUTTON_PRIMARY}
              >
                {t("settings.save")}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditing(false)}
                className={BUTTON_SECONDARY}
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
              className={BUTTON_SECONDARY}
            >
              {t("mission.edit")}
            </button>
          )}
        </div>
      </div>
      {message ? <div className="mt-1.5 font-mono text-[10px] leading-4 text-white/65">{message}</div> : null}
    </div>
  );
}
