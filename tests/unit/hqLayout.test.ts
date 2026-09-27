import { describe, expect, it } from "vitest";

import { HQ_AGENT_RADIUS, HQ_CAPACITIES, WORKSTATION, type HqCapacity } from "@/features/hq/core/config";
import {
  HQ_CHAIR_CLEARANCE,
  HQ_EXEC_DESK_EXTENT,
  HQ_LEAD_VIA,
  HQ_POD_WIDTH,
  HQ_PROP_FOOTPRINT,
  HQ_SOFT_SEAT_AISLE,
  generateHqLayout,
} from "@/features/hq/core/layout";
import { navNodeCount, nearestNode } from "@/features/hq/core/nav";
import type { HqDesk, HqLayout, HqProp, HqPropKind, HqRect, HqSegment } from "@/features/hq/core/types";

type P = { x: number; z: number };

// Footprints (width along local X, depth along local Z) of props.glb kinds.
const PROP_SIZE = HQ_PROP_FOOTPRINT;

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

/** AM7's command-arc desk and chair, as the bounding rectangle of the arc. */
function leadPoly(d: HqDesk, shrink = 0.02): P[] {
  const e = HQ_EXEC_DESK_EXTENT;
  return rectPoly(d.x, d.z, d.rotY, e.x0 + shrink, e.x1 - shrink, -HQ_CHAIR_CLEARANCE + shrink, e.z1 - shrink);
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

function pointInPoly(p: P, poly: P[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Partitions along x = x from z0 to z1 (vertical segments only). */
function wallAlongX(parts: HqSegment[], x: number, z0: number, z1: number): HqSegment[] {
  return parts
    .filter((s) => Math.abs(s.ax - x) < 1e-3 && Math.abs(s.bx - x) < 1e-3)
    .filter((s) => Math.min(s.az, s.bz) >= z0 - 1e-3 && Math.max(s.az, s.bz) <= z1 + 1e-3)
    .sort((a, b) => Math.min(a.az, a.bz) - Math.min(b.az, b.bz));
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

/** Nav edges with their node indices. */
function navEdgeNodes(layout: HqLayout): Array<{ a: number; b: number; pa: P; pb: P }> {
  const p = layout.nav.positions;
  const e = layout.nav.edges;
  const out: Array<{ a: number; b: number; pa: P; pb: P }> = [];
  for (let i = 0; i < e.length; i += 2) {
    out.push({
      a: e[i],
      b: e[i + 1],
      pa: { x: p[e[i] * 2], z: p[e[i] * 2 + 1] },
      pb: { x: p[e[i + 1] * 2], z: p[e[i + 1] * 2 + 1] },
    });
  }
  return out;
}

function distToSegment(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
}

/** Distance from a point to a prop's footprint (0 inside it). */
function distToProp(p: P, prop: HqProp): number {
  const [w, d] = PROP_SIZE[prop.kind];
  const c = Math.cos(prop.rotY);
  const s = Math.sin(prop.rotY);
  const dx = p.x - prop.x;
  const dz = p.z - prop.z;
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.hypot(Math.max(0, Math.abs(lx) - w / 2), Math.max(0, Math.abs(lz) - d / 2));
}

/**
 * Where people stand at a circular social spot (HqSimulation.slotPosition):
 * a 0.9 m ring, the first place in the spot's facing direction.
 */
function ringSlot(spot: { x: number; z: number; rotY: number; capacity: number }, k: number): P {
  const angle = spot.rotY + (Math.PI * 2 * k) / spot.capacity;
  return { x: spot.x + Math.sin(angle) * 0.9, z: spot.z + Math.cos(angle) * 0.9 };
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
    const polys = [...layout.desks.map((d) => deskPoly(d)), leadPoly(layout.leadDesk)];
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
    for (const p of leadPoly(lead)) expect(insideRect(p, office)).toBe(true);
    const officeKinds = layout.props.filter((p) => insideRect(p, office)).map((p) => p.kind);
    for (const kind of [
      "exec_desk",
      "exec_chair",
      "exec_shelf",
      "sofa",
      "wall_screen",
      "dark_plant",
      "server_pillar",
      "data_monolith",
    ] as const) {
      expect(officeKinds).toContain(kind);
    }
    expect(layout.partitions.some((s) => s.kind === "glass-door" && Math.abs(s.az - office.z1) < 1e-6)).toBe(true);

    expect(layout.meetingRooms).toHaveLength(1);
    for (const room of [...layout.meetingRooms, layout.cyberRange, layout.serverRoom, layout.lounge])
      expect(room.x0).toBeCloseTo(b.x0);
    expect(layout.serverRoom.z1).toBeLessThanOrEqual(layout.meetingRooms[0].z0 + 1e-6);
    expect(layout.meetingRooms[0].z1).toBeLessThanOrEqual(layout.cyberRange.z0 + 1e-6);
    expect(layout.cyberRange.z1).toBeLessThanOrEqual(layout.lounge.z0 + 1e-6);
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
    for (const kind of ["sofa", "lounge_chair", "coffee_table", "coffee_bar", "floor_lamp", "data_monolith", "wall_screen"] as const) {
      expect(loungeKinds.has(kind)).toBe(true);
    }

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
    expect(byKind("meeting")).toHaveLength(1);
    expect(byKind("server")).toHaveLength(1);
    expect(byKind("cyberrange")).toHaveLength(1);
    for (const s of byKind("cyberrange")) {
      expect(Math.sin(s.rotY)).toBeCloseTo(-1); // facing the target rigs on the west wall
    }
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
      ...layout.desks.map((d) => deskPoly(d, 0.05)),
      leadPoly(layout.leadDesk, 0.05),
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

  it("keeps plants out of the hall: two dark plants in AM7's south corners", () => {
    const office = layout.am7Office;
    for (const p of layout.props) {
      expect(p.kind === "planter_tall" || p.kind === "planter_low", `${p.kind} at ${p.x},${p.z}`).toBe(false);
      if (p.kind === "dark_plant") expect(insideRect(p, office), `dark_plant at ${p.x},${p.z}`).toBe(true);
    }
    // One in the corner west of the door, one in the corner past the sofa,
    // just inside the glass: the leaves stay clear of the opening and panes.
    const door = layout.partitions.find((s) => s.kind === "glass-door" && Math.abs(s.az - office.z1) < 1e-6)!;
    const d0 = Math.min(door.ax, door.bx);
    const plants = layout.props.filter((p) => p.kind === "dark_plant").sort((a, b) => a.x - b.x);
    expect(plants).toHaveLength(2);
    const [west, east] = plants;
    const half = PROP_SIZE.dark_plant[0] / 2;
    expect(west.x - half - office.x0).toBeLessThan(0.15);
    expect(office.x1 - (east.x + half)).toBeLessThan(0.15);
    expect(d0 - (west.x + half)).toBeGreaterThan(0.03);
    for (const p of plants) {
      expect(p.z).toBeCloseTo(west.z);
      expect(office.z1 - (p.z + half)).toBeLessThan(0.15);
      for (const q of propPoly(p)!) expect(insideRect(q, office, -0.05), `dark_plant at ${p.x},${p.z}`).toBe(true);
    }
    // The work wall, west to east: server pillar, wall screen, a run of
    // shelves, data monolith.
    const onWall = (kind: HqPropKind) =>
      layout.props.filter((p) => p.kind === kind && insideRect(p, office) && p.z - office.z0 < 0.6);
    const [screen] = onWall("wall_screen");
    expect(onWall("server_pillar")).toHaveLength(1);
    expect(onWall("data_monolith")).toHaveLength(1);
    expect(onWall("server_pillar")[0].x).toBeLessThan(screen.x - 1.1);
  });

  it("lines AM7's north wall with shelves from the wall screen to the monolith", () => {
    const office = layout.am7Office;
    const onWall = (kind: HqPropKind) =>
      layout.props
        .filter((p) => p.kind === kind && insideRect(p, office) && p.z - office.z0 < 0.6)
        .sort((a, b) => a.x - b.x);
    const [screen] = onWall("wall_screen");
    const [monolith] = onWall("data_monolith");
    const shelves = onWall("exec_shelf");
    const [w] = PROP_SIZE.exec_shelf;
    const from = screen.x + PROP_SIZE.wall_screen[0] / 2;
    const to = monolith.x - PROP_SIZE.data_monolith[0] / 2;
    // As many whole units as fit with ~0.1 m to spare on each side, centred.
    expect(shelves).toHaveLength(Math.floor((to - from - 0.2) / w + 1e-6));
    expect(shelves.length).toBeGreaterThanOrEqual(2);
    shelves.forEach((s, i) => {
      expect(s.z - office.z0).toBeCloseTo(0.25);
      expect(s.rotY).toBe(0);
      if (i > 0) expect(s.x - shelves[i - 1].x).toBeCloseTo(w);
    });
    const left = shelves[0].x - w / 2;
    const right = shelves[shelves.length - 1].x + w / 2;
    expect(left - from).toBeGreaterThanOrEqual(0.1 - 1e-6);
    expect(to - right).toBeGreaterThanOrEqual(0.1 - 1e-6);
    expect(left - from).toBeCloseTo(to - right);
    // Clear of AM7's desk and chair.
    const lead = leadPoly(layout.leadDesk);
    for (const s of shelves) expect(overlaps(propPoly(s)!, lead)).toBe(false);
  });

  it("brings AM7 to the chair from behind, clear of the arc desk's end pods", () => {
    const lead = layout.leadDesk;
    const pos = layout.nav.positions;
    const node = { x: pos[lead.navNode * 2], z: pos[lead.navNode * 2 + 1] };
    const via = { x: lead.x + HQ_LEAD_VIA.x, z: lead.z + HQ_LEAD_VIA.z };
    expect(lead.rotY).toBe(0);
    expect(node.z).toBeLessThan(lead.z - HQ_CHAIR_CLEARANCE);
    // The end pods: r = 0.39 m round the ends of the desk's middle arc (radius
    // 1.65 m round a centre 0.9 m behind the chair, +-45 degrees).
    const pods = [-1, 1].map((sx) => ({
      x: lead.x + sx * 1.65 * Math.SQRT1_2,
      z: lead.z - 0.9 + 1.65 * Math.SQRT1_2,
    }));
    const clear = 0.39 + HQ_AGENT_RADIUS - 0.02;
    const dist = (p: P, a: P, b: P) => {
      const ux = b.x - a.x;
      const uz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * ux + (p.z - a.z) * uz) / (ux * ux + uz * uz)));
      return Math.hypot(a.x + ux * t - p.x, a.z + uz * t - p.z);
    };
    for (const pod of pods) {
      expect(dist(pod, node, via)).toBeGreaterThan(clear);
      expect(dist(pod, via, lead.approach)).toBeGreaterThan(clear);
    }
    // Every edge at the lead's node stays clear of the pods too.
    for (const [a, c] of navEdges(layout)) {
      if (Math.hypot(a.x - node.x, a.z - node.z) > 1e-3 && Math.hypot(c.x - node.x, c.z - node.z) > 1e-3) continue;
      for (const pod of pods) expect(dist(pod, a, c)).toBeGreaterThan(clear);
    }
  });

  it("puts a server pillar at the east end of every pod", () => {
    const pods = new Map<number, HqDesk[]>();
    for (const d of layout.desks) pods.set(d.podId, [...(pods.get(d.podId) ?? []), d]);
    const pillars = layout.props.filter((p) => p.kind === "server_pillar" && !insideRect(p, layout.am7Office));
    expect(pillars).toHaveLength(pods.size);
    expect(pods.size).toBe(Math.ceil(capacity / 4));
    for (const desks of pods.values()) {
      const cx = (Math.min(...desks.map((d) => d.x)) + Math.max(...desks.map((d) => d.x))) / 2;
      const cz = (Math.min(...desks.map((d) => d.z)) + Math.max(...desks.map((d) => d.z))) / 2;
      const hit = pillars.filter((p) => Math.abs(p.x - (cx + HQ_POD_WIDTH / 2 + 0.45)) < 0.01 && Math.abs(p.z - cz) < 0.01);
      expect(hit, `pod at ${cx},${cz}`).toHaveLength(1);
      expect(hit[0].rotY).toBe(0);
    }
  });

  it("encloses the lounge in glass with a door for every way in", () => {
    const lounge = layout.lounge;
    // East side: glass from the north glass to the south wall, no gaps.
    const east = wallAlongX(layout.partitions, lounge.x1, lounge.z0, lounge.z1);
    let z = lounge.z0;
    for (const seg of east) {
      expect(Math.min(seg.az, seg.bz)).toBeCloseTo(z, 3);
      expect(seg.kind === "glass" || seg.kind === "glass-door").toBe(true);
      z = Math.max(seg.az, seg.bz);
    }
    expect(z).toBeCloseTo(lounge.z1, 3);
    // North side: the meeting room's south glass.
    expect(
      layout.partitions.some(
        (seg) =>
          Math.abs(seg.az - lounge.z0) < 1e-3 &&
          Math.abs(seg.bz - lounge.z0) < 1e-3 &&
          Math.min(seg.ax, seg.bx) <= lounge.x0 + 1e-3 &&
          Math.max(seg.ax, seg.bx) >= lounge.x1 - 1e-3,
      ),
    ).toBe(true);
    // A door for the coffee bar and one per seating group, each used by the nav graph.
    const doors = east.filter((seg) => seg.kind === "glass-door");
    expect(doors.length).toBe(1 + layout.loungeGroups.length);
    const crossings = navEdges(layout).filter(
      ([a, c]) => (a.x - lounge.x1) * (c.x - lounge.x1) < 0 && Math.max(a.z, c.z) > lounge.z0 && Math.min(a.z, c.z) < lounge.z1,
    );
    for (const door of doors) {
      const [d0, d1] = [Math.min(door.az, door.bz), Math.max(door.az, door.bz)];
      expect(crossings.some(([a, c]) => {
        const t = (lounge.x1 - a.x) / (c.x - a.x);
        const zc = a.z + (c.z - a.z) * t;
        return zc > d0 && zc < d1;
      })).toBe(true);
    }
    // Two to four seating groups where the hall has room for them.
    expect(layout.loungeGroups.length).toBeGreaterThanOrEqual(capacity >= 300 ? 2 : 1);
    expect(layout.loungeGroups.length).toBeLessThanOrEqual(4);
  });

  it("furnishes the lounge inside its walls and clear of its doors", () => {
    const lounge = layout.lounge;
    const doors = wallAlongX(layout.partitions, lounge.x1, lounge.z0, lounge.z1).filter((s) => s.kind === "glass-door");
    const inLounge = layout.props.filter((p) => insideRect(p, lounge));
    expect(inLounge.filter((p) => p.kind === "sofa")).toHaveLength(layout.loungeGroups.length * 2);
    expect(inLounge.filter((p) => p.kind === "wall_screen")).toHaveLength(layout.loungeGroups.length);
    expect(inLounge.filter((p) => p.kind === "data_monolith").length).toBeGreaterThanOrEqual(2 + layout.loungeGroups.length);
    for (const p of inLounge) {
      const poly = propPoly(p);
      if (!poly) continue;
      for (const q of poly) expect(insideRect(q, lounge, 0.01), `${p.kind} at ${p.x},${p.z}`).toBe(true);
      for (const door of doors) {
        // Keep 1.5 m in front of each door free.
        const zone = rectPoly(door.ax - 1.5, (door.az + door.bz) / 2, 0, 0, 1.5, -0.6, 0.6);
        expect(overlaps(poly, zone), `${p.kind} at ${p.x},${p.z} blocks a door`).toBe(false);
      }
    }
  });

  it("offers lounge seats that are reachable and sit inside their own sofa or chair", () => {
    const seats = layout.loungeSeats;
    expect(seats.length).toBe(layout.loungeGroups.length * 8);
    const spawnNode = nearestNode(layout.nav, layout.spawn.x, layout.spawn.z);
    const seen = reachable(layout, spawnNode);
    const pos = layout.nav.positions;
    const props = layout.props.map((p) => ({ p, poly: propPoly(p, -0.02) })).filter((e): e is { p: HqProp; poly: P[] } => e.poly !== null);
    const solid = layout.partitions.filter((s) => s.kind !== "glass-door");
    seats.forEach((seat, i) => {
      const tag = `seat ${i} at ${seat.x},${seat.z}`;
      expect(insideRect(seat, layout.lounge), tag).toBe(true);
      expect(seat.navNode, tag).toBeGreaterThanOrEqual(0);
      expect(seen[seat.navNode], tag).toBe(1);
      // SitDown contract: approach 0.14 m in front of the root, along rotY.
      expect(seat.approach.x - seat.x).toBeCloseTo(Math.sin(seat.rotY) * WORKSTATION.approachOffset, 2);
      expect(seat.approach.z - seat.z).toBeCloseTo(Math.cos(seat.rotY) * WORKSTATION.approachOffset, 2);
      // The root is on exactly one soft seat and on nothing else.
      const under = props.filter(({ poly }) => pointInPoly(seat, poly));
      expect(under.map(({ p }) => p.kind), tag).toHaveLength(1);
      expect(["sofa", "lounge_chair"]).toContain(under[0].p.kind);
      expect(Math.cos(seat.rotY - under[0].p.rotY), tag).toBeCloseTo(1);
      // Facing into the group, toward its table.
      const group = layout.loungeGroups[seat.group];
      const toTable = { x: group.tableX - seat.x, z: group.tableZ - seat.z };
      expect(Math.sin(seat.rotY) * toTable.x + Math.cos(seat.rotY) * toTable.z, tag).toBeGreaterThan(0.5);
      // The walk from the seat's node to its approach point crosses no other prop and no glass.
      const node = { x: pos[seat.navNode * 2], z: pos[seat.navNode * 2 + 1] };
      expect(Math.hypot(node.x - seat.approach.x, node.z - seat.approach.z), tag).toBeLessThan(HQ_SOFT_SEAT_AISLE);
      // Aisles run far enough out that walkers clear a sitter's feet (~0.5 m).
      expect(Math.hypot(node.x - seat.x, node.z - seat.z), tag).toBeGreaterThanOrEqual(0.5 + HQ_AGENT_RADIUS - 0.01);
      const walk = segment(node.x, node.z, seat.approach.x, seat.approach.z);
      for (const { p, poly } of props) {
        if (p === under[0].p || Math.hypot(p.x - seat.x, p.z - seat.z) > 4) continue;
        expect(segmentOverlaps(walk, poly), `${tag} walks through ${p.kind} at ${p.x},${p.z}`).toBe(false);
      }
      for (const w of solid) {
        expect(segmentsCross(node, seat.approach, { x: w.ax, z: w.az }, { x: w.bx, z: w.bz }), tag).toBe(false);
      }
    });
    // No two seats on top of each other.
    for (let i = 0; i < seats.length; i++) {
      for (let j = i + 1; j < seats.length; j++) {
        expect(Math.hypot(seats[i].x - seats[j].x, seats[i].z - seats[j].z)).toBeGreaterThan(0.55);
      }
    }
  });

  it("keeps the lounge's standing places off the walkways and the furniture", () => {
    const lounge = layout.lounge;
    const spots = layout.socialSpots.filter((s) => s.kind === "lounge");
    expect(spots).toHaveLength(layout.loungeGroups.length);
    const edges = navEdgeNodes(layout);
    const props = layout.props.filter((p) => insideRect(p, lounge) && PROP_SIZE[p.kind][0] > 0);
    for (const spot of spots) {
      // The spot hangs off a single spur.
      expect(edges.filter((e) => e.a === spot.navNode || e.b === spot.navNode)).toHaveLength(1);
      for (let k = 0; k < spot.capacity; k++) {
        const p = ringSlot(spot, k);
        const tag = `lounge spot ${spot.x},${spot.z} place ${k} at ${p.x.toFixed(2)},${p.z.toFixed(2)}`;
        expect(insideRect(p, lounge, -(HQ_AGENT_RADIUS + 0.2)), tag).toBe(true);
        // Walkers on any other aisle pass well clear of whoever stands here.
        for (const e of edges) {
          if (e.a === spot.navNode || e.b === spot.navNode) continue;
          expect(distToSegment(p, e.pa, e.pb), tag).toBeGreaterThan(0.7);
        }
        for (const prop of props) {
          expect(distToProp(p, prop), `${tag} vs ${prop.kind} at ${prop.x},${prop.z}`).toBeGreaterThan(HQ_AGENT_RADIUS + 0.25);
        }
      }
    }
  });

  it("turns the monoliths on the low south and east curbs toward the camera", () => {
    const b = layout.bounds;
    const monoliths = layout.props.filter((p) => p.kind === "data_monolith");
    const south = monoliths.filter((p) => b.z1 - p.z < 0.5 && p.x > layout.lounge.x1);
    const east = monoliths.filter((p) => b.x1 - p.x < 0.5);
    expect(south.length).toBeGreaterThan(0);
    expect(east.length).toBeGreaterThan(0);
    // props.glb fronts face local +Z: out of the south wall, out of the east wall.
    for (const p of south) expect(Math.cos(p.rotY), `monolith at ${p.x},${p.z}`).toBeCloseTo(1);
    for (const p of east) expect(Math.sin(p.rotY), `monolith at ${p.x},${p.z}`).toBeCloseTo(1);
  });

  it("keeps the entrance cut clear of the lounge glass and of props", () => {
    // The south curb opening (3.2 m, render/environment/palette.ts) is centred on the spawn point.
    const half = 1.6;
    const b = layout.bounds;
    expect(layout.spawn.x - half).toBeGreaterThan(layout.lounge.x1 + 0.1);
    for (const p of layout.props) {
      const poly = propPoly(p);
      if (!poly || b.z1 - p.z > 1.5) continue;
      const [x0, x1] = [Math.min(...poly.map((q) => q.x)), Math.max(...poly.map((q) => q.x))];
      expect(x1 < layout.spawn.x - half || x0 > layout.spawn.x + half, `${p.kind} at ${p.x},${p.z}`).toBe(true);
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
