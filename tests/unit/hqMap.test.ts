import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { planMapLoad } from "@/features/hq/render/map/mapData";
import {
  GEO_BORDER_RANGE,
  GEO_COAST_RANGE,
  GEO_FALLBACK_WIDTH,
  GEO_SHELF_RANGE,
  GEO_WIDTH,
  IMAGERY_MAX_WIDTH,
  dayLuma,
  distanceToInk,
  distanceTransform,
  encodeBorder,
  encodeCoast,
  encodeShelf,
  geoHeight,
  nightLight,
  packGeo,
  signedDistance,
  unwrapRing,
  type MapRaster,
} from "@/features/hq/render/map/mapGeo";
import {
  MAP_ASPECT,
  MAP_LAT_NORTH,
  MAP_LAT_SOUTH,
  MAP_MARKER_COLUMNS,
  cropRows,
  fitMap,
  latToV,
  lonToU,
  uToLon,
  vToLat,
} from "@/features/hq/render/map/mapProjection";
import { MapRig, type MapFrameInput } from "@/features/hq/render/map/mapRig";
import {
  EARTH_LIGHTS_ON,
  EARTH_NIGHT_LEVEL,
  EARTH_TWILIGHT,
  MAP_SHADER_SOURCES,
} from "@/features/hq/render/map/mapShaders";
import { subsolarPoint } from "@/features/hq/render/map/sun";

describe("world map projection", () => {
  it("round-trips longitude and latitude through map coordinates", () => {
    for (const [lon, lat] of [
      [-180, MAP_LAT_SOUTH],
      [0, 0],
      [37.62, 55.76],
      [180, MAP_LAT_NORTH],
    ]) {
      expect(uToLon(lonToU(lon))).toBeCloseTo(lon, 9);
      expect(vToLat(latToV(lat))).toBeCloseTo(lat, 9);
    }
    expect(lonToU(0)).toBeCloseTo(0.5, 9);
    expect(latToV(MAP_LAT_NORTH)).toBeCloseTo(1, 9);
  });

  it("finds the crop's rows in a whole-globe image", () => {
    // NASA's 5400 x 2700 and 3600 x 1800 globes: 78 N .. 58 S.
    expect(cropRows(2700)).toEqual({ y: 180, height: 2040 });
    expect(cropRows(1800)).toEqual({ y: 120, height: 1360 });
    const rows = cropRows(1000);
    expect(rows.height / 1000).toBeCloseTo((MAP_LAT_NORTH - MAP_LAT_SOUTH) / 180, 9);
  });

  it("centres the land inside the glass and sizes markers from its width", () => {
    for (const [w, h] of [
      [35.42, 4.1],
      [18.2, 4.1],
      [6, 4],
    ]) {
      const fit = fitMap(w, h);
      expect(fit.mapX0).toBeCloseTo(-fit.mapX1, 9);
      expect(fit.mapY0).toBeCloseTo(-fit.mapY1, 9);
      expect(fit.mapX1).toBeLessThan(fit.panelW / 2 - fit.frameInset);
      expect(fit.mapY1).toBeLessThan(fit.panelH / 2 - fit.frameInset);
      const mapW = fit.mapX1 - fit.mapX0;
      const aspect = mapW / (fit.mapY1 - fit.mapY0);
      expect(aspect).toBeGreaterThan(MAP_ASPECT / 1.2);
      expect(aspect).toBeLessThan(MAP_ASPECT * 1.9);
      expect(fit.unit).toBeCloseTo(mapW / MAP_MARKER_COLUMNS, 9);
    }
  });

  it("unwraps rings across the antimeridian", () => {
    const ring = unwrapRing([
      [170, 60],
      [-170, 60],
      [-170, 65],
      [170, 65],
    ]);
    expect(Array.from(ring.lon)).toEqual([170, 190, 190, 170]);
    expect(ring.min).toBe(170);
    expect(ring.max).toBe(190);
  });

  it("moves the Sun west by 15 degrees an hour", () => {
    const a = subsolarPoint(Date.UTC(2026, 8, 25, 10, 0));
    const b = subsolarPoint(Date.UTC(2026, 8, 25, 11, 0));
    const step = ((a.lon - b.lon + 540) % 360) - 180;
    expect(step).toBeGreaterThan(14.9);
    expect(step).toBeLessThan(15.1);
  });
});

