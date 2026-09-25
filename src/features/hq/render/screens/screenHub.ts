import * as THREE from "three";
import { HQ_STATUS_CODE, type HqAgentInput } from "@/features/hq/core/types";
import type { HqQuality } from "@/features/hq/render/scene/quality";
import { HQ_SCREEN_APPS } from "./screenApps";
import { APP_PAINTERS, EMPTY_FEED, Painter, type Ctx2D, type HqScreenFeed } from "./screenPaint";
import {
  paintExecMonitor,
  paintExecWall,
  paintMapLeft,
  paintMapRight,
  paintMusic,
  paintNews,
  paintSecurity,
} from "./screenPanels";

/**
 * Owns every screen texture in the HQ and keeps them moving:
 *
 *  - `monitors`: a texture array with one layer per desk app (code editor,
 *    terminal, logs…); every desk monitor samples the layer its agent's role
 *    and status call for (workstations/materials.ts).
 *  - `walls`: a texture array for the wall screens, one layer per channel
 *    (HQ_WALL_SCREEN): AM7's executive report, the lounge's news channel,
 *    security monitor and music visualiser.
 *  - `exec`: AM7's curved command monitor.
 *  - `mapLeft` / `mapRight`: the data panels either side of the globe.
 *
 * Painting is Canvas 2D, a few surfaces per frame on a round-robin schedule,
 * so the cost is spread out; each surface repaints every fraction of a second
 * to a couple of seconds depending on how busy its content is.
 */

const MONITOR_W = 512;
const MONITOR_H = 320;
const WALL_W = 1024;
const WALL_H = 576;
const EXEC_W = 1792;
const EXEC_H = 480;
const MAP_W = 2048;
const MAP_H = 600;
/** Width over height of the map wall's data panels (HqWorldMap sizes its planes by it). */
export const MAP_PANEL_ASPECT = MAP_W / MAP_H;

/** Seconds between repaints of each monitor app (typing apps repaint fastest). */
const APP_PERIOD: Record<string, number> = {
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
/** Slower everywhere on lower quality tiers. */
const QUALITY_SLOWDOWN: Record<HqQuality, number> = { high: 1, medium: 1.5, low: 3 };
/** Surfaces painted per frame at most (monitor layers, then big panels). */
const MONITOR_BUDGET = 3;
const PANEL_BUDGET = 1;
const FEED_PERIOD = 1;
const HISTORY = 180;
const EVENTS = 24;

function createContext(width: number, height: number, readback: boolean): { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: Ctx2D } {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: readback });
    if (ctx) return { canvas, ctx };
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: readback });
  if (!ctx) throw new Error("HQ screens: 2D canvas is unavailable");
  return { canvas, ctx };
}

function arrayTexture(width: number, height: number, layers: number): THREE.DataArrayTexture {
  const data = new Uint8Array(width * height * 4 * layers);
  // Start dark (a powered-off panel), fully opaque.
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const texture = new THREE.DataArrayTexture(data, width, height, layers);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

function canvasTexture(canvas: HTMLCanvasElement | OffscreenCanvas, flipY: boolean): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = flipY;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = 8;
  return texture;
}

type Layered = {
  texture: THREE.DataArrayTexture;
  painter: Painter;
  width: number;
  height: number;
  paint: Array<(p: Painter, t: number, feed: HqScreenFeed) => void>;
  period: number[];
  next: Float64Array;
};

type Single = {
  texture: THREE.CanvasTexture;
  painter: Painter;
  paint: (p: Painter, t: number, feed: HqScreenFeed) => void;
  period: number;
  next: number;
};

export class HqScreenHub {
  readonly monitors: THREE.DataArrayTexture;
  readonly walls: THREE.DataArrayTexture;
  readonly exec: THREE.CanvasTexture;
  readonly mapLeft: THREE.CanvasTexture;
  readonly mapRight: THREE.CanvasTexture;

  private readonly layered: Layered[];
  private readonly singles: Single[];
  private feed: HqScreenFeed = EMPTY_FEED;
  private feedAt = -Infinity;
  private readonly lastStatus = new Map<string, number>();
  private readonly events: Array<{ at: number; name: string; status: number }> = [];
  private readonly history: number[] = [];
  private slowdown = 1;
  private cursor = 0;

