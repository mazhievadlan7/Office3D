"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { t } from "@/lib/i18n";
import { HQ_HUD_GLASS, hqHudButtonClass } from "@/features/hq/hud/hudStyle";
import * as CesiumNS from "cesium";
import {
  DEFAULT_BASEMAP,
  GEO_ATTRIBUTION,
  GEO_BASEMAPS,
  basemapById,
  skinViewer,
  type GeoBasemapId,
} from "./cesiumConfig";
import { geoController } from "./geoController";
import { seedDemoGeo } from "./geoData";
import { GEO_ARC_STYLE, GEO_KIND_STYLE } from "./geoStyle";
import type { GeoArc, GeoSceneData } from "./geoTypes";
import { LIVE_LAYERS, startFlightsLayer, type LiveLayerHandle, type LiveLayerId } from "./liveLayers";

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

  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [basemap, setBasemap] = useState<GeoBasemapId>(DEFAULT_BASEMAP);
  const [activeLive, setActiveLive] = useState<LiveLayerId[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

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
      for (const handle of Object.values(liveHandlesRef.current)) handle?.destroy();
      liveHandlesRef.current = {};
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

  const switchBasemap = useCallback((id: GeoBasemapId) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    setBasemap(id);
    const layers = viewer.imageryLayers;
    const next = CesiumNS.ImageryLayer.fromProviderAsync(Promise.resolve(basemapById(id).create()), {});
    layers.add(next);
    // Drop the previous base layer(s) once the new one is in.
    while (layers.length > 1) layers.remove(layers.get(0), true);
    viewer.scene.requestRender();
  }, []);

  const toggleLive = useCallback((id: LiveLayerId) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const def = LIVE_LAYERS.find((layer) => layer.id === id);
    if (!def?.implemented) {
      setNotice(t("hqGeo.layerPlanned", { name: def?.label ?? id }));
      return;
    }
    const handles = liveHandlesRef.current;
    if (handles[id]) {
      handles[id]?.destroy();
      delete handles[id];
      setActiveLive((active) => active.filter((layer) => layer !== id));
      viewer.scene.requestRender();
      return;
    }
    if (id === "flights") {
      handles[id] = startFlightsLayer(viewer, (message) => setNotice(t("hqGeo.layerError", { detail: message })));
      setActiveLive((active) => [...active, id]);
    }
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

      {/* Basemap + live-layer controls (bottom-left). */}
      <div className={`absolute bottom-3 left-3 z-10 flex max-w-[94vw] flex-col gap-2 p-2 ${HQ_HUD_GLASS}`}>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="px-1 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-white/60">
            {t("hqGeo.basemap")}
          </span>
          {GEO_BASEMAPS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => switchBasemap(option.id)}
              title={option.egress ? t("hqGeo.needsEgress") : t("hqGeo.offline")}
              className={`h-8 px-2.5 font-mono text-[11px] ${hqHudButtonClass(basemap === option.id)}`}
            >
              {option.label}
              {option.egress ? <span className="ml-1 text-[9px] text-white/45">·сеть</span> : null}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="px-1 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-white/60">
            {t("hqGeo.liveLayers")}
          </span>
          {LIVE_LAYERS.map((layer) => (
            <button
              key={layer.id}
              type="button"
              onClick={() => toggleLive(layer.id)}
              title={t("hqGeo.needsEgress")}
              className={`h-8 px-2.5 font-mono text-[11px] ${hqHudButtonClass(activeLive.includes(layer.id))}`}
            >
              {layer.label}
              <span className="ml-1 text-[9px] text-white/45">·{layer.source}</span>
            </button>
          ))}
          <span className="px-1 font-mono text-[9px] uppercase tracking-[0.12em] text-white/40">
            {t("hqGeo.liveOffByDefault")}
          </span>
        </div>
      </div>

      {/* Legend (top-right, under close). */}
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

export default HqGeoView;
