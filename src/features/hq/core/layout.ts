// Procedural floor plan of the HQ hall. Pure and deterministic: the same
// capacity always yields the same layout, so desk indices can be persisted.
//
// Plan (north = -z carries the video wall, west = -x):
//
//   +--------+================ video wall ================+---------+
//   | server |   map spots     ( AM7's island )  map spots |  rack   |
//   |  room  |                  ( tribune )              | gallery |
//   +--------+   \  \   \    stage walkway    /   /  /    +---------+
//   | meet 1 |    \  \   \   rows of desks   /   /  /     | briefing|
//   +--------+     \  \   \  on arcs, all   /   /  /      +---------+
//   | meet 2 |      \  \   | facing the    |   /  /       | lounge  |
//   +--------+       \  \  |  video wall   |  /  /        |    2    |
//   | lounge |                                            |         |
//   | coffee |   (every side room is glass; the lounges   |         |
//   |        |    have a door per seating group)          |         |
//   +--entr--+--------------------------------------------+---------+
//
// The rows form an amphitheatre round a centre just in front of the video
// wall: every desk faces the wall, straight aisles run out from the stage
// through the rows, and a walkway ring runs behind every row.

import { buildArchiveStation } from "./archiveLayout";
import { POD, WORKSTATION, type HqCapacity } from "./config";
import { HqNavBuilder, nearestNode } from "./nav";
import type {
  HqArena,
  HqDesk,
  HqLayout,
  HqLoungeGroup,
  HqMapWall,
  HqProp,
  HqPropKind,
  HqRect,
  HqSeat,
  HqSegment,
  HqSocialSpot,
  HqSocialSpotKind,
  Vec2,
} from "./types";
import { HQ_WALL_SCREEN } from "./types";

const HALF_PI = Math.PI / 2;
/** Lounge wall screens, group by group: the news first, then business, then radio. */
const LOUNGE_CHANNELS = [HQ_WALL_SCREEN.news, HQ_WALL_SCREEN.markets, HQ_WALL_SCREEN.music] as const;

/** Floor space behind a chair centre that belongs to its desk (chair pushed back). */
export const HQ_CHAIR_CLEARANCE = 0.5;
export const HQ_WALL_HEIGHT = 5;
/** The north wall is taller: it carries the (now larger) video wall. */
export const HQ_NORTH_WALL_HEIGHT = 9;
export const HQ_GLASS_HEIGHT = 2.8;
export const HQ_DOOR_WIDTH = 1.2;
/** Longest edge between two aisle nodes. */
const NAV_MAX_GAP = 3;

// --- Amphitheatre -------------------------------------------------------------
/** Chair-centre radius step from one row to the next. */
export const HQ_ROW_PITCH = 2.8;
/** The walkway ring behind a row runs this far behind its chair centres. */
export const HQ_RING_BEHIND = 1.1;
/** Gap between the front corners of two desks side by side on an arc. */
const DESK_GAP = 0.12;
/** Half the width of a straight aisle through the rows, to the desks' edges. */
const AISLE_HALF = 0.9;
/** Widest half angle a row may span. */
const MAX_HALF_SPAN = Math.PI / 3;
/** Straight aisles from the stage out through the rows. */
const RADIAL_AISLES = [-Math.PI / 6, 0, Math.PI / 6] as const;
/**
 * A desk reaches at most this far sideways past its chair centre's x (its
 * back corner, at any angle), plus a margin: seat centres stay this far
 * inside the floor between the side walkways.
 */
const DESK_SIDE_REACH = 1.3;
/** A ring runs on past its row's end desk by about this much (metres) before it turns off. */
const RING_RUN_OUT = 1.8;
/** Samples along an arc so its chords stay close to the circle. */
const ARC_STEP = 2.4;
/** The rows' centre stands this far in front of the video wall. */
const ARENA_CENTRE_OFFSET = 1.6;
/** The walkway arc in front of the first row runs this far inside its chair radius. */
const STAGE_INSIDE = 2.1;
/** Walkway ring behind the last row to the south wall. */
const BACK_MARGIN = 3.0;

// --- Stage: AM7's island and the briefing tribune ------------------------------
export const HQ_DECK_RADIUS = 3.3;
/** Floor kept free round the tribune (radius): the stage's spacing, not its size. */
export const HQ_TRIBUNE_CLEAR = 1.5;
/** AM7 stands this far behind the tribune's centre to address the rows. */
export const HQ_TRIBUNE_STAND = 0.9;
const BALUSTRADE_HEIGHT = 1.05;
/**
 * Segments of the balustrade ring; the four round due north are left out (the
 * way in, 3.3 m wide), and the two round due south (1.7 m, AM7's way down to
 * the tribune).
 */
const BALUSTRADE_SEGMENTS = 24;
/** Map spots stand this far in front of the video wall's ends. */
const SPOTS_FROM_SCREEN = 1.0;
/** The stage walkway runs this far south of the map spots. */
const STAGE_LINE_FROM_SPOTS = 1.8;

// --- Video wall ------------------------------------------------------------------
const MAP_BOTTOM = 0.8;
const MAP_HEIGHT = 7.4;
const MAP_MAX_WIDTH = 60;
/** How far the display's ends come forward, per metre of its width. */
const MAP_CURVE_PER_WIDTH = 0.045;
const MAP_MAX_CURVE = 2.6;

// Soft seats (props.glb sofa and lounge_chair, blender/hq/props_furniture.py):
// the seated root sits this far in front of the prop origin, 0.24 m in front
// of the back cushion's face (-0.065 m on the sofa, -0.045 m on the chair),
// like the desk chair's root and backrest. The cushion top is 0.43-0.44 m,
// 3-4 cm under the 0.47 m desk-chair seat the SitDown clip is made for.
export const HQ_SOFA_SEAT_DEPTH = 0.175;
export const HQ_LOUNGE_CHAIR_SEAT_DEPTH = 0.195;
/**
 * The aisle node in front of every soft seat, from the seated root: a
 * sitter's feet reach about 0.5 m forward, so a passing walker (radius
 * HQ_AGENT_RADIUS) clears them.
 */
