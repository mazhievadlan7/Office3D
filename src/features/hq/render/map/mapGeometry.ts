import * as THREE from "three";
import { MAP_CASE, arcSag, arcSlope, mapCaseExtent, type MapFit } from "./mapProjection";
import type { MapWingSource, MapWingTile } from "./mapWings";

/**
 * The video wall's geometry in display-local metres (origin at the centre of
 * the display on the wall's face, +x east, +y up, +z into the room), every
 * layer bent onto the concave arc once, on the CPU. Bending only moves z
 * (arcSag) and turns the normals, so x, y and the UVs stay the flat layout
 * the shaders read as display-local metres.
 */

/** Depth of each layer in front of the arc, metres. The case's front is the arc itself, MAP_CASE.front off the wall. */
export const MAP_LAYER_Z = {
  halo: MAP_CASE.front + 0.012,
  bezelBack: MAP_CASE.front,
  bezelFront: MAP_CASE.front + 0.07,
  panel: MAP_CASE.front + 0.035,
  earth: MAP_CASE.front + 0.038,
  wings: MAP_CASE.front + 0.038,
  overlay: MAP_CASE.front + 0.039,
  /** The briefing's goal banner over the map, in front of the markers (drawn 1 cm off the overlay). */
  banner: MAP_CASE.front + 0.052,
} as const;

/** The floor spill lies this far above the floor. */
const FLOOR_LIFT = 0.012;
/** The case's back edge sinks this far into the wall, so no seam shows. */
const INTO_WALL = 0.01;
/**
 * Longest straight piece of a bent layer. On the flattest arc here (r ≈ 150 m)
 * a 0.4 m chord strays 0.13 mm from the circle, well inside the 3 mm between
 * layers, so layers never cut through each other between vertices.
 */
const ARC_STEP = 0.4;
const MAX_SEGMENTS = 192;

/** Segments along x for a bent piece `width` metres wide (1 when flat). */
export function arcSegments(width: number, k: number): number {
  if (k === 0 || !(width > 0)) return 1;
  return Math.min(MAX_SEGMENTS, Math.max(1, Math.ceil(width / ARC_STEP)));
}

/**
 * Bends a geometry built flat onto the arc: each vertex moves toward the room
 * by arcSag(k, x), and each normal by the inverse transpose of that shear
 * (a face's normal (0, 0, 1) becomes the arc's, ±x and ±y faces keep theirs).
 */
export function bendGeometry<T extends THREE.BufferGeometry>(geometry: T, k: number): T {
  if (k !== 0) {
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const normal = geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      position.setZ(i, position.getZ(i) + arcSag(k, x));
      if (normal) {
        const nz = normal.getZ(i);
        const nx = normal.getX(i) - arcSlope(k, x) * nz;
        const ny = normal.getY(i);
        const length = Math.hypot(nx, ny, nz) || 1;
        normal.setXYZ(i, nx / length, ny / length, nz / length);
      }
    }
    position.needsUpdate = true;
    if (normal) normal.needsUpdate = true;
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

type V3 = readonly [number, number, number];

/**
 * Collects quads into one indexed geometry, each quad wound to face its given
 * normal. A quad may be shaded (a grey vertex colour, for a material with
 * vertexColors): the geometry then carries a colour per vertex.
 */
class QuadBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly shades: number[] = [];
  private readonly indices: number[] = [];
  private shaded = false;

  quad(a: V3, b: V3, c: V3, d: V3, normal: V3, shade = 1): void {
    const base = this.positions.length / 3;
    if (shade !== 1) this.shaded = true;
    for (const p of [a, b, c, d]) {
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(normal[0], normal[1], normal[2]);
      this.shades.push(shade, shade, shade);
    }
    // (b - a) x (c - a) against the wanted normal decides the winding.
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const facing = (uy * vz - uz * vy) * normal[0] + (uz * vx - ux * vz) * normal[1] + (ux * vy - uy * vx) * normal[2];
    if (facing >= 0) this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else this.indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }

  /** A face split into `segments` quads along x; `at(x, s)` gives the point at x on edge s (0 or 1). */
  strip(x0: number, x1: number, segments: number, at: (x: number, edge: 0 | 1) => V3, normal: (x: number) => V3, shade = 1): void {
    for (let i = 0; i < segments; i++) {
      const xa = x0 + ((x1 - x0) * i) / segments;
      const xb = x0 + ((x1 - x0) * (i + 1)) / segments;
      // One normal per quad keeps the builder simple; bent faces get theirs from bendGeometry.
      this.quad(at(xa, 0), at(xb, 0), at(xb, 1), at(xa, 1), normal((xa + xb) / 2), shade);
    }
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(this.normals, 3));
    if (this.shaded) geometry.setAttribute("color", new THREE.Float32BufferAttribute(this.shades, 3));
    geometry.setIndex(this.indices);
    return geometry;
  }
}

