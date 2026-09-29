import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { HqLayout } from "@/features/hq/core/types";
import { entranceGap } from "./layoutGeometry";
import { CURB_HEIGHT, WALL_LINE, WALL_THICKNESS } from "./palette";

// The room shell as a handful of merged geometries: tall north and west walls
// (the north one taller still: it carries the video wall), low south and east
// curbs (so they never hide the room from the south-east camera), metal caps,
// and the emissive lines. Five draw calls in total.

export type RoomShellGeometry = {
  walls: THREE.BufferGeometry;
  caps: THREE.BufferGeometry;
  /** Lines on the tall back walls. */
  lines: THREE.BufferGeometry;
  /** Lines on the low curbs and the entrance posts. */
  curbLines: THREE.BufferGeometry;
};

/** Axis-aligned box from min/max corners. */
type Box = [x0: number, y0: number, z0: number, x1: number, y1: number, z1: number];

export function boxesToGeometry(boxes: Box[]): THREE.BufferGeometry {
  const parts = boxes
    .filter(([x0, y0, z0, x1, y1, z1]) => x1 - x0 > 1e-4 && y1 - y0 > 1e-4 && z1 - z0 > 1e-4)
    .map(([x0, y0, z0, x1, y1, z1]) => {
      const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
      g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      return g;
    });
  if (parts.length === 0) return new THREE.BufferGeometry();
  const merged = mergeGeometries(parts, false) ?? new THREE.BufferGeometry();
  for (const p of parts) p.dispose();
  return merged;
}

export function buildRoomShell(layout: HqLayout): RoomShellGeometry {
  const { x0, z0, x1, z1 } = layout.bounds;
  const t = WALL_THICKNESS;
  // The west wall and the north wall (the video wall's) have heights of their own.
  const H = layout.wallHeight;
  const N = layout.northWallHeight;
  const c = CURB_HEIGHT;
  const gap = entranceGap(layout);

  const walls: Box[] = [
    // North wall runs the full width, including the corners.
    [x0 - t, 0, z0 - t, x1 + t, N, z0],
    // West wall, butting into the north wall.
    [x0 - t, 0, z0, x0, H, z1 + t],
  ];
  const caps: Box[] = [
    [x0 - t - 0.01, N, z0 - t - 0.01, x1 + t + 0.01, N + 0.035, z0 + 0.01],
    [x0 - t - 0.01, H, z0 + 0.01, x0 + 0.01, H + 0.035, z1 + t + 0.01],
  ];
  // Emissive line profile: 2.5 cm tall, standing 1.2 cm proud of the wall.
  const lh = WALL_LINE.height;
  const lp = 0.012;
  const northTopY = N - WALL_LINE.belowTop;
  const westTopY = H - WALL_LINE.belowTop;
  const skirtY = WALL_LINE.skirt;
  const lines: Box[] = [
    [x0, northTopY - lh / 2, z0, x1, northTopY + lh / 2, z0 + lp],
    [x0, skirtY - lh / 2, z0, x1, skirtY + lh / 2, z0 + lp],
    [x0, westTopY - lh / 2, z0, x0 + lp, westTopY + lh / 2, z1],
    [x0, skirtY - lh / 2, z0, x0 + lp, skirtY + lh / 2, z1],
  ];

  // Low curbs, with the entrance cut out, and a red line along their top.
  const southRuns: Array<[number, number]> =
    gap.side === "south" ? [[x0, gap.from], [gap.to, x1 + t]] : [[x0, x1 + t]];
  const eastRuns: Array<[number, number]> =
    gap.side === "east" ? [[z0, gap.from], [gap.to, z1]] : [[z0, z1]];
  const lineW = 0.03;
  const curbLines: Box[] = [];
  for (const [a, b] of southRuns) {
    walls.push([a, 0, z1, b, c, z1 + t]);
    curbLines.push([a, c, z1 + t / 2 - lineW / 2, b, c + 0.005, z1 + t / 2 + lineW / 2]);
  }
  for (const [a, b] of eastRuns) {
    walls.push([x1, 0, a, x1 + t, c, b]);
    curbLines.push([x1 + t / 2 - lineW / 2, c, a, x1 + t / 2 + lineW / 2, c + 0.005, b]);
  }

  // Entrance: short glowing posts at both jambs.
  const postH = 1.1;
  const ps = 0.06;
  if (gap.side === "south") {
    const zc = z1 + t / 2;
    curbLines.push([gap.from - ps, 0, zc - ps / 2, gap.from, postH, zc + ps / 2]);
    curbLines.push([gap.to, 0, zc - ps / 2, gap.to + ps, postH, zc + ps / 2]);
  } else {
    const xc = x1 + t / 2;
    curbLines.push([xc - ps / 2, 0, gap.from - ps, xc + ps / 2, postH, gap.from]);
    curbLines.push([xc - ps / 2, 0, gap.to, xc + ps / 2, postH, gap.to + ps]);
  }

  return {
    walls: boxesToGeometry(walls),
    caps: boxesToGeometry(caps),
    lines: boxesToGeometry(lines),
    curbLines: boxesToGeometry(curbLines),
  };
}
