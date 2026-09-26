import { HQ_MAP_DAY_URL, HQ_MAP_NIGHT_URL } from "@/features/hq/core/config";
import { subsolarPoint } from "@/features/hq/render/map/sun";
import { makeCanvas } from "./screenKit";
import type { Ctx2D } from "./screenPaint";

/**
 * A photographic Earth for the big screens, drawn in Canvas 2D without WebGL:
 * NASA's topography/bathymetry by day and Black Marble city lights by night,
 * graded into our red / white palette, lit by the real Sun (the terminator is
 * where it is right now) with ocean glints, limb darkening and a red rim.
 *
 * Rendering is a per-pixel lookup: every pixel of the disc knows its latitude,
 * its longitude relative to the view and the terms of its normal, computed
 * once per view (GlobeView); a frame only adds the view's longitude, samples
 * the maps and shades — about a millisecond for a 400-pixel globe, in the
 * screens worker.
 *
 * Without the images (404, no OffscreenCanvas on the fallback path) the same
 * globe renders as a lit sphere with a graticule instead of invented land.
 */

/** The same NASA images as the world map (core/config.ts). */
export const EARTH_DAY_URL = HQ_MAP_DAY_URL;
export const EARTH_NIGHT_URL = HQ_MAP_NIGHT_URL;

/** One resolution of the sampling maps; w is a power of two. */
export type EarthLevel = {
  w: number;
  h: number;
  /** Daylight brightness, 0..255 (land lit, oceans dark). */
  day: Uint8Array;
  /** City lights, 0..255. */
  night: Uint8Array;
  /** 1 on water (for the sun's glint). */
  water: Uint8Array;
};

const BASE_W = 2048;
const BASE_H = 1024;
const MIN_W = 256;

/** The maps once loaded (per thread: the worker's globes use the worker's). */
let levels: EarthLevel[] | null = null;

/**
 * Turns decoded RGBA pixels (w x h, equirectangular, 180°W at the left, north
 * up) into the sampling levels, finest first. Either image may be missing.
 */
export function buildEarthLevels(day: ArrayLike<number> | null, night: ArrayLike<number> | null, w: number, h: number): EarthLevel[] {
  const n = w * h;
  const dayL = new Uint8Array(n);
  const nightL = new Uint8Array(n);
  const water = new Uint8Array(n);
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    if (day) {
      const r = day[o];
      const g = day[o + 1];
      const b = day[o + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      // Blue-dominant pixels are sea: kept dark, a little lighter over the shelves.
      const sea = b > r + 10 && b >= g;
      water[i] = sea ? 1 : 0;
      dayL[i] = sea ? Math.min(255, 12 + lum * 0.32) : Math.min(255, 52 + lum * 0.8);
    } else {
      dayL[i] = 70;
    }
    if (night) {
      const lum = 0.3 * night[o] + 0.59 * night[o + 1] + 0.11 * night[o + 2];
      // Black Marble oceans are a faint blue; lift the lights off that floor.
      const v = Math.max(0, lum - 16) * 1.35;
      nightL[i] = v > 255 ? 255 : v;
    }
  }
  const out: EarthLevel[] = [{ w, h, day: dayL, night: nightL, water }];
  while (out[out.length - 1].w / 2 >= MIN_W) out.push(halve(out[out.length - 1]));
  return out;
}

/** A 2x2 box filter: the next level down. */
function halve(src: EarthLevel): EarthLevel {
  const w = src.w >> 1;
  const h = src.h >> 1;
  const day = new Uint8Array(w * h);
  const night = new Uint8Array(w * h);
  const water = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const r0 = 2 * y * src.w;
    const r1 = r0 + src.w;
    for (let x = 0; x < w; x++) {
      const a = r0 + 2 * x;
      const b = r1 + 2 * x;
      const i = y * w + x;
      day[i] = (src.day[a] + src.day[a + 1] + src.day[b] + src.day[b + 1] + 2) >> 2;
      night[i] = (src.night[a] + src.night[a + 1] + src.night[b] + src.night[b + 1] + 2) >> 2;
      water[i] = src.water[a] + src.water[a + 1] + src.water[b] + src.water[b + 1] >= 2 ? 1 : 0;
    }
  }
  return { w, h, day, night, water };
}

/**
 * Loads and decodes the NASA images (in the screens worker). Resolves false
 * when neither image could be used; the globe then stays procedural.
 */
export async function loadEarth(dayUrl = EARTH_DAY_URL, nightUrl = EARTH_NIGHT_URL): Promise<boolean> {
  if (levels) return true;
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") return false;
  const [day, night] = await Promise.all([decode(dayUrl), decode(nightUrl)]);
  if (!day && !night) return false;
  levels = buildEarthLevels(day, night, BASE_W, BASE_H);
  return true;
}