const UP: V3 = [0, 1, 0];
const DOWN: V3 = [0, -1, 0];
const EAST: V3 = [1, 0, 0];
const WEST: V3 = [-1, 0, 0];
const OUT: V3 = [0, 0, 1];

/**
 * The bezel: four bars round the glass, standing off the case, with their
 * outer edges and the inner lips down to the glass. Built flat, then bent
 * (the long bars in short pieces).
 */
function createBezel(fit: MapFit): THREE.BufferGeometry {
  const ow = fit.outerW / 2;
  const oh = fit.outerH / 2;
  const iw = fit.panelW / 2;
  const ih = fit.panelH / 2;
  const z0 = MAP_LAYER_Z.bezelBack;
  const z1 = MAP_LAYER_Z.bezelFront;
  const k = fit.arcK;
  const long = arcSegments(fit.outerW, k);
  const lip = arcSegments(fit.panelW, k);
  const b = new QuadBuilder();
  const out = () => OUT;
  for (const side of [1, -1] as const) {
    // Top (side 1) and bottom (side -1) bars across the full width.
    const yo = side * oh;
    const yi = side * ih;
    b.strip(-ow, ow, long, (x, e) => [x, e ? yo : yi, z1], out);
    b.strip(-ow, ow, long, (x, e) => [x, yo, e ? z1 : z0], () => (side > 0 ? UP : DOWN));
    b.strip(-iw, iw, lip, (x, e) => [x, yi, e ? z1 : z0], () => (side > 0 ? DOWN : UP));
    // Side bars between them.
    const xo = side * ow;
    const xi = side * iw;
    b.quad([Math.min(xo, xi), -ih, z1], [Math.max(xo, xi), -ih, z1], [Math.max(xo, xi), ih, z1], [Math.min(xo, xi), ih, z1], OUT);
    b.quad([xo, -oh, z0], [xo, -oh, z1], [xo, oh, z1], [xo, oh, z0], side > 0 ? EAST : WEST);
    b.quad([xi, -ih, z0], [xi, -ih, z1], [xi, ih, z1], [xi, ih, z0], side > 0 ? WEST : EAST);
  }
  return bendGeometry(b.build(), k);
}

/**
 * The case's top, seen from the camera's height, is a crescent up to 2.5 m
 * deep: the hall's even light from above would make it a grey shelf over the
 * display, so it is shaded down to the dark band the concept has.
 */
export const MAP_CASE_TOP_SHADE = 0.3;

/**
 * The case: its front on the arc from the floor to above the bezel, its top
 * and its two ends reaching back into the wall. Built already bent, since
 * its back follows the flat wall while its front follows the arc. Its colour
 * attribute darkens the top (MAP_CASE_TOP_SHADE).
 */
