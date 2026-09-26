import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import { feature, mesh } from "topojson-client";
import type { GeometryObject, Topology } from "topojson-specification";
import { MAP_METROS } from "@/features/hq/render/map/mapCities";
import {
  MAP_ASPECT,
  MAP_LAT_NORTH,
  MAP_LAT_SOUTH,
  MAP_LON_EAST,
  MAP_LON_WEST,
  cropRows,
} from "@/features/hq/render/map/mapProjection";

/*
 * The world map's textures, built off the main thread (mapData.worker.ts) or,
 * without worker support, on it at a lower resolution (mapData.ts).
 *
 * "geo" is RGBA8 over the map's crop (north on the first row), from the
 * Natural Earth countries (world-atlas):
 *   R  signed distance to the coast in degrees, + on land: 0.5 + d / (2 * GEO_COAST_RANGE)
 *   G  unsigned distance to the coast in degrees: sqrt(min(|d| / GEO_SHELF_RANGE, 1))
 *   B  distance to the nearest land border in degrees: min(d / GEO_BORDER_RANGE, 1)
 *   A  fallback city lights (metro glows), used only without the NASA night imagery
 * Distances make the coastline and borders crisp at any zoom (the shader
 * anti-aliases them by their screen-space derivative) and give the oceans a
 * depth gradient without any bathymetry.
 *
 * "day" / "night" are R8 over the same crop, from the NASA imagery: the day
 * image's luma (albedo with shaded relief and bathymetry) and the night
 * image's city light level.
 */

/** Width of the vector data texture at full quality; the height follows the crop's aspect. */
export const GEO_WIDTH = 4096;
/** Width when the data has to be built on the main thread (a quarter of the work). */
export const GEO_FALLBACK_WIDTH = 2048;
/** Degrees either side of the coast that R covers: the coastline and its rim. */
export const GEO_COAST_RANGE = 0.7;
/** Degrees from the coast that G covers: shelves, coastal glow, how far inland. */
export const GEO_SHELF_RANGE = 11;
/** Degrees from a border that B covers. */
export const GEO_BORDER_RANGE = 0.5;
/**
 * Imagery is never wider than this, whatever the GPU allows: the crop of a
 * 6144-wide globe stays under the 16.7 Mpx a canvas may have in Safari.
 */
export const IMAGERY_MAX_WIDTH = 6144;

export type MapImageryKind = "day" | "night";

/** A texture's texels, rows from north to south. */
export type MapRaster = { width: number; height: number; channels: 1 | 4; data: Uint8Array };

export function geoHeight(width: number): number {
  return Math.max(1, Math.round(width / MAP_ASPECT));
}

// --------------------------------------------------------------- pure helpers

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function toByte(x: number): number {
  return Math.round(clamp01(x) * 255);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

export function encodeCoast(degrees: number): number {
  return toByte(0.5 + degrees / (2 * GEO_COAST_RANGE));
}

export function encodeShelf(degrees: number): number {
  return toByte(Math.sqrt(clamp01(Math.abs(degrees) / GEO_SHELF_RANGE)));
}

export function encodeBorder(degrees: number): number {
  return toByte(degrees / GEO_BORDER_RANGE);
}

/**
 * Day imagery (sRGB bytes) to its luma byte: albedo, shaded relief and ocean
 * depth in one channel. Snow and ice (bright and colourless) are pulled down
 * to the brightness of bare ground: the Blue Marble mosaic is December's, and
 * its winter snow would light the whole north up whatever the season, while
 * scaling keeps the relief shading inside it.
 */
export function dayLuma(r: number, g: number, b: number): number {
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  const snow = smoothstep(150, 215, luma) * (1 - smoothstep(18, 45, chroma));
  return Math.round(luma * (1 - 0.55 * snow));
}

/**
 * Night imagery (sRGB bytes) to a city light level 0..1. The Black Marble
 * composite lays near-white lights over a dim, bluish Earth, so light is what
 * raises every channel (the smallest one) above that blue background; warm,
 * orange light (other night composites) counts by its luma instead. The land
 * and sea underneath stay black.
 */
export function nightLight(r: number, g: number, b: number): number {
  const white = (Math.min(r, g, b) - 36) / 219;
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const warm = ((luma - 30) / 200) * clamp01((r - b) / 60);
  return Math.min(1, Math.max(0, white, warm));
}

const INF = 1e20;

/**
 * Exact squared Euclidean distance transform, in place (Felzenszwalb and
 * Huttenlocher, "Distance Transforms of Sampled Functions"): 0 marks the
 * features, INF everything else, and fractional values seed sub-texel offsets.
 */
export function distanceTransform(grid: Float32Array, width: number, height: number): void {
  const n = Math.max(width, height);
  const f = new Float64Array(n);
  const z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  for (let x = 0; x < width; x++) transform1d(grid, x, width, height, f, v, z);
  for (let y = 0; y < height; y++) transform1d(grid, y * width, 1, width, f, v, z);
}

function transform1d(
  grid: Float32Array,
  offset: number,
  stride: number,
  length: number,
  f: Float64Array,
  v: Int32Array,
  z: Float64Array,
): void {
  // Lower envelope of the parabolas rooted at every sample.
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset];
  for (let q = 1, k = 0; q < length; q++) {
    f[q] = grid[offset + q * stride];
    const q2 = q * q;
    let s = 0;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    const d = q - r;
    grid[offset + q * stride] = f[r] + d * d;
  }
}

