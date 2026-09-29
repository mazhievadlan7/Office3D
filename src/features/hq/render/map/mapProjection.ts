// Equirectangular crop used by the wall map. Antarctica and the far Arctic are
// dropped so the populated latitudes fill a wide display.
export const MAP_LON_WEST = -180;
export const MAP_LON_EAST = 180;
export const MAP_LAT_SOUTH = -58;
export const MAP_LAT_NORTH = 78;
export const MAP_ASPECT = (MAP_LON_EAST - MAP_LON_WEST) / (MAP_LAT_NORTH - MAP_LAT_SOUTH);

/** Markers, ripples and arc widths are sized in 1/MAP_MARKER_COLUMNS of the map width. */
export const MAP_MARKER_COLUMNS = 280;

/** Normalised map coordinates: u 0..1 west to east, v 0..1 south to north. */
export function lonToU(lon: number): number {
  return (lon - MAP_LON_WEST) / (MAP_LON_EAST - MAP_LON_WEST);
}

export function latToV(lat: number): number {
  return (lat - MAP_LAT_SOUTH) / (MAP_LAT_NORTH - MAP_LAT_SOUTH);
}

export function uToLon(u: number): number {
  return MAP_LON_WEST + u * (MAP_LON_EAST - MAP_LON_WEST);
}

export function vToLat(v: number): number {
  return MAP_LAT_SOUTH + v * (MAP_LAT_NORTH - MAP_LAT_SOUTH);
}

/**
 * The rows of a whole-globe equirectangular image (north at the top row,
 * latitude 90..-90) that the map's crop shows, in source pixels.
 */
export function cropRows(imageHeight: number): { y: number; height: number } {
  const y = ((90 - MAP_LAT_NORTH) / 180) * imageHeight;
  const bottom = ((90 - MAP_LAT_SOUTH) / 180) * imageHeight;
  return { y, height: bottom - y };
}

/**
 * Display geometry in display-local metres: origin at the centre of the map
 * surface, +x east (to the viewer's right), +y up, +z out of the wall.
 *
 * The display is concave toward the room (HqMapWall.curve): every layer is
 * the flat layout below pushed out of the wall by arcSag(arcK, x), so x and y
 * stay the flat "display-local metres" the shaders work in.
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
  /** Size unit for markers, ripples and arcs: the map width / MAP_MARKER_COLUMNS. */
  unit: number;
  /** Curvature (1 / radius, per metre) of the display's arc; 0 when it is flat. */
  arcK: number;
};

/**
 * Curvature of a display `width` wide whose middle touches the wall and whose
 * ends stand `curve` metres in front of it: a circular arc through the three
 * points, 1/r with r = (width²/4 + curve²) / (2 curve). 0 (flat) for no curve.
 * The curve is capped at a quarter of the width, well short of a half circle.
 */
export function arcCurvature(width: number, curve: number): number {
  if (!(width > 0) || !(curve > 0)) return 0;
  const c = Math.min(curve, width / 4);
  const half = width / 2;
  return (2 * c) / (half * half + c * c);
}

/**
 * How far the arc stands in front of the wall at display-local x (its
 * sagitta r - sqrt(r² - x²)), written so it holds for k = 0 and never
 * cancels: 0 in the middle, `curve` at the display's ends.
 */
export function arcSag(k: number, x: number): number {
  const kx = k * x;
  return (k * x * x) / (1 + Math.sqrt(Math.max(0, 1 - kx * kx)));
}

/** The arc's slope dz/dx at x: how fast it comes toward the room. */
export function arcSlope(k: number, x: number): number {
  const kx = k * x;
  return kx / Math.sqrt(Math.max(1e-6, 1 - kx * kx));
}

/** The same sagitta in GLSL, for layers placed in their vertex shader (`k` a uniform). */
export const ARC_SAG_GLSL = /* glsl */ `
float hqArcSag(float k, float x) {
  float kx = k * x;
  return k * x * x / (1.0 + sqrt(max(0.0, 1.0 - kx * kx)));
}
`;

/**
 * The display's case: a matte block from the floor to just above the bezel
 * that fills the space between the arc and the wall, so the forward-standing
 * ends read as one built-in piece. Its front is the arc (`front` off the wall
 * in the middle, clear of the wall's LED lines); it reaches `side` past the
 * bezel at each end and `top` above it. Nothing stands out in front of the
 * arc but the 7 cm bezel.
 */
export const MAP_CASE = { front: 0.02, side: 0.3, top: 0.3 } as const;

/** Half the case's width and its top, display-local metres. */
export function mapCaseExtent(fit: Pick<MapFit, "outerW" | "outerH">): { halfW: number; top: number } {
  return { halfW: fit.outerW / 2 + MAP_CASE.side, top: fit.outerH / 2 + MAP_CASE.top };
}

// The land may stretch a little away from true equirectangular proportions so
// it fills walls of other aspect ratios; beyond that it is letterboxed. Kept
// modest since the Earth is photographic: a wider stretch visibly flattened
// the continents, and the spare width goes to the side screens' margins.
const MAX_STRETCH_X = 1.35;
const MAX_STRETCH_Y = 1.15;

export function fitMap(width: number, height: number, curve = 0): MapFit {
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
    unit: mapW / MAP_MARKER_COLUMNS,
    arcK: arcCurvature(outerW, curve),
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