describe("world map distance fields", () => {
  const W = 40;
  const H = 30;
  // A 10 x 10 square of land, from x = 15 to 25 and y = 10 to 20.
  const square = new Uint8Array(W * H);
  for (let y = 10; y < 20; y++) for (let x = 15; x < 25; x++) square[y * W + x] = 255;

  it("measures exact distances to the nearest feature", () => {
    const grid = new Float32Array(W * H).fill(1e20);
    grid[5 * W + 7] = 0;
    distanceTransform(grid, W, H);
    expect(grid[5 * W + 7]).toBe(0);
    expect(grid[5 * W + 10]).toBe(9);
    expect(grid[9 * W + 10]).toBe(25); // 3-4-5
  });

  it("is positive on land, negative at sea and near zero on the coast", () => {
    const d = signedDistance(square, W, H);
    // The middle of the square is 5 texels from every side (texel centres at +0.5).
    expect(d[15 * W + 20]).toBeGreaterThan(4);
    expect(d[15 * W + 20]).toBeLessThan(6);
    expect(d[15 * W + 5]).toBeLessThan(-9);
    expect(d[15 * W + 5]).toBeGreaterThan(-11);
    // Coast texels on either side sit within a texel of zero, and the zero
    // (what the shader draws as the coastline) falls halfway between them.
    expect(d[15 * W + 15]).toBeGreaterThan(0);
    expect(d[15 * W + 15]).toBeLessThanOrEqual(1);
    expect(d[15 * W + 14]).toBeLessThan(0);
    expect(d[15 * W + 14]).toBeGreaterThanOrEqual(-1);
    expect(d[15 * W + 15] + d[15 * W + 14]).toBeCloseTo(0, 5);
  });

  it("moves the edge with partial coverage for smooth coasts", () => {
    const soft = square.slice();
    for (let y = 10; y < 20; y++) soft[y * W + 14] = 191; // three quarters covered
    const hard = signedDistance(square, W, H);
    const smooth = signedDistance(soft, W, H);
    expect(smooth[15 * W + 12]).toBeGreaterThan(hard[15 * W + 12]);
  });

  it("measures the distance to a stroked border", () => {
    const ink = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) ink[y * W + 20] = 255;
    const d = distanceToInk(ink, W, H);
    expect(d[5 * W + 20]).toBe(0);
    expect(d[5 * W + 23]).toBeCloseTo(3, 5);
  });

  it("encodes the fields the way the Earth shader decodes them", () => {
    const decodeCoast = (byte: number) => (byte / 255 - 0.5) * 2 * GEO_COAST_RANGE;
    const decodeShelf = (byte: number) => (byte / 255) ** 2 * GEO_SHELF_RANGE;
    const decodeBorder = (byte: number) => (byte / 255) * GEO_BORDER_RANGE;
    for (const deg of [-0.6, -0.1, 0, 0.05, 0.4]) {
      expect(decodeCoast(encodeCoast(deg))).toBeCloseTo(deg, 2);
    }
    expect(encodeCoast(5)).toBe(255);
    expect(encodeCoast(-5)).toBe(0);
    for (const deg of [0.5, 2, 7]) expect(decodeShelf(encodeShelf(deg))).toBeCloseTo(deg, 0);
    expect(decodeShelf(encodeShelf(0.1))).toBeLessThan(0.15);
    expect(encodeShelf(-40)).toBe(255);
    expect(decodeBorder(encodeBorder(0.2))).toBeCloseTo(0.2, 2);
    expect(encodeBorder(9)).toBe(255);
  });

  it("crops the padded fields to the map when packing", () => {
    const pad = 2;
    const width = 3;
    const height = 2;
    const stride = width + 2 * pad;
    const size = stride * (height + 2 * pad);
    const coast = new Float32Array(size).fill(-1000);
    const borders = new Float32Array(size).fill(1000);
    const lights = new Uint8Array(size);
    // The crop's first texel: on the coast, on a border, fully lit.
    coast[pad * stride + pad] = 0;
    borders[pad * stride + pad] = 0;
    lights[pad * stride + pad] = 200;
    const data = packGeo({ width, height, pad, texelDeg: 0.1, coast, borders, lights });
    expect(data).toHaveLength(width * height * 4);
    expect(Array.from(data.slice(0, 4))).toEqual([128, 0, 0, 200]);
    expect(Array.from(data.slice(4, 8))).toEqual([0, 255, 255, 0]);
  });
});

