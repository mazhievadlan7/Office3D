// CesiumJS setup for the «ГЕО» full-screen globe. This module is only reachable
// from HqGeoView, which is loaded with next/dynamic { ssr: false }, so importing
// Cesium at the top here stays client-only and never runs on the server.
//
// CesiumJS is Apache-2.0 (https://github.com/CesiumGS/cesium). The geo-view's
// shape is inspired by bilawalsidhu/gods-eye-view (MIT) — a clean rebuild in our
// Next.js app, keyless and local-first, with its OpenAI voice dropped (we use our
// own local voice stack). See ATTRIBUTION below.

import * as Cesium from "cesium";
import { GEO_SKIN } from "./geoStyle";

/**
 * Where Cesium fetches its vendored static assets (workers, textures, widget
 * CSS) — served same-origin from public/cesium by scripts/vendor-cesium.mjs.
 * Set at import time (client only) so it is in place before any Viewer is built.
 */
export const CESIUM_BASE_URL = "/cesium";
if (typeof window !== "undefined") {
  (window as unknown as { CESIUM_BASE_URL?: string }).CESIUM_BASE_URL ??= CESIUM_BASE_URL;
}

/**
 * Optional enhancers, OFF unless an env var is set. Cesium runs in the browser,
 * so these must be NEXT_PUBLIC_* to reach it (documented in .env.example). The
 * default view needs neither: it uses the offline Natural Earth basemap bundled
 * with Cesium, and plots only our own authorized-target pins.
 */
export const CESIUM_ION_TOKEN = (process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN ?? "").trim();
export const GOOGLE_3DTILES_KEY = (process.env.NEXT_PUBLIC_GOOGLE_3DTILES_KEY ?? "").trim();

if (CESIUM_ION_TOKEN) {
  // Only touch Ion when a token is configured; otherwise we never call it.
  Cesium.Ion.defaultAccessToken = CESIUM_ION_TOKEN;
}

/** The licence notes shown in the view's footer and kept with the code. */
export const GEO_ATTRIBUTION = {
  cesium: "CesiumJS © Cesium GS (Apache-2.0)",
  godsEye: "Вдохновлено gods-eye-view, Bilawal Sidhu (MIT)",
} as const;

export type GeoBasemapId = "natural-earth" | "osm" | "esri";

export type GeoBasemap = {
  id: GeoBasemapId;
  label: string;
  /** True when the tiles come from the public internet (needs egress). */
  egress: boolean;
  create: () => Cesium.ImageryProvider | Promise<Cesium.ImageryProvider>;
};

/**
 * Keyless basemaps. The default is Cesium's bundled offline Natural Earth II —
 * truly local-first, no account, no egress. OSM and Esri World Imagery are
 * keyless too but fetch tiles from the public internet, so they are marked as
 * egress and offered as explicit choices, never forced on.
 */
export const GEO_BASEMAPS: readonly GeoBasemap[] = [
  {
    id: "natural-earth",
    label: "Natural Earth (офлайн)",
    egress: false,
    create: () =>
      Cesium.TileMapServiceImageryProvider.fromUrl(Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII")),
  },
  {
    id: "osm",
    label: "OpenStreetMap",
    egress: true,
    create: () => new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" }),
  },
  {
    id: "esri",
    label: "Esri World Imagery",
    egress: true,
    create: () =>
      new Cesium.UrlTemplateImageryProvider({
        url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        maximumLevel: 18,
        credit: new Cesium.Credit("Esri, Maxar, Earthstar Geographics", true),
      }),
  },
];

export const DEFAULT_BASEMAP: GeoBasemapId = "natural-earth";

export function basemapById(id: GeoBasemapId): GeoBasemap {
  return GEO_BASEMAPS.find((basemap) => basemap.id === id) ?? GEO_BASEMAPS[0];
}

/** Builds a base imagery layer for a basemap id (the offline one by default). */
export function createBaseLayer(id: GeoBasemapId): Cesium.ImageryLayer {
  return Cesium.ImageryLayer.fromProviderAsync(Promise.resolve(basemapById(id).create()), {});
}

/**
 * Applies the dark, red-accented HQ skin to a built viewer: near-black space, a
 * cold graphite globe, a red atmosphere, real-Sun lighting (the terminator sits
 * where it is now, like the HQ's video wall), and all the stock chrome off.
 */
export function skinViewer(viewer: Cesium.Viewer): void {
  const scene = viewer.scene;
  scene.backgroundColor = Cesium.Color.fromCssColorString(GEO_SKIN.background);
  scene.globe.baseColor = Cesium.Color.fromCssColorString(GEO_SKIN.globeBase);
  scene.globe.enableLighting = true;
  scene.globe.showGroundAtmosphere = true;
  scene.globe.atmosphereBrightnessShift = -0.2;

  // Push the blue sky atmosphere toward the HQ's red.
  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.hueShift = -0.58;
    scene.skyAtmosphere.saturationShift = 0.35;
    scene.skyAtmosphere.brightnessShift = -0.1;
  }
  scene.fog.enabled = true;
  if (scene.sun) scene.sun.show = true;
  if (scene.moon) scene.moon.show = false;

  // The default Cesium UI is hidden in the Viewer options; keep the credit
  // display (attribution) but tuck it into our own footer container.
  viewer.scene.requestRenderMode = true;
  viewer.scene.maximumRenderTimeChange = Infinity;
}
