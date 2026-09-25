import * as THREE from "three";
import { HQ_THEME } from "@/features/hq/core/config";
import { MAP_HOTSPOT_COUNT, MAP_HOTSPOTS, latToV, lonToU, type MapFit } from "@/features/hq/render/map/mapProjection";
import {
  createGlowMaterial,
  createPanelMaterial,
  createSharedUniforms,
  type MapSharedUniforms,
} from "@/features/hq/render/map/mapShaders";
import type { HqQuality } from "@/features/hq/render/scene/quality";

// Shader clock wraps so float32 precision never degrades; 3600 s is a whole
// number of periods for the scan, pulses and dashes.
const TIME_WRAP = 3600;
const SCAN_PERIOD = 12;
const SCAN_SWEEP = 0.7;
const ACTIVITY_EASE = 1.5;
export const DEFAULT_MAP_ACTIVITY = 0.4;

const QUALITY_LEVEL: Record<HqQuality, number> = { low: 0, medium: 1, high: 2 };

/** Hotspot cities as interleaved u, v in the cropped projection (the arc scheduler's input). */
export const HOTSPOT_UV = new Float32Array(MAP_HOTSPOT_COUNT * 2);
MAP_HOTSPOTS.forEach(([lon, lat], i) => {
  HOTSPOT_UV[i * 2] = lonToU(lon);
  HOTSPOT_UV[i * 2 + 1] = latToV(lat);
});

export type MapFrameInput = {
  /** The display, with the map rectangle set to the backdrop behind the globe. */
  fit: MapFit;
  floorSize: THREE.Vector2;
  quality: HqQuality;
  /** Raw activity 0..1 (eased here unless quality is low). */
  activity: number;
  /** Whether the glass draws its own glyph panels beside the backdrop. */
  hud: boolean;
};

/**
 * Owns the map wall's materials (glass, bezel, wall and floor glow) and their
 * animation state. All per-frame writes happen here so the React component
 * stays a thin, pure description.
 */
export class MapRig {
  readonly shared: MapSharedUniforms = createSharedUniforms();
  readonly panel = createPanelMaterial(this.shared);
  readonly halo = createGlowMaterial(this.shared, 0);
  readonly floor = createGlowMaterial(this.shared, 1);
  readonly bezel = new THREE.MeshStandardMaterial({
    name: "HqMapBezel",
    color: HQ_THEME.metal,
    metalness: 0.85,
    roughness: 0.32,
  });

  private time = 0;
  private activity = DEFAULT_MAP_ACTIVITY;
  private appliedFit: MapFit | null = null;
  private appliedFloor = new THREE.Vector2(-1, -1);

  frame(delta: number, input: MapFrameInput): void {
    const dt = Math.min(Math.max(delta, 0), 0.1);
    const { fit, quality } = input;
    const u = this.shared;

    this.time += dt;
    if (this.time >= TIME_WRAP) this.time -= TIME_WRAP;

    const target = input.activity;
    this.activity =
      quality === "low" ? target : this.activity + (target - this.activity) * (1 - Math.exp(-dt * ACTIVITY_EASE));

    if (this.appliedFit !== fit || !this.appliedFloor.equals(input.floorSize)) {
      this.applyFit(fit, input.floorSize);
    }
    u.uQuality.value = QUALITY_LEVEL[quality];
    u.uHud.value = input.hud ? 1 : 0;
    u.uTime.value = this.time;
    u.uActivity.value = this.activity;
    u.uFlicker.value = flicker(this.time);
    u.uScanY.value = scanY(this.time, fit);
  }

  dispose(): void {
    this.panel.dispose();
    this.halo.dispose();
    this.floor.dispose();
    this.bezel.dispose();
  }

  private applyFit(fit: MapFit, floorSize: THREE.Vector2): void {
    this.appliedFit = fit;
    this.appliedFloor.copy(floorSize);
    this.shared.uMapRect.value.set(fit.mapX0, fit.mapY0, fit.mapX1, fit.mapY1);
    this.panel.uniforms.uHalf.value.set(fit.panelW / 2, fit.panelH / 2);
    this.panel.uniforms.uFrameInset.value = fit.frameInset;
    this.halo.uniforms.uHalf.value.set(fit.outerW / 2, fit.outerH / 2);
    this.floor.uniforms.uFloorSize.value.copy(floorSize);
  }
}

/** Mostly steady, with a faint mains shimmer and a rare brief dip. */
function flicker(t: number): number {
  const base = 0.975 + 0.018 * Math.sin(t * 13.1) * Math.sin(t * 7.3 + 1.7);
  const h = Math.sin(Math.floor(t * 8.3) * 91.345) * 43758.5453;
  return h - Math.floor(h) > 0.988 ? base * 0.84 : base;
}

/** The scan line sweeps top to bottom, then rests off the display. */
function scanY(t: number, fit: MapFit): number {
  const phase = (t % SCAN_PERIOD) / SCAN_PERIOD;
  if (phase > SCAN_SWEEP) return -1000;
  const top = fit.mapY1 + 0.3;
  const bottom = fit.mapY0 - 0.3;
  return top + (bottom - top) * (phase / SCAN_SWEEP);
}
