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
