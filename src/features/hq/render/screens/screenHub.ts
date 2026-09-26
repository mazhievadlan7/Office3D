import * as THREE from "three";
import { HQ_ROLE_FAMILY_COUNT, hqRoleFamily } from "@/features/hq/core/roles";
import { HQ_STATUS_CODE, type HqAgentInput } from "@/features/hq/core/types";
import type { HqQuality } from "@/features/hq/render/scene/quality";
import { EMPTY_FEED, Painter, type Ctx2D, type HqScreenFeed, type HqTeamStat } from "./screenPaint";
import {
  EXEC_H,
  EXEC_W,
  MAP_H,
  MAP_W,
  MONITOR_ATLAS,
  SCREEN_SURFACES,
  WALL_ATLAS,
  surfacePeriod,
  tileOrigin,
  type ScreenAtlas,
  type ScreenSurface,
  type ScreenView,
} from "./screenSurfaces";
import { anchorFacing, type ScreenAnchor } from "./screenViews";

export { MAP_PANEL_ASPECT } from "./screenSurfaces";

/**
 * Owns every screen texture in the HQ and keeps them moving:
 *
 *  - `monitors`: an atlas with one tile per desk app (code editor, terminal,
 *    logs…); every desk monitor samples the tile its agent's role and status
 *    call for (workstations/materials.ts).
 *  - `walls`: an atlas for the wall screens, one tile per channel
 *    (HQ_WALL_SCREEN): AM7's report, the lounge's news, business and radio.
 *  - `exec`: AM7's curved command monitor.
 *  - `mapLeft` / `mapRight`: the data panels either side of the world map.
 *
 * The painting (Canvas 2D, SCREEN_SURFACES) runs in a worker on
 * OffscreenCanvases; finished frames arrive as ImageBitmaps and go straight
 * to the GPU (a GPU-side copy of the bitmap into its tile, then one mipmap
 * pass per texture), a few per frame, so the main thread only uploads.
 * Browsers without OffscreenCanvas in workers paint here instead, more
 * slowly and within a small budget.
 *
 * The big screens (lounge TVs, AM7's office) repaint at broadcast rates only
 * while the camera can see one of them (setAnchors + the camera per frame);
 * off screen they rest at a slow idle rate.
 *
 * Every picture's first pixel row is its top, at the smallest v.
 */

/** Uploads per frame at most (a monitor tile is 0.6 MB, a map panel 4.9 MB). */
const LAYER_UPLOADS_PER_FRAME = 4;
const SINGLE_UPLOADS_PER_FRAME = 1;
/** The main-thread fallback repaints this much less often than the worker. */
const FALLBACK_SLOWDOWN = 3;
const FALLBACK_PAINTS_PER_FRAME = 1;
/** Slower everywhere on lower quality tiers (the HQ now always runs high). */
const QUALITY_SLOWDOWN: Record<HqQuality, number> = { high: 1, medium: 1.5, low: 3 };
const FEED_PERIOD = 1;
/**
 * Mipmaps of a texture are rebuilt at most this often: the full-size level
 * is always fresh, the smaller ones (screens seen from afar) lag a moment.
 */
const MIPMAP_PERIOD = 0.4;
/** The wall atlas while a channel is on screen: TVs seen from across the room move too. */
const WALL_MIPMAP_PERIOD = 1 / 12;
const HISTORY = 180;
const EVENTS = 24;
/** How often the visibility of the big screens is re-checked. */
const VIEW_PERIOD = 0.2;
/** Per-family working counts are kept this many seconds back for the "change in a minute" columns. */
const TEAM_HISTORY = 60;
const NO_ANCHORS: readonly ScreenAnchor[] = [];

type Ready = { index: number; bitmap: ImageBitmap };