describe("world map imagery", () => {
  it("keeps city lights and drops the dim blue Earth under them", () => {
    // Sampled from NASA's Black Marble 2016: the dim blue Earth under the lights.
    expect(nightLight(5, 5, 15)).toBe(0); // Pacific
    expect(nightLight(37, 34, 63)).toBe(0); // Sahara
    expect(nightLight(42, 48, 80)).toBeLessThan(0.05); // Greenland
    // Its near-white city lights, from a halo to a metro's core.
    expect(nightLight(120, 110, 130)).toBeGreaterThan(0.3);
    expect(nightLight(254, 249, 255)).toBeGreaterThan(0.95);
    // Warm light (other composites) counts too, dim towns included.
    expect(nightLight(255, 190, 110)).toBeGreaterThan(0.75);
    const dimTown = nightLight(70, 48, 22);
    expect(dimTown).toBeGreaterThan(0.05);
    expect(dimTown).toBeLessThan(0.3);
  });

  it("turns the day image into luma", () => {
    expect(dayLuma(0, 0, 0)).toBe(0);
    // Winter snow and ice (bright, colourless) come down to bare-ground brightness...
    expect(dayLuma(249, 253, 255)).toBeLessThan(150); // Greenland
    expect(dayLuma(202, 209, 215)).toBeLessThan(dayLuma(202, 171, 124)); // Siberia vs the Sahara
    // ...while bright deserts keep theirs.
    expect(dayLuma(202, 171, 124)).toBe(Math.round(0.2126 * 202 + 0.7152 * 171 + 0.0722 * 124));
    // Shallow sea (light cyan) is much brighter than the deep ocean (navy).
    expect(dayLuma(110, 190, 210)).toBeGreaterThan(dayLuma(8, 22, 70) * 4);
  });

  it("builds everything in a worker at full size when it can, and falls back otherwise", () => {
    const full = planMapLoad({ workers: true, offscreenCanvas: true, maxTextureSize: 16384 });
    expect(full).toEqual({ useWorker: true, geoWidth: GEO_WIDTH, imagery: true, imageryMaxWidth: IMAGERY_MAX_WIDTH });
    // No OffscreenCanvas for the worker: the vector look only, built on the page at half size.
    const noCanvas = planMapLoad({ workers: true, offscreenCanvas: false, maxTextureSize: 16384 });
    expect(noCanvas.useWorker).toBe(false);
    expect(noCanvas.imagery).toBe(false);
    expect(noCanvas.geoWidth).toBe(GEO_FALLBACK_WIDTH);
    // A small GPU caps every texture.
    const small = planMapLoad({ workers: true, offscreenCanvas: true, maxTextureSize: 2048 });
    expect(small.geoWidth).toBe(2048);
    expect(small.imageryMaxWidth).toBe(2048);
    expect(geoHeight(GEO_WIDTH)).toBe(Math.round(GEO_WIDTH / MAP_ASPECT));
  });
});

describe("world map day and night", () => {
  // The Earth shader's shading across the terminator (EARTH_FRAGMENT), in JS.
  const smoothstep = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const shade = (sunDot: number) =>
    (EARTH_NIGHT_LEVEL + (1 - EARTH_NIGHT_LEVEL) * smoothstep(EARTH_TWILIGHT[0], EARTH_TWILIGHT[1], sunDot)) *
    (0.94 + 0.12 * Math.min(1, Math.max(0, sunDot)));

  it("shades the night side softly, with no line at the terminator", () => {
    let previous = shade(-1);
    let steepest = 0;
    for (let s = -1; s <= 1.0001; s += 0.01) {
      const value = shade(s);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-9); // never a bright band
      steepest = Math.max(steepest, (value - previous) / 0.01);
      previous = value;
    }
    // 0.01 of the Sun's height is about half a degree on the map: the whole
    // change is spread over tens of degrees.
    expect(steepest).toBeLessThan(2);
    expect(EARTH_TWILIGHT[1] - EARTH_TWILIGHT[0]).toBeGreaterThanOrEqual(0.4);
    expect(EARTH_LIGHTS_ON[1] - EARTH_LIGHTS_ON[0]).toBeGreaterThanOrEqual(0.2);
    expect(shade(-1)).toBeGreaterThan(0.3); // the night side stays readable
  });

  it("draws no terminator glow on the glass or the Earth", () => {
    for (const source of Object.values(MAP_SHADER_SOURCES)) {
      expect(source).not.toMatch(/abs\(\s*sunDot\s*\)/);
    }
    expect(MAP_SHADER_SOURCES.panel).not.toMatch(/sunDot/);
  });
});

