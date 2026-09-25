import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import { feature } from "topojson-client";
import type { GeometryObject, Topology } from "topojson-specification";
import { HQ_WORLD_LAND_URL } from "@/features/hq/core/config";
import {
  MAP_ASPECT,
  MAP_LAT_NORTH,
  MAP_LAT_SOUTH,
  MAP_LON_EAST,
  MAP_LON_WEST,
} from "@/features/hq/render/map/mapProjection";

/** One byte of land coverage per pixel over the cropped equirectangular map. */
export type LandMask = { width: number; height: number; data: Uint8Array };

/** Land dots, 4 floats each: u, v (0..1, see mapProjection), coverage 0..1, seed 0..1. */
export type LandDots = { count: number; data: Float32Array };

export const LAND_MASK_WIDTH = 2048;
export const LAND_MASK_HEIGHT = Math.round(LAND_MASK_WIDTH / MAP_ASPECT);

let maskPromise: Promise<LandMask> | null = null;

/** Fetches, decodes and rasterises the land once per page; a failure clears the cache so a remount retries. */
export function loadLandMask(): Promise<LandMask> {
  if (!maskPromise) {
    maskPromise = fetchLandRings(HQ_WORLD_LAND_URL)
      .then((rings) => rasteriseLand(rings, LAND_MASK_WIDTH, LAND_MASK_HEIGHT))
      .catch((error: unknown) => {
        maskPromise = null;
        throw error;
      });
  }
  return maskPromise;
}

async function fetchLandRings(url: string): Promise<Position[][]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HQ map: ${response.status} for ${url}`);
  const topology = (await response.json()) as Topology;
  const land = topology.objects?.land as GeometryObject | undefined;
  if (!land) throw new Error("HQ map: the topology has no land object");
  return collectRings(feature(topology, land));
}

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

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function createContext(width: number, height: number): Ctx2D {
  if (typeof OffscreenCanvas !== "undefined") {
    const ctx = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
    if (ctx) return ctx;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("HQ map: 2D canvas is unavailable");
  return ctx;
}

function rasteriseLand(rings: Position[][], width: number, height: number): LandMask {
  const ctx = createContext(width, height);
  const sx = width / (MAP_LON_EAST - MAP_LON_WEST);
  const sy = height / (MAP_LAT_NORTH - MAP_LAT_SOUTH);
  ctx.clearRect(0, 0, width, height);
  // Mask ink, not a scene colour: only the alpha channel is read back.
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  for (const ring of rings) {
    if (ring.length < 3) continue;
    const { lon, lat, min, max } = unwrapRing(ring);
    let maxLat = -90;
    for (let i = 0; i < lat.length; i++) if (lat[i] > maxLat) maxLat = lat[i];
    if (maxLat < MAP_LAT_SOUTH) continue; // Antarctica lies wholly below the crop.
    for (let shift = -360; shift <= 360; shift += 360) {
      if (max + shift < MAP_LON_WEST || min + shift > MAP_LON_EAST) continue;
      for (let i = 0; i < lon.length; i++) {
        const x = (lon[i] + shift - MAP_LON_WEST) * sx;
        const y = (MAP_LAT_NORTH - lat[i]) * sy;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    }
  }
  ctx.fill("evenodd");
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4 + 3];
  return { width, height, data };
}

// 3x3 supersampling inside each cell gives partial dots along coastlines.
const SAMPLE_SPREAD = 0.34;
const MIN_HITS = 3;

/** Turns the land mask into a regular dot grid (cols x rows cells, row 0 at the south edge). */
export function extractLandDots(mask: LandMask, cols: number, rows: number): LandDots {
  const out = new Float32Array(cols * rows * 4);
  const { width, height, data } = mask;
  let count = 0;
  for (let j = 0; j < rows; j++) {
    const v = (j + 0.5) / rows;
    for (let i = 0; i < cols; i++) {
      const u = (i + 0.5) / cols;
      let hits = 0;
      for (let sy = -1; sy <= 1; sy++) {
        const sv = v + (sy * SAMPLE_SPREAD) / rows;
        const py = Math.min(height - 1, Math.max(0, Math.floor((1 - sv) * height)));
        for (let sx = -1; sx <= 1; sx++) {
          const su = u + (sx * SAMPLE_SPREAD) / cols;
          const px = Math.min(width - 1, Math.max(0, Math.floor(su * width)));
          if (data[py * width + px] > 127) hits++;
        }
      }
      if (hits < MIN_HITS) continue;
      const o = count * 4;
      out[o] = u;
      out[o + 1] = v;
      out[o + 2] = hits / 9;
      out[o + 3] = hash2(i, j);
      count++;
    }
  }
  return { count, data: out.slice(0, count * 4) };
}

function hash2(i: number, j: number): number {
  let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