function planeTexture(width: number, height: number): THREE.DataTexture {
  const data = new Uint8Array(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  // Start dark (a powered-off panel), fully opaque.
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  // sRGB bytes in plain RGBA8: the GPU copies bitmaps into it and mipmaps it
  // fastest; the screen shaders decode (screenSurfaces.ts SRGB_DECODE_GLSL).
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

function workerSupported(): boolean {
  return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof ImageBitmap !== "undefined";
}

export class HqScreenHub {
  readonly monitors = planeTexture(MONITOR_ATLAS.width, MONITOR_ATLAS.height);
  readonly walls = planeTexture(WALL_ATLAS.width, WALL_ATLAS.height);
  readonly exec = planeTexture(EXEC_W, EXEC_H);
  readonly mapLeft = planeTexture(MAP_W, MAP_H);
  readonly mapRight = planeTexture(MAP_W, MAP_H);

  private worker: Worker | null = null;
  private readonly ready = new Map<number, ImageBitmap>();
  private fallback: { painters: Map<string, { ctx: Ctx2D; painter: Painter }>; next: Float64Array } | null = null;
  private feed: HqScreenFeed = { ...EMPTY_FEED };
  private feedAt = -Infinity;
  private readonly lastStatus = new Map<string, number>();
  private readonly events: Array<{ at: number; name: string; status: number }> = [];
  private readonly history: number[] = [];
  private sample = 0;
  private slowdown = 1;
  private disposed = false;
  private readonly mipmapAt = new Map<THREE.Texture, number>();
  private readonly mipmapDue = new Set<THREE.DataTexture>();
  /** Null until the props report where the screens hang: then everything counts as seen. */
  private anchors: Map<ScreenView, ScreenAnchor[]> | null = null;
  /** 1 while a surface's screens are in view (or it has no view to track). */
  private readonly inView = new Uint8Array(SCREEN_SURFACES.length).fill(1);
  private viewAt = -Infinity;
  private readonly frustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private readonly familyOf = new Map<string, number>();
  private readonly teamWorking: number[][] = [];

  constructor() {
    if (workerSupported()) {
      try {
        const worker = new Worker(new URL("./screens.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<Ready>) => {
          const { index, bitmap } = event.data;
          if (this.disposed) {
            bitmap.close();
            return;
          }
          this.ready.get(index)?.close();
          this.ready.set(index, bitmap);
        };
        worker.onerror = () => this.useFallback();
        this.worker = worker;
      } catch {
        this.useFallback();
      }
    } else {
      this.useFallback();
    }
  }

  setQuality(quality: HqQuality): void {
    this.slowdown = QUALITY_SLOWDOWN[quality];
    this.worker?.postMessage({ type: "slowdown", value: this.slowdown });
  }

  /**
   * Where the big screens are (screenViews.ts screenAnchors). A view no screen
   * of the layout shows (the radio below capacity 1000) is never seen, so it
   * rests at its idle rate.
   */
  setAnchors(anchors: Map<ScreenView, ScreenAnchor[]>): void {
    this.anchors = anchors;
    this.viewAt = -Infinity;
  }

  /** Per frame: refresh the floor feed about once a second and upload what is ready. */
  update(seconds: number, agents: readonly HqAgentInput[], renderer: THREE.WebGLRenderer, camera?: THREE.Camera): void {
    if (seconds - this.feedAt >= FEED_PERIOD || seconds < this.feedAt) {
      this.feedAt = seconds;
      this.feed = this.buildFeed(agents);
      this.worker?.postMessage({ type: "feed", feed: this.feed });
    }
    if (camera && (seconds - this.viewAt >= VIEW_PERIOD || seconds < this.viewAt)) {
      this.viewAt = seconds;
      this.updateViews(camera);
    }
    if (this.worker) this.uploadReady(renderer, seconds);
    else this.paintHere(seconds);
  }

  /** Which big screens the camera can see; tells the worker when that changes. */
  private updateViews(camera: THREE.Camera): void {
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProjection);
    const eye = camera.matrixWorld.elements;
    const ex = eye[12];
    const ey = eye[13];
    const ez = eye[14];
    let changed = false;
    for (let i = 0; i < SCREEN_SURFACES.length; i++) {
      const view = SCREEN_SURFACES[i].view;
      let next = 1;
      if (view !== undefined && this.anchors) {
        next = 0;
        for (const a of this.anchors.get(view) ?? NO_ANCHORS) {
          if (!anchorFacing(a, ex, ey, ez)) continue;
          this.sphere.center.set(a.x, a.y, a.z);
          this.sphere.radius = a.r;
          if (this.frustum.intersectsSphere(this.sphere)) {
            next = 1;
            break;
          }
        }
      }
      if (next !== this.inView[i]) {
        this.inView[i] = next;
        changed = true;
        // Coming into view: repaint now rather than at the end of an idle wait.
        if (next && this.fallback) this.fallback.next[i] = 0;
      }
    }
    if (changed) this.worker?.postMessage({ type: "views", value: Array.from(this.inView) });
  }

  private uploadReady(renderer: THREE.WebGLRenderer, seconds: number): void {
    this.refreshMipmaps(renderer, seconds);
    if (this.ready.size === 0) return;
    let layers = 0;
    let singles = 0;
    const touched = this.mipmapDue;
    for (const [index, bitmap] of this.ready) {
      const target = SCREEN_SURFACES[index].target;
      if (target.kind === "layer" ? layers >= LAYER_UPLOADS_PER_FRAME : singles >= SINGLE_UPLOADS_PER_FRAME) continue;
      this.ready.delete(index);
      if (target.kind === "layer") {
        layers++;
        const [texture, spec] = this.atlasOf(target.set);
        const { x, y } = tileOrigin(spec, target.layer);
        if (uploadRect(renderer, texture, x, y, bitmap)) touched.add(texture);
      } else {
        singles++;
        if (uploadRect(renderer, this[target.id], 0, 0, bitmap)) touched.add(this[target.id]);
      }
      bitmap.close();
      this.worker?.postMessage({ type: "ack", index });
    }
    this.refreshMipmaps(renderer, seconds);
  }

  /** One mipmap pass per changed texture, at most every MIPMAP_PERIOD (faster for a watched wall channel). */
  private refreshMipmaps(renderer: THREE.WebGLRenderer, seconds: number): void {
    for (const texture of this.mipmapDue) {
      const last = this.mipmapAt.get(texture) ?? -Infinity;
      const period = texture === this.walls && this.wallInView() ? WALL_MIPMAP_PERIOD : MIPMAP_PERIOD;
      if (seconds - last < period && seconds >= last) continue;
      mipmap(renderer, texture);
      this.mipmapAt.set(texture, seconds);
      this.mipmapDue.delete(texture);
    }
  }

  /** Whether a tracked wall channel is on screen right now. */
  private wallInView(): boolean {
    for (let i = 0; i < SCREEN_SURFACES.length; i++) {
      const s = SCREEN_SURFACES[i];
      if (s.target.kind === "layer" && s.target.set === "walls" && s.view !== undefined && this.anchors?.has(s.view) && this.inView[i]) return true;
    }
    return false;
  }

  private atlasOf(set: "monitors" | "walls"): [THREE.DataTexture, ScreenAtlas] {
    return set === "monitors" ? [this.monitors, MONITOR_ATLAS] : [this.walls, WALL_ATLAS];
  }

  private useFallback(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const bitmap of this.ready.values()) bitmap.close();
    this.ready.clear();
    if (!this.fallback) this.fallback = { painters: new Map(), next: new Float64Array(SCREEN_SURFACES.length) };
  }

  /** Main-thread fallback: one surface per frame, slower than the worker. */
  private paintHere(seconds: number): void {
    const fallback = this.fallback;
    if (!fallback) return;
    let painted = 0;
    const count = SCREEN_SURFACES.length;
    const start = Math.floor(seconds * 97) % count;
    for (let k = 0; k < count && painted < FALLBACK_PAINTS_PER_FRAME; k++) {
      const i = (start + k) % count;
      if (seconds < fallback.next[i]) continue;
      const surface = SCREEN_SURFACES[i];
      fallback.next[i] = seconds + surfacePeriod(surface, this.inView[i] === 1) * this.slowdown * FALLBACK_SLOWDOWN;
      const { painter } = this.fallbackPainter(surface);
      // The clocks read the wall clock at paint time, as in the worker.
      this.feed.clock = Date.now();
      surface.paint(painter, seconds, this.feed);
      const pixels = painter.ctx.getImageData(0, 0, surface.w, surface.h).data;
      const target = surface.target;
      const [texture, x, y] =
        target.kind === "layer"
          ? (() => {
              const [atlasTexture, spec] = this.atlasOf(target.set);
              const origin = tileOrigin(spec, target.layer);
              return [atlasTexture, origin.x, origin.y] as const;
            })()
          : ([this[target.id], 0, 0] as const);
      const image = texture.image as { data: Uint8Array; width: number };
      for (let row = 0; row < surface.h; row++) {
        const from = row * surface.w * 4;
        image.data.set(pixels.subarray(from, from + surface.w * 4), ((y + row) * image.width + x) * 4);
      }
      // Only the rows of this tile go up again.
      texture.addUpdateRange(y * image.width * 4, surface.h * image.width * 4);
      texture.needsUpdate = true;
      painted++;
    }
  }

  private fallbackPainter(surface: ScreenSurface): { ctx: Ctx2D; painter: Painter } {
    const fallback = this.fallback!;
    const key = `${surface.w}x${surface.h}`;
    let entry = fallback.painters.get(key);
    if (!entry) {
      const canvas = document.createElement("canvas");
      canvas.width = surface.w;
      canvas.height = surface.h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true, alpha: false });
      if (!ctx) throw new Error("HQ screens: 2D canvas is unavailable");
      entry = { ctx, painter: new Painter(ctx, surface.w, surface.h) };
      fallback.painters.set(key, entry);
    }
    return entry;
  }

  private buildFeed(agents: readonly HqAgentInput[]): HqScreenFeed {
    const clock = Date.now();
    let working = 0;
    let idle = 0;
    let error = 0;
    const names: string[] = [];
    const seen = new Set<string>();
    const teams: HqTeamStat[] = [];
    for (let f = 0; f < HQ_ROLE_FAMILY_COUNT; f++) teams.push({ total: 0, working: 0, error: 0, workingAgo: 0 });
    for (const agent of agents) {
      const status = HQ_STATUS_CODE[agent.status] ?? 1;
      if (status === 0) working++;
      else if (status === 2) error++;
      else idle++;
      // Departments: role text to family, remembered per distinct role.
      const role = agent.role ?? "";
      let family = this.familyOf.get(role);
      if (family === undefined) {
        family = hqRoleFamily(role);
        if (this.familyOf.size < 512) this.familyOf.set(role, family);
      }
      const team = teams[family];
      team.total++;
      if (status === 0) team.working++;
      else if (status === 2) team.error++;
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
    this.teamWorking.push(teams.map((team) => team.working));
    if (this.teamWorking.length > TEAM_HISTORY + 1) this.teamWorking.shift();
    const ago = this.teamWorking[0];
    teams.forEach((team, f) => (team.workingAgo = ago[f] ?? team.working));
    this.sample++;
    return { clock, sample: this.sample, total, working, idle, error, names, events: this.events.slice(), history: this.history.slice(), teams };
  }

  dispose(): void {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    for (const bitmap of this.ready.values()) bitmap.close();
    this.ready.clear();
    this.monitors.dispose();
    this.walls.dispose();
    this.exec.dispose();
    this.mapLeft.dispose();
    this.mapRight.dispose();
  }
}

