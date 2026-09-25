import { describe, expect, it } from "vitest";

import { HQ_CAPACITIES, WORKSTATION, type HqCapacity } from "@/features/hq/core/config";
import { HQ_CHAIR_CLEARANCE, generateHqLayout } from "@/features/hq/core/layout";
import { navNodeCount, nearestNode } from "@/features/hq/core/nav";
import type { HqDesk, HqLayout, HqProp, HqPropKind, HqRect } from "@/features/hq/core/types";

type P = { x: number; z: number };

// Footprints (width along local X, depth along local Z) of props.glb kinds.
const PROP_SIZE: Record<HqPropKind, [number, number]> = {
  planter_tall: [0.54, 0.54],
  planter_low: [1.2, 0.42],
  server_rack: [0.6, 1.1],
  sofa: [2.2, 0.9],
  lounge_chair: [0.82, 0.8],
  coffee_table: [1.1, 0.6],
  coffee_bar: [2.5, 0.76],
  meeting_table: [3.2, 1.3],
  meeting_chair: [0.5, 0.5],
  exec_desk: [0, 0],
  exec_chair: [0, 0],
  exec_shelf: [1.8, 0.4],
  wall_screen: [2.2, 0.05],
  floor_lamp: [0.3, 0.3],
};

function rectPoly(x: number, z: number, rotY: number, lx0: number, lx1: number, lz0: number, lz1: number): P[] {
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  return [
    [lx0, lz0],
    [lx1, lz0],
    [lx1, lz1],
    [lx0, lz1],
  ].map(([lx, lz]) => ({ x: x + lx * c + lz * s, z: z - lx * s + lz * c }));
}

/** Desk + chair footprint of a workstation, shrunk a little so touching desks pass. */
function deskPoly(d: HqDesk, shrink = 0.02): P[] {
  return rectPoly(
    d.x,
    d.z,
    d.rotY,
    -WORKSTATION.width / 2 + shrink,
    WORKSTATION.width / 2 - shrink,
    -HQ_CHAIR_CLEARANCE + shrink,
    WORKSTATION.deskBack - shrink,
  );
}

function propPoly(p: HqProp, grow = 0): P[] | null {
  const [w, d] = PROP_SIZE[p.kind];
  if (w === 0) return null;
  return rectPoly(p.x, p.z, p.rotY, -w / 2 - grow, w / 2 + grow, -d / 2 - grow, d / 2 + grow);
}

function project(poly: P[], ax: number, az: number): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const p of poly) {
    const v = p.x * ax + p.z * az;
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return [min, max];
}

/** Separating-axis test for convex polygons (segments count as 2-point polygons). */
function overlaps(a: P[], b: P[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p0 = poly[i];
      const p1 = poly[(i + 1) % poly.length];
      const ax = -(p1.z - p0.z);
      const az = p1.x - p0.x;
      if (ax === 0 && az === 0) continue;
      const [a0, a1] = project(a, ax, az);
      const [b0, b1] = project(b, ax, az);
      if (a1 <= b0 || b1 <= a0) return false;
    }
  }
  return true;
}

function segment(ax: number, az: number, bx: number, bz: number): P[] {
  // A segment is separated by its own normal and by its direction.
  return [
    { x: ax, z: az },
    { x: bx, z: bz },
  ];
}

function segmentOverlaps(seg: P[], poly: P[]): boolean {
  if (!overlaps(seg, poly)) return false;
  // Also test the segment direction as an axis (overlaps() only uses normals).
  const dx = seg[1].x - seg[0].x;
  const dz = seg[1].z - seg[0].z;
  const [a0, a1] = project(seg, dx, dz);
  const [b0, b1] = project(poly, dx, dz);
  return !(a1 <= b0 || b1 <= a0);
}

function insideRect(p: P, r: HqRect, eps = 1e-6): boolean {
  return p.x >= r.x0 - eps && p.x <= r.x1 + eps && p.z >= r.z0 - eps && p.z <= r.z1 + eps;
}

function segmentsCross(a: P, b: P, c: P, d: P): boolean {
  const cross = (o: P, p: P, q: P) => (p.x - o.x) * (q.z - o.z) - (p.z - o.z) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}

