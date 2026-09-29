import * as THREE from "three";
import { WORKSTATION } from "@/features/hq/core/config";
import type { HqArena } from "@/features/hq/core/types";

// Floor markings of the amphitheatre (HqLayout.arena): crisp hairlines along
// both edges of every walkway (the stage arc in front of the first row, the
// ring behind every row) and along both edges of every straight aisle where it
// crosses a row. The walkways stay open where they meet, so every block of
// desks is outlined on its own. Pure geometry, no materials: one merged mesh.
//
// Every vertex sits on its line's centre; `aCross` is the unit vector across
// the line toward that vertex's edge, so the shader sets the width (and can
// keep a far line a pixel wide instead of letting it break into dashes).
//
// Angles follow HqArena: from due south (+Z), positive toward the east (+X);
// a point at angle a and radius r is at (x + r sin a, z + r cos a).

/** Width of every line on the floor (metres). */
export const ARENA_LINE_WIDTH = 0.025;
/** Height of the lines above the floor; the material's polygonOffset does the rest. */
export const ARENA_LINE_LIFT = 0.003;
/** The lines run this far inside a walkway's edges (the chair backs, the desks' fronts). */
const EDGE_INSET = 0.15;
/** Floor behind a chair centre that belongs to the desk (HQ_CHAIR_CLEARANCE). */
const CHAIR_BACK = 0.5;
/** Half the clear width of a straight aisle, to the desks' corners (AISLE_HALF in core/layout.ts). */
const AISLE_HALF = 0.9;
/** A row's lines run on past its end desks' centres by half a desk and a little more. */
const ROW_RUN_OUT = WORKSTATION.width / 2 + 0.35;
/** A walkway narrower than this between its line pair gets one centre line instead. */
const MIN_PAIR_GAP = 0.5;
/** Longest chord along an arc (metres). */
const ARC_STEP = 0.3;

/** A circle the lines keep out of (the holo table, AM7's island). */
export type ArenaKeepOut = { x: number; z: number; radius: number };

type Interval = [number, number];

/** Angle interval [a0, a1] minus a set of excluded intervals, as sorted runs. */
function subtract(a0: number, a1: number, cuts: Interval[]): Interval[] {
  let runs: Interval[] = [[a0, a1]];
  for (const [c0, c1] of cuts) {
    const next: Interval[] = [];
    for (const [r0, r1] of runs) {
      if (c1 <= r0 || c0 >= r1) {
        next.push([r0, r1]);
        continue;
      }
      if (c0 > r0) next.push([r0, c0]);
      if (c1 < r1) next.push([c1, r1]);
    }
    runs = next;
  }
  return runs.filter(([r0, r1]) => r1 - r0 > 1e-6);
}