export const HQ_SOFT_SEAT_AISLE = 0.85;
/** Seat spacing along a sofa: one per cushion of its three. */
const SOFA_SEAT_PITCH = 0.6;
/**
 * AM7's command-arc desk (props.glb exec_desk, blender/hq/props_exec.py) in
 * the seat frame (origin = chair centre, sitter facing +Z): a C round the
 * chair, its end pods beside the chair reaching back to z = -0.12, its far
 * edge at z = 1.15. The pocket between the pods is open behind the chair.
 */
export const HQ_EXEC_DESK_EXTENT = { x0: -1.57, x1: 1.57, z0: -0.12, z1: 1.15 } as const;
/** Where AM7 steps in behind the chair, west of it, on the way to the seat. */
export const HQ_LEAD_VIA = { x: -0.55, z: -0.2 } as const;
/**
 * Half the entrance cut into the south curb, centred on the spawn point
 * (ENTRANCE_WIDTH in render/environment/palette.ts), plus a margin: the cut
 * has to stay east of the lounge's glass.
 */
const ENTRANCE_CLEAR = 1.6 + 0.15;

/**
 * Floor footprint of every props.glb kind (width along local X, depth along
 * local Z, centred on the origin), measured from the GLB. The sim keeps
 * standing agents off them. exec_desk and exec_chair follow the workstation
 * frame (origin at the chair), so they have none here.
 */
export const HQ_PROP_FOOTPRINT: Readonly<Record<HqPropKind, readonly [number, number]>> = {
  planter_tall: [0.54, 0.54],
  planter_low: [1.2, 0.42],
  server_rack: [0.6, 1.1],
  server_pillar: [0.62, 0.62],
  data_monolith: [0.9, 0.5],
  dark_plant: [1.19, 1.19],
  sofa: [2.2, 0.9],
  lounge_chair: [0.88, 0.86],
  coffee_table: [1.1, 0.6],
  coffee_bar: [2.5, 0.76],
  meeting_table: [3.2, 1.3],
  meeting_chair: [0.5, 0.5],
  exec_desk: [0, 0],
  exec_chair: [0, 0],
  exec_shelf: [2.0, 0.4],
  wall_screen: [2.2, 0.05],
  floor_lamp: [0.39, 0.39],
  tribune: [1.0, 0.87],
  // The archive station's kinds are dynamic (HqLayout.archive), never in
  // layout.props. The cart reaches 0.513 m ahead of its origin and 0.64 m
  // behind it; its footprint here is the symmetric box round both.
  archive_cart: [0.63, 1.28],
  archive_cart_lit: [0, 0],
  archive_cart_display_full: [0, 0],
  archive_cart_display_empty: [0, 0],
  archive_load_1: [0, 0],
  archive_load_2: [0, 0],
  archive_load_3: [0, 0],
  archive_load_4: [0, 0],
  archive_bay: [0.95, 1.4],
  archive_bay_led_1: [0, 0],
  archive_bay_led_2: [0, 0],
  archive_bay_led_3: [0, 0],
  archive_bay_led_4: [0, 0],
  archive_chute: [0.7, 0.6],
  archive_chute_shutter: [0, 0],
  archive_chute_slot: [0, 0],
  archive_case: [0, 0],
};

// Lounge seating group, in a frame of u = metres in from the lounge's outer
// wall (west wall for the west lounge, east wall for the east one) and
// v = metres south of the group centre (its coffee table). Every seat faces
// the table and has its nav node on one of four aisles around it,
// HQ_SOFT_SEAT_AISLE in front of the seat; the south aisle leads to the
// group's door in the inner glass, with a standing spot on a short spur off
// that corridor. Drawn for the west lounge; the east one is its mirror image.
//
//        lamp [======= sofa B =======]
//        [s]  + - - north aisle - - -+- -+     spot (standing ring)
//        [o]  |    +-------+         |      [chair]  |
//        [f]  |    | table |         |      [  E  ]  |
//        [a]  |    +-------+         |               |
//        [A]  + - - south aisle - - -+ - - - - - - - + - - - door
//    monolith        [chair S]
const LOUNGE = {
  /** Sofa A's origin from the outer wall: its back 0.1 m off the wall. */
  sofaAU: 0.55,
  /** Aisle centre to table centre, across the table's 0.6 m width. */
  tableGap: 0.625,
  /** Sofa B's centre past the table's, so its outer end clears the lamp. */
  sofaBShift: 0.2,
  northAisleV: -1.0,
  southAisleV: 1.0,
  /** Standing spot: north of the corridor, between chair E and the glass. */
  spotU: 5.6,
  spotV: -0.9,
  /** How far the group's props reach south of its centre (chair S's back). */
  south: 2.5,
  /** Coffee bar centre from the lounge's north glass; its monoliths either side. */
  coffeeV: 2.4,
  coffeeMonolith: 1.8,
  /** Earliest first group centre from the north glass, after the coffee bar or without one. */
  firstGroup: 7.1,
  firstGroupNoBar: 3.2,
  pitch: 5.3,
  maxPitch: 6,
  maxGroups: 4,
} as const;

type Tier = { westW: number; eastW: number; halfWidth: number };

// Side column widths and the half width of the floor the rows may use
// (between the side walkways) grow with the hall.
const TIERS: Record<HqCapacity, Tier> = {
  100: { westW: 8, eastW: 8, halfWidth: 20 },
  // Wide enough that every row is a whole arc (to MAX_HALF_SPAN): a full fan, no clipped corners.
  300: { westW: 11, eastW: 9, halfWidth: 40 },
  1000: { westW: 11, eastW: 11, halfWidth: 44 },
};

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Local (lx, lz) of a seat frame to world. rotY 0 faces +Z; +X is the sitter's left. */
export function seatToWorld(
  x: number,
  z: number,
  rotY: number,
  lx: number,
  lz: number,
): { x: number; z: number } {
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  return { x: x + lx * c + lz * s, z: z - lx * s + lz * c };
}

