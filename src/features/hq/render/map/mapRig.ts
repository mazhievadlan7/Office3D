import * as THREE from "three";
import { HQ_THEME } from "@/features/hq/core/config";
import { GLOW, WALL_LINE } from "@/features/hq/render/environment/palette";
import type { MapRaster } from "@/features/hq/render/map/mapGeo";
import {
  MAP_HOTSPOT_COUNT,
  MAP_HOTSPOTS,
  latToV,
  lonToU,
  type MapFit,
} from "@/features/hq/render/map/mapProjection";
import { mapWings } from "@/features/hq/render/map/mapWings";
import {
  createEarthMaterial,
  createGlowMaterial,
  createHotspotMaterial,
  createPanelMaterial,
  createSharedUniforms,
  type MapSharedUniforms,
} from "@/features/hq/render/map/mapShaders";
import { sunDirection } from "@/features/hq/render/map/sun";
import type { HqQuality } from "@/features/hq/render/scene/quality";

// Shader clock wraps so float32 precision never degrades; 3600 s is a whole
// number of periods for the scan and the markers' breathing.
const TIME_WRAP = 3600;
const SCAN_PERIOD = 12;
const SCAN_SWEEP = 0.7;
const REVEAL_SECONDS = 1.8;
const ACTIVITY_EASE = 1.5;
/** Seconds for NASA imagery to fade in over the procedural look once it arrives. */
const IMAGERY_FADE_SECONDS = 1.6;
/** Anisotropic filtering at most this strong (the camera sees the wall at an angle). */
const MAX_ANISOTROPY = 8;
/** The Sun moves a quarter of a degree a minute: once a second is smooth, and spares a per-frame allocation. */
const SUN_UPDATE_MS = 1000;
/**
 * Texels sent to the GPU per frame while a map layer streams in. The day
 * imagery alone is 11 MB (5400×2040) and the geo layer 25 MB; uploaded whole
 * on its first draw, one layer froze a frame for 30-130 ms on ANGLE/D3D.
 */
const UPLOAD_BYTES_PER_FRAME = 1 << 20;
export const DEFAULT_MAP_ACTIVITY = 0.4;

const QUALITY_LEVEL: Record<HqQuality, number> = { low: 0, medium: 1, high: 2 };

/** Hotspot cities as interleaved u, v in the cropped projection. */
export const HOTSPOT_UV = new Float32Array(MAP_HOTSPOT_COUNT * 2);
MAP_HOTSPOTS.forEach(([lon, lat], i) => {
  HOTSPOT_UV[i * 2] = lonToU(lon);
  HOTSPOT_UV[i * 2 + 1] = latToV(lat);
});

export type MapLayer = "geo" | "day" | "night";

export type MapFrameInput = {
  fit: MapFit;
  floorSize: THREE.Vector2;
  /** The floor's height in display-local metres (minus the display centre's height). */
  floorY: number;
  quality: HqQuality;
  /** Raw activity 0..1 (eased here unless quality is low). */
  activity: number;
  /** Whether the glass draws its own glyph panels beside the map. */
  hud: boolean;
  /** Whether the wings show a briefing (whole panels, no tiles under a title rule). */
  briefing: boolean;
  /** Wall clock (ms since the epoch) for the real-time day and night. */
  clockMs: number;
};

/** A map texture from a raster: linear data (not colour), mipmapped, wrapping east-west like the globe. */
export function rasterTexture(raster: MapRaster, anisotropy: number): THREE.DataTexture {
  const format = raster.channels === 1 ? THREE.RedFormat : THREE.RGBAFormat;
  const texture = new THREE.DataTexture(raster.data, raster.width, raster.height, format, THREE.UnsignedByteType);
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.unpackAlignment = 1;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = Math.max(1, Math.min(MAX_ANISOTROPY, anisotropy));
  texture.needsUpdate = true;
  return texture;
}

