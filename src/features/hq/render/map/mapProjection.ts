import type { HqQuality } from "@/features/hq/render/scene/quality";

// Equirectangular crop used by the wall map. Antarctica and the far Arctic are
// dropped so the populated latitudes fill a wide display.
export const MAP_LON_WEST = -180;
export const MAP_LON_EAST = 180;
export const MAP_LAT_SOUTH = -58;
export const MAP_LAT_NORTH = 78;
export const MAP_ASPECT = (MAP_LON_EAST - MAP_LON_WEST) / (MAP_LAT_NORTH - MAP_LAT_SOUTH);

// Dot columns across the map. Low keeps half the dots of medium (1/sqrt 2 per axis).
export const MAP_DOT_COLUMNS: Record<HqQuality, number> = {
  high: 280,
  medium: 220,
  low: 156,
};

/** Normalised map coordinates: u 0..1 west to east, v 0..1 south to north. */
export function lonToU(lon: number): number {
  return (lon - MAP_LON_WEST) / (MAP_LON_EAST - MAP_LON_WEST);
}

export function latToV(lat: number): number {
  return (lat - MAP_LAT_SOUTH) / (MAP_LAT_NORTH - MAP_LAT_SOUTH);
}

/**
 * Display geometry in display-local metres: origin at the centre of the map
 * surface, +x east (to the viewer's right), +y up, +z out of the wall.
 */
export type MapFit = {
  outerW: number;
  outerH: number;
  /** Width of the dark metal bezel around the glass. */
  bezel: number;
  panelW: number;
  panelH: number;
  /** Inset of the glowing frame line from the glass edge. */
  frameInset: number;
  /** Land rectangle (x0, y0 bottom-left; x1, y1 top-right). */
  mapX0: number;
  mapY0: number;
  mapX1: number;
  mapY1: number;
  /** Dot grid; pitch is the same along both axes. */
  cols: number;
  rows: number;
  pitch: number;
};

// The land may stretch a little away from true equirectangular proportions so
// it fills walls of other aspect ratios; beyond that it is letterboxed.
const MAX_STRETCH_X = 1.85;
const MAX_STRETCH_Y = 1.15;

export function fitMap(width: number, height: number, cols: number): MapFit {
  const outerW = Math.max(width, 0.5);
  const outerH = Math.max(height, 0.3);
  const bezel = clamp(Math.min(outerW, outerH) * 0.018, 0.05, 0.14);
  const panelW = outerW - 2 * bezel;
  const panelH = outerH - 2 * bezel;
  const frameInset = clamp(panelH * 0.035, 0.04, 0.16);
  // Room for the frame line and the edge ticks around the land.
  const padX = frameInset + clamp(panelH * 0.06, 0.08, 0.4);
  const padY = frameInset + clamp(panelH * 0.07, 0.08, 0.45);
  const availW = Math.max(panelW - 2 * padX, 0.1);
  const availH = Math.max(panelH - 2 * padY, 0.1);

  let mapW: number;
  let mapH: number;
  if (availW / availH > MAP_ASPECT) {
    mapH = availH;
    mapW = Math.min(availW, availH * MAP_ASPECT * MAX_STRETCH_X);
  } else {
    mapW = availW;
    mapH = Math.min(availH, (availW / MAP_ASPECT) * MAX_STRETCH_Y);
  }

  const safeCols = Math.max(8, Math.round(cols));
  const pitch = mapW / safeCols;
  const rows = Math.max(4, Math.round(mapH / pitch));
  // Snap the height to whole rows so dots stay square-pitched.
  mapH = rows * pitch;

  return {
    outerW,
    outerH,
    bezel,
    panelW,
    panelH,
    frameInset,
    mapX0: -mapW / 2,
    mapY0: -mapH / 2,
    mapX1: mapW / 2,
    mapY1: mapH / 2,
    cols: safeCols,
    rows,
    pitch,
  };
}

// Hotspot cities as [lon, lat]. Picked for a spread across every continent.
export const MAP_HOTSPOTS: ReadonlyArray<readonly [number, number]> = [
  [-74.01, 40.71], // New York
  [-118.24, 34.05], // Los Angeles
  [-122.42, 37.77], // San Francisco
  [-79.38, 43.65], // Toronto
  [-99.13, 19.43], // Mexico City
  [-46.63, -23.55], // Sao Paulo
  [-58.38, -34.6], // Buenos Aires
  [-0.13, 51.51], // London
  [2.35, 48.86], // Paris
  [13.4, 52.52], // Berlin
  [37.62, 55.76], // Moscow
  [28.98, 41.01], // Istanbul
  [55.27, 25.2], // Dubai
  [31.24, 30.04], // Cairo
  [3.38, 6.52], // Lagos
  [28.05, -26.2], // Johannesburg
  [72.88, 19.08], // Mumbai
  [103.82, 1.35], // Singapore
  [114.17, 22.32], // Hong Kong
  [116.41, 39.9], // Beijing
  [139.69, 35.68], // Tokyo
  [151.21, -33.87], // Sydney
];

export const MAP_HOTSPOT_COUNT = MAP_HOTSPOTS.length;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