  constructor() {
    const mon = createContext(MONITOR_W, MONITOR_H, true);
    this.monitors = arrayTexture(MONITOR_W, MONITOR_H, HQ_SCREEN_APPS.length);
    const monitorLayers: Layered = {
      texture: this.monitors,
      painter: new Painter(mon.ctx, MONITOR_W, MONITOR_H),
      width: MONITOR_W,
      height: MONITOR_H,
      paint: HQ_SCREEN_APPS.map((name, i) => {
        const app = APP_PAINTERS[name];
        const seed = (i * 0.6180339) % 1;
        return (p: Painter, t: number, feed: HqScreenFeed) => app(p, t, seed, feed);
      }),
      period: HQ_SCREEN_APPS.map((name) => APP_PERIOD[name] ?? DEFAULT_APP_PERIOD),
      next: new Float64Array(HQ_SCREEN_APPS.length),
    };

    const wall = createContext(WALL_W, WALL_H, true);
    this.walls = arrayTexture(WALL_W, WALL_H, 4);
    const wallLayers: Layered = {
      texture: this.walls,
      painter: new Painter(wall.ctx, WALL_W, WALL_H),
      width: WALL_W,
      height: WALL_H,
      // Layer order = HQ_WALL_SCREEN.
      paint: [paintExecWall, paintNews, paintSecurity, (p, t) => paintMusic(p, t)],
      period: [1, 0.12, 0.25, 0.1],
      next: new Float64Array(4),
    };
    this.layered = [monitorLayers, wallLayers];

    const exec = createContext(EXEC_W, EXEC_H, false);
    const left = createContext(MAP_W, MAP_H, false);
    const right = createContext(MAP_W, MAP_H, false);
    // AM7's monitor comes from props.glb (UV v = 0 at the top); the map panels are plain planes.
    this.exec = canvasTexture(exec.canvas, false);
    this.mapLeft = canvasTexture(left.canvas, true);
    this.mapRight = canvasTexture(right.canvas, true);
    this.singles = [
      { texture: this.exec, painter: new Painter(exec.ctx, EXEC_W, EXEC_H), paint: paintExecMonitor, period: 0.5, next: 0 },
      { texture: this.mapLeft, painter: new Painter(left.ctx, MAP_W, MAP_H), paint: paintMapLeft, period: 0.5, next: 0.15 },
      { texture: this.mapRight, painter: new Painter(right.ctx, MAP_W, MAP_H), paint: paintMapRight, period: 0.6, next: 0.3 },
    ];
  }

  setQuality(quality: HqQuality): void {
    this.slowdown = QUALITY_SLOWDOWN[quality];
  }

  /** Per frame: refresh the floor feed about once a second and repaint what is due. */
  update(seconds: number, agents: readonly HqAgentInput[]): void {
    if (seconds - this.feedAt >= FEED_PERIOD || seconds < this.feedAt) {
      this.feedAt = seconds;
      this.feed = this.buildFeed(agents);
    }
    for (const set of this.layered) this.paintLayers(set, seconds, set === this.layered[0] ? MONITOR_BUDGET : 1);
    let painted = 0;
    for (let k = 0; k < this.singles.length && painted < PANEL_BUDGET; k++) {
      const s = this.singles[(this.cursor + k) % this.singles.length];
      if (seconds < s.next) continue;
      s.next = seconds + s.period * this.slowdown;
      s.paint(s.painter, seconds, this.feed);
      s.texture.needsUpdate = true;
      painted++;
    }
    this.cursor = (this.cursor + 1) % this.singles.length;
  }

  private paintLayers(set: Layered, seconds: number, budget: number): void {
    let painted = 0;
    const n = set.paint.length;
    const start = Math.floor(seconds * 97) % n;
    for (let k = 0; k < n && painted < budget; k++) {
      const layer = (start + k) % n;
      if (seconds < set.next[layer]) continue;
      set.next[layer] = seconds + set.period[layer] * this.slowdown;
      set.paint[layer](set.painter, seconds, this.feed);
      const pixels = set.painter.ctx.getImageData(0, 0, set.width, set.height).data;
      const image = set.texture.image as { data: Uint8Array };
      image.data.set(pixels, layer * set.width * set.height * 4);
      set.texture.addLayerUpdate(layer);
      painted++;
    }
    if (painted > 0) set.texture.needsUpdate = true;
  }

  private buildFeed(agents: readonly HqAgentInput[]): HqScreenFeed {
    const clock = Date.now();
    let working = 0;
    let idle = 0;
    let error = 0;
    const names: string[] = [];
    const seen = new Set<string>();
    for (const agent of agents) {
      const status = HQ_STATUS_CODE[agent.status] ?? 1;
      if (status === 0) working++;
      else if (status === 2) error++;
      else idle++;
      if (names.length < 256 && agent.name) names.push(agent.name);
      seen.add(agent.id);
      const before = this.lastStatus.get(agent.id);
      if (before !== undefined && before !== status) {
        this.events.unshift({ at: clock, name: agent.name || agent.id, status });
      }
      this.lastStatus.set(agent.id, status);
    }
    for (const id of this.lastStatus.keys()) if (!seen.has(id)) this.lastStatus.delete(id);
    if (this.events.length > EVENTS) this.events.length = EVENTS;
    const total = agents.length;
    this.history.push(total > 0 ? working / total : 0);
    if (this.history.length > HISTORY) this.history.shift();
    return { clock, total, working, idle, error, names, events: this.events.slice(), history: this.history.slice() };
  }

  dispose(): void {
    this.monitors.dispose();
    this.walls.dispose();
    this.exec.dispose();
    this.mapLeft.dispose();
    this.mapRight.dispose();
  }
}
