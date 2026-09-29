import { afterEach, describe, expect, it, vi } from "vitest";
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
import { MAP_LAYER_Z, createDisplayGeometry, createWingGeometry } from "@/features/hq/render/map/mapGeometry";
import {
  MAP_ASPECT,
  MAP_CASE,
  MAP_LAT_NORTH,
  MAP_LAT_SOUTH,
  MAP_MARKER_COLUMNS,
  arcCurvature,
  arcSag,
  arcSlope,
  cropRows,
  fitMap,
  latToV,
  lonToU,
  mapCaseExtent,
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
import { MAP_WING_BLOCKS, mapBriefing, mapWings, type MapWingTile } from "@/features/hq/render/map/mapWings";
import { subsolarPoint } from "@/features/hq/render/map/sun";
import {
  ellipsize,
  fitBlocks,
  nextBriefing,
  paintBriefingBanner,
  paintBriefingPlan,
  paintBriefingTask,
  planSteps,
  wrapLines,
  type Measure,
} from "@/features/hq/render/screens/screenBriefing";
import { HqScreenHub } from "@/features/hq/render/screens/screenHub";
import { Painter, type Ctx2D, type HqScreenBriefing } from "@/features/hq/render/screens/screenPaint";
import { BANNER_H, BANNER_W, MAP_H, MAP_W, MONITOR_ATLAS } from "@/features/hq/render/screens/screenSurfaces";

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
    floorY: -2.65,
    quality: "high",
    activity: 0.5,
    hud: false,
    briefing: false,
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

    // A renderer stand-in: records the strips streamed into GPU storage.
    const strips: Array<[number, number]> = [];
    let mipmaps = 0;
    const handles = new Map<THREE.Texture, { __webglTexture: object }>();
    const gl = {
      TEXTURE_2D: 1, RGBA: 2, RED: 3, UNSIGNED_BYTE: 4, NONE: 0,
      UNPACK_ALIGNMENT: 5, UNPACK_FLIP_Y_WEBGL: 6, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 7,
      UNPACK_COLORSPACE_CONVERSION_WEBGL: 8, UNPACK_ROW_LENGTH: 9, UNPACK_SKIP_PIXELS: 10, UNPACK_SKIP_ROWS: 11,
      texStorage2D: () => undefined,
      texSubImage2D: (...args: number[]) => strips.push([args[3], args[5]]),
      generateMipmap: () => (mipmaps += 1),
    };
    const renderer = {
      initTexture: (texture: THREE.Texture) => handles.set(texture, { __webglTexture: {} }),
      properties: { get: (texture: THREE.Texture) => handles.get(texture) ?? {} },
      getContext: () => gl,
      state: { bindTexture: () => undefined, pixelStorei: () => undefined },
    } as unknown as THREE.WebGLRenderer;
    const step = () => {
      rig.upload(renderer);
      rig.frame(1 / 60, frame);
    };

    // Imagery missing (a 404): only the vector data arrives. It streams in
    // (storage first, then its rows, then the mip chain) before it shows.
    rig.setRaster("geo", raster(4));
    step();
    expect(rig.has("geo")).toBe(false);
    const geo = [...handles.keys()][0] as THREE.DataTexture;
    expect(geo.source.dataReady).toBe(false);
    step();
    expect(rig.has("geo")).toBe(true);
    expect(strips).toEqual([[0, 3]]);
    expect(mipmaps).toBe(1);
    expect(geo.source.dataReady).toBe(true);
    expect((uniforms.uGeoMap.value as THREE.DataTexture).image.width).toBe(8);
    for (let i = 0; i < 180; i++) rig.frame(1 / 60, frame);
    expect(rig.shared.uReveal.value).toBe(1);
    expect(uniforms.uDayMix.value).toBe(0);
    expect(uniforms.uNightMix.value).toBe(0);

    // Both images arrive together: streamed one after the other, then faded in.
    rig.setRaster("day", raster(1));
    rig.setRaster("night", raster(1));
    step();
    step();
    expect(rig.has("day")).toBe(true);
    expect(rig.has("night")).toBe(false);
    step();
    step();
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

// The layout's video walls at capacity 100, 300 and 1000: width and curve (height 6.4).
const VIDEO_WALLS: ReadonlyArray<readonly [number, number]> = [
  [36, 1.6],
  [54, 2.4],
  [60, 2.6],
];

describe("the video wall's concave arc", () => {
  it("keeps the middle on the wall and brings both ends `curve` forward, on a circle", () => {
    for (const [width, curve] of VIDEO_WALLS) {
      const k = arcCurvature(width, curve);
      const r = 1 / k;
      expect(arcSag(k, 0)).toBe(0);
      expect(arcSag(k, width / 2)).toBeCloseTo(curve, 9);
      expect(arcSag(k, -width / 2)).toBeCloseTo(curve, 9);
      for (const x of [-width / 2, -width / 5, 3, width / 3]) {
        // Every point is r from the centre, r in front of the middle.
        expect(Math.hypot(x, arcSag(k, x) - r)).toBeCloseTo(r, 6);
        const h = 1e-4;
        expect(arcSlope(k, x)).toBeCloseTo((arcSag(k, x + h) - arcSag(k, x - h)) / (2 * h), 5);
      }
    }
    // No curve is a flat display.
    expect(arcCurvature(54, 0)).toBe(0);
    expect(arcSag(0, 20)).toBe(0);
    expect(fitMap(54, 6.4).arcK).toBe(0);
    expect(fitMap(54, 6.4, 2.4).arcK).toBeCloseTo(arcCurvature(54, 2.4), 12);
  });

  it("bends every layer onto the arc, keeping x, y and the UVs flat", () => {
    const fit = fitMap(54, 6.4, 2.4);
    const k = fit.arcK;
    const floorY = -4;
    const display = createDisplayGeometry(fit, floorY);
    const centre = 1 / k;
    for (const [geometry, depth] of [
      [display.panel, MAP_LAYER_Z.panel],
      [display.earth, MAP_LAYER_Z.earth],
      [display.halo, MAP_LAYER_Z.halo],
    ] as const) {
      const position = geometry.getAttribute("position");
      const normal = geometry.getAttribute("normal");
      const xs: number[] = [];
      for (let i = 0; i < position.count; i++) {
        const x = position.getX(i);
        xs.push(x);
        // (Float32 attributes: sub-millimetre checks, not exact ones.)
        expect(position.getZ(i)).toBeCloseTo(depth + arcSag(k, x), 5);
        // Normals look at the arc's centre.
        const n = new THREE.Vector3(normal.getX(i), normal.getY(i), normal.getZ(i));
        expect(n.length()).toBeCloseTo(1, 5);
        expect(n.dot(new THREE.Vector3(-x, 0, centre - arcSag(k, x)).normalize())).toBeCloseTo(1, 5);
      }
      // Short straight pieces: a chord never strays a fraction of a millimetre from the arc,
      // so the layers (millimetres apart) never cut through each other.
      xs.sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeLessThan(0.41);
    }
    // The halo's uv is its display-local position, which the glow shader reads.
    const halo = display.halo.getAttribute("position");
    const haloUv = display.halo.getAttribute("uv");
    for (let i = 0; i < halo.count; i++) {
      expect(haloUv.getX(i)).toBeCloseTo(halo.getX(i), 9);
      expect(haloUv.getY(i)).toBeCloseTo(halo.getY(i), 9);
    }
    // Layer order in front of the case, which fills back to the wall.
    expect(MAP_CASE.front).toBeLessThan(MAP_LAYER_Z.halo);
    expect(MAP_LAYER_Z.halo).toBeLessThan(MAP_LAYER_Z.panel);
    expect(MAP_LAYER_Z.panel).toBeLessThan(MAP_LAYER_Z.earth);
    expect(MAP_LAYER_Z.panel).toBeLessThan(MAP_LAYER_Z.wings);
    expect(MAP_LAYER_Z.earth).toBeLessThan(MAP_LAYER_Z.overlay);
    expect(MAP_LAYER_Z.overlay).toBeLessThan(MAP_LAYER_Z.bezelFront);
    const body = display.body;
    body.computeBoundingBox();
    const { halfW, top } = mapCaseExtent(fit);
    expect(body.boundingBox!.min.z).toBeLessThanOrEqual(0);
    expect(body.boundingBox!.max.z).toBeCloseTo(MAP_CASE.front + arcSag(k, halfW), 5);
    expect(body.boundingBox!.min.y).toBeCloseTo(floorY, 5);
    expect(body.boundingBox!.max.y).toBeCloseTo(top, 5);
    expect(body.boundingBox!.max.x).toBeCloseTo(halfW, 4);
    // Nothing but the 7 cm bezel stands out in front of the arc.
    display.bezel.computeBoundingBox();
    expect(display.bezel.boundingBox!.max.z).toBeCloseTo(MAP_LAYER_Z.bezelFront + arcSag(k, fit.outerW / 2), 6);
    // The floor spill starts at the case's foot, where the glow shader's "from the wall" is 0.
    const floor = display.floor.getAttribute("position");
    const floorUv = display.floor.getAttribute("uv");
    for (let i = 0; i < floor.count; i += 2) {
      expect(floor.getZ(i)).toBeCloseTo(MAP_CASE.front + arcSag(k, floor.getX(i)), 5);
      expect(floorUv.getY(i)).toBeCloseTo(display.floorSize.y / 2, 6);
    }
    display.dispose();
  });
});

describe("the video wall's wings", () => {
  const texture = (t: MapWingTile) => (t.source === "apps" ? [MONITOR_ATLAS.width, MONITOR_ATLAS.height] : [MAP_W, MAP_H]);
  const midX = (t: MapWingTile) => (t.x0 + t.x1) / 2;
  const midY = (t: MapWingTile) => (t.y0 + t.y1) / 2;

  for (const [width, curve] of VIDEO_WALLS) {
    it(`fills both wings with live panels, none stretched, no neighbours alike (${width} m)`, () => {
      const fit = fitMap(width, 6.4, curve);
      const wings = mapWings(fit);
      expect(wings).not.toBeNull();
      const { tiles, inner, outer } = wings!;
      for (const t of tiles) {
        expect(Math.min(Math.abs(t.x0), Math.abs(t.x1))).toBeGreaterThanOrEqual(inner - 1e-9);
        expect(Math.max(Math.abs(t.x0), Math.abs(t.x1))).toBeLessThanOrEqual(outer + 1e-9);
        expect(t.y0).toBeGreaterThanOrEqual(fit.mapY0 - 1e-9);
        expect(t.y1).toBeLessThanOrEqual(fit.mapY1 + 1e-9);
        for (const v of [t.u0, t.v0, t.u1, t.v1]) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
        expect(t.u1).toBeGreaterThan(t.u0);
        expect(t.v1).toBeGreaterThan(t.v0);
        const [tw, th] = texture(t);
        expect((t.x1 - t.x0) / (t.y1 - t.y0)).toBeCloseTo(((t.u1 - t.u0) * tw) / ((t.v1 - t.v0) * th), 6);
      }
      for (let i = 0; i < tiles.length; i++) {
        for (let j = i + 1; j < tiles.length; j++) {
          const a = tiles[i];
          const b = tiles[j];
          const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 1e-6 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 1e-6;
          expect(overlap, `${a.name} / ${b.name}`).toBe(false);
        }
      }
      // A title per wing, at its outer end: the left canvas's in the west.
      const titles = tiles.filter((t) => t.name.startsWith("title"));
      expect(titles.map((t) => [t.name, Math.sign(midX(t))])).toEqual([
        ["title-left", -1],
        ["title-right", 1],
      ]);
      // Dense: the panels cover most of the wings, no black letterbox.
      const covered = tiles.reduce((sum, t) => sum + (t.x1 - t.x0) * (t.y1 - t.y0), 0);
      expect(covered / (2 * (outer - inner) * (fit.mapY1 - fit.mapY0))).toBeGreaterThan(0.6);
      // Side by side or one above the other, two panels never show the same picture.
      const panels = tiles.filter((t) => !titles.includes(t));
      for (const a of panels) {
        const row = panels.filter((b) => Math.abs(midY(b) - midY(a)) < 1e-6 && Math.sign(midX(b)) === Math.sign(midX(a)));
        row.sort((p, q) => midX(p) - midX(q));
        for (let i = 1; i < row.length; i++) expect(row[i].name).not.toBe(row[i - 1].name);
        for (const b of panels) {
          if (b !== a && Math.abs(midX(b) - midX(a)) < 1e-6) expect(b.name).not.toBe(a.name);
        }
      }
      // Every panel there is shows up before any repeats.
      expect(new Set(panels.map((t) => t.name)).size).toBe(Math.min(panels.length, MAP_WING_BLOCKS.length));
    });
  }

  it("bends the wings with their pictures upright (the hub's textures keep their top row at v = 0)", () => {
    const fit = fitMap(54, 6.4, 2.4);
    const { tiles } = mapWings(fit)!;
    for (const source of ["left", "right", "apps"] as const) {
      const geometry = createWingGeometry(tiles, source, fit.arcK)!;
      expect(geometry).not.toBeNull();
      const position = geometry.getAttribute("position");
      const uv = geometry.getAttribute("uv");
      const own = tiles.filter((t) => t.source === source);
      for (let i = 0; i < position.count; i++) {
        const x = position.getX(i);
        const y = position.getY(i);
        expect(position.getZ(i)).toBeCloseTo(MAP_LAYER_Z.wings + arcSag(fit.arcK, x), 5);
        const t = own.find((c) => x >= c.x0 - 1e-4 && x <= c.x1 + 1e-4 && (Math.abs(y - c.y0) < 1e-5 || Math.abs(y - c.y1) < 1e-5));
        expect(t).toBeDefined();
        expect(uv.getY(i)).toBeCloseTo(Math.abs(y - t!.y1) < 1e-5 ? t!.v0 : t!.v1, 6);
      }
      geometry.dispose();
    }
    // A display too narrow for wings has none: the glass draws its own glyph panels there.
    expect(mapWings(fitMap(12, 6.4, 0))).toBeNull();
  });
});

// --- the briefing on the video wall -------------------------------------------------------------

/** Every glyph 0.55 em wide: enough to test layout without a canvas. */
const monoAt = (size: number): Measure => (text) => text.length * size * 0.55;

/** A 2D context that draws nothing and records every text, for the briefing's painters. */
class FakeContext {
  font = "10px sans-serif";
  fillStyle: unknown = "#000";
  strokeStyle: unknown = "#000";
  globalAlpha = 1;
  lineWidth = 1;
  lineCap = "butt";
  lineJoin = "miter";
  textAlign: CanvasTextAlign = "left";
  textBaseline = "alphabetic";
  letterSpacing = "0px";
  readonly texts: Array<{ text: string; left: number; right: number; y: number; size: number; color: unknown; alpha: number }> = [];
  constructor(readonly canvas: { width: number; height: number }) {}
  private size(): number {
    return Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 10);
  }
  measureText(text: string): { width: number } {
    return { width: text.length * this.size() * 0.55 };
  }
  fillText(text: string, x: number, y: number): void {
    const width = this.measureText(text).width;
    const left = this.textAlign === "right" ? x - width : this.textAlign === "center" ? x - width / 2 : x;
    this.texts.push({ text, left, right: left + width, y, size: this.size(), color: this.fillStyle, alpha: this.globalAlpha });
  }
  getImageData(_x: number, _y: number, w: number, h: number): { data: Uint8ClampedArray } {
    return { data: new Uint8ClampedArray(w * h * 4) };
  }
  createLinearGradient(): { addColorStop(): void } {
    return { addColorStop() {} };
  }
  createRadialGradient(): { addColorStop(): void } {
    return { addColorStop() {} };
  }
  fillRect(): void {}
  strokeRect(): void {}
  beginPath(): void {}
  closePath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  arc(): void {}
  arcTo(): void {}
  roundRect(): void {}
  quadraticCurveTo(): void {}
  fill(): void {}
  stroke(): void {}
  save(): void {}
  restore(): void {}
}

