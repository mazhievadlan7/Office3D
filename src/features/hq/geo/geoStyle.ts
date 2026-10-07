import type { GeoArcKind, GeoTargetKind } from "./geoTypes";

/**
 * Colours for the geo-view, shared by both surfaces so a pin looks the same on
 * the full-screen CesiumJS globe and on the cheap video-wall preview. Plain CSS
 * hex strings: Cesium parses them with Color.fromCssColorString, the wall
 * preview uses them straight on a 2D canvas. The HQ palette — red accents on
 * near-black — holds; the kinds are told apart by warmth, not by leaving red.
 */

export type GeoKindStyle = {
  /** Fill / glow colour. */
  color: string;
  /** Short label for the legend. */
  label: string;
};

export const GEO_KIND_STYLE: Record<GeoTargetKind, GeoKindStyle> = {
  hq: { color: "#ffffff", label: "Штаб" },
  asset: { color: "#ff2a2a", label: "Свой актив" },
  bounty: { color: "#ff8a3a", label: "Bug bounty" },
  client: { color: "#ffd24a", label: "Клиент" },
  osint: { color: "#4ab8ff", label: "OSINT" },
  whiteboard: { color: "#f0e68c", label: "Доска" },
};

export const GEO_ARC_STYLE: Record<GeoArcKind, { color: string }> = {
  engagement: { color: "#ff3a2a" },
  recon: { color: "#4ab8ff" },
  lateral: { color: "#ffb020" },
};

/** The dark premium HQ globe skin, in one place. */
export const GEO_SKIN = {
  /** Space behind the globe. */
  background: "#06080c",
  /** The globe's unlit base colour (under imagery), a cold graphite. */
  globeBase: "#0a0e14",
  /** Atmosphere / rim, red to match the HQ. */
  atmosphere: "#ff2a2a",
} as const;