/** 1x1 stand-ins until the real data arrives: open ocean, no borders, no lights, black imagery. */
function placeholder(layer: MapLayer): THREE.DataTexture {
  const texel = layer === "geo" ? new Uint8Array([0, 255, 255, 0]) : new Uint8Array([0]);
  const texture = new THREE.DataTexture(texel, 1, 1, layer === "geo" ? THREE.RGBAFormat : THREE.RedFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

const MAP_UNIFORM: Record<MapLayer, "uGeoMap" | "uDayMap" | "uNightMap"> = {
  geo: "uGeoMap",
  day: "uDayMap",
  night: "uNightMap",
};

/**
 * Owns the map's materials, textures and animation state. All per-frame
 * writes happen here so the React component stays a thin, pure description.
 */
export class MapRig {
  readonly shared: MapSharedUniforms = createSharedUniforms();
  private readonly placeholders: Record<MapLayer, THREE.DataTexture> = {
    geo: placeholder("geo"),
    day: placeholder("day"),
    night: placeholder("night"),
  };
  readonly panel = createPanelMaterial(this.shared);
  readonly earth = createEarthMaterial(this.shared, this.placeholders);
  readonly hotspots = createHotspotMaterial(this.shared);
  readonly halo = createGlowMaterial(this.shared, 0);
  readonly floor = createGlowMaterial(this.shared, 1);
  readonly bezel = new THREE.MeshStandardMaterial({
    name: "HqMapBezel",
    color: HQ_THEME.metal,
    metalness: 0.85,
    roughness: 0.32,
  });
  /**
   * The case between the display and the wall: black and truly matte. A PBR
   * surface, however rough, catches the key light as a grey sheen at the
   * grazing angle the camera sees the case's top from (a crescent up to
   * 2.5 m deep at the ends); Lambert has no specular lobe at all. The
   * geometry darkens the top further (mapGeometry.ts MAP_CASE_TOP_SHADE).
   */
  readonly body = new THREE.MeshLambertMaterial({
    name: "HqMapCase",
    color: HQ_THEME.wall,
    vertexColors: true,
  });

  private time = 0;
  private activity = DEFAULT_MAP_ACTIVITY;
  private revealStart = -1;
  private appliedFit: MapFit | null = null;
  private appliedFloor = new THREE.Vector2(-1, -1);
  private appliedFloorY = Number.NaN;
  /** 1 when the fit has wings for the screen hub's panels (mapWings.ts). */
  private wings = 0;
  private anisotropy = 1;
  private readonly loaded: Record<MapLayer, THREE.DataTexture | null> = { geo: null, day: null, night: null };
  /** Layers waiting to stream in, in arrival order; `row` is how far the head has been sent. */
  private readonly queued: Array<{ layer: MapLayer; texture: THREE.DataTexture; row: number; allocated: boolean }> = [];
  private dayMix = 0;
  private nightMix = 0;
  private sunAtMs = Number.NEGATIVE_INFINITY;

  /** The renderer's anisotropy limit, for textures that arrive later. */
  setAnisotropy(max: number): void {
    this.anisotropy = Number.isFinite(max) ? max : 1;
  }

  /**
   * Hands over a layer's texels. They stream to the GPU over the next frames
   * (upload()), one layer at a time, and the layer is attached once complete.
   */
  setRaster(layer: MapLayer, raster: MapRaster): void {
    this.queued.push({ layer, texture: rasterTexture(raster, this.anisotropy), row: 0, allocated: false });
  }

  /**
   * Streams the next strip of the waiting layer: storage (every mip level)
   * first, then UPLOAD_BYTES_PER_FRAME of rows a frame, then the mip chain,
   * built once by the GPU; only then is the layer attached, so its first
   * draw uploads nothing. Call once per frame before the draw.
   */
  upload(renderer: THREE.WebGLRenderer): void {
    const next = this.queued[0];
    if (!next) return;
    const texture = next.texture;
    if (!next.allocated) {
      // Allocate (texStorage2D, sampler state) without sending the texels.
      texture.source.dataReady = false;
      renderer.initTexture(texture);
      next.allocated = true;
      return;
    }
    const image = texture.image as { width: number; height: number; data: Uint8Array };
    const glTexture = (renderer.properties.get(texture) as { __webglTexture?: WebGLTexture }).__webglTexture;
    const gl = renderer.getContext();
    if (!glTexture || !("texStorage2D" in gl)) {
      // No storage to stream into: let three upload it whole on the first draw.
      texture.source.dataReady = true;
      texture.needsUpdate = true;
      this.queued.shift();
      this.attach(next.layer, texture);
      return;
    }
    const rgba = texture.format === THREE.RGBAFormat;
    const rowBytes = image.width * (rgba ? 4 : 1);
    const rows = Math.min(image.height - next.row, Math.max(1, Math.floor(UPLOAD_BYTES_PER_FRAME / rowBytes)));
    // Through three's state, which caches the bound texture and the pixel-store
    // parameters: a raw gl call would leave its cache wrong for its next upload.
    const state = renderer.state as unknown as {
      bindTexture: (target: number, texture: WebGLTexture) => void;
      pixelStorei: (name: number, value: number | boolean) => void;
    };
    state.bindTexture(gl.TEXTURE_2D, glTexture);
    state.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    state.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    state.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    state.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    state.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    state.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    state.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      next.row,
      image.width,
      rows,
      rgba ? gl.RGBA : gl.RED,
      gl.UNSIGNED_BYTE,
      image.data,
      next.row * rowBytes,
    );
    next.row += rows;
    if (next.row < image.height) return;
    gl.generateMipmap(gl.TEXTURE_2D);
    texture.source.dataReady = true;
    this.queued.shift();
    this.attach(next.layer, texture);
  }

  /** Whether a layer's real data is on the map (not its stand-in). */
  has(layer: MapLayer): boolean {
    return this.loaded[layer] !== null;
  }

  frame(delta: number, input: MapFrameInput): void {
    const dt = Math.min(Math.max(delta, 0), 0.1);
    const { fit, quality } = input;
    const u = this.shared;

    this.time += dt;
    if (this.time >= TIME_WRAP) {
      this.time -= TIME_WRAP;
      if (this.revealStart >= 0) this.revealStart -= TIME_WRAP;
    }

    const target = input.activity;
    this.activity =
      quality === "low" ? target : this.activity + (target - this.activity) * (1 - Math.exp(-dt * ACTIVITY_EASE));

    if (this.appliedFit !== fit || !this.appliedFloor.equals(input.floorSize) || this.appliedFloorY !== input.floorY) {
      this.applyFit(fit, input.floorSize, input.floorY);
    }
    u.uQuality.value = QUALITY_LEVEL[quality];
    u.uHud.value = input.hud ? 1 : 0;
    this.panel.uniforms.uWings.value.w = input.hud || input.briefing ? 0 : this.wings;
    // Also refreshed when the clock jumps back (a changed system time).
    if (Math.abs(input.clockMs - this.sunAtMs) >= SUN_UPDATE_MS) {
      this.sunAtMs = input.clockMs;
      sunDirection(input.clockMs, u.uSunDir.value);
    }

    // Imagery fades in over the procedural look rather than popping.
    const fade = dt / IMAGERY_FADE_SECONDS;
    this.dayMix = this.loaded.day ? Math.min(1, this.dayMix + fade) : 0;
    this.nightMix = this.loaded.night ? Math.min(1, this.nightMix + fade) : 0;
    this.earth.uniforms.uDayMix.value = this.dayMix;
    this.earth.uniforms.uNightMix.value = this.nightMix;

    if (this.loaded.geo && this.revealStart < 0) this.revealStart = this.time;
    const reveal = this.revealStart < 0 ? 0 : Math.min(1, (this.time - this.revealStart) / REVEAL_SECONDS);

    u.uTime.value = this.time;
    u.uActivity.value = this.activity;
    u.uFlicker.value = flicker(this.time);
    u.uScanY.value = scanY(this.time, fit);
    u.uReveal.value = reveal;
  }

  dispose(): void {
    this.panel.dispose();
    this.earth.dispose();
    this.hotspots.dispose();
    this.halo.dispose();
    this.floor.dispose();
    this.bezel.dispose();
    this.body.dispose();
    // GPU copies only: a disposed texture still in use uploads again on its next draw.
    for (const layer of ["geo", "day", "night"] as const) {
      this.placeholders[layer].dispose();
      this.loaded[layer]?.dispose();
    }
    for (const { texture } of this.queued) texture.dispose();
  }

  private attach(layer: MapLayer, texture: THREE.DataTexture): void {
    this.loaded[layer]?.dispose();
    this.loaded[layer] = texture;
    this.earth.uniforms[MAP_UNIFORM[layer]].value = texture;
  }

  private applyFit(fit: MapFit, floorSize: THREE.Vector2, floorY: number): void {
    this.appliedFit = fit;
    this.appliedFloor.copy(floorSize);
    this.appliedFloorY = floorY;
    this.shared.uArcK.value = fit.arcK;
    this.shared.uMapRect.value.set(fit.mapX0, fit.mapY0, fit.mapX1, fit.mapY1);
    this.panel.uniforms.uHalf.value.set(fit.panelW / 2, fit.panelH / 2);
    this.panel.uniforms.uFrameInset.value = fit.frameInset;
    this.earth.uniforms.uHalf.value.set(fit.panelW / 2, fit.panelH / 2);
    this.earth.uniforms.uSpot.value = fit.unit * 0.74;
    this.hotspots.uniforms.uSize.value = fit.unit * 4.5;
    // Markers only move with the fit: x, y, a breathing phase, and w = 0 (no flash).
    const spots = this.shared.uHotspots.value;
    const w = fit.mapX1 - fit.mapX0;
    const h = fit.mapY1 - fit.mapY0;
    for (let i = 0; i < MAP_HOTSPOT_COUNT; i++) {
      spots[i].set(fit.mapX0 + w * HOTSPOT_UV[i * 2], fit.mapY0 + h * HOTSPOT_UV[i * 2 + 1], (i * 0.618034) % 1, 0);
    }
    this.halo.uniforms.uHalf.value.set(fit.outerW / 2, fit.outerH / 2);
    // The case carries on the walls' skirt line, hidden behind it; the wall's
    // own top line runs just above the case, so the case needs none there.
    this.halo.uniforms.uFootLine.value.set(floorY + WALL_LINE.skirt, GLOW.line);
    this.floor.uniforms.uFloorSize.value.copy(floorSize);
    const wings = mapWings(fit);
    this.wings = wings ? 1 : 0;
    if (wings) this.panel.uniforms.uWings.value.set(wings.inner, wings.outer, wings.ruleY, 0);
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
