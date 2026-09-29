"use client";

import type { ReactNode } from "react";
import { Crosshair, Crown, Globe, Maximize2, MessageSquare, Radar, Settings, Volume2, VolumeX } from "lucide-react";

import { t } from "@/lib/i18n";
import { adapterLabel, gatewayStatusLabel } from "@/lib/i18n/labels";
import type { HqCameraMode } from "../render/scene/HqCameraRig";
import type { HqCameraPreset } from "../render/scene/cameraMath";
import { HQ_HUD_GLASS, hqHudButtonClass } from "./hudStyle";

export type HqHudCounts = {
  total: number;
  working: number;
  idle: number;
  error: number;
  free: number;
};

// The HUD's text is white on dark red-edged glass, so it reads at a glance.
function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex min-w-[62px] flex-col items-center px-2.5">
      <span className="font-mono text-[16px] font-semibold tabular-nums leading-none text-white">{value}</span>
      <span className="mt-1 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-white">{label}</span>
    </div>
  );
}

function BarButton({
  active = false,
  disabled = false,
  title,
  label,
  onClick,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  title?: string;
  /** Accessible name when the visible text collapses to an icon on narrow screens. */
  label?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title ?? label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-9 items-center gap-1.5 px-2.5 font-mono text-[12px] tracking-wide ${hqHudButtonClass(active)}`}
    >
      {children}
    </button>
  );
}

const Divider = () => <div className="mx-1 hidden h-6 w-px bg-white/10 sm:block" />;

/** Which backend the office talks to and whether it is connected. */
export type HqRuntimeStatus = {
  adapter: string;
  status: string;
};

/**
 * The runtime chip and the office settings button. Part of the bottom bar, and
 * shown on their own when the scene cannot start, so the connection and
 * settings stay reachable without WebGL.
 */
export function HqSettingsControls({
  runtime,
  settingsOpen = false,
  onOpenSettings,
}: {
  runtime?: HqRuntimeStatus | null;
  settingsOpen?: boolean;
  onOpenSettings?: () => void;
}) {
  if (!runtime && !onOpenSettings) return null;
  const runtimeTitle = runtime
    ? t("office.runtimeTitle", { adapter: adapterLabel(runtime.adapter), status: gatewayStatusLabel(runtime.status) })
    : "";
  return (
    <>
      {runtime ? (
        <div
          role="status"
          title={runtimeTitle}
          aria-label={runtimeTitle}
          className={`flex h-9 items-center gap-1.5 rounded-md border px-2.5 font-mono text-[11px] uppercase tracking-[0.12em] text-white ${
            runtime.status === "connected" ? "border-red-500/45 bg-red-600/15" : "border-red-900/40 bg-black/40"
          }`}
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${
              runtime.status === "connected"
                ? "bg-red-400 shadow-[0_0_8px_rgba(255,42,42,0.8)]"
                : runtime.status === "connecting"
                  ? "animate-pulse bg-red-300/70"
                  : "bg-white/25"
            }`}
          />
          <span>{gatewayStatusLabel(runtime.status)}</span>
        </div>
      ) : null}
      {onOpenSettings ? (
        <BarButton active={settingsOpen} label={t("office.voiceSettings")} onClick={onOpenSettings}>
          <Settings className="h-4 w-4" />
        </BarButton>
      ) : null}
    </>
  );
}

/**
 * The HQ overlay: title and live counters on top, the camera controls along
 * the bottom. The local clock and the HQ navigation sit in the right column
 * (HQSidebar), the event console top left and the chat button bottom right;
 * all of them share HQ_HUD_GLASS. The scene always renders at its highest
 * quality, so there is no quality switch.
 */
