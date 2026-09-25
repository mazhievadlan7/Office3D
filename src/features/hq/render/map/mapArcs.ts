import * as THREE from "three";
import { latToV } from "@/features/hq/render/map/mapProjection";
import type { HqQuality } from "@/features/hq/render/scene/quality";

// Travelling arcs between hotspots. Every arc is one instance of a shared
// ribbon strip; the vertex shader bends it, so the CPU only rewrites two
// vec4 attributes when a slot is (re)spawned.

export const ARC_SLOTS: Record<HqQuality, number> = { high: 28, medium: 20, low: 10 };
export const ARC_SEGMENTS: Record<HqQuality, number> = { high: 72, medium: 48, low: 20 };
/** Always-on arcs at zero activity; the rest scale with activity. */
const ARC_MIN_ACTIVE = 3;
/** Comet tail length and fade-out after landing, as fractions of the flight time (uTail / uFade in the shader). */
export const ARC_TAIL = 0.32;
export const ARC_FADE = 0.5;
const EQUATOR_V = latToV(0);

export type ArcBuffers = {
  geometry: THREE.InstancedBufferGeometry;
  /** Per arc: from u, v, to u, v (normalised map coordinates). */
  ends: THREE.InstancedBufferAttribute;
  endsArray: Float32Array;
  /** Per arc: start time, duration (0 = free slot), bow, seed. */
  timing: THREE.InstancedBufferAttribute;
  timingArray: Float32Array;
};

/** A strip of `segments` quads; position.x is the path fraction, position.y the side (-1..1). */
export function createArcBuffers(segments: number, slots: number, boundsRadius: number): ArcBuffers {
  const verts = new Float32Array((segments + 1) * 2 * 3);
  const index: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    verts.set([t, -1, 0, t, 1, 0], i * 6);
    if (i < segments) {
      const a = i * 2;
      index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  geometry.setIndex(index);
  const endsArray = new Float32Array(slots * 4);
  const timingArray = new Float32Array(slots * 4);
  const ends = new THREE.InstancedBufferAttribute(endsArray, 4);
  const timing = new THREE.InstancedBufferAttribute(timingArray, 4);
  ends.setUsage(THREE.DynamicDrawUsage);
  timing.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("aEnds", ends);
  geometry.setAttribute("aTiming", timing);
  geometry.instanceCount = slots;
  // The strip's own positions are parameters, not metres: give culling the
  // display's real extent instead.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0.5), boundsRadius);
  geometry.boundingBox = null;
  return { geometry, ends, endsArray, timing, timingArray };
}

/**
 * Spawns and retires arcs. Holds no GPU objects; writes straight into the
 * attribute arrays it is given and reports when they need uploading.
 */
export class ArcScheduler {
  private readonly to: Int16Array;
  private readonly landed: Uint8Array;
  private readonly nextSpawn: Float32Array;
  private seed: number;
  private started = false;

  constructor(
    /** Hotspots as interleaved u, v. */
    private readonly hotspots: Float32Array,
    readonly slots: number,
    seed = 0x5eed,
  ) {
    this.to = new Int16Array(slots);
    this.landed = new Uint8Array(slots);
    this.nextSpawn = new Float32Array(slots);
    this.seed = seed >>> 0;
    // Stagger the first wave (relative to the first update) so arcs never
    // launch in lockstep.
    for (let i = 0; i < slots; i++) this.nextSpawn[i] = 0.4 + this.random() * 2.5;
  }

  /**
   * Advances every slot. `flash` receives 1 for a hotspot an arc just reached.
   * Returns true when `ends` or `timing` changed.
   */
  update(time: number, activity: number, ends: Float32Array, timing: Float32Array, flash: Float32Array): boolean {
    if (!this.started) {
      this.started = true;
      for (let i = 0; i < this.slots; i++) this.nextSpawn[i] += time;
    }
    const target = Math.round(ARC_MIN_ACTIVE + (this.slots - ARC_MIN_ACTIVE) * activity);
    let dirty = false;
    for (let i = 0; i < this.slots; i++) {
      const o = i * 4;
      const duration = timing[o + 1];
      if (duration > 0) {
        const life = (time - timing[o]) / duration;
        if (!this.landed[i] && life >= 1) {
          this.landed[i] = 1;
          flash[this.to[i]] = 1;
        }
        // Matches the shader's fade: gone once life passes 1 + tail / 2 + fade.
        if (life > 1 + ARC_TAIL * 0.5 + ARC_FADE + 0.05) {
          timing[o + 1] = 0;
          // Busier HQ, shorter gaps between launches.
          this.nextSpawn[i] = time + (0.3 + this.random() * 2.2) * (1.6 - activity);
          dirty = true;
        }
      } else if (i < target && time >= this.nextSpawn[i]) {
        this.spawn(i, time, activity, ends, timing);
        dirty = true;
      }
    }
    return dirty;
  }

  /** Shifts every stored time back by `period` when the caller wraps its clock. */
  rebase(period: number, timing: Float32Array): void {
    for (let i = 0; i < this.slots; i++) {
      timing[i * 4] -= period;
      this.nextSpawn[i] -= period;
    }
  }

  private spawn(i: number, time: number, activity: number, ends: Float32Array, timing: Float32Array): void {
    const count = this.hotspots.length / 2;
    let a = 0;
    let b = 0;
    let du = 0;
    let dv = 0;
    // Prefer pairs far enough apart to read as a long-haul link.
    for (let attempt = 0; attempt < 8; attempt++) {
      a = Math.floor(this.random() * count);
      b = Math.floor(this.random() * (count - 1));
      if (b >= a) b++;
      du = this.hotspots[b * 2] - this.hotspots[a * 2];
      dv = this.hotspots[b * 2 + 1] - this.hotspots[a * 2 + 1];
      if (du * du + dv * dv > 0.02) break;
    }
    const dist = Math.sqrt(du * du + dv * dv);
    const o = i * 4;
    ends[o] = this.hotspots[a * 2];
    ends[o + 1] = this.hotspots[a * 2 + 1];
    ends[o + 2] = this.hotspots[b * 2];
    ends[o + 3] = this.hotspots[b * 2 + 1];
    // Bow toward the nearer pole, as great circles do on this projection. The
    // shader offsets along n = (-dv, du), whose y sign follows du.
    const midV = (ends[o + 1] + ends[o + 3]) / 2;
    const towardNorth = midV > EQUATOR_V ? 1 : -1;
    const nySign = du >= 0 ? 1 : -1;
    const bow = (0.14 + this.random() * 0.14) * towardNorth * nySign;
    const speed = 0.7 + 0.9 * activity;
    const duration = ((1.3 + 2.6 * dist) / speed) * (0.85 + this.random() * 0.3);
    timing[o] = time;
    timing[o + 1] = duration;
    timing[o + 2] = bow;
    timing[o + 3] = this.random();
    this.to[i] = b;
    this.landed[i] = 0;
  }

  private random(): number {
    // mulberry32: tiny, deterministic, allocation-free.
    let t = (this.seed = (this.seed + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
