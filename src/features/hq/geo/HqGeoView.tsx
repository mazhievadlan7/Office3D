"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { t } from "@/lib/i18n";
import { HQ_HUD_GLASS, hqHudButtonClass } from "@/features/hq/hud/hudStyle";
import * as CesiumNS from "cesium";
import {
  DEFAULT_BASEMAP,
  GEO_ATTRIBUTION,
  REALISM_MODE,
  basemapById,
  createLabelsImageryLayer,
  enablePhotoreal,
  skinViewer,
  type RealismHandle,
} from "./cesiumConfig";
import { geoController } from "./geoController";
import { seedDemoGeo } from "./geoData";
import { GEO_ARC_STYLE, GEO_KIND_STYLE } from "./geoStyle";
import type { GeoArc, GeoSceneData } from "./geoTypes";
import {
  GEO_CAMERA_PROPERTY,
  LIVE_LAYERS,
  layerAvailable,
  startLiveLayer,
  type GeoCameraInfo,
  type LiveLayerHandle,
  type LiveLayerId,
} from "./liveLayers";
import { createTracker, type TrackHandle, type TrackedInfo } from "./tracking";

// Cesium's CSS (vendored to public/cesium) laid out via a <link>, so we never
// hit Next's global-CSS import rules from a client component.
const CESIUM_CSS_HREF = "/cesium/Widgets/widgets.css";
const CESIUM_CSS_ID = "hq-cesium-widgets-css";

function ensureCesiumCss(): void {
  if (typeof document === "undefined" || document.getElementById(CESIUM_CSS_ID)) return;
  const link = document.createElement("link");
  link.id = CESIUM_CSS_ID;
  link.rel = "stylesheet";
  link.href = CESIUM_CSS_HREF;
  document.head.appendChild(link);
}

/** Great-circle positions between two points, bowed up into a premium arc. */
function arcPositions(arc: GeoArc): CesiumNS.Cartesian3[] {
  const start = CesiumNS.Cartographic.fromDegrees(arc.from.lon, arc.from.lat);
  const end = CesiumNS.Cartographic.fromDegrees(arc.to.lon, arc.to.lat);
  const geodesic = new CesiumNS.EllipsoidGeodesic(start, end);
  const steps = 64;
  const peak = Math.min(1.5e6, Math.max(2e5, geodesic.surfaceDistance * 0.18));
  const out: CesiumNS.Cartesian3[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const f = i / steps;
    const point = geodesic.interpolateUsingFraction(f);
    const height = peak * Math.sin(Math.PI * f);
    out.push(CesiumNS.Cartesian3.fromRadians(point.longitude, point.latitude, height));
  }
  return out;
}

/** Rebuilds our pins and arcs into a data source from a scene snapshot. */
function paintScene(source: CesiumNS.CustomDataSource, scene: GeoSceneData): void {
  source.entities.removeAll();
  for (const arc of scene.arcs) {
    source.entities.add({
      polyline: {
        positions: arcPositions(arc),
        width: 2.2,
        material: new CesiumNS.PolylineGlowMaterialProperty({
          glowPower: 0.22,
          taperPower: 0.5,
          color: CesiumNS.Color.fromCssColorString(GEO_ARC_STYLE[arc.kind].color).withAlpha(0.9),
        }),
        arcType: CesiumNS.ArcType.NONE,
      },
    });
  }
  for (const target of scene.targets) {
    const style = GEO_KIND_STYLE[target.kind];
    const isHq = target.kind === "hq";
    source.entities.add({
      id: `tgt:${target.id}`,
      position: CesiumNS.Cartesian3.fromDegrees(target.lon, target.lat),
      point: {
        pixelSize: isHq ? 13 : 9,
        color: CesiumNS.Color.fromCssColorString(style.color),
        outlineColor: CesiumNS.Color.fromCssColorString("#06080c").withAlpha(0.85),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: target.label,
        font: '600 13px "Segoe UI", sans-serif',
        fillColor: CesiumNS.Color.WHITE,
        showBackground: true,
        backgroundColor: CesiumNS.Color.fromCssColorString("#06080c").withAlpha(0.72),
        backgroundPadding: new CesiumNS.Cartesian2(7, 4),
        pixelOffset: new CesiumNS.Cartesian2(0, -16),
        verticalOrigin: CesiumNS.VerticalOrigin.BOTTOM,
        scale: 0.9,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        translucencyByDistance: new CesiumNS.NearFarScalar(1.5e6, 1.0, 4.0e7, 0.25),
      },
    });
  }
}

