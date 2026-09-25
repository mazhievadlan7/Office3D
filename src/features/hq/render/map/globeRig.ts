import * as THREE from "three";
import { HQ_THEME } from "@/features/hq/core/config";
import {
  createGlobeArcMaterial,
  createGlobeBeamMaterial,
  createGlobeHaloMaterial,
  createGlobeSurfaceMaterial,
  createGlobeUniforms,
  globeDirection,
  subsolarPoint,
  type GlobeUniforms,
} from "@/features/hq/render/map/globeShaders";
import type { LandMask } from "@/features/hq/render/map/landMask";
import { ARC_SEGMENTS, ARC_SLOTS, ArcScheduler, createArcBuffers, type ArcBuffers } from "@/features/hq/render/map/mapArcs";
import { MAP_HOTSPOT_COUNT, MAP_HOTSPOTS } from "@/features/hq/render/map/mapProjection";
import { DEFAULT_MAP_ACTIVITY, HOTSPOT_UV } from "@/features/hq/render/map/mapRig";
import type { HqQuality } from "@/features/hq/render/scene/quality";

const TIME_WRAP = 3600;
/** One turn every this many seconds: slow enough to read, fast enough to live. */
const SPIN_PERIOD = 110;
export const GLOBE_HALO_SCALE = 1.1;
const FLASH_DECAY = 0.9;
const ACTIVITY_EASE = 1.5;

/**
 * Owns the globe's materials, arcs and animation state; HqGlobe describes the
 * meshes and calls `frame` once per frame. Every per-frame write happens here.
 */
export class GlobeRig {
  readonly uniforms: GlobeUniforms = createGlobeUniforms();
  readonly halo: THREE.ShaderMaterial;
  readonly beam: THREE.ShaderMaterial;
  readonly arcMaterial: THREE.ShaderMaterial;
  readonly ring = new THREE.MeshBasicMaterial({
    color: new THREE.Color(HQ_THEME.accent).multiplyScalar(1.8),
    toneMapped: false,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  readonly satellite = new THREE.MeshBasicMaterial({
    color: new THREE.Color(HQ_THEME.ledWarm).multiplyScalar(4),
    toneMapped: false,
  });
  readonly base = new THREE.MeshStandardMaterial({ color: HQ_THEME.deskTop, roughness: 0.18, metalness: 0.6 });
  readonly baseGlow = new THREE.MeshBasicMaterial({
    color: new THREE.Color(HQ_THEME.accent).multiplyScalar(5),
    toneMapped: false,
  });

  readonly surface: THREE.ShaderMaterial;
  readonly arcs: ArcBuffers;
  private land: THREE.DataTexture;
  private readonly scheduler: ArcScheduler;
  private landReady = false;
  private time = 0;
  private activity = DEFAULT_MAP_ACTIVITY;
  private readonly flash = new Float32Array(MAP_HOTSPOT_COUNT);
  private readonly cityDirs = MAP_HOTSPOTS.map(([lon, lat]) => globeDirection(lon, lat));
  private readonly sun = new THREE.Vector3();

  constructor(radius: number, quality: HqQuality) {
    this.uniforms.uQuality.value = quality === "low" ? 0 : quality === "medium" ? 1 : 2;
    this.land = emptyLand();
    this.surface = createGlobeSurfaceMaterial(this.uniforms, this.land);
    this.halo = createGlobeHaloMaterial(this.uniforms, GLOBE_HALO_SCALE);
    this.beam = createGlobeBeamMaterial(this.uniforms);
    this.arcMaterial = createGlobeArcMaterial(this.uniforms, radius);
    this.arcs = createArcBuffers(ARC_SEGMENTS[quality], ARC_SLOTS[quality], radius * 2);
    this.scheduler = new ArcScheduler(HOTSPOT_UV, ARC_SLOTS[quality], 0x61be);
  }

  /** Continents from the land raster (null until it has loaded). */
  setLand(mask: LandMask | null): void {
    if (!mask || this.landReady) return;
    const texture = new THREE.DataTexture(mask.data, mask.width, mask.height, THREE.RedFormat, THREE.UnsignedByteType);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.wrapS = THREE.RepeatWrapping;
    texture.needsUpdate = true;
    this.land.dispose();
    this.land = texture;
    this.surface.uniforms.uLand.value = texture;
    this.surface.uniforms.uLandReady.value = 1;
    this.landReady = true;
  }

  /** Advances the clock, arcs and city flashes; returns the globe's spin angle. */
  frame(delta: number, rawActivity: number, wallClockMs: number): number {
    const dt = Math.min(Math.max(delta, 0), 0.1);
    this.time += dt;
    if (this.time >= TIME_WRAP) {
      this.time -= TIME_WRAP;
      this.scheduler.rebase(TIME_WRAP, this.arcs.timingArray);
      this.arcs.timing.needsUpdate = true;
    }
    const target = Number.isFinite(rawActivity) ? Math.min(1, Math.max(0, rawActivity)) : 0;
    this.activity += (target - this.activity) * (1 - Math.exp(-dt * ACTIVITY_EASE));
    const u = this.uniforms;
    u.uTime.value = this.time;
    u.uActivity.value = this.activity;
    u.uFlicker.value = 0.97 + 0.03 * Math.sin(this.time * 11.3) * Math.sin(this.time * 6.1);

    // The day side faces the real Sun at this moment.
    const sp = subsolarPoint(wallClockMs);
    globeDirection(sp.lon, sp.lat, this.sun);
    this.surface.uniforms.uSunDir.value.copy(this.sun);

    const arcs = this.arcs;
    if (this.landReady && this.scheduler.update(this.time, this.activity, arcs.endsArray, arcs.timingArray, this.flash)) {
      arcs.ends.needsUpdate = true;
      arcs.timing.needsUpdate = true;
    }
    const cities = this.surface.uniforms.uCities.value as THREE.Vector4[];
    for (let i = 0; i < MAP_HOTSPOT_COUNT; i++) {
      this.flash[i] = Math.max(0, this.flash[i] - dt * FLASH_DECAY);
      const d = this.cityDirs[i];
      cities[i].set(d.x, d.y, d.z, this.flash[i]);
    }
    return (this.time / SPIN_PERIOD) * Math.PI * 2;
  }

  get clock(): number {
    return this.time;
  }

  dispose(): void {
    for (const m of [this.surface, this.halo, this.beam, this.arcMaterial, this.ring, this.satellite, this.base, this.baseGlow]) {
      m.dispose();
    }
    this.arcs.geometry.dispose();
    this.land.dispose();
  }
}

function emptyLand(): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
  texture.needsUpdate = true;
  return texture;
}