function makeSeat(
  index: number,
  id: string,
  x: number,
  z: number,
  rotY: number,
  navNode: number,
  podId: number,
): HqDesk {
  const approach = seatToWorld(x, z, rotY, 0, WORKSTATION.approachOffset);
  return {
    index,
    id,
    x: round3(x),
    z: round3(z),
    rotY,
    approach: { x: round3(approach.x), z: round3(approach.z) },
    navNode,
    podId,
  };
}

/** One row of the amphitheatre: seat angles (west to east) and the row's half span. */
export type HqArenaRowPlan = { radius: number; span: number; angles: number[] };

/**
 * Seat angles of a row at chair radius `radius`: desks side by side on the
 * arc with DESK_GAP between their front corners, a clear AISLE_HALF either
 * side of every straight aisle, and no seat centre past `halfWidth -
 * DESK_SIDE_REACH` from the centre line (so the desks stay off the side
 * walkways). Each run between aisles is centred in its sector.
 */
export function planArenaRow(radius: number, halfWidth: number): HqArenaRowPlan {
  const halfDesk = WORKSTATION.width / 2;
  const inner = radius - WORKSTATION.deskBack;
  const pitch = 2 * Math.atan((halfDesk + DESK_GAP / 2) / inner);
  // Smallest angle between an aisle line and a seat centre whose desk's near
  // edge (worst at its front corner) stays AISLE_HALF from the line.
  const offset = Math.asin(Math.min(1, AISLE_HALF / Math.hypot(inner, halfDesk))) + Math.atan(halfDesk / inner);
  const reach = halfWidth - DESK_SIDE_REACH;
  const span = Math.min(MAX_HALF_SPAN, reach >= radius ? HALF_PI : Math.asin(Math.max(0, reach / radius)));
  // An aisle just past the row's end still needs its clearance: it runs on
  // outward, so it counts as a cut whenever a desk could reach it.
  const cuts = [-span, ...RADIAL_AISLES.filter((a) => Math.abs(a) < span + offset), span];
  const angles: number[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const lo = Math.max(-span, cuts[i] + (i === 0 ? 0 : offset));
    const hi = Math.min(span, cuts[i + 1] - (i + 2 === cuts.length ? 0 : offset));
    if (hi < lo - 1e-9) continue;
    const n = Math.floor((hi - lo) / pitch + 1e-9) + 1;
    const start = (lo + hi) / 2 - ((n - 1) * pitch) / 2;
    for (let k = 0; k < n; k++) angles.push(start + k * pitch);
  }
  return { radius, span, angles };
}

/** Collects the stops of one straight aisle; nodes are made in `finish`. */
class NavLine {
  private readonly stops: number[] = [];

  constructor(
    readonly vertical: boolean,
    readonly fixed: number,
    readonly from: number,
    readonly to: number,
  ) {}

  add(t: number): void {
    if (t >= this.from - 1e-6 && t <= this.to + 1e-6) this.stops.push(t);
  }

  finish(nav: HqNavBuilder): void {
    const ts = [this.from, this.to, ...this.stops].sort((a, b) => a - b);
    const unique: number[] = [];
    // Merge stops that land on the same centimetre (the builder's node key).
    for (const t of ts) {
      if (unique.length === 0 || Math.round(t * 100) !== Math.round(unique[unique.length - 1] * 100)) unique.push(t);
    }
    const nodes: number[] = [];
    for (let i = 0; i < unique.length; i++) {
      if (i > 0) {
        const gap = unique[i] - unique[i - 1];
        const parts = Math.ceil(gap / NAV_MAX_GAP - 1e-6);
        for (let k = 1; k < parts; k++) nodes.push(this.nodeAt(nav, unique[i - 1] + (gap * k) / parts));
      }
      nodes.push(this.nodeAt(nav, unique[i]));
    }
    nav.chain(nodes);
  }

  private nodeAt(nav: HqNavBuilder, t: number): number {
    return this.vertical ? nav.node(this.fixed, t) : nav.node(t, this.fixed);
  }
}

/**
 * A glass wall from a to b with a door (HQ_DOOR_WIDTH wide) centred at each
 * given distance from a. Doors are kept inside the wall; overlapping ones
 * merge into one wider opening.
 */
function pushWallWithDoors(
  out: HqSegment[],
  ax: number,
  az: number,
  bx: number,
  bz: number,
  doorCentres: readonly number[],
): void {
  const len = Math.hypot(bx - ax, bz - az);
  const ux = (bx - ax) / len;
  const uz = (bz - az) / len;
  const seg = (t0: number, t1: number, kind: HqSegment["kind"]) => {
    if (t1 - t0 < 0.01) return;
    out.push({
      ax: round3(ax + ux * t0),
      az: round3(az + uz * t0),
      bx: round3(ax + ux * t1),
      bz: round3(az + uz * t1),
      height: HQ_GLASS_HEIGHT,
      kind,
    });
  };
  const half = HQ_DOOR_WIDTH / 2;
  const centres = doorCentres.map((c) => Math.min(len - half, Math.max(half, c))).sort((a, b) => a - b);
  // Openings as [start, end) runs along the wall, merged where they touch.
  const runs: Array<[number, number]> = [];
  for (const c of centres) {
    const last = runs[runs.length - 1];
    if (last && c - half <= last[1] + 0.01) last[1] = Math.max(last[1], c + half);
    else runs.push([c - half, c + half]);
  }
  let t = 0;
  for (const [d0, d1] of runs) {
    seg(t, d0, "glass");
    seg(d0, d1, "glass-door");
    t = d1;
  }
  seg(t, len, "glass");
}

function pushWallWithDoor(
  out: HqSegment[],
  ax: number,
  az: number,
  bx: number,
  bz: number,
  doorCentre: number | null,
): void {
  pushWallWithDoors(out, ax, az, bx, bz, doorCentre === null ? [] : [doorCentre]);
}

