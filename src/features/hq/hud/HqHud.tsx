"use client";

import type { ReactNode } from "react";
import { Crosshair, Crown, Gauge, Globe, Maximize2, MessageSquare } from "lucide-react";

import { t } from "@/lib/i18n";
import type { HqQualityMode } from "../render/scene/HqAdaptiveQuality";
import type { HqCameraMode } from "../render/scene/HqCameraRig";
import type { HqCameraPreset } from "../render/scene/cameraMath";
import type { HqQuality } from "../render/scene/quality";

export type HqHudCounts = {
  total: number;
  working: number;
  idle: number;
  error: number;
  free: number;
};

const QUALITY_LABEL: Record<HqQuality, () => string> = {
  high: () => t("hqScene.qualityHigh"),
  medium: () => t("hqScene.qualityMedium"),
  low: () => t("hqScene.qualityLow"),
};

function Counter({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex min-w-[58px] flex-col items-center px-2.5">
      <span className={`font-mono text-[15px] font-semibold tabular-nums leading-none ${tone}`}>{value}</span>
      <span className="mt-1 font-mono text-[9px] uppercase tracking-[0.16em] text-red-400/80">{label}</span>
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
      className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 font-mono text-[11px] tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
        active
          ? "border-red-500/60 bg-red-600/20 text-red-100 shadow-[0_0_14px_rgba(255,26,26,0.25)]"
          : "border-red-900/40 bg-black/40 text-red-200/80 hover:border-red-500/50 hover:text-red-100"
      }`}
    >
      {children}
    </button>
  );
}

const Divider = () => <div className="mx-1 hidden h-6 w-px bg-white/10 sm:block" />;

/**
 * The HQ overlay: title and live counters on top, the camera, capacity and
 * quality controls along the bottom. Dark glass with red accents, in the
 * same monospace voice as the rest of the office HUD.
 */
export function HqHud({
  counts,
  cameraMode,
  canFollow,
  onCameraPreset,
  qualityMode,
  quality,
  onQualityCycle,
  onMessageLead,
}: {
  counts: HqHudCounts;
  cameraMode: HqCameraMode;
  canFollow: boolean;
  onCameraPreset: (preset: HqCameraPreset) => void;
  qualityMode: HqQualityMode;
  quality: HqQuality;
  onQualityCycle: () => void;
  /** Opens the chat with the lead agent (AM7); hidden when there is none. */
  onMessageLead?: () => void;
}) {
  const qualityText =
    qualityMode === "auto"
      ? t("hqScene.qualityAuto", { level: QUALITY_LABEL[quality]() })
      : QUALITY_LABEL[qualityMode]();

  return (
    <>
      <div className="pointer-events-none absolute left-1/2 top-3 z-10 flex -translate-x-1/2 flex-col items-center gap-2 select-none">
        <div className="flex items-center gap-3">
          <div className="h-px w-14 bg-gradient-to-r from-transparent to-red-500/60" />
          <span className="text-sm font-bold uppercase tracking-[0.34em] text-red-100/90 [text-shadow:0_0_14px_rgba(255,26,26,0.55)]">
            {t("hqScene.title")}
          </span>
          <div className="h-px w-14 bg-gradient-to-l from-transparent to-red-500/60" />
        </div>
        <div
          role="status"
          aria-label={t("hqScene.countersLabel")}
          className="flex items-center divide-x divide-red-900/40 rounded-lg border border-red-900/50 bg-black/65 py-1.5 shadow-lg backdrop-blur-sm"
        >
          <Counter label={t("hqScene.countAgents")} value={counts.total} tone="text-white" />
          <Counter label={t("hqScene.countWorking")} value={counts.working} tone="text-red-400" />
          <Counter label={t("hqScene.countIdle")} value={counts.idle} tone="text-white" />
          <Counter label={t("hqScene.countError")} value={counts.error} tone="text-red-400" />
          <Counter label={t("hqScene.countFree")} value={counts.free} tone="text-white" />
        </div>
      </div>

      {/* Clear of the chat button (bottom-right); the event console sits top-left in the HQ. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex flex-col items-center gap-1.5 px-3 md:right-[110px]">
        <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1.5 rounded-xl border border-red-900/40 bg-black/70 px-2 py-1.5 shadow-2xl backdrop-blur-sm">
          <span className="hidden px-1 font-mono text-[9px] uppercase tracking-[0.16em] text-red-400/60 xl:inline">
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
          <BarButton title={t("hqScene.qualityTitle")} onClick={onQualityCycle}>
            <Gauge className="h-3.5 w-3.5" />
            <span className="hidden text-red-300/60 xl:inline">{t("hqScene.quality")}</span>
            <span>{qualityText}</span>
          </BarButton>
          {onMessageLead ? (
            <BarButton label={t("hqScene.messageLead")} title={t("hqScene.messageLeadTitle")} onClick={onMessageLead}>
              <MessageSquare className="h-3.5 w-3.5" />
              <span className="hidden xl:inline">{t("hqScene.messageLead")}</span>
            </BarButton>
          ) : null}
        </div>
        <p className="hidden select-none font-mono text-[10px] tracking-wide text-red-300/45 xl:block">
          {t("hqScene.controlsHint")}
        </p>
      </div>
    </>
  );
}