function paintInto(w: number, h: number, paint: (p: Painter) => void): FakeContext {
  const ctx = new FakeContext({ width: w, height: h });
  paint(new Painter(ctx as unknown as Ctx2D, w, h));
  return ctx;
}

const BRIEFING: HqScreenBriefing = {
  id: 1,
  task: "Проверить периметр клиента: внешние сервисы, открытые порты и забытые поддомены до конца смены",
  goal: "Карта внешней поверхности атаки с приоритетами к 18:00",
  plan: "План:\n1. Разведка поддоменов и сертификатов\n2) Сканирование открытых портов\n3. Сверка найденного со скоупом\n4. Отчёт AM7 с приоритетами",
};

describe("the video wall's briefing: text layout", () => {
  it("wraps words into the width, keeps line breaks and breaks a word too long for a line", () => {
    const measure = monoAt(10); // 5.5 px a character
    const lines = wrapLines("раз два три четыре пять\nшесть", 60, measure);
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(60);
    expect(lines).toEqual(["раз два", "три четыре", "пять", "шесть"]);
    const long = wrapLines("сверхдлиннословобезпробелов", 55, measure);
    expect(long.join("")).toBe("сверхдлиннословобезпробелов");
    for (const line of long) expect(measure(line)).toBeLessThanOrEqual(55);
  });

  it("sets the text as large as the box allows, and cuts it with an ellipsis only at the smallest size", () => {
    const text = "Проверить периметр клиента и собрать карту внешней поверхности";
    const roomy = fitBlocks([text], 1800, 400, monoAt, { max: 80, min: 30, leading: 1.2 });
    expect(roomy.size).toBe(80);
    expect(roomy.clipped).toBe(false);
    const tight = fitBlocks([text], 600, 160, monoAt, { max: 80, min: 20, leading: 1.2 });
    expect(tight.size).toBeLessThan(80);
    expect(tight.clipped).toBe(false);
    expect(tight.blocks[0].length * tight.size * 1.2).toBeLessThanOrEqual(160);
    for (const line of tight.blocks[0]) expect(monoAt(tight.size)(line)).toBeLessThanOrEqual(600);
    // Just above the fit: the next size up would not have fitted.
    const bigger = Math.floor(tight.size / 0.94);
    expect(wrapLines(text, 600, monoAt(bigger)).length * bigger * 1.2).toBeGreaterThan(160);
    const cut = fitBlocks([text.repeat(6)], 300, 60, monoAt, { max: 40, min: 20, leading: 1.2 });
    expect(cut.size).toBe(20);
    expect(cut.clipped).toBe(true);
    expect(cut.blocks[0]).toHaveLength(2);
    expect(cut.blocks[0][1].endsWith("…")).toBe(true);
    expect(monoAt(20)(cut.blocks[0][1])).toBeLessThanOrEqual(300);
    expect(ellipsize("Отчёт готов.", 1000, monoAt(10))).toBe("Отчёт готов…");
  });

  it("finds numbered or bulleted steps in a plan, and leaves prose alone", () => {
    expect(planSteps(BRIEFING.plan)).toEqual({
      intro: "",
      steps: ["Разведка поддоменов и сертификатов", "Сканирование открытых портов", "Сверка найденного со скоупом", "Отчёт AM7 с приоритетами"],
    });
    expect(planSteps("Сначала так:\n- **Разведка**\n  с подробностями\n- Скан")).toEqual({
      intro: "Сначала так",
      steps: ["Разведка с подробностями", "Скан"],
    });
    // Numbered inline, as a transcript comes: numbers in order from 1; a decimal is not a step.
    expect(planSteps("Делаем так: 1) разведка, версия 2.5; 2) скан портов 3) отчёт")).toEqual({
      intro: "Делаем так",
      steps: ["разведка, версия 2.5", "скан портов", "отчёт"],
    });
    expect(planSteps("Шаг 1: разведка\nШаг 2: скан")?.steps).toEqual(["разведка", "скан"]);
    expect(planSteps("Разведать периметр и доложить к вечеру.")).toBeNull();
    expect(planSteps("Только 3) один пункт")).toBeNull();
  });

  it("gives a briefing a new id only when its text changes", () => {
    const first = nextBriefing(null, { task: "  Задача  ", goal: "Цель\nв две строки", plan: "**1. Шаг**" }, 1)!;
    expect(first).toEqual({ id: 1, task: "Задача", goal: "Цель в две строки", plan: "1. Шаг" });
    expect(nextBriefing(first, { task: "Задача", goal: "Цель в две строки", plan: "1. Шаг" }, 2)).toBe(first);
    expect(nextBriefing(first, { task: "Задача", goal: "Цель в две строки", plan: "1. Шаг\n2. Ещё" }, 2)?.id).toBe(2);
    expect(nextBriefing(first, null, 2)).toBeNull();
  });
});

