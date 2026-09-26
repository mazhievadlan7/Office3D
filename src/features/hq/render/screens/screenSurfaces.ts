import { HQ_SCREEN_APPS } from "./screenApps";
import { paintMarkets, paintMusic, paintNews } from "./screenBroadcast";
import { APP_PAINTERS, type HqScreenFeed, type Painter } from "./screenPaint";
import { paintExecMonitor, paintExecWall, paintMapLeft, paintMapRight } from "./screenPanels";

/**
 * Every surface the screen hub paints, shared by the painting worker and the
 * main-thread fallback: its size, how often it repaints and where it goes.
 * Pure (no three.js, no DOM), so it runs in a worker.
 *
 * Desk monitor apps and wall channels are tiles of two 2D atlases (a gutter
 * round every tile keeps mipmaps from bleeding between them); AM7's monitor
 * and the map panels are textures of their own. 2D textures, not texture
 * arrays: browsers copy an ImageBitmap into a 2D texture on the GPU, while
 * array layers go through a slow CPU readback.
 *
 * Orientation: every surface's first pixel row is the top of the picture and
 * lands at the smallest v of its tile (props.glb display UVs have v = 0 at
 * the top; the workstation shader and the map panels flip to match).
 */

export const MONITOR_W = 512;
export const MONITOR_H = 320;
export const WALL_W = 1024;
export const WALL_H = 576;
export const EXEC_W = 1792;
export const EXEC_H = 480;
export const MAP_W = 2048;
export const MAP_H = 600;
/** Width over height of the map wall's data panels (HqWorldMap sizes its planes by it). */
export const MAP_PANEL_ASPECT = MAP_W / MAP_H;

/** Wall screen channels, in tile order (HQ_WALL_SCREEN: AM7's report, news, business, radio). */
export const WALL_LAYERS = 4;

/** A grid of equal tiles, each inside a gutter of GUTTER pixels. */
export type ScreenAtlas = { tileW: number; tileH: number; cols: number; rows: number; width: number; height: number };

export const ATLAS_GUTTER = 8;

function atlas(tileW: number, tileH: number, tiles: number, cols: number): ScreenAtlas {
  const rows = Math.ceil(tiles / cols);
  return { tileW, tileH, cols, rows, width: cols * (tileW + 2 * ATLAS_GUTTER), height: rows * (tileH + 2 * ATLAS_GUTTER) };
}

/** Top-left pixel of a tile. */
export function tileOrigin(spec: ScreenAtlas, index: number): { x: number; y: number } {
  const col = index % spec.cols;
  const row = Math.floor(index / spec.cols);
  return {
    x: col * (spec.tileW + 2 * ATLAS_GUTTER) + ATLAS_GUTTER,
    y: row * (spec.tileH + 2 * ATLAS_GUTTER) + ATLAS_GUTTER,
  };
}

export const MONITOR_ATLAS = atlas(MONITOR_W, MONITOR_H, HQ_SCREEN_APPS.length, 4);
export const WALL_ATLAS = atlas(WALL_W, WALL_H, WALL_LAYERS, 2);

export type ScreenTarget =
  | { kind: "layer"; set: "monitors" | "walls"; layer: number }
  | { kind: "single"; id: "exec" | "mapLeft" | "mapRight" };

/**
 * The big screens the hub can see or not (screenViews.ts): a surface with a
 * view repaints at `period` while one of its screens is in view and at
 * `idlePeriod` otherwise. Surfaces without one always repaint at `period`.
 */
export type ScreenView = "execWall" | "news" | "markets" | "music" | "exec";

export type ScreenSurface = {
  target: ScreenTarget;
  w: number;
  h: number;
  /** Seconds between repaints at full quality (while in view). */
  period: number;
  /** Seconds between repaints while none of its screens is in view. */
  idlePeriod?: number;
  view?: ScreenView;
  paint: (p: Painter, t: number, feed: HqScreenFeed) => void;
};

/** Off-screen channels still repaint now and then, so a glance never finds a stale picture. */
const IDLE_PERIOD = 2;