export function HqHud({
  counts,
  cameraMode,
  canFollow,
  onCameraPreset,
  onMessageLead,
  onOpenCombat,
  soundOn,
  onToggleSound,
  runtime,
  settingsOpen,
  onOpenSettings,
}: {
  counts: HqHudCounts;
  /** The HQ's own sounds (keyboards, talk): on or off; the button is hidden without the toggle. */
  soundOn?: boolean;
  onToggleSound?: () => void;
  cameraMode: HqCameraMode;
  canFollow: boolean;
  onCameraPreset: (preset: HqCameraPreset) => void;
  /** Opens the chat with the lead agent (AM7); hidden when there is none. */
  onMessageLead?: () => void;
  /** Opens the combat console (the dense operations screen); hidden without it. */
  onOpenCombat?: () => void;
  /** The connected backend, shown as a chip next to the settings button. */
  runtime?: HqRuntimeStatus | null;
  settingsOpen?: boolean;
  /** Toggles the office settings; the button is hidden without it. */
  onOpenSettings?: () => void;
}) {
  return (
    <>
      <div className="pointer-events-none absolute left-1/2 top-3 z-10 flex -translate-x-1/2 flex-col items-center gap-2 select-none">
        <div className="flex items-center gap-3">
          <div className="h-px w-14 bg-gradient-to-r from-transparent to-red-500/60" />
          <span className="text-sm font-bold uppercase tracking-[0.34em] text-white [text-shadow:0_0_14px_rgba(255,26,26,0.55)]">
            {t("hqScene.title")}
          </span>
          <div className="h-px w-14 bg-gradient-to-l from-transparent to-red-500/60" />
        </div>
        <div
          role="status"
          aria-label={t("hqScene.countersLabel")}
          className={`flex items-center divide-x divide-red-900/40 py-1.5 ${HQ_HUD_GLASS}`}
        >
          <Counter label={t("hqScene.countAgents")} value={counts.total} />
          <Counter label={t("hqScene.countWorking")} value={counts.working} />
          <Counter label={t("hqScene.countIdle")} value={counts.idle} />
          <Counter label={t("hqScene.countError")} value={counts.error} />
          <Counter label={t("hqScene.countFree")} value={counts.free} />
        </div>
      </div>

      {/* Centred under the counters from lg up; the padding keeps it clear of
          the chat button in the bottom-right corner (up to ~150px wide). */}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3 md:pr-[164px] lg:pl-[164px]">
        <div className={`pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1.5 p-1.5 ${HQ_HUD_GLASS}`}>
          <span className="hidden px-1 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-white xl:inline">
            {t("hqScene.cameraLabel")}
          </span>
          <BarButton
            active={cameraMode === "overview"}
            label={t("hqScene.cameraOverview")}
            onClick={() => onCameraPreset("overview")}
          >
            <Maximize2 className="h-4 w-4" />
            <span className="hidden xl:inline">{t("hqScene.cameraOverview")}</span>
          </BarButton>
          <BarButton active={cameraMode === "am7"} label={t("hqScene.cameraAm7")} onClick={() => onCameraPreset("am7")}>
            <Crown className="h-4 w-4" />
            <span className="hidden xl:inline">{t("hqScene.cameraAm7")}</span>
          </BarButton>
          <BarButton active={cameraMode === "map"} label={t("hqScene.cameraMap")} onClick={() => onCameraPreset("map")}>
            <Globe className="h-4 w-4" />
            <span className="hidden xl:inline">{t("hqScene.cameraMap")}</span>
          </BarButton>
          <BarButton
            active={cameraMode === "follow"}
            label={t("hqScene.cameraFollow")}
            disabled={!canFollow && cameraMode !== "follow"}
            title={
              cameraMode === "follow"
                ? t("hqScene.cameraStopFollow")
                : canFollow
                  ? undefined
                  : t("hqScene.cameraFollowHint")
            }
            onClick={() => onCameraPreset("follow")}
          >
            <Crosshair className="h-4 w-4" />
            <span className="hidden xl:inline">{t("hqScene.cameraFollow")}</span>
          </BarButton>

          <Divider />
          {onOpenCombat ? (
            <BarButton label={t("hqScene.combat")} title={t("hqScene.combatTitle")} onClick={onOpenCombat}>
              <Radar className="h-4 w-4" />
              <span className="hidden xl:inline">{t("hqScene.combat")}</span>
            </BarButton>
          ) : null}
          {onMessageLead ? (
            <BarButton label={t("hqScene.messageLead")} title={t("hqScene.messageLeadTitle")} onClick={onMessageLead}>
              <MessageSquare className="h-4 w-4" />
              <span className="hidden xl:inline">{t("hqScene.messageLead")}</span>
            </BarButton>
          ) : null}
          {onToggleSound ? (
            <BarButton
              active={Boolean(soundOn)}
              label={t("hqScene.sound")}
              title={soundOn ? t("hqScene.soundOnTitle") : t("hqScene.soundOffTitle")}
              onClick={onToggleSound}
            >
              {soundOn ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
              <span className="hidden xl:inline">{t("hqScene.sound")}</span>
            </BarButton>
          ) : null}
          {runtime || onOpenSettings ? (
            <>
              <Divider />
              <HqSettingsControls runtime={runtime} settingsOpen={settingsOpen} onOpenSettings={onOpenSettings} />
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
