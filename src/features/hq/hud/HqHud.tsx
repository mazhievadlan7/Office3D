"use client";

import type { ReactNode } from "react";
import { Crosshair, Crown, Globe, Maximize2, MessageSquare, Settings } from "lucide-react";

import { t } from "@/lib/i18n";
import { adapterLabel, gatewayStatusLabel } from "@/lib/i18n/labels";
import type { HqCameraMode } from "../render/scene/HqCameraRig";
import type { HqCameraPreset } from "../render/scene/cameraMath";
import { HqClock } from "./HqClock";

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
      className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 font-mono text-[11px] tracking-wide text-white transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
        active
          ? "border-red-500/60 bg-red-600/20 shadow-[0_0_14px_rgba(255,26,26,0.25)]"
          : "border-red-900/40 bg-black/40 hover:border-red-500/50 hover:bg-red-950/40"
      }`}
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
          className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 font-mono text-[10px] uppercase tracking-[0.12em] text-white ${
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
          <Settings className="h-3.5 w-3.5" />
        </BarButton>
      ) : null}
    </>
  );
}

/**
 * The HQ overlay: title and live counters on top, the local clock top right,
 * the camera controls along the bottom. Dark glass with red accents and white
 * text, in the same monospace voice as the rest of the office HUD. The scene
 * always renders at its highest quality, so there is no quality switch.
 */
export function HqHud({
  counts,
  cameraMode,
  canFollow,
  onCameraPreset,
  onMessageLead,
  runtime,
  settingsOpen,
  onOpenSettings,
}: {
  counts: HqHudCounts;
  cameraMode: HqCameraMode;
  canFollow: boolean;
  onCameraPreset: (preset: HqCameraPreset) => void;
  /** Opens the chat with the lead agent (AM7); hidden when there is none. */
  onMessageLead?: () => void;
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
          className="flex items-center divide-x divide-red-900/40 rounded-lg border border-red-900/50 bg-black/65 py-1.5 shadow-lg backdrop-blur-sm"
        >
          <Counter label={t("hqScene.countAgents")} value={counts.total} />
          <Counter label={t("hqScene.countWorking")} value={counts.working} />
          <Counter label={t("hqScene.countIdle")} value={counts.idle} />
          <Counter label={t("hqScene.countError")} value={counts.error} />
          <Counter label={t("hqScene.countFree")} value={counts.free} />
        </div>
      </div>

      {/* Top right, clear of the sidebar tabs along the right edge. */}
      <div className="absolute right-12 top-3 z-10">
        <HqClock />
      </div>

      {/* Clear of the chat button (bottom-right); the event console sits top-left in the HQ. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex flex-col items-center gap-1.5 px-3 md:right-[110px]">
        <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1.5 rounded-xl border border-red-900/40 bg-black/70 px-2 py-1.5 shadow-2xl backdrop-blur-sm">
          <span className="hidden px-1 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-white xl:inline">
            {t("hqScene.cameraLabel")}
          </span>
          <BarButton
            active={cameraMode === "overview"}
            label={t("hqScene.cameraOverview")}
            onClick={() => onCameraPreset("overview")}
          >
            <Maximize2 className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">{t("hqScene.cameraOverview")}</span>
          </BarButton>
          <BarButton active={cameraMode === "am7"} label={t("hqScene.cameraAm7")} onClick={() => onCameraPreset("am7")}>
            <Crown className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">{t("hqScene.cameraAm7")}</span>
          </BarButton>
          <BarButton active={cameraMode === "map"} label={t("hqScene.cameraMap")} onClick={() => onCameraPreset("map")}>
            <Globe className="h-3.5 w-3.5" />
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
            <Crosshair className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">{t("hqScene.cameraFollow")}</span>
          </BarButton>


          <Divider />
          {onMessageLead ? (
            <BarButton label={t("hqScene.messageLead")} title={t("hqScene.messageLeadTitle")} onClick={onMessageLead}>
              <MessageSquare className="h-3.5 w-3.5" />
              <span className="hidden xl:inline">{t("hqScene.messageLead")}</span>
            </BarButton>
          ) : null}
          {runtime || onOpenSettings ? (
            <>
              <Divider />
              <HqSettingsControls runtime={runtime} settingsOpen={settingsOpen} onOpenSettings={onOpenSettings} />
            </>
          ) : null}
        </div>
        <p className="hidden select-none font-mono text-[10px] tracking-wide text-white xl:block">
          {t("hqScene.controlsHint")}
        </p>
      </div>
    </>
  );
}