// --- direct GPU uploads ---------------------------------------------------------------------
// three.js owns the textures; after `initTexture` allocates them, frames are
// written into them straight from the worker's ImageBitmaps (no CPU copy),
// binding through three's state cache so its own bindings stay correct.

function glTextureOf(renderer: THREE.WebGLRenderer, texture: THREE.Texture): WebGLTexture | null {
  let props = renderer.properties.get(texture) as { __webglTexture?: WebGLTexture; __version?: number };
  if (!props.__webglTexture || props.__version !== texture.version) {
    renderer.initTexture(texture);
    props = renderer.properties.get(texture) as { __webglTexture?: WebGLTexture };
  }
  return props.__webglTexture ?? null;
}

// three r184+ caches pixel-store state; set it through the cache when there is one.
function resetUnpack(renderer: THREE.WebGLRenderer, gl: WebGL2RenderingContext): void {
  const cached = (renderer.state as unknown as { pixelStorei?: (name: number, value: number | boolean) => void }).pixelStorei;
  const set = cached ? (name: number, value: number | boolean) => cached.call(renderer.state, name, value) : (name: number, value: number | boolean) => gl.pixelStorei(name, value as number);
  set(gl.UNPACK_FLIP_Y_WEBGL, false);
  set(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  set(gl.UNPACK_ROW_LENGTH, 0);
  set(gl.UNPACK_IMAGE_HEIGHT, 0);
  set(gl.UNPACK_SKIP_PIXELS, 0);
  set(gl.UNPACK_SKIP_ROWS, 0);
  set(gl.UNPACK_SKIP_IMAGES, 0);
}

function uploadRect(renderer: THREE.WebGLRenderer, texture: THREE.DataTexture, x: number, y: number, bitmap: ImageBitmap): boolean {
  const handle = glTextureOf(renderer, texture);
  if (!handle) return false;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  renderer.state.bindTexture(gl.TEXTURE_2D, handle);
  resetUnpack(renderer, gl);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  return true;
}

function mipmap(renderer: THREE.WebGLRenderer, texture: THREE.DataTexture): void {
  const handle = glTextureOf(renderer, texture);
  if (!handle) return;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  renderer.state.bindTexture(gl.TEXTURE_2D, handle);
  gl.generateMipmap(gl.TEXTURE_2D);
}