async function decode(url: string): Promise<Uint8ClampedArray | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = new OffscreenCanvas(BASE_W, BASE_H);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      bitmap.close();
      return null;
    }
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, BASE_W, BASE_H);
    bitmap.close();
    return ctx.getImageData(0, 0, BASE_W, BASE_H).data;
  } catch {
    return null;
  }
}

// --- colour grading ---------------------------------------------------------------------------
type Ramp = { r: Uint8Array; g: Uint8Array; b: Uint8Array };

function ramp(stops: ReadonlyArray<readonly [number, number, number, number]>): Ramp {
  const r = new Uint8Array(256);
  const g = new Uint8Array(256);
  const b = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let k = 0;
    while (k < stops.length - 2 && i > stops[k + 1][0]) k++;
    const [a0, r0, g0, b0] = stops[k];
    const [a1, r1, g1, b1] = stops[k + 1];
    const f = Math.min(1, Math.max(0, (i - a0) / (a1 - a0)));
    r[i] = Math.round(r0 + (r1 - r0) * f);
    g[i] = Math.round(g0 + (g1 - g0) * f);
    b[i] = Math.round(b0 + (b1 - b0) * f);
  }
  return { r, g, b };
}

// Daylight: near-black maroon seas, deep red lowlands, warm white peaks and ice.
const DAY = ramp([
  [0, 3, 1, 2],
  [30, 22, 5, 7],
  [80, 76, 11, 13],
  [140, 152, 26, 24],
  [200, 222, 84, 74],
  [255, 250, 218, 210],
]);
// City lights: red glow, white-hot cores.
const NIGHT = ramp([
  [0, 0, 0, 0],
  [30, 70, 8, 6],
  [90, 210, 36, 24],
  [170, 255, 120, 96],
  [255, 255, 240, 232],
]);

// --- the view ------------------------------------------------------------------------------------
const DEG = Math.PI / 180;

export type GlobePoint = { x: number; y: number; z: number };

/**
 * A globe of a fixed pixel radius seen from a fixed latitude; render() turns
 * it to any longitude at any moment. The canvas is (2R + 4) square with the
 * centre in the middle and transparent corners.
 */
export class GlobeView {
  readonly size: number;
  readonly canvas: OffscreenCanvas | HTMLCanvasElement | null;
  private readonly ctx: Ctx2D | null;
  private readonly image: ImageData | null;
  private readonly out: Uint32Array | null;
  private readonly count: number;
  private readonly index: Int32Array;
  private readonly alpha: Uint8Array;
  private readonly a: Float32Array;
  private readonly b: Float32Array;
  private readonly c: Float32Array;
  private readonly shade: Float32Array;
  private readonly rim: Float32Array;
  private readonly lonF: Float32Array;
  private readonly latF: Float32Array;
  private rows: { w: number; base: Int32Array } | null = null;
  private readonly sinTilt: number;
  private readonly cosTilt: number;