export type HqGeoViewProps = {
  onClose: () => void;
};

/**
 * The full-screen «ГЕО» globe: a clean CesiumJS view skinned in the HQ's dark red
 * palette. Keyless and local-first — the default basemap is Cesium's bundled
 * offline Natural Earth and it plots only our own authorized-target pins and the
 * arcs between them. Online basemaps and live public-data layers are offered as
 * clearly-optional, egress-gated choices, off by default.
 *
 * The viewer is built once on mount and destroyed on unmount, so Cesium runs
 * only while the view is open (the hall's R3F render is paused by HqOffice
 * meanwhile). requestRenderMode keeps it still when nothing moves.
 */
export function HqGeoView({ onClose }: HqGeoViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const creditRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<CesiumNS.Viewer | null>(null);
  const sourceRef = useRef<CesiumNS.CustomDataSource | null>(null);
  const liveHandlesRef = useRef<Partial<Record<LiveLayerId, LiveLayerHandle>>>({});
  const realismHandleRef = useRef<RealismHandle | null>(null);
  const sensorStageRef = useRef<CesiumNS.PostProcessStage | null>(null);

  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [activeLive, setActiveLive] = useState<LiveLayerId[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // Realism tier is managed by the realismHandleRef; the flags below just track
  // "is anything mounted / are we currently loading" for internal use.
  const [, setRealismOn] = useState(false);
  const [, setRealismBusy] = useState(false);
  const [camera, setCamera] = useState<GeoCameraInfo | null>(null);
  const [tracked, setTracked] = useState<TrackedInfo | null>(null);
  const trackerRef = useRef<TrackHandle | null>(null);
  const [cockpitOn, setCockpitOn] = useState(false);

  // Build the viewer once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    ensureCesiumCss();
    let viewer: CesiumNS.Viewer | null = null;
    try {
      viewer = new CesiumNS.Viewer(container, {
        baseLayer: CesiumNS.ImageryLayer.fromProviderAsync(
          Promise.resolve(basemapById(DEFAULT_BASEMAP).create()),
          {},
        ),
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        animation: false,
        timeline: false,
        fullscreenButton: false,
        selectionIndicator: false,
        infoBox: false,
        vrButton: false,
        shouldAnimate: false,
        creditContainer: creditRef.current ?? undefined,
        contextOptions: { webgl: { alpha: false, powerPreference: "high-performance" } },
      });
    } catch (error) {
      console.error("[hq-geo] CesiumJS could not start.", error);
      // Deferred so the effect does not call setState synchronously in its body.
      queueMicrotask(() => setFailed(true));
      return;
    }
    viewerRef.current = viewer;
    skinViewer(viewer);

    // Country / major-city labels overlay — keyless, serves as geographic context
    // over any imagery basemap. Reads as "real map with place names" at any zoom.
    createLabelsImageryLayer(viewer);

    // Nicer close-zoom look: dynamic water animation and sharper tile detail.
    viewer.scene.globe.showWaterEffect = true;
    viewer.scene.globe.maximumScreenSpaceError = 1.5;

    // Seed the demo targets the first time the view opens (the controller is
    // shared, so this also feeds the wall preview).
    if (geoController.getScene().targets.length === 0) seedDemoGeo(geoController);

    const source = new CesiumNS.CustomDataSource("hq-geo-targets");
    sourceRef.current = source;
    viewer.dataSources.add(source);
    paintScene(source, geoController.getScene());
    viewer.scene.requestRender();

    const flyTo = (lat: number, lon: number, height?: number) => {
      void viewer.camera.flyTo({
        destination: CesiumNS.Cartesian3.fromDegrees(lon, lat, height ?? 2.2e6),
        duration: 1.8,
      });
    };

    // Honour a fly-to issued before the view mounted (window.__hqGeo(lat, lon)),
    // otherwise frame all the targets on open.
    const pending = geoController.getPendingFlyTo();
    if (pending) flyTo(pending.lat, pending.lon, pending.height);
    else if (source.entities.values.length > 0) void viewer.flyTo(source, { duration: 1.6 }).catch(() => undefined);

    queueMicrotask(() => setReady(true));

    // All keyless live layers start automatically on mount: the owner (and every
    // agent) just opens ГЕО and sees everything — no toggles to think about. The
    // key-gated layers (vessels / fires / cameras) stay silent until their
    // NEXT_PUBLIC_* key is configured.
    queueMicrotask(() => {
      const handles = liveHandlesRef.current;
      for (const layer of LIVE_LAYERS) {
        if (layer.needsKey && !layerAvailable(layer.id)) continue;
        if (handles[layer.id]) continue;
        const handle = startLiveLayer(layer.id, viewer, (detail) =>
          setNotice(t("hqGeo.layerError", { detail })),
        );
        if (handle) handles[layer.id] = handle;
      }
      setActiveLive(
        LIVE_LAYERS.filter((layer) => !(layer.needsKey && !layerAvailable(layer.id))).map((layer) => layer.id),
      );
    });

    // Realism tier starts automatically — the owner opens ГЕО and the best tier
    // the keys allow is live without a toggle. The imagery globe stays visible
    // under Google tiles until the camera descends (handled inside enablePhotoreal).
    queueMicrotask(() => {
      if (realismHandleRef.current) return;
      setRealismBusy(true);
      enablePhotoreal(viewer)
        .then((handle) => {
          realismHandleRef.current = handle;
          setRealismOn(true);
        })
        .catch((error: unknown) =>
          setNotice(t("hqGeo.layerError", { detail: error instanceof Error ? error.message : String(error) })),
        )
        .finally(() => setRealismBusy(false));
    });

    // Universal click: a public webcam pin opens its thumbnail (DOM, kept out of
    // WebGL so cross-origin images never taint the canvas); any other entity
    // becomes the tracked target — camera-lock, fading trail, metadata popup.
    const tracker = createTracker(viewer, setTracked);
    trackerRef.current = tracker;
    const picker = new CesiumNS.ScreenSpaceEventHandler(viewer.scene.canvas);
    picker.setInputAction((movement: CesiumNS.ScreenSpaceEventHandler.PositionedEvent) => {
      const live = viewerRef.current;
      if (!live) return;
      const picked = live.scene.pick(movement.position);
      const entity = picked?.id as CesiumNS.Entity | undefined;
      if (!entity) return;
      const info = entity.properties?.getValue(CesiumNS.JulianDate.now())?.[GEO_CAMERA_PROPERTY] as
        | GeoCameraInfo
        | undefined;
      if (info) {
        setCamera(info);
        return;
      }
      tracker.track(entity);
    }, CesiumNS.ScreenSpaceEventType.LEFT_CLICK);

    const unsubscribeScene = geoController.subscribe((scene) => {
      const current = sourceRef.current;
      const live = viewerRef.current;
      if (!current || !live) return;
      paintScene(current, scene);
      live.scene.requestRender();
    });
    // Later fly-to requests (dev console, voice command) drive the live camera.
    const unsubscribeFly = geoController.onFlyTo((request) => flyTo(request.lat, request.lon, request.height));

    return () => {
      unsubscribeScene();
      unsubscribeFly();
      if (!picker.isDestroyed()) picker.destroy();
      trackerRef.current?.destroy();
      trackerRef.current = null;
      for (const handle of Object.values(liveHandlesRef.current)) handle?.destroy();
      liveHandlesRef.current = {};
      realismHandleRef.current?.disable();
      realismHandleRef.current = null;
      sensorStageRef.current = null;
      sourceRef.current = null;
      viewerRef.current = null;
      if (viewer && !viewer.isDestroyed()) viewer.destroy();
    };
    // Built once; basemap/live changes are handled by their own callbacks.
  }, []);

  // Esc closes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Pause every live fetcher while the tab is hidden; resume on return. The
  // globe is still (requestRenderMode) meanwhile, so a backgrounded ГЕО costs
  // nothing — no polling, no sockets, no renders.
  useEffect(() => {
    const onVisibility = () => {
      const paused = document.hidden;
      for (const handle of Object.values(liveHandlesRef.current)) handle?.setPaused(paused);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  return (
    <div className="fixed inset-0 z-[80] bg-[#06080c]" role="dialog" aria-label={t("hqGeo.title")}>
      <div ref={containerRef} className="absolute inset-0 [&_.cesium-viewer-bottom]:hidden" />

      {/* Loading / failure states. */}
      {!ready && !failed ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="font-mono text-[12px] uppercase tracking-[0.2em] text-white/70">{t("hqGeo.loading")}</span>
        </div>
      ) : null}
      {failed ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="max-w-md font-mono text-[13px] text-white/70">{t("hqGeo.failed")}</p>
          <button type="button" onClick={onClose} className={`h-9 px-4 font-mono text-[12px] ${hqHudButtonClass(false)}`}>
            {t("hqGeo.close")}
          </button>
        </div>
      ) : null}

      {/* Title + lawful note (top-left). */}
      <div className={`pointer-events-none absolute left-3 top-3 z-10 flex flex-col gap-1 px-3 py-2 ${HQ_HUD_GLASS}`}>
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-red-400 shadow-[0_0_8px_rgba(255,42,42,0.8)]" />
          <span className="font-mono text-[12px] font-semibold uppercase tracking-[0.28em] text-white">
            {t("hqGeo.title")}
          </span>
        </div>
        <span className="max-w-[320px] font-mono text-[9px] leading-relaxed uppercase tracking-[0.1em] text-white/55">
          {t("hqGeo.lawful")}
        </span>
      </div>

      {/* Close (top-right). */}
      <button
        type="button"
        onClick={onClose}
        aria-label={t("hqGeo.close")}
        title={t("hqGeo.close")}
        className={`absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center ${hqHudButtonClass(false)}`}
      >
        <X className="h-4 w-4" />
      </button>

      {/* Thin live-layer status strip (bottom-left). Not toggles — just dots
          telling the owner which feeds are live. Everything is auto-on at the
          highest tier the keys allow. */}
      <div className={`absolute bottom-3 left-3 z-10 flex max-w-[94vw] flex-wrap items-center gap-x-3 gap-y-1 p-2 ${HQ_HUD_GLASS}`}>
        <span className="px-1 font-mono text-[9px] uppercase tracking-[0.12em] text-white/45" title={t("hqGeo.realismHint", { mode: REALISM_MODE })}>
          реализм · {REALISM_MODE}
        </span>
        <span className="px-1 font-mono text-[9px] text-white/20">·</span>
        {LIVE_LAYERS.map((layer) => {
          const on = activeLive.includes(layer.id);
          const needsKey = layer.needsKey && !layerAvailable(layer.id);
          return (
            <span
              key={layer.id}
              title={needsKey ? t("hqGeo.layerNeedsKey", { name: layer.label, env: layer.keyEnv ?? "" }) : layer.source}
              className={`flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] ${
                needsKey ? "text-amber-300/60" : on ? "text-emerald-300/90" : "text-white/50"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${needsKey ? "bg-amber-400/60" : on ? "bg-emerald-400 shadow-[0_0_6px_rgba(16,255,160,0.8)]" : "bg-white/30"}`} />
              {layer.label}
              {needsKey ? <span className="text-[9px] text-amber-300/60">·ключ</span> : null}
            </span>
          );
        })}
      </div>

      {/* Legend (top-right, right under the close button). */}
      <div className={`absolute right-3 top-14 z-10 flex flex-col gap-1 p-2 ${HQ_HUD_GLASS}`}>
        {(Object.keys(GEO_KIND_STYLE) as Array<keyof typeof GEO_KIND_STYLE>).map((kind) => (
          <div key={kind} className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: GEO_KIND_STYLE[kind].color }} />
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-white/70">
              {GEO_KIND_STYLE[kind].label}
            </span>
          </div>
        ))}
      </div>

      {/* Transient notice (e.g. a live layer failed, or is planned). */}
      {notice ? (
        <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2">
          <button
            type="button"
            onClick={() => setNotice(null)}
            className={`px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-white/80 ${HQ_HUD_GLASS}`}
          >
            {notice}
          </button>
        </div>
      ) : null}

      {/* Public-webcam thumbnail (DOM, not WebGL) shown when a camera point is
          clicked. View-only open public feed. */}
      {camera ? (
        <div className={`absolute right-3 bottom-16 z-10 w-[260px] overflow-hidden ${HQ_HUD_GLASS}`}>
          <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
            <span className="truncate font-mono text-[11px] text-white/85">{camera.title}</span>
            <button
              type="button"
              onClick={() => setCamera(null)}
              aria-label={t("hqGeo.close")}
              className="flex h-5 w-5 shrink-0 items-center justify-center text-white/60 hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element -- live external webcam frame, not a static asset */}
          <img src={camera.preview} alt={camera.title} className="block h-[146px] w-full object-cover" />
          <div className="flex items-center justify-between px-2.5 py-1.5">
            <span className="truncate font-mono text-[9px] uppercase tracking-[0.1em] text-white/50">{camera.place}</span>
            {camera.detail ? (
              <a
                href={camera.detail}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[9px] uppercase tracking-[0.1em] text-blue-300/80 hover:text-blue-200"
              >
                Windy
              </a>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Tracked target: camera-locked, trail-drawn, metadata panel. */}
      {tracked ? (
        <div className={`absolute left-3 top-16 z-10 w-[280px] overflow-hidden ${HQ_HUD_GLASS}`}>
          <div className="flex items-center justify-between gap-2 border-b border-white/10 px-2.5 py-1.5">
            <div className="min-w-0">
              <div className="truncate font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-amber-200">
                {kindLabel(tracked.kind)}
              </div>
              <div className="truncate font-mono text-[11px] text-white/85">{tracked.title}</div>
            </div>
            <button
              type="button"
              onClick={() => {
                trackerRef.current?.clear();
                setCockpitOn(false);
              }}
              aria-label={t("hqGeo.close")}
              className="flex h-5 w-5 shrink-0 items-center justify-center text-white/60 hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {tracked.subtitle ? (
            <div className="px-2.5 pt-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-white/55">
              {tracked.subtitle}
            </div>
          ) : null}
          {typeof tracked.lat === "number" && typeof tracked.lon === "number" ? (
            <div className="grid grid-cols-2 gap-x-2 px-2.5 py-1 font-mono text-[10px] text-white/70">
              <span>φ {tracked.lat.toFixed(4)}°</span>
              <span>λ {tracked.lon.toFixed(4)}°</span>
              {typeof tracked.height === "number" ? (
                <span className="col-span-2 text-white/50">h {Math.round(tracked.height)} м</span>
              ) : null}
            </div>
          ) : null}
          {tracked.extras && Object.keys(tracked.extras).length ? (
            <div className="border-t border-white/5 px-2.5 py-1.5">
              <ul className="space-y-0.5 font-mono text-[10px]">
                {Object.entries(tracked.extras).map(([k, v]) => (
                  <li key={k} className="flex items-baseline justify-between gap-2">
                    <span className="text-white/45">{k}</span>
                    <span className="truncate text-right text-white/85">{v}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {tracked.kind === "flight" || tracked.kind === "satellite" || tracked.kind === "iss" ? (
            <div className="flex items-center gap-1.5 border-t border-white/5 px-2.5 py-1.5">
              <button
                type="button"
                onClick={() => {
                  trackerRef.current?.cockpit(!cockpitOn);
                  setCockpitOn((v) => !v);
                }}
                className={`h-7 flex-1 font-mono text-[10px] uppercase tracking-[0.12em] ${hqHudButtonClass(cockpitOn)}`}
                title="Камера едет вместе с объектом, смотрит вперёд"
              >
                {cockpitOn ? "ВЫЙТИ ИЗ КАБИНЫ" : "В КАБИНУ"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Attribution footer: Cesium's credit display lands in creditRef; our own
          notes sit beside it. */}
      <div className="pointer-events-none absolute bottom-1 right-2 z-10 flex items-center gap-3">
        <span className="font-mono text-[9px] text-white/35">{GEO_ATTRIBUTION.cesium}</span>
        <span className="font-mono text-[9px] text-white/35">{GEO_ATTRIBUTION.godsEye}</span>
        <div ref={creditRef} className="hq-geo-credit font-mono text-[9px] text-white/35" />
      </div>
    </div>
  );
}

function kindLabel(kind: TrackedInfo["kind"]): string {
  switch (kind) {
    case "flight":
      return "Воздушное судно";
    case "satellite":
      return "Спутник";
    case "iss":
      return "МКС";
    case "cyclone":
      return "Циклон";
    case "earthquake":
      return "Землетрясение";
    case "launch":
      return "Пуск ракеты";
    case "camera":
      return "Публичная камера";
    case "datacenter":
      return "Дата-центр";
    case "dam":
      return "Плотина";
    case "pin":
      return "Отметка";
    default:
      return "Объект";
  }
}

export default HqGeoView;