/** Builds the markings; null when the layout has no rows. */
export function buildArenaLines(arena: HqArena, keepOuts: readonly ArenaKeepOut[] = []): THREE.BufferGeometry | null {
  const { rows, spans, rings, aisles, stage } = arena;
  if (rows.length === 0) return null;
  const positions: number[] = [];
  const cross: number[] = [];
  const y = ARENA_LINE_LIFT;
  const cx = arena.x;
  const cz = arena.z;
  const aisleEdge = AISLE_HALF - EDGE_INSET;

  const vertex = (x: number, z: number, ux: number, uz: number) => {
    positions.push(x, y, z);
    cross.push(ux, uz);
  };
  /**
   * One piece of a line from centre point p to q; (nx, nz) at p and (mx, mz)
   * at q are the unit vectors across it. Two triangles facing up.
   */
  const piece = (px: number, pz: number, nx: number, nz: number, qx: number, qz: number, mx: number, mz: number) => {
    vertex(px, pz, -nx, -nz);
    vertex(px, pz, nx, nz);
    vertex(qx, qz, -mx, -mz);
    vertex(qx, qz, -mx, -mz);
    vertex(px, pz, nx, nz);
    vertex(qx, qz, mx, mz);
  };

  /** A line along the arc of `radius` from angle a0 to a1. */
  const arc = (radius: number, a0: number, a1: number) => {
    const n = Math.max(1, Math.ceil((radius * (a1 - a0)) / ARC_STEP));
    for (let k = 0; k < n; k++) {
      const t0 = a0 + ((a1 - a0) * k) / n;
      const t1 = a0 + ((a1 - a0) * (k + 1)) / n;
      const s0 = Math.sin(t0);
      const c0 = Math.cos(t0);
      const s1 = Math.sin(t1);
      const c1 = Math.cos(t1);
      piece(cx + radius * s0, cz + radius * c0, s0, c0, cx + radius * s1, cz + radius * c1, s1, c1);
    }
  };

  /** A straight line from p to q. */
  const segment = (px: number, pz: number, qx: number, qz: number) => {
    const length = Math.hypot(qx - px, qz - pz);
    if (length < 1e-4) return;
    const nx = -(qz - pz) / length;
    const nz = (qx - px) / length;
    piece(px, pz, nx, nz, qx, qz, nx, nz);
  };

  /** Row r's half extent (radians) at `radius`: past its end desks by ROW_RUN_OUT, never past a half turn. */
  const extent = (r: number, radius: number) => Math.min(Math.PI * 0.5, (spans[r] ?? 0) + ROW_RUN_OUT / Math.max(radius, 1));

  /** The angles a line of `radius` gives up to the aisles crossing row r, and to the keep-outs. */
  const cutsAt = (radius: number, ext: number, aisleRows: boolean): Interval[] => {
    const cuts: Interval[] = [];
    if (aisleRows) {
      for (const a of aisles) {
        if (Math.abs(a) >= ext || radius <= aisleEdge) continue;
        const d = Math.asin(aisleEdge / radius);
        cuts.push([a - d, a + d]);
      }
    }
    for (const k of keepOuts) {
      const dx = k.x - cx;
      const dz = k.z - cz;
      const d = Math.hypot(dx, dz);
      if (d < 1e-6 || Math.abs(d - radius) >= k.radius) continue;
      const cos = (radius * radius + d * d - k.radius * k.radius) / (2 * radius * d);
      const spread = Math.acos(Math.max(-1, Math.min(1, cos)));
      const at = Math.atan2(dx, dz);
      cuts.push([at - spread, at + spread]);
    }
    return cuts.sort((p, q) => p[0] - q[0]);
  };

  /** One line along an arc across row r's extent, broken at the aisles (when it borders a row) and keep-outs. */
  const ringLine = (radius: number, r: number, bordersRow: boolean) => {
    const ext = extent(r, radius);
    for (const [a0, a1] of subtract(-ext, ext, cutsAt(radius, ext, bordersRow))) arc(radius, a0, a1);
  };

  /** Radii of the pair of lines along a walkway centred at `centre` between the free edges lo and hi. */
  const pair = (centre: number, lo: number, hi: number): number[] => {
    const halfWidth = Math.min(centre - lo, hi - centre) - EDGE_INSET;
    return halfWidth * 2 < MIN_PAIR_GAP ? [centre] : [centre - halfWidth, centre + halfWidth];
  };

  const deskFront = (r: number) => rows[r] - WORKSTATION.deskBack;
  const chairBack = (r: number) => rows[r] + CHAIR_BACK;

  // The stage walkway in front of the first row: its inner line faces the
  // holo table, its outer one the first row's desks.
  const stageLines = pair(stage, stage - (deskFront(0) - stage), deskFront(0));
  stageLines.forEach((radius, i) => ringLine(radius, 0, i === stageLines.length - 1 && stageLines.length > 1));

  // The ring behind every row: its inner line behind this row's chairs, its
  // outer one in front of the next row's desks (or as far out again behind the last).
  const ringLines: number[][] = rings.map((ring, r) => {
    const next = r + 1 < rows.length ? deskFront(r + 1) : ring + (ring - chairBack(r));
    const lines = pair(ring, chairBack(r), next);
    lines.forEach((radius, i) => {
      // The inner line borders row r; the outer one row r + 1 (or row r again behind the last).
      const bordering = i === 0 || r + 1 >= rows.length ? r : r + 1;
      ringLine(radius, bordering, true);
    });
    return lines;
  });

  // Both edges of every straight aisle across every row it cuts, from the line
  // in front of the row to the line behind it.
  rows.forEach((radius, r) => {
    const front = r === 0 ? stageLines[stageLines.length - 1] : ringLines[r - 1][ringLines[r - 1].length - 1];
    const back = ringLines[r]?.[0];
    if (front === undefined || back === undefined || back <= front) return;
    for (const a of aisles) {
      if (Math.abs(a) >= extent(r, radius)) continue;
      const ux = Math.sin(a);
      const uz = Math.cos(a);
      for (const side of [-1, 1]) {
        const ox = side * aisleEdge * uz;
        const oz = -side * aisleEdge * ux;
        const t0 = Math.sqrt(Math.max(0, front * front - aisleEdge * aisleEdge));
        const t1 = Math.sqrt(Math.max(0, back * back - aisleEdge * aisleEdge));
        segment(cx + ux * t0 + ox, cz + uz * t0 + oz, cx + ux * t1 + ox, cz + uz * t1 + oz);
      }
    }
  });

  if (positions.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aCross", new THREE.Float32BufferAttribute(cross, 2));
  geometry.computeBoundingSphere();
  return geometry;
}