/**
 * Signed distance in texels to the edge of an anti-aliased coverage mask
 * (0..255), positive inside. Partly covered texels place the edge between
 * texels, so the field is smooth along diagonal and curved coasts.
 */
export function signedDistance(coverage: Uint8Array, width: number, height: number): Float32Array {
  const size = width * height;
  const outer = new Float32Array(size);
  const inner = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const a = coverage[i] / 255;
    if (a >= 1) {
      inner[i] = INF;
    } else if (a <= 0) {
      outer[i] = INF;
    } else {
      const d = 0.5 - a;
      if (d > 0) outer[i] = d * d;
      else inner[i] = d * d;
    }
  }
  distanceTransform(outer, width, height);
  distanceTransform(inner, width, height);
  for (let i = 0; i < size; i++) outer[i] = Math.sqrt(inner[i]) - Math.sqrt(outer[i]);
  return outer;
}

/** Distance in texels to the nearest inked texel of a coverage mask (0..255), e.g. a stroked line. */
export function distanceToInk(coverage: Uint8Array, width: number, height: number): Float32Array {
  const size = width * height;
  const grid = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const a = coverage[i] / 255;
    const d = 0.5 - a;
    grid[i] = a <= 0 ? INF : d > 0 ? d * d : 0;
  }
  distanceTransform(grid, width, height);
  for (let i = 0; i < size; i++) grid[i] = Math.sqrt(grid[i]);
  return grid;
}

export type GeoFields = {
  /** Output size; the fields carry `pad` extra texels on every side. */
  width: number;
  height: number;
  pad: number;
  /** Degrees per texel. */
  texelDeg: number;
  /** Signed coast distance (texels, + on land), padded. */
  coast: Float32Array;
  /** Border distance (texels), padded. */
  borders: Float32Array;
  /** Fallback city light coverage (0..255), padded. */
  lights: Uint8Array;
};

/** Crops the padded fields to the map and packs them into the geo texture's RGBA bytes. */
export function packGeo(fields: GeoFields): Uint8Array {
  const { width, height, pad, texelDeg, coast, borders, lights } = fields;
  const stride = width + 2 * pad;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    let src = (y + pad) * stride + pad;
    let o = y * width * 4;
    for (let x = 0; x < width; x++, src++, o += 4) {
      const d = coast[src] * texelDeg;
      out[o] = encodeCoast(d);
      out[o + 1] = encodeShelf(d);
      out[o + 2] = encodeBorder(borders[src] * texelDeg);
      out[o + 3] = lights[src];
    }
  }
  return out;
}

// ------------------------------------------------------------- vector sources

export function collectRings(geo: Feature<Geometry> | FeatureCollection<Geometry>): Position[][] {
  const rings: Position[][] = [];
  const addGeometry = (geometry: Geometry | null) => {
    if (!geometry) return;
    if (geometry.type === "Polygon") rings.push(...geometry.coordinates);
    else if (geometry.type === "MultiPolygon") {
      for (const polygon of geometry.coordinates) rings.push(...polygon);
    } else if (geometry.type === "GeometryCollection") {
      for (const child of geometry.geometries) addGeometry(child);
    }
  };
  if (geo.type === "FeatureCollection") for (const item of geo.features) addGeometry(item.geometry);
  else addGeometry(geo.geometry);
  return rings;
}

/**
 * Rings that cross the antimeridian jump between -180 and 180 (Chukotka, Fiji).
 * Unwrapping keeps them continuous; the caller then draws copies shifted by
 * +-360 degrees so both halves land on the canvas.
 */
export function unwrapRing(ring: Position[]): { lon: Float64Array; lat: Float64Array; min: number; max: number } {
  const lon = new Float64Array(ring.length);
  const lat = new Float64Array(ring.length);
  let offset = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const x = ring[i][0];
    if (i > 0) {
      const delta = x - ring[i - 1][0];
      if (delta > 180) offset -= 360;
      else if (delta < -180) offset += 360;
    }
    lon[i] = x + offset;
    lat[i] = ring[i][1];
    if (lon[i] < min) min = lon[i];
    if (lon[i] > max) max = lon[i];
  }
  return { lon, lat, min, max };
}