describe("world map rig", () => {
  const fit = fitMap(35.42, 4.1);
  const input = (): MapFrameInput => ({
    fit,
    floorSize: new THREE.Vector2(20, 4),
    quality: "high",
    activity: 0.5,
    hud: false,
    clockMs: Date.UTC(2026, 8, 25, 12),
  });
  const raster = (channels: 1 | 4, width = 8, height = 3): MapRaster => ({
    width,
    height,
    channels,
    data: new Uint8Array(width * height * channels),
  });
  const materials = (rig: MapRig) => [rig.panel, rig.earth, rig.hotspots, rig.halo, rig.floor];

  it("keeps the markers small and still: no flying arcs, no landing flashes", () => {
    const rig = new MapRig();
    const frame = input();
    for (let i = 0; i < 240; i++) rig.frame(1 / 60, frame);
    expect(rig).not.toHaveProperty("arcs");
    for (const spot of rig.shared.uHotspots.value) expect(spot.w).toBe(0);
    expect(rig.hotspots.uniforms.uSize.value).toBeLessThan(fit.unit * 6);
    rig.dispose();
  });

  it("declares every uniform its shaders use", () => {
    const rig = new MapRig();
    for (const material of materials(rig)) {
      const source = `${material.vertexShader}\n${material.fragmentShader}`;
      for (const match of source.matchAll(/^\s*uniform\s+\w+\s+(\w+)/gm)) {
        expect(material.uniforms, `${material.name}: ${match[1]}`).toHaveProperty(match[1]);
      }
    }
    rig.dispose();
  });

  it("moves the Sun about once a second, and at once when the clock jumps back", () => {
    const rig = new MapRig();
    const frame = input();
    const sun = rig.shared.uSunDir.value;
    rig.frame(1 / 60, frame);
    const first = sun.clone();
    // Six hours later the Sun is a quarter of the way round.
    frame.clockMs += 6 * 3600 * 1000;
    rig.frame(1 / 60, frame);
    const later = sun.clone();
    expect(later.angleTo(first)).toBeGreaterThan(1);
    // Within the same second nothing is recomputed...
    frame.clockMs += 500;
    rig.frame(1 / 60, frame);
    expect(sun.equals(later)).toBe(true);
    // ...but a clock set back is followed straight away.
    frame.clockMs -= 6 * 3600 * 1000;
    rig.frame(1 / 60, frame);
    expect(sun.angleTo(first)).toBeLessThan(0.01);
    rig.dispose();
  });

  it("stays on the vector look until imagery arrives, then fades it in", () => {
    const rig = new MapRig();
    const frame = input();
    const uniforms = rig.earth.uniforms;
    rig.frame(1 / 60, frame);
    expect((uniforms.uGeoMap.value as THREE.DataTexture).image.width).toBe(1);
    expect(uniforms.uDayMix.value).toBe(0);
    expect(rig.shared.uReveal.value).toBe(0);

    // Imagery missing (a 404): only the vector data arrives.
    rig.setRaster("geo", raster(4));
    rig.frame(1 / 60, frame);
    expect(rig.has("geo")).toBe(true);
    expect((uniforms.uGeoMap.value as THREE.DataTexture).image.width).toBe(8);
    for (let i = 0; i < 180; i++) rig.frame(1 / 60, frame);
    expect(rig.shared.uReveal.value).toBe(1);
    expect(uniforms.uDayMix.value).toBe(0);
    expect(uniforms.uNightMix.value).toBe(0);

    // Both images arrive together: attached on separate frames, then faded in.
    rig.setRaster("day", raster(1));
    rig.setRaster("night", raster(1));
    rig.frame(1 / 60, frame);
    expect(rig.has("day")).toBe(true);
    expect(rig.has("night")).toBe(false);
    rig.frame(1 / 60, frame);
    expect(rig.has("night")).toBe(true);
    expect(uniforms.uDayMix.value).toBeGreaterThan(0);
    expect(uniforms.uDayMix.value).toBeLessThan(0.1);
    for (let i = 0; i < 120; i++) rig.frame(1 / 60, frame);
    expect(uniforms.uDayMix.value).toBe(1);
    expect(uniforms.uNightMix.value).toBe(1);
    const day = uniforms.uDayMap.value as THREE.DataTexture;
    expect(day.format).toBe(THREE.RedFormat);
    expect(day.colorSpace).toBe(THREE.NoColorSpace);
    expect(day.wrapS).toBe(THREE.RepeatWrapping);
    expect(day.generateMipmaps).toBe(true);
    rig.dispose();
  });
});
