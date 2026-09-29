import { describe, expect, it } from "vitest";

import {
  HQ_AGENT_RADIUS,
  HQ_ARCHIVE_CART,
  HQ_CAPACITIES,
  HQ_PUSH_GRIP,
  WORKSTATION,
  type HqCapacity,
} from "@/features/hq/core/config";
import {
  HQ_CHAIR_CLEARANCE,
  HQ_DECK_RADIUS,
  HQ_TRIBUNE_STAND,
  HQ_EXEC_DESK_EXTENT,
  HQ_LEAD_VIA,
  HQ_PROP_FOOTPRINT,
  HQ_RING_BEHIND,
  HQ_SOFT_SEAT_AISLE,
  generateHqLayout,
  planArenaRow,
} from "@/features/hq/core/layout";
import { navNodeCount, nearestNode } from "@/features/hq/core/nav";
import {
  HQ_ARCHIVE,
  HQ_ARCHIVE_BAY,
  HQ_CURB_DEPTH,
  HQ_ENTRANCE_HALF_WIDTH,
  archiveAssembly,
  archiveBumperPoly,
  archiveChutePoly,
  polySegmentDistance,
} from "@/features/hq/core/archiveLayout";
import type { HqArchiveLane, HqDesk, HqLayout, HqProp, HqPropKind, HqRect, HqSegment } from "@/features/hq/core/types";

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

/** Distance from point `q` to the segment a-b. */
function segmentDistance(q: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.z - a.z) * dz) / len2)) : 0;
  return Math.hypot(q.x - (a.x + dx * t), q.z - (a.z + dz * t));
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

/** The hall tiers' half width (layout.ts TIERS), for planning a whole row. */
const TIER_HALF_WIDTH: Record<HqCapacity, number> = { 100: 20, 300: 40, 1000: 44 };