/** Land rings and land borders (shared edges between countries) from a world-atlas countries topology. */
export function worldShapes(topology: Topology): { land: Position[][]; borders: Position[][] } {
  const land = topology.objects?.land as GeometryObject | undefined;
  const countries = topology.objects?.countries as GeometryObject | undefined;
  if (!land) throw new Error("HQ map: the topology has no land object");
  const borders = countries ? mesh(topology, countries, (a, b) => a !== b).coordinates : [];
  return { land: collectRings(feature(topology, land)), borders };
}

// ------------------------------------------------------------------ rasterising

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type ContextFactory = (width: number, height: number) => Ctx2D;

/** The padded raster: the crop plus `pad` texels on every side, so fields run on across the edges. */
type GeoFrame = {
  width: number;
  height: number;
  pad: number;
  paddedW: number;
  paddedH: number;
  /** Texels per degree. */
  sx: number;
  sy: number;
  /** Degrees at the padded raster's left and top edges. */
  lon0: number;
  lat0: number;
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
};

function geoFrame(width: number): GeoFrame {
  const height = geoHeight(width);
  const sx = width / (MAP_LON_EAST - MAP_LON_WEST);
  const sy = height / (MAP_LAT_NORTH - MAP_LAT_SOUTH);
  // Enough room for the widest field, so its values at the crop's edges see
  // the land beyond them (across the antimeridian, below 58 S, above 78 N).
  const pad = Math.ceil(GEO_SHELF_RANGE * Math.max(sx, sy));
  const lon0 = MAP_LON_WEST - pad / sx;
  // Not clamped at 90 N: packGeo takes the crop from `pad` rows down, so the
  // top edge must sit exactly `pad` rows above the crop (rows past the pole stay empty).
  const lat0 = MAP_LAT_NORTH + pad / sy;
  return {
    width,
    height,
    pad,
    paddedW: width + 2 * pad,
    paddedH: height + 2 * pad,
    sx,
    sy,
    lon0,
    lat0,
    lonMin: lon0,
    lonMax: MAP_LON_EAST + pad / sx,
    latMin: MAP_LAT_SOUTH - pad / sy,
    latMax: lat0,
  };
}