  constructor(
    readonly radius: number,
    tiltDeg = 20,
  ) {
    const r = radius;
    this.size = Math.ceil(2 * r) + 4;
    const made = makeCanvas(this.size, this.size);
    this.canvas = made?.canvas ?? null;
    this.ctx = made?.ctx ?? null;
    this.image = this.ctx ? this.ctx.createImageData(this.size, this.size) : null;
    this.out = this.image ? new Uint32Array(this.image.data.buffer) : null;
    this.sinTilt = Math.sin(tiltDeg * DEG);
    this.cosTilt = Math.cos(tiltDeg * DEG);

    const centre = this.size / 2;
    const pixels: number[] = [];
    for (let py = 0; py < this.size; py++) {
      for (let px = 0; px < this.size; px++) {
        const d = Math.hypot(px + 0.5 - centre, py + 0.5 - centre);
        if (d < r + 0.5) pixels.push(py * this.size + px);
      }
    }
    const n = pixels.length;
    this.count = n;
    this.index = Int32Array.from(pixels);
    this.alpha = new Uint8Array(n);
    this.a = new Float32Array(n);
    this.b = new Float32Array(n);
    this.c = new Float32Array(n);
    this.shade = new Float32Array(n);
    this.rim = new Float32Array(n);
    this.lonF = new Float32Array(n);
    this.latF = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const px = pixels[i] % this.size;
      const py = Math.floor(pixels[i] / this.size);
      let x = (px + 0.5 - centre) / r;
      let y = -(py + 0.5 - centre) / r;
      const d = Math.hypot(x, y);
      this.alpha[i] = Math.round(255 * Math.min(1, Math.max(0, r + 0.5 - d * r)));
      if (d > 0.9999) {
        // Edge pixels: sample just inside the limb.
        x *= 0.9999 / d;
        y *= 0.9999 / d;
      }
      const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
      // View basis (east right, north up, toward the viewer) at longitude 0:
      // world = x·east + y·up + z·forward; see project().
      const pp = z * this.cosTilt - y * this.sinTilt;
      const sinLat = y * this.cosTilt + z * this.sinTilt;
      const lonT = Math.atan2(x, pp);
      this.a[i] = pp;
      this.b[i] = x;
      this.c[i] = sinLat;
      this.lonF[i] = (lonT + Math.PI) / (2 * Math.PI);
      this.latF[i] = (Math.PI / 2 - Math.asin(Math.max(-1, Math.min(1, sinLat)))) / Math.PI;
      this.shade[i] = 0.62 + 0.38 * Math.pow(z, 0.6);
      this.rim[i] = Math.pow(1 - z, 3);
    }
  }

  /** Picks the sampling level whose texel is about one pixel at the centre. */
  private level(maps: readonly EarthLevel[]): EarthLevel {
    const want = 5.5 * this.radius;
    let best = maps[0];
    for (const m of maps) if (m.w >= want) best = m;
    return best;
  }

  private rowBase(level: EarthLevel): Int32Array {
    if (this.rows && this.rows.w === level.w) return this.rows.base;
    const base = new Int32Array(this.count);
    for (let i = 0; i < this.count; i++) base[i] = Math.min(level.h - 1, Math.floor(this.latF[i] * level.h)) * level.w;
    this.rows = { w: level.w, base };
    return base;
  }

  /**
   * Draws the globe centred on longitude `lonDeg` as lit at `ms` into the
   * canvas and returns it (null when there is no canvas to draw into).
   */
  render(lonDeg: number, ms: number): OffscreenCanvas | HTMLCanvasElement | null {
    const { ctx, image, out } = this;
    if (!ctx || !image || !out) return null;
    const lam = (((lonDeg * DEG) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const cl = Math.cos(lam);
    const sl = Math.sin(lam);
    const sun = subsolarPoint(ms);
    const sLat = sun.lat * DEG;
    const sLon = sun.lon * DEG;
    const sx = Math.cos(sLat) * Math.cos(sLon);
    const sy = Math.sin(sLat);
    const sz = Math.cos(sLat) * Math.sin(sLon);
    // Terms of (world normal · sun) for this longitude (see the constructor).
    const k1 = sx * cl + sz * sl;
    const k2 = sz * cl - sx * sl;
    const k3 = sy;
    // Half vector between the Sun and the viewer, for the ocean glint.
    const fx = this.cosTilt * cl;
    const fy = this.sinTilt;
    const fz = this.cosTilt * sl;
    let hx = sx + fx;
    let hy = sy + fy;
    let hz = sz + fz;
    const hl = Math.hypot(hx, hy, hz) || 1;
    hx /= hl;
    hy /= hl;
    hz /= hl;
    const h1 = hx * cl + hz * sl;
    const h2 = hz * cl - hx * sl;
    const h3 = hy;
    const off = lam / (2 * Math.PI);

    const { index, alpha, a, b, c, shade, rim, lonF, latF } = this;
    const maps = levels;
    const n = this.count;
    if (maps) {
      const level = this.level(maps);
      const rows = this.rowBase(level);
      const { w, day, night, water } = level;
      const wm = w - 1;
      for (let i = 0; i < n; i++) {
        const k = rows[i] + ((((lonF[i] + off) * w) | 0) & wm);
        const d = a[i] * k1 + b[i] * k2 + c[i] * k3;
        let dayF = (d + 0.1) * 4.5;
        dayF = dayF <= 0 ? 0 : dayF >= 1 ? 1 : dayF * dayF * (3 - 2 * dayF);
        const lit = d <= 0 ? 0 : d >= 0.87 ? 1 : d * 1.15;
        let dv = day[k] * (0.08 + 0.92 * lit) * shade[i];
        dv = dv > 255 ? 255 : dv;
        const nv = night[k] * (1 - dayF);
        const di = dv | 0;
        const ni = nv | 0;
        let rr = DAY.r[di] + NIGHT.r[ni];
        let gg = DAY.g[di] + NIGHT.g[ni];
        let bb = DAY.b[di] + NIGHT.b[ni];
        if (water[k] === 1 && dayF > 0) {
          // The Sun's glint on open water: small and warm, like from orbit.
          const hh = a[i] * h1 + b[i] * h2 + c[i] * h3;
          if (hh > 0.975) {
            let s = hh * hh;
            s *= s;
            s *= s;
            s *= s;
            s *= s;
            s *= s;
            s *= s;
            s *= s; // ^256
            s *= 120 * dayF;
            rr += s;
            gg += s * 0.5;
            bb += s * 0.45;
          }
        }
        const rimK = rim[i] * (0.35 + 0.65 * dayF);
        rr += 235 * rimK;
        gg += 38 * rimK;
        bb += 30 * rimK;
        out[index[i]] = ((alpha[i] << 24) | ((bb > 255 ? 255 : bb) << 16) | ((gg > 255 ? 255 : gg) << 8) | (rr > 255 ? 255 : rr)) >>> 0;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const d = a[i] * k1 + b[i] * k2 + c[i] * k3;
        let dayF = (d + 0.1) * 4.5;
        dayF = dayF <= 0 ? 0 : dayF >= 1 ? 1 : dayF * dayF * (3 - 2 * dayF);
        const lat = 90 - latF[i] * 180;
        const lon = (lonF[i] + off) * 360;
        // A graticule every 15 degrees, about a pixel wide.
        const gl = Math.abs((((lat / 15) % 1) + 1.5) % 1 - 0.5);
        const gn = Math.abs((((lon / 15) % 1) + 1.5) % 1 - 0.5);
        const line = gl < 0.035 || gn < 0.035 * Math.max(1, 1 / Math.max(0.05, Math.sqrt(1 - c[i] * c[i]))) ? 1 : 0;
        const lit = d <= 0 ? 0 : d;
        let v = (34 + 60 * line) * (0.25 + 0.75 * lit) * shade[i] + 10 * line * (1 - dayF);
        v = v > 255 ? 255 : v;
        const vi = v | 0;
        const rimK = rim[i] * (0.35 + 0.65 * dayF);
        const rr = DAY.r[vi] + 235 * rimK;
        const gg = DAY.g[vi] + 38 * rimK;
        const bb = DAY.b[vi] + 30 * rimK;
        out[index[i]] = ((alpha[i] << 24) | ((bb > 255 ? 255 : bb | 0) << 16) | ((gg > 255 ? 255 : gg | 0) << 8) | (rr > 255 ? 255 : rr | 0)) >>> 0;
      }
    }
    ctx.putImageData(image, 0, 0);
    return this.canvas;
  }

  /**
   * Where a place appears on this globe turned to `viewLonDeg`: x right and y
   * down in pixels from the centre, z > 0 on the visible side (1 at the centre).
   */
  project(lonDeg: number, latDeg: number, viewLonDeg: number, out: GlobePoint = { x: 0, y: 0, z: 0 }): GlobePoint {
    return projectGlobe(lonDeg, latDeg, viewLonDeg, this.sinTilt, this.cosTilt, this.radius, out);
  }
}

/** The pure projection behind GlobeView.project (tested). */
export function projectGlobe(
  lonDeg: number,
  latDeg: number,
  viewLonDeg: number,
  sinTilt: number,
  cosTilt: number,
  radius: number,
  out: GlobePoint = { x: 0, y: 0, z: 0 },
): GlobePoint {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const lam = viewLonDeg * DEG;
  // World point in the map's convention (sun.ts): x = cos lat cos lon, z = cos lat sin lon.
  const px = Math.cos(lat) * Math.cos(lon);
  const py = Math.sin(lat);
  const pz = Math.cos(lat) * Math.sin(lon);
  // View basis: forward f at (lam, tilt), east e, up u.
  const fx = cosTilt * Math.cos(lam);
  const fy = sinTilt;
  const fz = cosTilt * Math.sin(lam);
  const ex = -Math.sin(lam);
  const ez = Math.cos(lam);
  const ux = -sinTilt * Math.cos(lam);
  const uy = cosTilt;
  const uz = -sinTilt * Math.sin(lam);
  out.x = (px * ex + pz * ez) * radius;
  out.y = -(px * ux + py * uy + pz * uz) * radius;
  out.z = px * fx + py * fy + pz * fz;
  return out;
}

/** Points (lon, lat in degrees) along the great circle between two places, for arcs over a globe. */
export function greatCircle(lon0: number, lat0: number, lon1: number, lat1: number, steps: number): Array<[number, number]> {
  const toVec = (lon: number, lat: number) => [Math.cos(lat * DEG) * Math.cos(lon * DEG), Math.sin(lat * DEG), Math.cos(lat * DEG) * Math.sin(lon * DEG)];
  const p = toVec(lon0, lat0);
  const q = toVec(lon1, lat1);
  const dotPQ = Math.max(-1, Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]));
  const omega = Math.acos(dotPQ);
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    let v: number[];
    if (omega < 1e-6) v = p;
    else {
      const s0 = Math.sin((1 - f) * omega) / Math.sin(omega);
      const s1 = Math.sin(f * omega) / Math.sin(omega);
      v = [p[0] * s0 + q[0] * s1, p[1] * s0 + q[1] * s1, p[2] * s0 + q[2] * s1];
    }
    out.push([Math.atan2(v[2], v[0]) / DEG, Math.asin(Math.max(-1, Math.min(1, v[1]))) / DEG]);
  }
  return out;
}