function reachable(layout: HqLayout, from: number): Uint8Array {
  const n = navNodeCount(layout.nav);
  const adj: number[][] = Array.from({ length: n }, () => []);
  const e = layout.nav.edges;
  for (let i = 0; i < e.length; i += 2) {
    adj[e[i]].push(e[i + 1]);
    adj[e[i + 1]].push(e[i]);
  }
  const seen = new Uint8Array(n);
  const queue = [from];
  seen[from] = 1;
  while (queue.length) {
    const u = queue.pop()!;
    for (const v of adj[u]) {
      if (!seen[v]) {
        seen[v] = 1;
        queue.push(v);
      }
    }
  }
  return seen;
}

function navEdges(layout: HqLayout): Array<[P, P]> {
  const p = layout.nav.positions;
  const e = layout.nav.edges;
  const out: Array<[P, P]> = [];
  for (let i = 0; i < e.length; i += 2) {
    out.push([
      { x: p[e[i] * 2], z: p[e[i] * 2 + 1] },
      { x: p[e[i + 1] * 2], z: p[e[i + 1] * 2 + 1] },
    ]);
  }
  return out;
}

const layouts = new Map<HqCapacity, HqLayout>(HQ_CAPACITIES.map((c) => [c, generateHqLayout(c)]));

describe.each(HQ_CAPACITIES)("generateHqLayout(%i)", (capacity) => {
  const layout = layouts.get(capacity)!;

  it("has exactly one desk per seat with stable ids", () => {
    expect(layout.capacity).toBe(capacity);
    expect(layout.desks).toHaveLength(capacity);
    const ids = new Set(layout.desks.map((d) => d.id));
    expect(ids.size).toBe(capacity);
    layout.desks.forEach((d, i) => {
      expect(d.index).toBe(i);
      expect(d.id).toBe(`hq-desk-${String(i).padStart(4, "0")}`);
      expect(d.podId).toBeGreaterThanOrEqual(0);
    });
    expect(layout.leadDesk.index).toBe(-1);
  });

  it("keeps desks inside the hall and apart from each other", () => {
    const polys = layout.desks.map((d) => deskPoly(d));
    for (const poly of polys) for (const p of poly) expect(insideRect(p, layout.bounds)).toBe(true);
    // Bucket by 4 m cells; desks further apart cannot overlap.
    const buckets = new Map<string, number[]>();
    layout.desks.forEach((d, i) => {
      const key = `${Math.floor(d.x / 4)}:${Math.floor(d.z / 4)}`;
      buckets.set(key, [...(buckets.get(key) ?? []), i]);
    });
    let pairs = 0;
    layout.desks.forEach((d, i) => {
      const cx = Math.floor(d.x / 4);
      const cz = Math.floor(d.z / 4);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const j of buckets.get(`${cx + dx}:${cz + dz}`) ?? []) {
            if (j <= i) continue;
            pairs++;
            expect(overlaps(polys[i], polys[j]), `desks ${i} and ${j}`).toBe(false);
          }
        }
      }
    });
    expect(pairs).toBeGreaterThan(capacity);
  });

  it("keeps desks and props clear of glass partitions", () => {
    const polys = [...layout.desks, layout.leadDesk].map((d) => deskPoly(d));
    for (const seg of layout.partitions) {
      const s = segment(seg.ax, seg.az, seg.bx, seg.bz);
      for (const poly of polys) expect(segmentOverlaps(s, poly)).toBe(false);
      for (const prop of layout.props) {
        const poly = propPoly(prop);
        if (poly) expect(segmentOverlaps(s, poly), `${prop.kind} at ${prop.x},${prop.z}`).toBe(false);
      }
    }
  });

  it("places props inside the hall without hitting desks or each other", () => {
    const deskPolys = layout.desks.map((d) => deskPoly(d));
    const props = layout.props.map((p) => ({ p, poly: propPoly(p, -0.01) }));
    for (const { p, poly } of props) {
      expect(insideRect(p, layout.bounds)).toBe(true);
      if (!poly) continue;
      for (const q of poly) expect(insideRect(q, layout.bounds, 0.01), `${p.kind} at ${p.x},${p.z}`).toBe(true);
      for (let i = 0; i < deskPolys.length; i++) {
        const d = layout.desks[i];
        if (Math.abs(d.x - p.x) > 5 || Math.abs(d.z - p.z) > 5) continue;
        expect(overlaps(poly, deskPolys[i]), `${p.kind} at ${p.x},${p.z} vs desk ${i}`).toBe(false);
      }
    }
    for (let i = 0; i < props.length; i++) {
      for (let j = i + 1; j < props.length; j++) {
        const a = props[i];
        const b = props[j];
        if (!a.poly || !b.poly) continue;
        if (Math.abs(a.p.x - b.p.x) > 4 || Math.abs(a.p.z - b.p.z) > 4) continue;
        expect(overlaps(a.poly, b.poly), `${a.p.kind}@${a.p.x},${a.p.z} vs ${b.p.kind}@${b.p.x},${b.p.z}`).toBe(false);
      }
    }
  });

  it("zones the hall: AM7 office in the north-east, rooms along the west wall", () => {
    const b = layout.bounds;
    const office = layout.am7Office;
    expect(office.x1).toBeCloseTo(b.x1);
    expect(office.z0).toBeCloseTo(b.z0);
    expect(office.x1 - office.x0).toBeGreaterThanOrEqual(9);
    expect(office.z1 - office.z0).toBeGreaterThanOrEqual(8);
    const lead = layout.leadDesk;
    for (const p of deskPoly(lead)) expect(insideRect(p, office)).toBe(true);
    const officeKinds = layout.props.filter((p) => insideRect(p, office)).map((p) => p.kind);
    for (const kind of ["exec_desk", "exec_chair", "exec_shelf", "sofa", "planter_tall", "wall_screen"] as const) {
      expect(officeKinds).toContain(kind);
    }
    expect(layout.partitions.some((s) => s.kind === "glass-door" && Math.abs(s.az - office.z1) < 1e-6)).toBe(true);

    expect(layout.meetingRooms).toHaveLength(2);
    for (const room of [...layout.meetingRooms, layout.serverRoom, layout.lounge]) expect(room.x0).toBeCloseTo(b.x0);
    expect(layout.serverRoom.z1).toBeLessThanOrEqual(layout.meetingRooms[0].z0 + 1e-6);
    expect(layout.lounge.z1).toBeCloseTo(b.z1);
    for (const room of layout.meetingRooms) {
      const kinds = layout.props.filter((p) => insideRect(p, room)).map((p) => p.kind);
      expect(kinds).toContain("meeting_table");
      expect(kinds.filter((k) => k === "meeting_chair").length).toBeGreaterThanOrEqual(6);
    }
    const racks = layout.props.filter((p) => p.kind === "server_rack");
    expect(racks.length).toBeGreaterThanOrEqual(12);
    for (const rack of racks) expect(insideRect(rack, layout.serverRoom)).toBe(true);
    const loungeKinds = new Set(layout.props.filter((p) => insideRect(p, layout.lounge)).map((p) => p.kind));
    for (const kind of ["sofa", "lounge_chair", "coffee_table", "coffee_bar", "floor_lamp", "planter_tall"] as const) {
      expect(loungeKinds.has(kind)).toBe(true);
    }
    expect(layout.props.filter((p) => p.kind.startsWith("planter")).length).toBeGreaterThanOrEqual(capacity / 4);

    // Entrance on the south wall, next to the lounge.
    expect(layout.spawn.z).toBeGreaterThan(b.z1 - 1.5);
    expect(layout.spawn.x).toBeLessThan(layout.lounge.x1 + 3);
    expect(layout.wallHeight).toBe(5);
    expect(layout.focus.radius).toBeGreaterThan(Math.max(b.x1 - b.x0, b.z1 - b.z0) / 2);
  });

  it("hangs the world map on the north wall between the west side and the AM7 office", () => {
    const b = layout.bounds;
    const map = layout.mapWall;
    const hallW = b.x1 - b.x0;
    expect(map.z).toBeCloseTo(b.z0);
    expect(map.height).toBeCloseTo(4.1);
    expect(map.y - map.height / 2).toBeCloseTo(0.6);
    expect(map.y + map.height / 2).toBeLessThan(layout.wallHeight);
    expect(map.width).toBeLessThanOrEqual(40);
    expect(map.width).toBeGreaterThanOrEqual(Math.min(0.42 * hallW, 40) - 1e-6);
    expect(map.width).toBeLessThanOrEqual(0.5 * hallW + 1e-6);
    expect(map.x - map.width / 2).toBeGreaterThan(b.x0);
    expect(map.x + map.width / 2).toBeLessThan(layout.am7Office.x0);
    expect(map.x).toBeCloseTo((b.x0 + layout.am7Office.x0) / 2);
  });

  it("offers social spots of every kind", () => {
    const byKind = (k: string) => layout.socialSpots.filter((s) => s.kind === k);
    expect(byKind("coffee")).toHaveLength(1);
    expect(byKind("coffee")[0].capacity).toBeGreaterThanOrEqual(4);
    expect(byKind("coffee")[0].capacity).toBeLessThanOrEqual(6);
    expect(byKind("map").length).toBeGreaterThanOrEqual(3);
    for (const s of byKind("map")) {
      expect(Math.cos(s.rotY)).toBeCloseTo(-1); // facing the north wall
      expect(Math.abs(s.x - layout.mapWall.x)).toBeLessThan(layout.mapWall.width / 2);
    }
    expect(byKind("lounge").length).toBeGreaterThanOrEqual(1);
    expect(byKind("meeting")).toHaveLength(2);
    expect(byKind("server")).toHaveLength(1);
  });

  it("links every desk, the lead desk and every social spot to the entrance", () => {
    const spawnNode = nearestNode(layout.nav, layout.spawn.x, layout.spawn.z);
    const p = layout.nav.positions;
    expect(Math.hypot(p[spawnNode * 2] - layout.spawn.x, p[spawnNode * 2 + 1] - layout.spawn.z)).toBeLessThan(0.01);
    const seen = reachable(layout, spawnNode);
    for (const d of [...layout.desks, layout.leadDesk]) {
      expect(d.navNode).toBeGreaterThanOrEqual(0);
      expect(seen[d.navNode], d.id).toBe(1);
      // The desk hangs off a nearby aisle node.
      expect(Math.hypot(p[d.navNode * 2] - d.approach.x, p[d.navNode * 2 + 1] - d.approach.z)).toBeLessThan(3);
    }
    for (const s of layout.socialSpots) {
      expect(seen[s.navNode]).toBe(1);
      expect(p[s.navNode * 2]).toBeCloseTo(s.x, 2);
      expect(p[s.navNode * 2 + 1]).toBeCloseTo(s.z, 2);
    }
    // Aisle nodes every few metres.
    for (const [a, c] of navEdges(layout)) expect(Math.hypot(a.x - c.x, a.z - c.z)).toBeLessThanOrEqual(3.01 + 2.5);
  });

  it("routes aisles through doors only and clear of desks and props", () => {
    const edges = navEdges(layout);
    const solid = layout.partitions.filter((s) => s.kind !== "glass-door");
    for (const [a, c] of edges) {
      for (const s of solid) {
        expect(segmentsCross(a, c, { x: s.ax, z: s.az }, { x: s.bx, z: s.bz }), `edge ${a.x},${a.z}-${c.x},${c.z}`).toBe(
          false,
        );
      }
    }
    const obstacles = [
      ...[...layout.desks, layout.leadDesk].map((d) => deskPoly(d, 0.05)),
      ...layout.props.map((p) => propPoly(p, 0.1)).filter((p): p is P[] => p !== null),
    ];
    for (const [a, c] of edges) {
      const seg = segment(a.x, a.z, c.x, c.z);
      for (const poly of obstacles) {
        if (Math.min(...poly.map((q) => Math.hypot(q.x - a.x, q.z - a.z))) > 8) continue;
        expect(segmentOverlaps(seg, poly), `edge ${a.x},${a.z}-${c.x},${c.z}`).toBe(false);
      }
    }
  });

  it("is deterministic", () => {
    const again = generateHqLayout(capacity);
    const plain = (l: HqLayout) =>
      JSON.stringify({ ...l, nav: { positions: Array.from(l.nav.positions), edges: Array.from(l.nav.edges) } });
    expect(plain(again)).toBe(plain(layout));
  });
});

describe("generateHqLayout sizing", () => {
  it("grows the hall and its zones with capacity", () => {
    const small = layouts.get(100)!;
    const big = layouts.get(1000)!;
    const area = (r: HqRect) => (r.x1 - r.x0) * (r.z1 - r.z0);
    expect(area(big.bounds)).toBeGreaterThan(area(small.bounds) * 4);
    expect(area(big.am7Office)).toBeGreaterThan(area(small.am7Office));
    expect(big.socialSpots.length).toBeGreaterThan(small.socialSpots.length);
  });

  it("generates the 1000-desk hall quickly", () => {
    generateHqLayout(1000);
    const t0 = performance.now();
    generateHqLayout(1000);
    expect(performance.now() - t0).toBeLessThan(30);
  });
});