/** Adds every path (and its +-360 degree copies that reach the raster) as subpaths. */
function tracePaths(ctx: Ctx2D, frame: GeoFrame, paths: Position[][], close: boolean): void {
  for (const path of paths) {
    if (path.length < 2) continue;
    const { lon, lat, min, max } = unwrapRing(path);
    let latLo = Infinity;
    let latHi = -Infinity;
    for (let i = 0; i < lat.length; i++) {
      if (lat[i] < latLo) latLo = lat[i];
      if (lat[i] > latHi) latHi = lat[i];
    }
    if (latHi < frame.latMin || latLo > frame.latMax) continue;
    for (let shift = -360; shift <= 360; shift += 360) {
      if (max + shift < frame.lonMin || min + shift > frame.lonMax) continue;
      for (let i = 0; i < lon.length; i++) {
        const x = (lon[i] + shift - frame.lon0) * frame.sx;
        const y = (frame.lat0 - lat[i]) * frame.sy;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      if (close) ctx.closePath();
    }
  }
}

function readAlpha(ctx: Ctx2D, width: number, height: number): Uint8Array {
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const out = new Uint8Array(width * height);
  for (let i = 0, j = 3; i < out.length; i++, j += 4) out[i] = rgba[j];
  return out;
}

/** mulberry32: small, deterministic, so the fallback lights never change between loads. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    let t = (s = (s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function glow(ctx: Ctx2D, x: number, y: number, radius: number, alpha: number): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
  g.addColorStop(0, `rgba(255,255,255,${alpha.toFixed(3)})`);
  g.addColorStop(0.3, `rgba(255,255,255,${(alpha * 0.5).toFixed(3)})`);
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

/**
 * Each metro as a dim regional haze (suburbs, towns, roads; the shader breaks
 * it into specks), a bright city glow sized by its population, and a scatter
 * of satellite towns.
 */
function drawMetroLights(ctx: Ctx2D, frame: GeoFrame): void {
  const rand = random(0x11647);
  const spot = (lon: number, lat: number, radiusDeg: number, alpha: number) => {
    const y = (frame.lat0 - lat) * frame.sy;
    for (let shift = -360; shift <= 360; shift += 360) {
      const x = (lon + shift - frame.lon0) * frame.sx;
      const r = radiusDeg * frame.sx;
      if (x < -r || x > frame.paddedW + r) continue;
      glow(ctx, x, y, r, alpha);
    }
  };
  ctx.globalCompositeOperation = "lighter";
  for (const [lon, lat, population] of MAP_METROS) {
    const weight = Math.min(1, Math.sqrt(population / 35));
    const radiusDeg = 0.28 + 0.7 * weight;
    const alpha = 0.5 + 0.5 * weight;
    // East-west offsets shrink toward the poles on an equirectangular map.
    const stretch = 1 / Math.max(0.35, Math.cos((lat * Math.PI) / 180));
    spot(lon, lat, 1.2 + 2.2 * weight, 0.07 + 0.1 * weight);
    spot(lon, lat, radiusDeg, alpha);
    const satellites = 3 + Math.round(9 * weight);
    for (let i = 0; i < satellites; i++) {
      const angle = rand() * Math.PI * 2;
      const dist = (0.8 + rand() * 2.6) * radiusDeg;
      spot(
        lon + Math.cos(angle) * dist * stretch,
        lat + Math.sin(angle) * dist,
        radiusDeg * (0.25 + rand() * 0.3),
        alpha * (0.25 + rand() * 0.35),
      );
    }
  }
  ctx.globalCompositeOperation = "source-over";
}

export type GeoBuildOptions = {
  url: string;
  width: number;
  context: ContextFactory;
  /** Yields between the heavy steps (the main-thread fallback passes one). */
  pause?: () => Promise<void>;
};

/** Fetches the countries topology and builds the geo texture (see the top of this file). */
export async function buildGeoRaster({ url, width, context, pause }: GeoBuildOptions): Promise<MapRaster> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HQ map: ${response.status} for ${url}`);
  const topology = (await response.json()) as Topology;
  const shapes = worldShapes(topology);
  const frame = geoFrame(width);
  const { paddedW, paddedH } = frame;
  const ctx = context(paddedW, paddedH);

  // Mask ink, not scene colours: only the alpha channel is read back.
  ctx.clearRect(0, 0, paddedW, paddedH);
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  tracePaths(ctx, frame, shapes.land, true);
  ctx.fill("evenodd");
  const land = readAlpha(ctx, paddedW, paddedH);
  await pause?.();

  ctx.clearRect(0, 0, paddedW, paddedH);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1;
  ctx.lineJoin = "round";
  ctx.beginPath();
  tracePaths(ctx, frame, shapes.borders, false);
  ctx.stroke();
  const borderInk = readAlpha(ctx, paddedW, paddedH);

  ctx.clearRect(0, 0, paddedW, paddedH);
  drawMetroLights(ctx, frame);
  const lights = readAlpha(ctx, paddedW, paddedH);
  await pause?.();

  const coast = signedDistance(land, paddedW, paddedH);
  await pause?.();
  const borders = distanceToInk(borderInk, paddedW, paddedH);
  await pause?.();

  const data = packGeo({
    width: frame.width,
    height: frame.height,
    pad: frame.pad,
    texelDeg: 1 / frame.sx,
    coast,
    borders,
    lights,
  });
  return { width: frame.width, height: frame.height, channels: 4, data };
}

/**
 * Fetches and decodes a whole-globe NASA image (equirectangular, 2:1) and
 * converts the map's crop of it into one channel: the day image's luma or
 * the night image's light level. Decoding a 5400 x 2700 JPEG and reading its
 * pixels back takes a while, so only the worker calls this.
 */
export async function buildImageryRaster(options: {
  url: string;
  kind: MapImageryKind;
  maxWidth: number;
  context: ContextFactory;
}): Promise<MapRaster> {
  const { url, kind, maxWidth, context } = options;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HQ map: ${response.status} for ${url}`);
  const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: "none" });
  try {
    if (Math.abs(bitmap.width / bitmap.height - 2) > 0.02) {
      throw new Error(`HQ map: ${url} is not a whole-globe equirectangular image`);
    }
    const rows = cropRows(bitmap.height);
    const width = Math.max(1, Math.min(bitmap.width, Math.floor(maxWidth)));
    const height = Math.max(1, Math.round((rows.height * width) / bitmap.width));
    const ctx = context(width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, rows.y, bitmap.width, rows.height, 0, 0, width, height);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const data = new Uint8Array(width * height);
    if (kind === "day") {
      for (let i = 0, j = 0; i < data.length; i++, j += 4) data[i] = dayLuma(rgba[j], rgba[j + 1], rgba[j + 2]);
    } else {
      for (let i = 0, j = 0; i < data.length; i++, j += 4) {
        data[i] = Math.round(nightLight(rgba[j], rgba[j + 1], rgba[j + 2]) * 255);
      }
    }
    return { width, height, channels: 1, data };
  } finally {
    bitmap.close();
  }
}
