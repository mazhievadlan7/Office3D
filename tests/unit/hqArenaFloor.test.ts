import { describe, expect, it } from "vitest";

import { ARENA_LINE_LIFT, buildArenaLines } from "@/features/hq/render/environment/arenaLines";
import type { HqArena } from "@/features/hq/core/types";

// A synthetic amphitheatre shaped like generateHqLayout's: rows every 2.8 m,
// a walkway ring 1.1 m behind each row, aisles at -30, 0 and +30 degrees.
const ARENA: HqArena = {
  x: 2,
  z: -30,
  rows: [18.8, 21.6, 24.4],
  spans: [0.9, 0.95, 1.0],
  rings: [19.9, 22.7, 25.5],
  aisles: [-Math.PI / 6, 0, Math.PI / 6],
  stage: 16.7,
};
const TRIBUNE = { x: ARENA.x, z: ARENA.z + 14.2, radius: 2.3 };

function lineCentres() {
  const geometry = buildArenaLines(ARENA, [TRIBUNE]);
  expect(geometry).not.toBeNull();
  const position = geometry!.getAttribute("position");
  const cross = geometry!.getAttribute("aCross");
  const points: Array<{ x: number; y: number; z: number; cx: number; cz: number }> = [];
  for (let i = 0; i < position.count; i++) {
    points.push({ x: position.getX(i), y: position.getY(i), z: position.getZ(i), cx: cross.getX(i), cz: cross.getY(i) });
  }
  return { geometry: geometry!, points };
}

describe("the arena's floor lines", () => {
  it("lie on the floor as whole triangles with unit cross vectors", () => {
    const { geometry, points } = lineCentres();
    expect(geometry.getAttribute("position").count % 3).toBe(0);
    for (const p of points) {
      expect(p.y).toBeCloseTo(ARENA_LINE_LIFT, 6);
      expect(Math.hypot(p.cx, p.cz)).toBeCloseTo(1, 5);
    }
  });

  it("keep out of the tribune's circle", () => {
    for (const p of lineCentres().points) {
      expect(Math.hypot(p.x - TRIBUNE.x, p.z - TRIBUNE.z)).toBeGreaterThan(TRIBUNE.radius - 1e-3);
    }
  });

  it("leave every aisle open through the rows and the rings", () => {
    // Everything outside the stage walkway's inner line (which faces the
    // tribune, not a row) stays at least an aisle edge from every aisle's axis.
    for (const p of lineCentres().points) {
      const dx = p.x - ARENA.x;
      const dz = p.z - ARENA.z;
      if (Math.hypot(dx, dz) < ARENA.stage) continue;
      for (const a of ARENA.aisles) {
        const along = dx * Math.sin(a) + dz * Math.cos(a);
        if (along <= 0) continue;
        const across = Math.abs(dx * Math.cos(a) - dz * Math.sin(a));
        expect(across).toBeGreaterThan(0.75 - 1e-3);
      }
    }
  });

  it("run along both edges of every walkway ring, clear of the chairs and the desks", () => {
    const radii = new Set(lineCentres().points.map((p) => Math.round(Math.hypot(p.x - ARENA.x, p.z - ARENA.z) * 100) / 100));
    ARENA.rings.forEach((ring, r) => {
      expect(radii.has(Math.round((ring - 0.45) * 100) / 100)).toBe(true);
      expect(radii.has(Math.round((ring + 0.45) * 100) / 100)).toBe(true);
      // Behind this row's chair backs, in front of the next row's desks.
      expect(ring - 0.45).toBeGreaterThan(ARENA.rows[r] + 0.5);
      if (r + 1 < ARENA.rows.length) expect(ring + 0.45).toBeLessThan(ARENA.rows[r + 1] - 1.1);
    });
  });

  it("draws nothing for an empty arena", () => {
    expect(buildArenaLines({ ...ARENA, rows: [], spans: [], rings: [] })).toBeNull();
  });
});