describe("the video wall's briefing: pictures", () => {
  const inside = (ctx: FakeContext, w: number, h: number) => {
    for (const t of ctx.texts) {
      expect(t.left, t.text).toBeGreaterThanOrEqual(0);
      expect(t.right, t.text).toBeLessThanOrEqual(w);
      expect(t.y, t.text).toBeGreaterThan(0);
      expect(t.y, t.text).toBeLessThanOrEqual(h);
    }
  };

  it("paints the task large on the west wing's canvas", () => {
    const ctx = paintInto(MAP_W, MAP_H, (p) => paintBriefingTask(p, 1, BRIEFING));
    const texts = ctx.texts.map((t) => t.text);
    expect(texts).toContain("ЗАДАЧА");
    const body = ctx.texts.filter((t) => BRIEFING.task.includes(t.text) && t.text.length > 8);
    expect(body.map((t) => t.text).join(" ")).toBe(BRIEFING.task);
    // Readable from the rows: the canvas spans about 17 m, so 40 px is 0.33 m of line.
    for (const t of body) expect(t.size).toBeGreaterThanOrEqual(40);
    inside(ctx, MAP_W, MAP_H);
  });

  it("paints the plan's steps numbered on the east wing's canvas", () => {
    const ctx = paintInto(MAP_W, MAP_H, (p) => paintBriefingPlan(p, 1, BRIEFING));
    const texts = ctx.texts.map((t) => t.text);
    expect(texts).toContain("ПЛАН");
    for (const n of ["1", "2", "3", "4"]) expect(texts).toContain(n);
    expect(texts.join(" ")).toContain("Сканирование открытых портов");
    expect(texts.some((t) => /^\d+[.)]/.test(t))).toBe(false);
    inside(ctx, MAP_W, MAP_H);
    // Many steps go to two columns, still inside the canvas.
    const many = { ...BRIEFING, plan: Array.from({ length: 9 }, (_, i) => `${i + 1}. Шаг номер ${i + 1} с подробным описанием работ`).join("\n") };
    const wide = paintInto(MAP_W, MAP_H, (p) => paintBriefingPlan(p, 1, many));
    const lefts = new Set(wide.texts.filter((t) => t.text.startsWith("Шаг")).map((t) => Math.round(t.left)));
    expect(lefts.size).toBe(2);
    inside(wide, MAP_W, MAP_H);
  });

  it("follows AM7's sentence: the step lit on the plan, large on the task screen, on the banner", () => {
    const focus = { section: "step" as const, step: 1, steps: 4, label: "ШАГ 2 / 4", title: "Сканирование открытых портов" };
    const lit = { ...BRIEFING, focus };
    const plan = paintInto(MAP_W, MAP_H, (p) => paintBriefingPlan(p, 1, lit));
    const color = (text: string) => plan.texts.find((t) => t.text.startsWith(text))?.color;
    expect(color("Сканирование открытых портов")).toBe("#ffffff");
    for (const other of ["Разведка поддоменов", "Сверка найденного", "Отчёт AM7"]) expect(color(other)).not.toBe("#ffffff");
    inside(plan, MAP_W, MAP_H);
    // Nothing lit: every step in full white.
    const plain = paintInto(MAP_W, MAP_H, (p) => paintBriefingPlan(p, 1, BRIEFING));
    expect(plain.texts.filter((t) => /^(Разведка|Сканирование|Сверка|Отчёт)/.test(t.text)).every((t) => t.color === "#ffffff")).toBe(true);
    // The task screen: the step's number huge, its title large, the task in the header.
    const task = paintInto(MAP_W, MAP_H, (p) => paintBriefingTask(p, 1, lit));
    const texts = task.texts.map((t) => t.text);
    expect(texts).toContain("02");
    expect(texts).toContain("ШАГ 2 ИЗ 4");
    expect(texts.join(" ")).toContain("Сканирование открытых портов");
    const number = task.texts.find((t) => t.text === "02")!;
    expect(number.size).toBeGreaterThanOrEqual(200);
    inside(task, MAP_W, MAP_H);
    // The banner: the step's label and title instead of the goal.
    const banner = paintInto(BANNER_W, BANNER_H, (p) => paintBriefingBanner(p, 1, lit));
    const bannerText = banner.texts.map((t) => t.text).join(" ");
    expect(bannerText).toContain("ШАГ 2 / 4");
    expect(bannerText).toContain("Сканирование открытых портов");
    expect(bannerText).not.toContain("ЦЕЛЬ");
    inside(banner, BANNER_W, BANNER_H);
  });

  it("says on the banner that AM7 is waiting for the floor, and how many stand at their places", () => {
    const banner = paintInto(BANNER_W, BANNER_H, (p) => paintBriefingBanner(p, 1, { ...BRIEFING, hold: { gathered: 37, expected: 52 } }));
    const texts = banner.texts.map((t) => t.text).join(" ");
    expect(texts).toContain("ОЖИДАНИЕ КОМАНДЫ");
    expect(texts).toContain("на местах 37 / 52");
    expect(texts).not.toContain("ЦЕЛЬ");
    inside(banner, BANNER_W, BANNER_H);
  });

  it("paints the goal on the banner with the live tag, and waits politely for missing parts", () => {
    const banner = paintInto(BANNER_W, BANNER_H, (p) => paintBriefingBanner(p, 1, BRIEFING));
    const texts = banner.texts.map((t) => t.text);
    expect(texts).toContain("ЦЕЛЬ");
    expect(texts).toContain("БРИФИНГ · AM7");
    expect(texts.join(" ")).toContain("Карта внешней поверхности атаки");
    inside(banner, BANNER_W, BANNER_H);
    const early = { ...BRIEFING, goal: "", plan: "" };
    expect(paintInto(MAP_W, MAP_H, (p) => paintBriefingPlan(p, 0, early)).texts.some((t) => t.text.startsWith("AM7 составляет план"))).toBe(true);
    expect(paintInto(BANNER_W, BANNER_H, (p) => paintBriefingBanner(p, 0, early)).texts.some((t) => t.text.startsWith("уточняется"))).toBe(true);
  });
});