describe.each(HQ_CAPACITIES)("generateHqLayout(%i)", (capacity) => {
  const layout = layouts.get(capacity)!;

  it("has exactly one desk per seat with stable ids", () => {
    expect(layout.capacity).toBe(capacity);
    // At least the capacity, and whole rows: the last one is never cut short.
    expect(layout.desks.length).toBeGreaterThanOrEqual(capacity);
    const lastRowIndex = layout.arena.rows.length - 1;
    const lastRow = layout.desks.filter((d) => d.podId === lastRowIndex).length;
    expect(lastRow).toBe(planArenaRow(layout.arena.rows[lastRowIndex], TIER_HALF_WIDTH[capacity]).angles.length);
    expect(layout.desks.length - capacity).toBeLessThan(lastRow);
    const ids = new Set(layout.desks.map((d) => d.id));
    expect(ids.size).toBe(layout.desks.length);
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

  it("zones the hall: AM7's island in front of the video wall, glass rooms along both side walls", () => {
    const b = layout.bounds;
    // AM7's island: on the arena's axis between the video wall and the first row.
    const deck = layout.deck;
    const arena = layout.arena;
    expect(deck.radius).toBe(HQ_DECK_RADIUS);
    expect(deck.x).toBeCloseTo(arena.x);
    expect(deck.x).toBeCloseTo(layout.mapWall.x);
    expect(deck.z - deck.radius).toBeGreaterThan(b.z0 + layout.mapWall.curve + 2);
    expect(deck.z + deck.radius).toBeLessThan(arena.z + arena.stage - 1);
    const office = layout.am7Office;
    expect(office.x0).toBeCloseTo(deck.x - deck.radius, 2);
    expect(office.z0).toBeCloseTo(deck.z - deck.radius, 2);
    expect(office.x1).toBeCloseTo(deck.x + deck.radius, 2);
    expect(office.z1).toBeCloseTo(deck.z + deck.radius, 2);
    const lead = layout.leadDesk;
    expect(lead.x).toBeCloseTo(deck.x);
    expect(lead.z).toBeCloseTo(deck.z);
    for (const p of leadPoly(lead)) expect(Math.hypot(p.x - deck.x, p.z - deck.z)).toBeLessThan(deck.radius - 0.8);
    const onDeck = layout.props.filter((p) => Math.hypot(p.x - deck.x, p.z - deck.z) < deck.radius).map((p) => p.kind);
    expect(onDeck.sort()).toEqual(["exec_chair", "exec_desk"]);
    // The tribune on the axis between the island and the first row, facing the
    // rows; AM7's spot behind it (the wall at his back) is on the nav graph.
    const { tribune } = layout;
    expect(layout.props.some((p) => p.kind === "tribune")).toBe(false);
    expect(tribune.x).toBeCloseTo(arena.x);
    expect(tribune.rotY).toBe(0);
    expect(tribune.z - HQ_TRIBUNE_STAND).toBeGreaterThan(deck.z + deck.radius + 1);
    expect(tribune.z + PROP_SIZE.tribune[1] / 2).toBeLessThan(arena.z + arena.stage - 1);
    expect(tribune.standX).toBeCloseTo(tribune.x);
    expect(tribune.standZ).toBeCloseTo(tribune.z - HQ_TRIBUNE_STAND);
    const standNode = nearestNode(layout.nav, tribune.standX, tribune.standZ);
    expect(layout.nav.positions[standNode * 2]).toBeCloseTo(tribune.standX, 2);
    expect(layout.nav.positions[standNode * 2 + 1]).toBeCloseTo(tribune.standZ, 2);
    // No walkway runs through the lectern.
    for (const [a, c] of navEdges(layout)) {
      expect(segmentDistance(tribune, a, c), `${a.x},${a.z} -> ${c.x},${c.z}`).toBeGreaterThan(0.75);
    }

    // West column: server room in the north-west corner, two meeting rooms, the
    // lounge with the coffee bar. East column: rack gallery, briefing room, lounge.
    const [westServer, eastServer] = layout.serverRooms;
    expect(layout.serverRooms).toHaveLength(2);
    expect(layout.serverRoom).toBe(westServer);
    expect(westServer.x0).toBeCloseTo(b.x0);
    expect(westServer.z0).toBeCloseTo(b.z0);
    expect(eastServer.x1).toBeCloseTo(b.x1);
    expect(eastServer.z0).toBeCloseTo(b.z0);
    expect(layout.meetingRooms).toHaveLength(3);
    const [westLounge, eastLounge] = layout.lounges;
    expect(layout.lounges).toHaveLength(2);
    expect(layout.lounge).toBe(westLounge);
    for (const room of [westServer, layout.meetingRooms[0], layout.meetingRooms[1], westLounge]) expect(room.x0).toBeCloseTo(b.x0);
    for (const room of [eastServer, layout.meetingRooms[2], eastLounge]) expect(room.x1).toBeCloseTo(b.x1);
    expect(westServer.z1).toBeLessThanOrEqual(layout.meetingRooms[0].z0 + 1e-6);
    expect(eastServer.z1).toBeLessThanOrEqual(layout.meetingRooms[2].z0 + 1e-6);
    for (const room of layout.lounges) expect(room.z1).toBeCloseTo(b.z1);
    for (const room of layout.meetingRooms) {
      const kinds = layout.props.filter((p) => insideRect(p, room)).map((p) => p.kind);
      expect(kinds).toContain("meeting_table");
      expect(kinds.filter((k) => k === "meeting_chair").length).toBeGreaterThanOrEqual(6);
    }
    const racks = layout.props.filter((p) => p.kind === "server_rack");
    for (const room of layout.serverRooms) expect(racks.filter((r) => insideRect(r, room)).length).toBeGreaterThanOrEqual(12);
    for (const rack of racks) expect(layout.serverRooms.some((room) => insideRect(rack, room))).toBe(true);
    layout.lounges.forEach((room, i) => {
      const kinds = new Set(layout.props.filter((p) => insideRect(p, room)).map((p) => p.kind));
      for (const kind of ["sofa", "lounge_chair", "coffee_table", "floor_lamp", "data_monolith", "wall_screen"] as const) {
        expect(kinds.has(kind)).toBe(true);
      }
      expect(kinds.has("coffee_bar")).toBe(i === 0);
    });

    // Entrance on the south wall, next to the west lounge.
    expect(layout.spawn.z).toBeGreaterThan(b.z1 - 1.5);
    expect(layout.spawn.x).toBeLessThan(layout.lounge.x1 + 3);
    expect(layout.wallHeight).toBe(5);
    expect(layout.northWallHeight).toBe(9);
    expect(layout.focus.radius).toBeGreaterThan(Math.max(b.x1 - b.x0, b.z1 - b.z0) / 2);
  });

  it("hangs a curved video wall on the north wall, centred on the rows", () => {
    const b = layout.bounds;
    const map = layout.mapWall;
    expect(map.z).toBeCloseTo(b.z0);
    expect(map.x).toBeCloseTo(layout.arena.x);
    expect(map.y - map.height / 2).toBeCloseTo(0.8);
    expect(map.y + map.height / 2).toBeLessThan(layout.northWallHeight);
    expect(map.height).toBeGreaterThan(6);
    expect(map.width).toBeLessThanOrEqual(60);
    expect(map.width).toBeGreaterThan(30);
    expect(map.curve).toBeGreaterThan(0);
    expect(map.curve).toBeLessThanOrEqual(2.6);
    // Between the side columns' glass.
    expect(map.x - map.width / 2).toBeGreaterThan(layout.serverRooms[0].x1 + 1);
    expect(map.x + map.width / 2).toBeLessThan(layout.serverRooms[1].x0 - 1);
    // Nobody's path runs into the display's forward-standing ends.
    const p = layout.nav.positions;
    for (let i = 0; i < p.length; i += 2) {
      if (Math.abs(p[i] - map.x) > map.width / 2 + 0.5) continue;
      expect(p[i + 1] - map.z, `node ${p[i]},${p[i + 1]}`).toBeGreaterThan(map.curve + 0.6);
    }
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
      // Beside AM7's island, not in front of it.
      expect(Math.abs(s.x - layout.deck.x)).toBeGreaterThan(layout.deck.radius + 1);
    }
    expect(byKind("lounge")).toHaveLength(layout.loungeGroups.length);
    expect(byKind("meeting")).toHaveLength(layout.meetingRooms.length);
    expect(byKind("server")).toHaveLength(layout.serverRooms.length);
  });

  it("sets the desks in rows on arcs, every desk facing the video wall", () => {
    const { arena } = layout;
    const rows = new Map<number, HqDesk[]>();
    for (const d of layout.desks) rows.set(d.podId, [...(rows.get(d.podId) ?? []), d]);
    expect(rows.size).toBe(arena.rows.length);
    expect(arena.rings).toHaveLength(arena.rows.length);
    const pos = layout.nav.positions;
    for (const [r, desks] of rows) {
      for (const d of desks) {
        const dx = d.x - arena.x;
        const dz = d.z - arena.z;
        // On its row's arc, turned to face the centre.
        expect(Math.hypot(dx, dz)).toBeCloseTo(arena.rows[r], 2);
        expect(Math.sin(d.rotY) * -dx + Math.cos(d.rotY) * -dz).toBeCloseTo(Math.hypot(dx, dz), 2);
        // Its nav node is on the walkway ring behind the chair.
        const nx = pos[d.navNode * 2] - arena.x;
        const nz = pos[d.navNode * 2 + 1] - arena.z;
        expect(Math.hypot(nx, nz)).toBeCloseTo(arena.rows[r] + HQ_RING_BEHIND, 1);
        expect(nx * dx + nz * dz).toBeGreaterThan(0);
      }
      const angles = desks.map((d) => Math.atan2(d.x - arena.x, d.z - arena.z));
      expect(Math.max(...angles.map(Math.abs))).toBeLessThanOrEqual(arena.spans[r] + 1e-3);
    }
    // Inner rows first, numbered from the centre out.
    for (let i = 1; i < layout.desks.length; i++) expect(layout.desks[i].podId).toBeGreaterThanOrEqual(layout.desks[i - 1].podId);
    // A clear aisle along every straight aisle line through the rows.
    for (const angle of arena.aisles) {
      const ux = Math.sin(angle);
      const uz = Math.cos(angle);
      for (const d of layout.desks) {
        for (const q of deskPoly(d, 0)) {
          const along = (q.x - arena.x) * ux + (q.z - arena.z) * uz;
          if (along <= 0) continue;
          const across = Math.abs((q.x - arena.x) * uz - (q.z - arena.z) * ux);
          expect(across, `desk ${d.id} by the aisle at ${angle.toFixed(2)}`).toBeGreaterThan(0.85);
        }
      }
    }
    // Rows are spread evenly out from the centre.
    for (let r = 1; r < arena.rows.length; r++) expect(arena.rows[r] - arena.rows[r - 1]).toBeCloseTo(2.8);
  });

  it("keeps the island, the tribune and the map spots clear of the rows", () => {
    const { deck } = layout;
    for (const d of layout.desks) {
      for (const q of deskPoly(d)) expect(Math.hypot(q.x - deck.x, q.z - deck.z)).toBeGreaterThan(deck.radius + 1);
    }
    // The balustrade: low glass on the deck's rim, open to the north behind AM7.
    const rim = layout.partitions.filter(
      (s) => Math.abs(Math.hypot(s.ax - deck.x, s.az - deck.z) - deck.radius) < 0.01 && Math.abs(Math.hypot(s.bx - deck.x, s.bz - deck.z) - deck.radius) < 0.01,
    );
    expect(rim.length).toBeGreaterThanOrEqual(16);
    for (const s of rim) {
      expect(s.kind).toBe("glass");
      expect(s.height).toBeLessThan(1.2);
      // Nothing on the north side, where AM7 comes in.
      expect(Math.min(s.az, s.bz) - (deck.z - deck.radius), `rim at ${s.ax},${s.az}`).toBeGreaterThan(0.2);
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

  it("keeps plants out of the hall", () => {
    const plants: HqPropKind[] = ["planter_tall", "planter_low", "dark_plant"];
    for (const p of layout.props) expect(plants.includes(p.kind), `${p.kind} at ${p.x},${p.z}`).toBe(false);
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

  /** The lounge's inner glass (toward the hall): its east side for the west lounge, its west side for the east one. */
  const innerX = (lounge: HqRect) => (lounge.x0 <= layout.bounds.x0 + 1e-6 ? lounge.x1 : lounge.x0);
  const groupsIn = (lounge: HqRect) => layout.loungeGroups.filter((g) => insideRect({ x: g.tableX, z: g.tableZ }, lounge));

  it("encloses each lounge in glass with a door for every way in", () => {
    layout.lounges.forEach((lounge, i) => {
      const x = innerX(lounge);
      const inner = wallAlongX(layout.partitions, x, lounge.z0, lounge.z1);
      let z = lounge.z0;
      for (const seg of inner) {
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
      // A door for the coffee bar (west lounge) and one per seating group, each used by the nav graph.
      const groups = groupsIn(lounge);
      const doors = inner.filter((seg) => seg.kind === "glass-door");
      expect(doors.length).toBe((i === 0 ? 1 : 0) + groups.length);
      const crossings = navEdges(layout).filter(
        ([a, c]) => (a.x - x) * (c.x - x) < 0 && Math.max(a.z, c.z) > lounge.z0 && Math.min(a.z, c.z) < lounge.z1,
      );
      for (const door of doors) {
        const [d0, d1] = [Math.min(door.az, door.bz), Math.max(door.az, door.bz)];
        expect(
          crossings.some(([a, c]) => {
            const t = (x - a.x) / (c.x - a.x);
            const zc = a.z + (c.z - a.z) * t;
            return zc > d0 && zc < d1;
          }),
        ).toBe(true);
      }
      // One to four seating groups, at least two in the bigger halls.
      expect(groups.length).toBeGreaterThanOrEqual(capacity >= 300 ? 2 : 1);
      expect(groups.length).toBeLessThanOrEqual(4);
    });
    expect(layout.lounges.reduce((n, l) => n + groupsIn(l).length, 0)).toBe(layout.loungeGroups.length);
  });

  it("furnishes each lounge inside its walls and clear of its doors", () => {
    layout.lounges.forEach((lounge, i) => {
      const x = innerX(lounge);
      const inward = x === lounge.x1 ? -1 : 1;
      const groups = groupsIn(lounge).length;
      const doors = wallAlongX(layout.partitions, x, lounge.z0, lounge.z1).filter((s) => s.kind === "glass-door");
      const inLounge = layout.props.filter((p) => insideRect(p, lounge));
      expect(inLounge.filter((p) => p.kind === "sofa")).toHaveLength(groups * 2);
      expect(inLounge.filter((p) => p.kind === "wall_screen")).toHaveLength(groups);
      expect(inLounge.filter((p) => p.kind === "data_monolith").length).toBeGreaterThanOrEqual((i === 0 ? 2 : 0) + groups);
      for (const p of inLounge) {
        const poly = propPoly(p);
        if (!poly) continue;
        for (const q of poly) expect(insideRect(q, lounge, 0.01), `${p.kind} at ${p.x},${p.z}`).toBe(true);
        for (const door of doors) {
          // Keep 1.5 m in front of each door free.
          const zone = rectPoly(door.ax, (door.az + door.bz) / 2, 0, inward < 0 ? -1.5 : 0, inward < 0 ? 0 : 1.5, -0.6, 0.6);
          expect(overlaps(poly, zone), `${p.kind} at ${p.x},${p.z} blocks a door`).toBe(false);
        }
      }
    });
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
      const table = layout.loungeGroups[seat.group];
      const home = layout.lounges.find((l) => insideRect({ x: table.tableX, z: table.tableZ }, l));
      expect(home, tag).toBeDefined();
      expect(insideRect(seat, home!), tag).toBe(true);
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

  it("keeps the lounges' standing places off the walkways and the furniture", () => {
    const spots = layout.socialSpots.filter((s) => s.kind === "lounge");
    expect(spots).toHaveLength(layout.loungeGroups.length);
    const edges = navEdgeNodes(layout);
    for (const spot of spots) {
      const lounge = layout.lounges.find((l) => insideRect(spot, l))!;
      expect(lounge, `lounge spot ${spot.x},${spot.z}`).toBeDefined();
      const props = layout.props.filter((p) => insideRect(p, lounge) && PROP_SIZE[p.kind][0] > 0);
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

  it("turns the monoliths on the low south curb and at the video wall toward the camera", () => {
    const b = layout.bounds;
    const monoliths = layout.props.filter((p) => p.kind === "data_monolith");
    const south = monoliths.filter((p) => b.z1 - p.z < 0.5 && p.x > layout.lounges[0].x1 && p.x < layout.lounges[1].x0);
    const north = monoliths.filter((p) => p.z - b.z0 < 0.5 && p.x > layout.serverRooms[0].x1 && p.x < layout.serverRooms[1].x0);
    expect(south.length).toBeGreaterThan(0);
    expect(north).toHaveLength(2);
    // props.glb fronts face local +Z: out of the south curb, into the hall from the north wall.
    for (const p of [...south, ...north]) expect(Math.cos(p.rotY), `monolith at ${p.x},${p.z}`).toBeCloseTo(1);
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

/** Distance between two convex polygons (0 when they overlap). */
function polyDistance(a: P[], b: P[]): number {
  if (overlaps(a, b)) return 0;
  let best = Infinity;
  for (let i = 0; i < b.length; i++) {
    const p = b[i];
    const q = b[(i + 1) % b.length];
    best = Math.min(best, polySegmentDistance(a, p.x, p.z, q.x, q.z));
  }
  return best;
}

type LaneSample = { i: number; x: number; z: number; h: number; cart: P[]; body: P[] };

function laneSamples(lane: HqArchiveLane): LaneSample[] {
  return Array.from({ length: lane.x.length }, (_, i) => {
    const { cart, body } = archiveAssembly(lane.x[i], lane.z[i], lane.rotY[i]);
    return { i, x: lane.x[i], z: lane.z[i], h: lane.rotY[i], cart, body };
  });
}

describe.each(HQ_CAPACITIES)("archive station (%i)", (capacity) => {
  const layout = layouts.get(capacity)!;
  const st = layout.archive;
  const sx = layout.spawn.x;
  const z1 = layout.bounds.z1;
  const lanes = [
    ["laneOut", st.laneOut],
    ["laneBack", st.laneBack],
  ] as const;
  const parked = archiveAssembly(st.stand.x, st.stand.z, st.stand.rotY).cart;
  const bayPoly = rectPoly(st.bay.x, st.bay.z, st.bay.rotY, -0.475, 0.475, -0.7, 0.7);
  const obstacles = [
    ...layout.desks.map((d) => ({ tag: d.id, poly: deskPoly(d, 0) })),
    { tag: "lead desk", poly: leadPoly(layout.leadDesk, 0) },
    ...layout.props.flatMap((p) => {
      const poly = propPoly(p);
      return poly ? [{ tag: `${p.kind}@${p.x},${p.z}`, poly }] : [];
    }),
  ];
  const solid = layout.partitions.filter((s) => s.kind !== "glass-door");
  /** The station's own spur: every edge along the approach line between the west walkway and the approach. */
  const onSpur = (p: P) => Math.abs(p.z - st.approach.z) < 1e-3 && p.x <= st.approach.x + 1e-3 && p.x >= sx - 1;
  const walkways = navEdges(layout).filter(([a, c]) => !(onSpur(a) && onSpur(c)));
  const near = (poly: P[], q: P, r: number) => poly.some((p) => Math.hypot(p.x - q.x, p.z - q.z) < r);

  it("parks the cart nose in, in a bay by the curb east of the entrance", () => {
    const forward = { x: Math.sin(st.stand.rotY), z: Math.cos(st.stand.rotY) };
    // Cart = stand + forward * reach, heading = the bay's + pi (nose toward the bumper).
    expect(st.cart.x).toBeCloseTo(st.stand.x + forward.x * HQ_ARCHIVE_CART.reach, 3);
    expect(st.cart.z).toBeCloseTo(st.stand.z + forward.z * HQ_ARCHIVE_CART.reach, 3);
    expect(Math.cos(st.cart.rotY - st.bay.rotY - Math.PI)).toBeCloseTo(1, 6);
    expect(st.cart.rotY).toBe(st.stand.rotY);
    // The grip bar sits inside the cart's footprint, behind its origin.
    expect(HQ_ARCHIVE_CART.reach - HQ_PUSH_GRIP.reach).toBeLessThanOrEqual(HQ_ARCHIVE_CART.tail);
    expect(HQ_ARCHIVE_CART.nose + HQ_ARCHIVE_CART.tail).toBeCloseTo(HQ_ARCHIVE_CART.length, 3);
    // Nose against the bumper, not into it.
    const bumper = archiveBumperPoly(st.bay);
    const gap = polyDistance(parked, bumper);
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(0.03);
    // The bay backs onto the south curb, east of the entrance, facing into the hall.
    expect(Math.cos(st.bay.rotY)).toBeCloseTo(-1, 6);
    expect(z1 - (st.bay.z + HQ_ARCHIVE_BAY.depth / 2)).toBeGreaterThan(0);
    expect(z1 - (st.bay.z + HQ_ARCHIVE_BAY.depth / 2)).toBeLessThan(0.05);
    expect(st.bay.x).toBeGreaterThan(sx + HQ_ENTRANCE_HALF_WIDTH);
    for (const poly of [parked, bayPoly]) {
      for (const q of poly) expect(insideRect(q, layout.bounds)).toBe(true);
      for (const o of obstacles) expect(overlaps(poly, o.poly), o.tag).toBe(false);
      for (const s of layout.partitions) expect(segmentOverlaps(segment(s.ax, s.az, s.bx, s.bz), poly)).toBe(false);
      // Well clear of the entrance cut.
      expect(polySegmentDistance(poly, sx - HQ_ENTRANCE_HALF_WIDTH, z1, sx + HQ_ENTRANCE_HALF_WIDTH, z1)).toBeGreaterThanOrEqual(1.2);
    }
    // Walkers pass well clear of the parked cart, and no walkway crosses the bay.
    for (const [a, c] of navEdges(layout)) {
      expect(polySegmentDistance(parked, a.x, a.z, c.x, c.z), `${a.x},${a.z}-${c.x},${c.z}`).toBeGreaterThanOrEqual(0.62);
      expect(polySegmentDistance(bayPoly, a.x, a.z, c.x, c.z), `${a.x},${a.z}-${c.x},${c.z}`).toBeGreaterThanOrEqual(0.4);
    }
  });

  it("samples both lanes as one continuous loop from the stand and back", () => {
    const out = st.laneOut;
    const back = st.laneBack;
    const last = (l: HqArchiveLane) => l.x.length - 1;
    // Out starts at the stand; back starts where out ends and ends at the stand, bay heading.
    expect(out.x[0]).toBeCloseTo(st.stand.x, 3);
    expect(out.z[0]).toBeCloseTo(st.stand.z, 3);
    expect(out.rotY[0]).toBeCloseTo(st.stand.rotY, 3);
    expect(back.x[0]).toBeCloseTo(out.x[last(out)], 3);
    expect(back.z[0]).toBeCloseTo(out.z[last(out)], 3);
    expect(back.rotY[0]).toBeCloseTo(out.rotY[last(out)], 3);
    expect(back.x[last(back)]).toBeCloseTo(st.stand.x, 3);
    expect(back.z[last(back)]).toBeCloseTo(st.stand.z, 3);
    expect(Math.abs(back.rotY[last(back)] - st.stand.rotY)).toBeLessThanOrEqual(1e-3);
    for (const [name, lane] of lanes) {
      const n = lane.x.length;
      expect(lane.z.length).toBe(n);
      expect(lane.rotY.length).toBe(n);
      expect(lane.s.length).toBe(n);
      expect(lane.noStop.length).toBe(n);
      expect(lane.reverse.length).toBe(n);
      expect(lane.s[0]).toBe(0);
      expect(lane.length).toBeCloseTo(lane.s[n - 1], 2);
      expect(lane.length).toBeGreaterThan(5);
      for (let i = 1; i < n; i++) {
        const d = Math.hypot(lane.x[i] - lane.x[i - 1], lane.z[i] - lane.z[i - 1]);
        const tag = `${name} sample ${i}`;
        expect(d, tag).toBeLessThanOrEqual(0.12);
        expect(d, tag).toBeGreaterThan(0.01);
        expect(lane.s[i] - lane.s[i - 1], tag).toBeCloseTo(d, 3);
        // Tightest turn: the U-turn's radius.
        expect(Math.abs(lane.rotY[i] - lane.rotY[i - 1]) / d, tag).toBeLessThanOrEqual(1 / HQ_ARCHIVE.uTurnR + 0.01);
        // Moving along the heading (forward) or against it (a pull), per the reverse flag.
        const along = ((lane.x[i] - lane.x[i - 1]) * Math.sin(lane.rotY[i]) + (lane.z[i] - lane.z[i - 1]) * Math.cos(lane.rotY[i])) / d;
        expect(along * (lane.reverse[i] ? -1 : 1), tag).toBeGreaterThan(0.95);
      }
    }
    // Only the start of the way out is a pull (out of the bay, handle first).
    const firstPush = out.reverse.indexOf(0);
    expect(firstPush).toBeGreaterThan(5);
    expect(out.reverse.subarray(firstPush).every((r) => r === 0)).toBe(true);
    expect(back.reverse.every((r) => r === 0)).toBe(true);
    // The cart leaves the hall heading south, through the entrance.
    expect(Math.cos(out.rotY[last(out)])).toBeCloseTo(1, 6);
  });

  it("keeps the swept cart and pusher off everything, through the middle of the entrance and on the apron", () => {
    const chute = archiveChutePoly(st.chute);
    const bumper = archiveBumperPoly(st.bay);
    const glass = layout.partitions;
    for (const [name, lane] of lanes) {
      for (const s of laneSamples(lane)) {
        const tag = `${name} sample ${s.i} at ${s.x.toFixed(2)},${s.z.toFixed(2)}`;
        for (const poly of [s.cart, s.body]) {
          for (const o of obstacles) {
            if (!near(o.poly, s, 6)) continue;
            expect(overlaps(poly, o.poly), `${tag} vs ${o.tag}`).toBe(false);
          }
          for (const w of solid) expect(segmentOverlaps(segment(w.ax, w.az, w.bx, w.bz), poly), tag).toBe(false);
          for (const w of glass) expect(polySegmentDistance(poly, w.ax, w.az, w.bx, w.bz), `${tag} by the glass`).toBeGreaterThanOrEqual(0.3);
          expect(overlaps(poly, bumper), `${tag} vs the bay's bumper`).toBe(false);
          expect(polyDistance(poly, chute), `${tag} vs the chute`).toBeGreaterThanOrEqual(0.15);
          for (const q of poly) {
            expect(q.x, tag).toBeGreaterThan(layout.bounds.x0);
            expect(q.x, tag).toBeLessThan(layout.bounds.x1);
            expect(q.z, tag).toBeGreaterThan(layout.bounds.z0);
            // Through the curb only inside the cut, clear of both jambs.
            if (q.z > z1 - 0.02 && q.z < z1 + HQ_CURB_DEPTH + 0.02) {
              expect(q.x - (sx - HQ_ENTRANCE_HALF_WIDTH), `${tag} by the west jamb`).toBeGreaterThanOrEqual(0.15);
              expect(sx + HQ_ENTRANCE_HALF_WIDTH - q.x, `${tag} by the east jamb`).toBeGreaterThanOrEqual(0.15);
            }
            if (q.z > z1 + HQ_CURB_DEPTH) expect(insideRect(q, st.apron), `${tag} off the apron`).toBe(true);
          }
        }
      }
    }
    // The apron is outside the entrance, centred on it and wider than the cut.
    expect(st.apron.z0).toBeCloseTo(z1, 3);
    expect(st.apron.z1).toBeGreaterThan(z1 + 3);
    expect((st.apron.x0 + st.apron.x1) / 2).toBeCloseTo(sx, 3);
    expect(st.apron.x1 - st.apron.x0).toBeGreaterThan(HQ_ENTRANCE_HALF_WIDTH * 2);
    // The gate: the two jambs of the cut, on the curb.
    expect(st.gate.from.x).toBeCloseTo(sx - HQ_ENTRANCE_HALF_WIDTH, 3);
    expect(st.gate.to.x).toBeCloseTo(sx + HQ_ENTRANCE_HALF_WIDTH, 3);
    for (const g of [st.gate.from, st.gate.to]) expect(g.z).toBeCloseTo(z1 + HQ_CURB_DEPTH / 2, 3);
  });

  it("hands the load over at the chute's slot, beside the cart on the apron", () => {
    const n = st.laneOut.x.length - 1;
    const { cart } = archiveAssembly(st.laneOut.x[n], st.laneOut.z[n], st.laneOut.rotY[n]);
    const west = Math.min(...cart.map((q) => q.x));
    const [zMin, zMax] = [Math.min(...cart.map((q) => q.z)), Math.max(...cart.map((q) => q.z))];
    // The slot faces east, toward the cart's west side, within 0.35 m of it.
    expect(Math.sin(st.chute.rotY)).toBeCloseTo(1, 6);
    expect(st.chute.slot.x).toBeLessThan(west);
    expect(west - st.chute.slot.x).toBeLessThanOrEqual(0.35);
    expect(st.chute.slot.z).toBeGreaterThan(zMin + 0.2);
    expect(st.chute.slot.z).toBeLessThan(zMax - 0.2);
    // The chute stands on the apron, beyond the curb.
    for (const q of archiveChutePoly(st.chute)) {
      expect(insideRect(q, st.apron)).toBe(true);
      expect(q.z).toBeGreaterThan(z1 + HQ_CURB_DEPTH + 0.1);
    }
  });

  it("marks the doorway, the apron and every walkway crossing as no-stop", () => {
    for (const [name, lane] of lanes) {
      for (const s of laneSamples(lane)) {
        const tag = `${name} sample ${s.i} at ${s.x.toFixed(2)},${s.z.toFixed(2)}`;
        const points = [...s.cart, ...s.body];
        const inBand = points.some((q) => q.z > z1 - 0.02);
        const byWalkway = [s.cart, s.body].some((poly) =>
          walkways.some(([a, c]) => polySegmentDistance(poly, a.x, a.z, c.x, c.z) < HQ_ARCHIVE.noStopEdge),
        );
        if (inBand || byWalkway) expect(lane.noStop[s.i], tag).toBe(1);
      }
    }
    // The cart can be left in the bay and on the way out of it, never at the handover.
    expect(st.laneOut.noStop[0]).toBe(0);
    expect(st.laneOut.noStop[st.laneOut.x.length - 1]).toBe(1);
    expect(st.laneBack.noStop[0]).toBe(1);
    expect(st.laneBack.noStop[st.laneBack.x.length - 1]).toBe(0);
    // Back through the door: the first stoppable sample has the cart and the
    // pusher wholly inside the hall, past the doorway band.
    const samples = laneSamples(st.laneBack);
    const firstStop = samples.find((s) => !st.laneBack.noStop[s.i])!;
    expect(firstStop).toBeDefined();
    for (const q of [...firstStop.cart, ...firstStop.body]) expect(q.z).toBeLessThanOrEqual(z1 - HQ_ARCHIVE.noStopBand + 1e-6);
    // Both lanes have somewhere to leave the cart for a briefing.
    for (const [, lane] of lanes) expect(lane.noStop.some((v) => v === 0)).toBe(true);
  });

  it("brings the hauler to the cart from the entrance's walkway", () => {
    const spawnNode = nearestNode(layout.nav, layout.spawn.x, layout.spawn.z);
    const seen = reachable(layout, spawnNode);
    const pos = layout.nav.positions;
    for (const node of [st.entryNode, st.leaveNode]) {
      expect(node).toBeGreaterThanOrEqual(0);
      expect(seen[node]).toBe(1);
    }
    expect(pos[st.entryNode * 2]).toBeCloseTo(st.approach.x, 2);
    expect(pos[st.entryNode * 2 + 1]).toBeCloseTo(st.approach.z, 2);
    // The approach is behind the stand, along the cart's heading.
    const forward = { x: Math.sin(st.stand.rotY), z: Math.cos(st.stand.rotY) };
    expect(st.approach.x).toBeCloseTo(st.stand.x - forward.x * HQ_ARCHIVE.approach, 3);
    expect(st.approach.z).toBeCloseTo(st.stand.z - forward.z * HQ_ARCHIVE.approach, 3);
    // The step up to the handle keeps a body's width off the parked cart.
    expect(polySegmentDistance(parked, st.approach.x, st.approach.z, st.stand.x, st.stand.z)).toBeGreaterThanOrEqual(HQ_AGENT_RADIUS);
  });

  it("is deterministic", () => {
    const plain = (l: HqLayout) =>
      JSON.stringify(l.archive, (_, v: unknown) => (ArrayBuffer.isView(v) ? Array.from(v as Float32Array) : v));
    expect(plain(generateHqLayout(capacity))).toBe(plain(layout));
  });
});

describe("generateHqLayout sizing", () => {
  it("grows the hall and its zones with capacity", () => {
    const small = layouts.get(100)!;
    const big = layouts.get(1000)!;
    const area = (r: HqRect) => (r.x1 - r.x0) * (r.z1 - r.z0);
    expect(area(big.bounds)).toBeGreaterThan(area(small.bounds) * 4);
    expect(big.arena.rows.length).toBeGreaterThan(small.arena.rows.length);
    expect(big.mapWall.width).toBeGreaterThan(small.mapWall.width);
    expect(big.socialSpots.length).toBeGreaterThan(small.socialSpots.length);
  });

  it("plans a full row symmetrically, wider rows holding more desks", () => {
    const row = planArenaRow(20, 29);
    const n = row.angles.length;
    expect(n).toBeGreaterThan(10);
    for (let i = 0; i < n; i++) expect(row.angles[i]).toBeCloseTo(-row.angles[n - 1 - i]);
    expect(Math.max(...row.angles)).toBeLessThanOrEqual(row.span + 1e-9);
    expect(planArenaRow(30, 29).angles.length).toBeGreaterThan(n);
    // A narrow floor clips the row's span, not its spacing.
    const narrow = planArenaRow(30, 15);
    expect(narrow.span).toBeLessThan(row.span);
    expect(30 * Math.sin(narrow.span)).toBeLessThanOrEqual(15 - 1.3 + 1e-9);
  });

  it("generates the 1000-desk hall quickly", () => {
    generateHqLayout(1000);
    const t0 = performance.now();
    generateHqLayout(1000);
    expect(performance.now() - t0).toBeLessThan(30);
  });
});