export function generateHqLayout(capacity: HqCapacity): HqLayout {
  const tier = TIERS[capacity] ?? TIERS[100];
  const { westW, eastW, halfWidth } = tier;
  const aisle = POD.aisle;

  // --- Stage stack, in metres south of the north wall ------------------------
  // The video wall's ends come forward; the map spots stand clear of them,
  // then the stage walkway, AM7's island, the tribune and the walkway arc
  // in front of the first row follow, each clear of the next.
  const mapW = Math.min(MAP_MAX_WIDTH, halfWidth * 2 - 4);
  const curve = round2(Math.min(MAP_MAX_CURVE, mapW * MAP_CURVE_PER_WIDTH));
  const spotsD = curve + SPOTS_FROM_SCREEN;
  const stageD = spotsD + STAGE_LINE_FROM_SPOTS;
  const deckD = stageD + 1.1 + HQ_DECK_RADIUS;
  const tribuneD = deckD + HQ_DECK_RADIUS + 1.2 + HQ_TRIBUNE_CLEAR;
  const stageArcD = tribuneD + HQ_TRIBUNE_CLEAR + 1.0;
  const stageR = stageArcD - ARENA_CENTRE_OFFSET;
  const firstRow = stageR + STAGE_INSIDE;

  // --- Rows ------------------------------------------------------------------
  // Rows are added outward until every desk has a seat, and every row is
  // whole: the last one is never cut short (a ragged back row reads as gaps),
  // so a hall has at least `capacity` desks, a few more to finish its last
  // row. Desks are numbered row by row from the centre out, so a small team
  // sits together in front of the wall.
  const rows: HqArenaRowPlan[] = [];
  let seats = 0;
  for (let k = 0; seats < capacity; k++) {
    const row = planArenaRow(firstRow + k * HQ_ROW_PITCH, halfWidth);
    if (row.angles.length === 0) throw new Error("HQ layout: the hall is too narrow for its rows");
    seats += row.angles.length;
    rows.push(row);
  }
  const lastRow = rows[rows.length - 1].radius;

  // --- Hall ------------------------------------------------------------------
  const W = westW + aisle + halfWidth * 2 + aisle + eastW;
  // The side columns (server room, meeting rooms, lounge) need ~27 m.
  const D = Math.max(ARENA_CENTRE_OFFSET + lastRow + HQ_RING_BEHIND + BACK_MARGIN, 27);
  const x0 = -W / 2;
  const x1 = W / 2;
  const z0 = -D / 2;
  const z1 = D / 2;
  const bounds: HqRect = { x0: round3(x0), z0: round3(z0), x1: round3(x1), z1: round3(z1) };

  const cx = x0 + westW + aisle + halfWidth;
  const cz = z0 + ARENA_CENTRE_OFFSET;
  const westAisleX = x0 + westW + aisle / 2;
  const eastAisleX = x1 - eastW - aisle / 2;
  const at = (radius: number, angle: number) => ({ x: cx + radius * Math.sin(angle), z: cz + radius * Math.cos(angle) });

  const nav = new HqNavBuilder();
  const props: HqProp[] = [];
  const partitions: HqSegment[] = [];
  const addProp = (kind: HqPropKind, x: number, z: number, rotY = 0) =>
    props.push({ kind, x: round3(x), z: round3(z), rotY });
  const socialSpots: HqSocialSpot[] = [];
  const spotNodes: Array<{ spot: HqSocialSpot; node: number }> = [];
  const addSpot = (kind: HqSocialSpotKind, x: number, z: number, rotY: number, cap: number) => {
    const spot: HqSocialSpot = { kind, x: round3(x), z: round3(z), rotY, capacity: cap, navNode: -1 };
    socialSpots.push(spot);
    const node = nav.node(spot.x, spot.z);
    spotNodes.push({ spot, node });
    return node;
  };

  // Spawn: at the south wall, just east of the west column so the entrance
  // cut centred on it stays clear of the lounge glass.
  const spawn = { x: round3(Math.max(westAisleX, x0 + westW + ENTRANCE_CLEAR)), z: round3(z1 - 0.5) };
  // The side walkways along the columns' glass, from the north wall to the south.
  const westLine = new NavLine(true, westAisleX, z0 + 1.0, spawn.z);
  const eastLine = new NavLine(true, eastAisleX, z0 + 1.0, z1 - 1.0);
  const stageZ = z0 + stageD;
  const stageLine = new NavLine(false, stageZ, westAisleX, eastAisleX);
  westLine.add(stageZ);
  eastLine.add(stageZ);
  /** Links a point to the side walkway on its side with a straight run at its z. */
  const toSideWalkway = (node: number, x: number, z: number) => {
    const line = x < cx ? westLine : eastLine;
    line.add(z);
    nav.link(node, nav.node(line.fixed, z));
  };

  // --- Arcs --------------------------------------------------------------------
  /**
   * Chains nodes along the arc of `radius` through `angles` (any order), with
   * extra samples so no chord is longer than ARC_STEP. Returns the node at
   * each requested angle, in angle order.
   */
  const chainArc = (radius: number, angles: readonly number[]): Array<{ angle: number; node: number }> => {
    const sorted = [...angles].sort((a, b) => a - b).filter((a, i, all) => i === 0 || a - all[i - 1] > 1e-7);
    const out: Array<{ angle: number; node: number }> = [];
    const chain: number[] = [];
    sorted.forEach((angle, i) => {
      if (i > 0) {
        const prev = sorted[i - 1];
        const parts = Math.ceil((radius * (angle - prev)) / ARC_STEP - 1e-6);
        for (let k = 1; k < parts; k++) {
          const p = at(radius, prev + ((angle - prev) * k) / parts);
          chain.push(nav.node(p.x, p.z));
        }
      }
      const p = at(radius, angle);
      const node = nav.node(p.x, p.z);
      chain.push(node);
      out.push({ angle, node });
    });
    nav.chain(chain);
    return out;
  };
  /** Where an arc of `radius` stops: past `lastSeat` by RING_RUN_OUT, but still on the floor. */
  const arcEnd = (radius: number, lastSeat: number, seatRadius: number) => {
    const past = lastSeat + RING_RUN_OUT / Math.max(1, seatRadius - WORKSTATION.deskBack);
    const edge = Math.asin(Math.min(1, (halfWidth + 0.5) / radius));
    return Math.min(past, edge, HALF_PI);
  };

  // --- Desks ---------------------------------------------------------------------
  type Placed = { row: number; angle: number; x: number; z: number; rotY: number };
  const placed: Placed[] = [];
  rows.forEach((row, r) => {
    for (const angle of row.angles) {
      const p = at(row.radius, angle);
      placed.push({ row: r, angle, x: p.x, z: p.z, rotY: Math.atan2(-Math.sin(angle), -Math.cos(angle)) });
    }
  });
  placed.sort((a, b) => a.row - b.row || Math.abs(a.angle) - Math.abs(b.angle) || a.angle - b.angle);
  const desks: HqDesk[] = placed.map((s, index) =>
    makeSeat(index, `hq-desk-${String(index).padStart(4, "0")}`, s.x, s.z, s.rotY, -1, s.row),
  );

  // Walkway rings: one behind every row, with a node behind each of its
  // chairs; they run on past the row's ends and turn off to the side walkways.
  const ringEnds: number[] = [];
  const rings: number[] = [];
  const spans: number[] = [];
  const deskAngle = placed.map((s) => s.angle);
  rows.forEach((row) => {
    const ring = row.radius + HQ_RING_BEHIND;
    const west = Math.min(...row.angles);
    const east = Math.max(...row.angles);
    const endW = -arcEnd(ring, -west, row.radius);
    const endE = arcEnd(ring, east, row.radius);
    const stops = [endW, endE, ...row.angles, ...RADIAL_AISLES.filter((a) => a > endW && a < endE)];
    const nodes = chainArc(ring, stops);
    for (const { angle, node } of [nodes[0], nodes[nodes.length - 1]]) {
      const p = at(ring, angle);
      toSideWalkway(node, p.x, p.z);
    }
    rings.push(round3(ring));
    spans.push(round3(Math.max(-west, east)));
    ringEnds.push(Math.min(-endW, endE));
  });
  desks.forEach((d, i) => {
    const ring = rows[placed[i].row].radius + HQ_RING_BEHIND;
    const p = at(ring, deskAngle[i]);
    d.navNode = nav.node(p.x, p.z);
  });

  // The stage walkway arc in front of the first row, and the straight aisles
  // from it out through the rows, stopping at every ring they cross.
  const row0 = rows[0];
  const stageEnd = Math.min(
    arcEnd(stageR, -Math.min(...row0.angles), row0.radius),
    arcEnd(stageR, Math.max(...row0.angles), row0.radius),
  );
  // Two short runs from the stage walkway (north of the island) down past the
  // island's sides to the arc.
  const besideDeck = HQ_DECK_RADIUS + 1.6;
  const besideAngle = Math.asin(besideDeck / stageR);
  const stageNodes = chainArc(stageR, [-stageEnd, stageEnd, -besideAngle, besideAngle, ...RADIAL_AISLES]);
  for (const { angle, node } of [stageNodes[0], stageNodes[stageNodes.length - 1]]) {
    const p = at(stageR, angle);
    toSideWalkway(node, p.x, p.z);
  }
  for (const side of [-1, 1]) {
    const x = cx + side * besideDeck;
    const p = at(stageR, side * besideAngle);
    stageLine.add(x);
    nav.link(nav.node(x, stageZ), nav.node(p.x, p.z));
  }
  for (const angle of RADIAL_AISLES) {
    const chain: number[] = [];
    const s = at(stageR, angle);
    chain.push(nav.node(s.x, s.z));
    for (let r = 0; r < rows.length && Math.abs(angle) < ringEnds[r] - 1e-9; r++) {
      const p = at(rings[r], angle);
      chain.push(nav.node(p.x, p.z));
    }
    nav.chain(chain);
  }

  // --- AM7's island and the briefing tribune ------------------------------------
  const deckZ = z0 + deckD;
  const deck = { x: round3(cx), z: round3(deckZ), radius: HQ_DECK_RADIUS };
  const am7Office: HqRect = {
    x0: round3(cx - HQ_DECK_RADIUS),
    z0: round3(deckZ - HQ_DECK_RADIUS),
    x1: round3(cx + HQ_DECK_RADIUS),
    z1: round3(deckZ + HQ_DECK_RADIUS),
  };
  // AM7 faces the rows, the command-arc desk in front; the balustrade is open
  // to the north, where AM7 comes in from the stage walkway behind the chair.
  const leadX = cx;
  const leadZ = deckZ;
  const leadNode = nav.node(leadX - 1.0, leadZ - 1.1);
  stageLine.add(leadX - 1.0);
  nav.link(nav.node(leadX - 1.0, stageZ), leadNode);
  addProp("exec_desk", leadX, leadZ, 0);
  addProp("exec_chair", leadX, leadZ, 0);
  {
    const step = (Math.PI * 2) / BALUSTRADE_SEGMENTS;
    for (let i = 0; i < BALUSTRADE_SEGMENTS; i++) {
      // Angle from due south; the segments within 30 degrees of due north (pi)
      // are the way in, the two either side of due south the way to the tribune.
      const a0 = i * step;
      const a1 = (i + 1) * step;
      const mid = (a0 + a1) / 2;
      if (Math.abs(mid - Math.PI) < step * 2) continue;
      if (Math.min(mid, Math.PI * 2 - mid) < step) continue;
      const pa = { x: cx + HQ_DECK_RADIUS * Math.sin(a0), z: deckZ + HQ_DECK_RADIUS * Math.cos(a0) };
      const pb = { x: cx + HQ_DECK_RADIUS * Math.sin(a1), z: deckZ + HQ_DECK_RADIUS * Math.cos(a1) };
      partitions.push({
        ax: round3(pa.x),
        az: round3(pa.z),
        bx: round3(pb.x),
        bz: round3(pb.z),
        height: BALUSTRADE_HEIGHT,
        kind: "glass",
      });
    }
  }
  // The tribune faces the rows; AM7 comes round it from the stage walkway arc
  // (either side) to the spot behind it, the video wall at his back, or
  // straight down from the island: from behind his chair round the west end
  // of the command desk and out through the balustrade's south opening.
  const tribuneZ = z0 + tribuneD;
  const tribune = {
    x: round3(cx),
    z: round3(tribuneZ),
    rotY: 0,
    standX: round3(cx),
    standZ: round3(tribuneZ - HQ_TRIBUNE_STAND),
  };
  {
    const front = at(stageR, 0);
    const stand = nav.node(tribune.standX, tribune.standZ);
    nav.chain([
      leadNode,
      nav.node(leadX - 2.1, leadZ - 0.2),
      nav.node(leadX - 2.1, leadZ + 1.7),
      nav.node(leadX, leadZ + HQ_DECK_RADIUS),
      stand,
    ]);
    for (const side of [-1, 1]) {
      nav.chain([
        nav.node(front.x, front.z),
        nav.node(cx + side * 1.3, tribuneZ + 0.9),
        nav.node(cx + side * 1.2, tribune.standZ),
        stand,
      ]);
    }
  }

  // --- Video wall and the map spots in front of it --------------------------------
  const mapWall: HqMapWall = {
    x: round3(cx),
    y: MAP_BOTTOM + MAP_HEIGHT / 2,
    z: round3(z0),
    width: round3(mapW),
    height: MAP_HEIGHT,
    curve,
  };
  {
    const inner = HQ_DECK_RADIUS + 2.4;
    const outer = mapW / 2 - 1.5;
    const perSide = Math.max(1, Math.min(4, Math.floor((outer - inner) / 5) + 1));
    for (const side of [-1, 1]) {
      for (let i = 0; i < perSide; i++) {
        const t = perSide === 1 ? 0.5 : i / (perSide - 1);
        const x = cx + side * (inner + (outer - inner) * t);
        const node = addSpot("map", x, z0 + spotsD, Math.PI, 3);
        stageLine.add(x);
        nav.link(node, nav.node(x, stageZ));
      }
    }
    // Data monoliths stand at the video wall's two ends.
    for (const side of [-1, 1]) addProp("data_monolith", cx + side * (mapW / 2 + 1.2), z0 + 0.35);
  }

  // --- Side columns: server rooms, meeting rooms, lounges ---------------------------
  const colLen = z1 - z0;
  const serverL = Math.max(6, colLen * 0.24);
  // Compact meeting rooms leave the lounges room for three or four groups.
  const meetL = Math.max(5.5, colLen * 0.17);
  const westRooms = {
    server: { x0: round3(x0), z0: round3(z0), x1: round3(x0 + westW), z1: round3(z0 + serverL) },
    meetings: [0, 1].map((i) => ({
      x0: round3(x0),
      z0: round3(z0 + serverL + meetL * i),
      x1: round3(x0 + westW),
      z1: round3(z0 + serverL + meetL * (i + 1)),
    })),
  };
  const lounge: HqRect = { x0: round3(x0), z0: westRooms.meetings[1].z1, x1: round3(x0 + westW), z1: round3(z1) };
  const eastRooms = {
    server: { x0: round3(x1 - eastW), z0: round3(z0), x1: round3(x1), z1: round3(z0 + serverL) },
    meetings: [{ x0: round3(x1 - eastW), z0: round3(z0 + serverL), x1: round3(x1), z1: round3(z0 + serverL + meetL) }],
  };
  const eastLounge: HqRect = { x0: round3(x1 - eastW), z0: eastRooms.meetings[0].z1, x1: round3(x1), z1: round3(z1) };

  const loungeSeats: HqSeat[] = [];
  const loungeGroups: HqLoungeGroup[] = [];
  const loungeLines: NavLine[] = [];
  const seatAisles: Vec2[] = [];

  /**
   * One column of glass rooms along a side wall. `side` -1 is the west wall,
   * +1 the east wall; u is metres in from that wall, and headings are
   * mirrored for the east so both columns open toward the hall.
   */
  const buildColumn = (
    side: -1 | 1,
    colW: number,
    line: NavLine,
    server: HqRect,
    meetings: HqRect[],
    room: HqRect,
    coffee: boolean,
  ) => {
    const ux = (u: number) => (side < 0 ? x0 + u : x1 - u);
    const rot = (r: number) => (side < 0 ? r : -r);
    const doorX = ux(colW);
    const lineX = line.fixed;

    // Server room: rows of racks facing south, a walkway along the glass.
    {
      const rackW = 0.6;
      const rackD = 1.1;
      const racks = Math.floor((colW - 2.5) / rackW);
      const rowsZ: number[] = [];
      for (let z = server.z0 + 0.6 + rackD / 2; z + rackD / 2 + 1.4 <= server.z1 - 0.2; z += 2.4) rowsZ.push(z);
      for (const z of rowsZ) {
        for (let k = 0; k < racks; k++) addProp("server_rack", ux(0.5 + rackW * (k + 0.5)), z, 0);
      }
      const lastRack = rowsZ[rowsZ.length - 1] ?? server.z0 + 1.1;
      const spotZ = lastRack + rackD / 2 + 0.7;
      const spotX = ux(0.5 + (racks * rackW) / 2);
      if (server.z0 > z0 + 1e-6) pushWallWithDoor(partitions, ux(0), server.z0, doorX, server.z0, null);
      pushWallWithDoor(partitions, doorX, server.z0, doorX, server.z1, spotZ - server.z0);
      pushWallWithDoor(partitions, ux(0), server.z1, doorX, server.z1, null);
      const node = addSpot("server", spotX, spotZ, Math.PI, 3);
      line.add(spotZ);
      nav.link(node, nav.node(lineX, spotZ));
    }

    // Meeting rooms: table(s) with chairs, a standing spot between table and door.
    meetings.forEach((m, i) => {
      const mz = (m.z0 + m.z1) / 2;
      const a0 = 0.6;
      const a1 = colW - 3.2;
      const tu = (a0 + a1) / 2;
      const tx = ux(tu);
      if (m.z1 - m.z0 - 1.2 > a1 - a0) {
        const tables = Math.max(1, Math.min(3, Math.floor((m.z1 - m.z0 - 2.4) / 3.4)));
        for (let t = 0; t < tables; t++) {
          const tz = mz + (t - (tables - 1) / 2) * 3.3;
          addProp("meeting_table", tx, tz, HALF_PI);
          for (const dz of [-1.1, 0, 1.1]) {
            addProp("meeting_chair", ux(tu - 1.05), tz + dz, rot(HALF_PI));
            addProp("meeting_chair", ux(tu + 1.05), tz + dz, rot(-HALF_PI));
          }
        }
      } else {
        addProp("meeting_table", tx, mz, 0);
        for (const dx of [-1.1, 0, 1.1]) {
          addProp("meeting_chair", tx + dx, mz - 1.05, 0);
          addProp("meeting_chair", tx + dx, mz + 1.05, Math.PI);
        }
      }
      addProp("data_monolith", ux(0.3), i === 0 ? m.z0 + 0.6 : m.z1 - 0.6, rot(HALF_PI));
      // The east column's room is the briefing room: AM7's report on its outer wall.
      if (side > 0) {
        props.push({ kind: "wall_screen", x: round3(ux(0.025)), z: round3(mz), rotY: rot(HALF_PI), screen: HQ_WALL_SCREEN.exec });
      }
      pushWallWithDoor(partitions, doorX, m.z0, doorX, m.z1, mz - m.z0);
      pushWallWithDoor(partitions, ux(0), m.z1, doorX, m.z1, null);
      const node = addSpot("meeting", ux(colW - 1.9), mz, rot(-HALF_PI), 6);
      line.add(mz);
      nav.link(node, nav.node(lineX, mz));
    });

    // Lounge: smoked glass like the meeting rooms, a door per way in; the
    // west one has the coffee bar on its outer wall between two monoliths.
    const doors: number[] = [];
    let first: number = LOUNGE.firstGroupNoBar;
    if (coffee) {
      const coffeeZ = room.z0 + LOUNGE.coffeeV;
      addProp("coffee_bar", ux(0.45), coffeeZ, rot(HALF_PI));
      addProp("data_monolith", ux(0.3), coffeeZ - LOUNGE.coffeeMonolith, rot(HALF_PI));
      addProp("data_monolith", ux(0.3), coffeeZ + LOUNGE.coffeeMonolith, rot(HALF_PI));
      const coffeeNode = addSpot("coffee", ux(2.4), coffeeZ, rot(-HALF_PI), 5);
      line.add(coffeeZ);
      nav.link(coffeeNode, nav.node(lineX, coffeeZ));
      doors.push(coffeeZ - room.z0);
      first = LOUNGE.firstGroup;
    }

    // As many groups as fit (at most four), spread evenly.
    const free = Math.max(0, room.z1 - room.z0 - LOUNGE.south - 0.3 - first);
    const groups = Math.max(1, Math.min(LOUNGE.maxGroups, 1 + Math.floor(free / LOUNGE.pitch)));
    const pitch = groups > 1 ? Math.min(LOUNGE.maxPitch, free / (groups - 1)) : 0;
    const start = first + (free - pitch * (groups - 1)) / 2;
    const { northAisleV: nv, southAisleV: sv } = LOUNGE;
    // Seat root to prop origin, and seat root to its aisle node, per kind.
    const sofaReach = HQ_SOFA_SEAT_DEPTH + HQ_SOFT_SEAT_AISLE;
    const chairReach = HQ_LOUNGE_CHAIR_SEAT_DEPTH + HQ_SOFT_SEAT_AISLE;
    // Centimetre grid, so aisle nodes computed twice land on the same key.
    const wu = round2(LOUNGE.sofaAU + sofaReach);
    const tableU = round2(wu + LOUNGE.tableGap);
    const eu = round2(tableU + LOUNGE.tableGap);
    const sofaBU = tableU + LOUNGE.sofaBShift;
    const span = (a: number, b: number): [number, number] => [Math.min(ux(a), ux(b)), Math.max(ux(a), ux(b))];

    for (let g = 0; g < groups; g++) {
      const gz = round2(room.z0 + start + g * pitch);
      const pos = (u: number, v: number) => ({ x: round3(ux(u)), z: round3(gz + v) });
      const sofaA = pos(wu - sofaReach, 0);
      const sofaB = pos(sofaBU, nv - sofaReach);
      const chairE = pos(eu + chairReach, 0);
      const chairS = pos(tableU, sv + chairReach);
      const table = pos(tableU, 0);
      addProp("sofa", sofaA.x, sofaA.z, rot(HALF_PI));
      addProp("sofa", sofaB.x, sofaB.z, 0);
      addProp("lounge_chair", chairE.x, chairE.z, rot(-HALF_PI));
      addProp("lounge_chair", chairS.x, chairS.z, Math.PI);
      addProp("coffee_table", table.x, table.z, rot(HALF_PI));
      // A lamp in the corner of the L, a monolith closing the group to the
      // south, a dashboard on the wall above the wall sofa.
      addProp("floor_lamp", sofaA.x, sofaB.z);
      addProp("data_monolith", ux(0.3), gz + 1.75, rot(HALF_PI));
      // The lounge screens take turns: news, business, radio.
      props.push({
        kind: "wall_screen",
        x: round3(ux(0.025)),
        z: round3(gz),
        rotY: rot(HALF_PI),
        screen: LOUNGE_CHANNELS[loungeGroups.length % LOUNGE_CHANNELS.length],
      });
      const group = loungeGroups.length;
      loungeGroups.push({ tableX: table.x, tableZ: table.z });

      // Four aisles around the table; every seat's node lies on one of them.
      const [nx0, nx1] = span(wu, sofaBU + SOFA_SEAT_PITCH);
      const [sx0, sx1] = span(wu, eu);
      const outerAisle = new NavLine(true, ux(wu), gz + nv, gz + sv);
      const innerAisle = new NavLine(true, ux(eu), gz + nv, gz + sv);
      const north = new NavLine(false, gz + nv, nx0, nx1);
      const south = new NavLine(false, gz + sv, sx0, sx1);
      north.add(ux(eu));
      loungeLines.push(outerAisle, innerAisle, north, south);
      const seatsOn = (prop: Vec2, rotY: number, depth: number, offsets: readonly number[], aisleLine: NavLine) => {
        for (const lx of offsets) {
          const root = seatToWorld(prop.x, prop.z, rotY, lx, depth);
          const approach = seatToWorld(prop.x, prop.z, rotY, lx, depth + WORKSTATION.approachOffset);
          const node = seatToWorld(prop.x, prop.z, rotY, lx, depth + HQ_SOFT_SEAT_AISLE);
          aisleLine.add(aisleLine.vertical ? node.z : node.x);
          seatAisles.push({ x: node.x, z: node.z });
          loungeSeats.push({
            x: round3(root.x),
            z: round3(root.z),
            rotY,
            approach: { x: round3(approach.x), z: round3(approach.z) },
            navNode: -1, // resolved once the aisles have made their nodes
            group,
          });
        }
      };
      const along = [-SOFA_SEAT_PITCH, 0, SOFA_SEAT_PITCH];
      seatsOn(sofaA, rot(HALF_PI), HQ_SOFA_SEAT_DEPTH, along, outerAisle);
      seatsOn(sofaB, 0, HQ_SOFA_SEAT_DEPTH, along, north);
      seatsOn(chairE, rot(-HALF_PI), HQ_LOUNGE_CHAIR_SEAT_DEPTH, [0], innerAisle);
      seatsOn(chairS, Math.PI, HQ_LOUNGE_CHAIR_SEAT_DEPTH, [0], south);

      // South aisle -> corridor -> door -> the side walkway outside. The
      // standing spot hangs off the corridor on a short spur to the north,
      // turned so the spur comes in between two of its four places: nobody
      // stands where people walk.
      const doorZ = gz + sv;
      const corridor = nav.node(ux(LOUNGE.spotU), doorZ);
      nav.link(nav.node(ux(eu), doorZ), corridor);
      line.add(doorZ);
      nav.link(corridor, nav.node(lineX, doorZ));
      const spotNode = addSpot("lounge", ux(LOUNGE.spotU), gz + LOUNGE.spotV, rot(-Math.PI / 4), 4);
      nav.link(spotNode, corridor);
      doors.push(doorZ - room.z0);
    }
    pushWallWithDoors(partitions, doorX, room.z0, doorX, room.z1, doors);
  };

  buildColumn(-1, westW, westLine, westRooms.server, westRooms.meetings, lounge, true);
  buildColumn(1, eastW, eastLine, eastRooms.server, eastRooms.meetings, eastLounge, false);

  // --- South curb ------------------------------------------------------------------
  // Data monoliths along the low south curb, facing out toward the camera, clear
  // of the entrance.
  {
    const from = x0 + westW + aisle + 1;
    const to = x1 - eastW - aisle - 1;
    const count = Math.max(1, Math.floor((to - from) / 6) + 1);
    for (let i = 0; i < count; i++) {
      const x = count === 1 ? (from + to) / 2 : from + ((to - from) * i) / (count - 1);
      if (Math.abs(x - spawn.x) > 3) addProp("data_monolith", x, z1 - 0.3, 0);
    }
  }

  // --- Archive station ---------------------------------------------------------------
  // The cart's docking bay east of the entrance, its lanes out to the chute on
  // the apron and back, and a spur off the west walkway to the bay.
  const archivePlan = buildArchiveStation({
    nav,
    bounds,
    spawn,
    westAisleX,
    addWestStop: (z) => westLine.add(z),
  });

  // --- Nav graph ----------------------------------------------------------------
  westLine.add(spawn.z);
  for (const line of [westLine, eastLine, stageLine, ...loungeLines]) line.finish(nav);
  nav.link(nav.node(westAisleX, spawn.z), nav.node(spawn.x, spawn.z));
  const navGraph = nav.build();
  const archive = archivePlan.complete(navGraph);
  for (const { spot, node } of spotNodes) spot.navNode = node;
  loungeSeats.forEach((seat, i) => {
    seat.navNode = nav.find(seatAisles[i].x, seatAisles[i].z);
  });

  const leadDesk = makeSeat(-1, "hq-desk-lead", leadX, leadZ, 0, leadNode, -1);

  if (
    desks.some((d) => d.navNode < 0) ||
    loungeSeats.some((s) => s.navNode < 0) ||
    nearestNode(navGraph, spawn.x, spawn.z) < 0
  ) {
    throw new Error("HQ layout: a desk or seat is not attached to the nav graph");
  }

  const arena: HqArena = {
    x: round3(cx),
    z: round3(cz),
    rows: rows.map((r) => round3(r.radius)),
    spans,
    rings,
    aisles: [...RADIAL_AISLES],
    stage: round3(stageR),
  };

  return {
    capacity,
    bounds,
    wallHeight: HQ_WALL_HEIGHT,
    northWallHeight: HQ_NORTH_WALL_HEIGHT,
    desks,
    leadDesk,
    am7Office,
    deck,
    tribune,
    arena,
    meetingRooms: [...westRooms.meetings, ...eastRooms.meetings],
    lounge,
    lounges: [lounge, eastLounge],
    serverRoom: westRooms.server,
    serverRooms: [westRooms.server, eastRooms.server],
    mapWall,
    partitions,
    props,
    socialSpots,
    loungeSeats,
    loungeGroups,
    nav: navGraph,
    spawn,
    archive,
    focus: { x: round3(cx), z: 0, radius: round3(Math.hypot(W, D) / 2) },
  };
}