describe("the video wall's briefing: layout and switching", () => {
  afterEach(() => vi.restoreAllMocks());

  it("puts the task and the plan whole on the wings and the goal's banner over the top of the map", () => {
    for (const [width, curve] of VIDEO_WALLS) {
      const fit = fitMap(width, 6.4, curve);
      const wings = mapWings(fit)!;
      const tiles = mapBriefing(fit)!;
      const [task, plan, goal] = tiles;
      expect([task.source, plan.source, goal.source]).toEqual(["left", "right", "banner"]);
      for (const [t, tw, th] of [
        [task, MAP_W, MAP_H],
        [plan, MAP_W, MAP_H],
        [goal, BANNER_W, BANNER_H],
      ] as const) {
        expect([t.u0, t.v0, t.u1, t.v1]).toEqual([0, 0, 1, 1]);
        expect((t.x1 - t.x0) / (t.y1 - t.y0)).toBeCloseTo(tw / th, 6);
      }
      expect(task.x0).toBeGreaterThanOrEqual(-wings.outer - 1e-9);
      expect(task.x1).toBeLessThanOrEqual(-wings.inner + 1e-9);
      expect(plan.x0).toBeGreaterThanOrEqual(wings.inner - 1e-9);
      expect(plan.x1).toBeLessThanOrEqual(wings.outer + 1e-9);
      // Level with the map's top, like the banner, which spans the map and hides little of it.
      expect(task.y1).toBeCloseTo(fit.mapY1, 9);
      expect(plan.y1).toBeCloseTo(fit.mapY1, 9);
      expect(goal.y1).toBeCloseTo(fit.mapY1, 9);
      expect(goal.x0).toBeGreaterThanOrEqual(fit.mapX0 - 1e-9);
      expect(goal.x1).toBeLessThanOrEqual(fit.mapX1 + 1e-9);
      expect(goal.x1 - goal.x0).toBeGreaterThan((fit.mapX1 - fit.mapX0) * 0.95);
      expect((goal.y1 - goal.y0) / (fit.mapY1 - fit.mapY0)).toBeLessThanOrEqual(0.2);
    }
  });

  it("switches the wall only once the pictures are painted, and back the same way", () => {
    // jsdom has no 2D canvas: the hub paints on the main thread into the fake
    // context (every other painter's calls, the globes' pixels included, do nothing).
    const anyContext = () =>
      new Proxy(new FakeContext({ width: 1, height: 1 }), {
        get: (target, key) =>
          key in target
            ? Reflect.get(target, key)
            : key === "createImageData"
              ? (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })
              : () => undefined,
      });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      anyContext as unknown as typeof HTMLCanvasElement.prototype.getContext,
    );
    const hub = new HqScreenHub();
    const renderer = {} as THREE.WebGLRenderer;
    let seconds = 0;
    const run = (until: () => boolean) => {
      for (let i = 0; i < 400 && !until(); i++) hub.update((seconds += 0.25), [], renderer);
      return until();
    };
    run(() => false);
    expect(hub.briefingOnWings).toBe(false);
    expect(hub.briefingBanner).toBe(false);

    hub.setBriefing({ task: BRIEFING.task, goal: BRIEFING.goal, plan: "" });
    // Nothing moves until the pictures are there.
    expect(hub.briefingOnWings).toBe(false);
    expect(hub.briefingBanner).toBe(false);
    expect(run(() => hub.briefingOnWings && hub.briefingBanner)).toBe(true);
    // The plan comes in later: the same briefing, no flicker of the banner.
    hub.setBriefing({ task: BRIEFING.task, goal: BRIEFING.goal, plan: BRIEFING.plan });
    expect(hub.briefingBanner).toBe(true);
    expect(hub.briefingOnWings).toBe(true);

    hub.setBriefing(null);
    expect(hub.briefingBanner).toBe(false);
    // The wings keep the briefing until both panels are repainted as usual.
    expect(hub.briefingOnWings).toBe(true);
    expect(run(() => !hub.briefingOnWings)).toBe(true);
    hub.dispose();
  });
});