/** Seconds between repaints of each monitor app (typing apps repaint fastest). */
const APP_PERIOD: Partial<Record<(typeof HQ_SCREEN_APPS)[number], number>> = {
  code_ts: 0.25,
  code_py: 0.25,
  term_build: 0.4,
  term_ops: 0.4,
  tests: 0.4,
  logs: 0.33,
  docs: 0.3,
  alert: 0.5,
  lock: 5,
};
const DEFAULT_APP_PERIOD = 0.8;

export const SCREEN_SURFACES: readonly ScreenSurface[] = [
  ...HQ_SCREEN_APPS.map((name, layer): ScreenSurface => {
    const app = APP_PAINTERS[name];
    const seed = (layer * 0.6180339) % 1;
    return {
      target: { kind: "layer", set: "monitors", layer },
      w: MONITOR_W,
      h: MONITOR_H,
      period: APP_PERIOD[name] ?? DEFAULT_APP_PERIOD,
      paint: (p, t, feed) => app(p, t, seed, feed),
    };
  }),
  // Layer order = HQ_WALL_SCREEN: AM7's report, news, business, radio. The
  // channels with a crawl or a turning Earth repaint at broadcast-like rates
  // while someone is watching, and rest otherwise.
  { target: { kind: "layer", set: "walls", layer: 0 }, w: WALL_W, h: WALL_H, period: 1 / 10, idlePeriod: IDLE_PERIOD, view: "execWall", paint: paintExecWall },
  { target: { kind: "layer", set: "walls", layer: 1 }, w: WALL_W, h: WALL_H, period: 1 / 20, idlePeriod: IDLE_PERIOD, view: "news", paint: paintNews },
  { target: { kind: "layer", set: "walls", layer: 2 }, w: WALL_W, h: WALL_H, period: 1 / 16, idlePeriod: IDLE_PERIOD, view: "markets", paint: paintMarkets },
  { target: { kind: "layer", set: "walls", layer: 3 }, w: WALL_W, h: WALL_H, period: 1 / 15, idlePeriod: IDLE_PERIOD, view: "music", paint: paintMusic },
  { target: { kind: "single", id: "exec" }, w: EXEC_W, h: EXEC_H, period: 1 / 6, idlePeriod: IDLE_PERIOD, view: "exec", paint: paintExecMonitor },
  { target: { kind: "single", id: "mapLeft" }, w: MAP_W, h: MAP_H, period: 0.25, paint: paintMapLeft },
  { target: { kind: "single", id: "mapRight" }, w: MAP_W, h: MAP_H, period: 0.2, paint: paintMapRight },
];

/** Seconds between repaints of a surface, given whether any of its screens is in view. */
export function surfacePeriod(surface: ScreenSurface, inView: boolean): number {
  return inView || surface.idlePeriod === undefined ? surface.period : Math.max(surface.period, surface.idlePeriod);
}

/**
 * GLSL: `vec2 <name>(float tile, vec2 p)`, the atlas UV of point p inside a
 * tile, p in 0..1 from the tile's top-left corner (x right, y down).
 */
export function atlasUvGlsl(name: string, spec: ScreenAtlas): string {
  const f = (v: number) => v.toFixed(6);
  const cellW = spec.tileW + 2 * ATLAS_GUTTER;
  const cellH = spec.tileH + 2 * ATLAS_GUTTER;
  return /* glsl */ `
vec2 ${name}(float tile, vec2 p) {
  float col = mod(tile, ${f(spec.cols)});
  float row = floor(tile / ${f(spec.cols)} + 0.0001);
  vec2 origin = vec2(col * ${f(cellW / spec.width)}, row * ${f(cellH / spec.height)}) + vec2(${f(ATLAS_GUTTER / spec.width)}, ${f(ATLAS_GUTTER / spec.height)});
  return origin + clamp(p, 0.0, 1.0) * vec2(${f(spec.tileW / spec.width)}, ${f(spec.tileH / spec.height)});
}
`;
}

/**
 * GLSL: the screen textures hold sRGB bytes in plain RGBA8 (the fastest
 * format to copy an ImageBitmap into and to mipmap), so shaders decode them.
 */
export const SRGB_DECODE_GLSL = /* glsl */ `
vec3 hqSrgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
`;