function createCase(fit: MapFit, floorY: number): THREE.BufferGeometry {
  const k = fit.arcK;
  const { halfW, top } = mapCaseExtent(fit);
  const front = (x: number) => MAP_CASE.front + arcSag(k, x);
  const facing = (x: number): V3 => {
    const slope = arcSlope(k, x);
    const length = Math.hypot(slope, 1);
    return [-slope / length, 0, 1 / length];
  };
  const segments = arcSegments(halfW * 2, k);
  const b = new QuadBuilder();
  b.strip(-halfW, halfW, segments, (x, e) => [x, e ? top : floorY, front(x)], facing);
  b.strip(-halfW, halfW, segments, (x, e) => [x, top, e ? front(x) : -INTO_WALL], () => UP, MAP_CASE_TOP_SHADE);
  for (const side of [1, -1] as const) {
    const x = side * halfW;
    b.quad([x, floorY, -INTO_WALL], [x, floorY, front(x)], [x, top, front(x)], [x, top, -INTO_WALL], side > 0 ? EAST : WEST);
  }
  const geometry = b.build();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** A plane in the xy plane at depth z, split along x, with `uv` = its position in metres. */
function metricPlane(x0: number, x1: number, y0: number, y1: number, z: number, segments: number): THREE.PlaneGeometry {
  const plane = new THREE.PlaneGeometry(x1 - x0, y1 - y0, segments, 1);
  plane.translate((x0 + x1) / 2, (y0 + y1) / 2, z);
  const position = plane.getAttribute("position");
  const uv = plane.getAttribute("uv");
  for (let i = 0; i < uv.count; i++) uv.setXY(i, position.getX(i), position.getY(i));
  return plane;
}

/**
 * The light spill on the floor: a band from the foot of the case out into
 * the room, following the arc. Its `uv` is what the glow shader reads as
 * display-local metres: x across, and y from +depth/2 at the case to -depth/2.
 */
function createFloorSpill(fit: MapFit, floorY: number, size: THREE.Vector2): THREE.BufferGeometry {
  const k = fit.arcK;
  const half = size.x / 2;
  const depth = size.y;
  const segments = arcSegments(size.x, k);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const y = floorY + FLOOR_LIFT;
  for (let i = 0; i <= segments; i++) {
    const x = -half + (size.x * i) / segments;
    const z = MAP_CASE.front + arcSag(k, x);
    positions.push(x, y, z, x, y, z + depth);
    normals.push(0, 1, 0, 0, 1, 0);
    uvs.push(x, depth / 2, x, -depth / 2);
    if (i < segments) {
      const a = i * 2;
      // Wound to face up: near edge a, a + 2; far edge a + 1, a + 3.
      indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export type DisplayGeometry = {
  /** The matte case filling the space between the arc and the wall. */
  body: THREE.BufferGeometry;
  bezel: THREE.BufferGeometry;
  /** The glass, in display-local metres (the panel shader reads position.xy). */
  panel: THREE.BufferGeometry;
  /** The Earth's surface over the land rectangle, in display-local metres (uv 0..1 west-east, south-north). */
  earth: THREE.BufferGeometry;
  /** The glow on the case's face round the glass (uv = display-local metres). */
  halo: THREE.BufferGeometry;
  floor: THREE.BufferGeometry;
  /** Width of the floor spill across and its depth into the room. */
  floorSize: THREE.Vector2;
  dispose(): void;
};

/** Every surface of the display but the wings and the markers, at its layer depth, bent. */
export function createDisplayGeometry(fit: MapFit, floorY: number): DisplayGeometry {
  const k = fit.arcK;
  const panel = new THREE.PlaneGeometry(fit.panelW, fit.panelH, arcSegments(fit.panelW, k), 1);
  panel.translate(0, 0, MAP_LAYER_Z.panel);
  bendGeometry(panel, k);

  const mapW = fit.mapX1 - fit.mapX0;
  const earth = new THREE.PlaneGeometry(mapW, fit.mapY1 - fit.mapY0, arcSegments(mapW, k), 1);
  earth.translate((fit.mapX0 + fit.mapX1) / 2, (fit.mapY0 + fit.mapY1) / 2, MAP_LAYER_Z.earth);
  bendGeometry(earth, k);

  const { halfW, top } = mapCaseExtent(fit);
  const halo = bendGeometry(metricPlane(-halfW, halfW, Math.min(floorY, -top), top, MAP_LAYER_Z.halo, arcSegments(halfW * 2, k)), k);

  const floorSize = new THREE.Vector2(halfW * 2, THREE.MathUtils.clamp(fit.outerH * 0.9, 3, 6));
  const floor = createFloorSpill(fit, floorY, floorSize);
  const body = createCase(fit, floorY);
  const bezel = createBezel(fit);

  return {
    body,
    bezel,
    panel,
    earth,
    halo,
    floor,
    floorSize,
    dispose() {
      body.dispose();
      bezel.dispose();
      panel.dispose();
      earth.dispose();
      halo.dispose();
      floor.dispose();
    },
  };
}

/**
 * One source's tiles merged into a single bent geometry, at the wings' layer
 * (or `z`): each tile a strip of quads with its texture rect (v = 0 at the
 * top edge, as the screen hub's textures keep their top row there).
 */
export function createWingGeometry(
  tiles: readonly MapWingTile[],
  source: MapWingSource,
  k: number,
  z: number = MAP_LAYER_Z.wings,
): THREE.BufferGeometry | null {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const t of tiles) {
    if (t.source !== source) continue;
    const segments = arcSegments(t.x1 - t.x0, k);
    const base = positions.length / 3;
    for (let i = 0; i <= segments; i++) {
      const f = i / segments;
      const x = t.x0 + (t.x1 - t.x0) * f;
      const u = t.u0 + (t.u1 - t.u0) * f;
      positions.push(x, t.y1, z, x, t.y0, z);
      normals.push(0, 0, 1, 0, 0, 1);
      uvs.push(u, t.v0, u, t.v1);
      if (i < segments) {
        const a = base + i * 2;
        // Top edge a, a + 2; bottom edge a + 1, a + 3: counter-clockwise seen from the room.
        indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
      }
    }
  }
  if (indices.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return bendGeometry(geometry, k);
}
