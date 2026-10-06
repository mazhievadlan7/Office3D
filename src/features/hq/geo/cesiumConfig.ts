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

/** The best realism tier available with the configured keys (for the UI label). */
export type RealismMode = "google" | "ion" | "esri";
export const REALISM_MODE: RealismMode = GOOGLE_3DTILES_KEY ? "google" : CESIUM_ION_TOKEN ? "ion" : "esri";

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

/**
 * «РЕАЛИЗМ» — the maximum-realism surface the configured keys allow, as a clean
 * on/off unit:
 *   - google : Google Photorealistic 3D Tiles (needs NEXT_PUBLIC_GOOGLE_3DTILES_KEY)
 *   - ion    : Cesium World Terrain + World Imagery (needs NEXT_PUBLIC_CESIUM_ION_TOKEN)
 *   - esri   : keyless fallback — Esri World Imagery overlay (terrain stays flat)
 * Returns a handle whose disable() reverts exactly what it added.
 */
export type RealismHandle = { mode: RealismMode; disable(): void };

export async function enablePhotoreal(viewer: Cesium.Viewer): Promise<RealismHandle> {
  const scene = viewer.scene;
  if (GOOGLE_3DTILES_KEY) {
    const tileset = await Cesium.createGooglePhotorealistic3DTileset({ key: GOOGLE_3DTILES_KEY });
    scene.primitives.add(tileset);
    // The photoreal tiles are the surface now; hide the imagery globe under them.
    scene.globe.show = false;
    scene.requestRender();
    return {
      mode: "google",
      disable() {
        scene.primitives.remove(tileset);
        scene.globe.show = true;
        scene.requestRender();
      },
    };
  }
  if (CESIUM_ION_TOKEN) {
    const previousTerrain = scene.terrainProvider;
    scene.terrainProvider = await Cesium.createWorldTerrainAsync();
    const imagery = viewer.imageryLayers.addImageryProvider(await Cesium.createWorldImageryAsync());
    scene.requestRender();
    return {
      mode: "ion",
      disable() {
        viewer.imageryLayers.remove(imagery, true);
        scene.terrainProvider = previousTerrain;
        scene.requestRender();
      },
    };
  }
  const esri = viewer.imageryLayers.addImageryProvider(
    new Cesium.UrlTemplateImageryProvider({
      url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      maximumLevel: 18,
      credit: new Cesium.Credit("Esri, Maxar, Earthstar Geographics", true),
    }),
  );
  scene.requestRender();
  return {
    mode: "esri",
    disable() {
      viewer.imageryLayers.remove(esri, true);
      scene.requestRender();
    },
  };
}

/** Cinematic / sensor looks borrowed from the source project's spirit. */
export type SensorStyle = "clean" | "night" | "thermal";

/** A false-colour "iron" thermal look as a single full-screen post-process pass. */
const THERMAL_FRAGMENT_SHADER = `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
void main(void) {
  vec3 rgb = texture(colorTexture, v_textureCoordinates).rgb;
  float l = clamp(dot(rgb, vec3(0.299, 0.587, 0.114)), 0.0, 1.0);
  // iron ramp: black -> purple -> red -> orange -> yellow -> white
  vec3 cold = mix(vec3(0.0, 0.0, 0.05), vec3(0.55, 0.0, 0.5), smoothstep(0.0, 0.35, l));
  vec3 warm = mix(vec3(0.9, 0.2, 0.0), vec3(1.0, 0.95, 0.6), smoothstep(0.55, 1.0, l));
  vec3 mid = mix(cold, vec3(0.9, 0.2, 0.0), smoothstep(0.3, 0.6, l));
  vec3 iron = mix(mid, warm, smoothstep(0.55, 1.0, l));
  out_FragColor = vec4(iron, 1.0);
}
`;

export function createThermalStage(): Cesium.PostProcessStage {
  return new Cesium.PostProcessStage({ name: "hq-geo-thermal", fragmentShader: THERMAL_FRAGMENT_SHADER });
}

/** Applies the atmosphere / lighting profile for a sensor style (thermal uses clean). */
export function applySensorAtmosphere(viewer: Cesium.Viewer, style: SensorStyle): void {
  const scene = viewer.scene;
  const night = style === "night";
  scene.globe.enableLighting = true;
  scene.globe.atmosphereBrightnessShift = night ? -0.55 : -0.2;
  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.brightnessShift = night ? -0.45 : -0.1;
    scene.skyAtmosphere.saturationShift = night ? 0.1 : 0.35;
  }
  scene.requestRender();
}
