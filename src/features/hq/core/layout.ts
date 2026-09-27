// Procedural floor plan of the HQ hall. Pure and deterministic: the same
// capacity always yields the same layout, so desk indices can be persisted.
//
// Plan (north = -z is the tall back wall, west = -x the other back wall):
//
//   +---------------------------------------------+------------+
//   |  map plaza  (world map on the north wall)    | AM7 office |
//   +-----------+---------------------------------+------------+
//   | server    |                                               |
//   +-----------+                                               |
//   | meeting 1 |              pods of 4 desks                  |
//   +-----------+       (aisles, avenues, server pillars)       |
//   | meeting 2 |                                               |
//   +-----------+                                               |
//   | lounge +  |                                               |
//   | coffee    |   (every west room is glass; the lounge has   |
//   |           |    a door per seating group and one for coffee)
//   +--entrance-+-----------------------------------------------+

import { POD, WORKSTATION, type HqCapacity } from "./config";
import { HqNavBuilder, nearestNode } from "./nav";
import type {
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

/** Floor space behind a chair centre that belongs to its pod (chair pushed back). */
export const HQ_CHAIR_CLEARANCE = 0.5;
export const HQ_POD_WIDTH = POD.deskPitchX * 2;
export const HQ_POD_DEPTH = POD.rowGap + HQ_CHAIR_CLEARANCE * 2;
/** Wider aisle that splits big pod blocks into districts. */
export const HQ_AVENUE = 4.2;
export const HQ_WALL_HEIGHT = 5;
export const HQ_GLASS_HEIGHT = 2.8;
export const HQ_DOOR_WIDTH = 1.2;
const MAP_HEIGHT = 4.1;
const MAP_BOTTOM = 0.6;
const MAP_MAX_WIDTH = 40;
const MAP_SHARE = 0.46;
/** Longest edge between two aisle nodes. */
const NAV_MAX_GAP = 3;
const DESKS_PER_POD = 4;

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
/** Width of one props.glb exec_shelf unit (blender/hq/props_tech.py). */
const EXEC_SHELF_WIDTH = 2.0;
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
};

// Lounge seating group, in a frame of u = metres east of the lounge's west
// wall and v = metres south of the group centre (its coffee table). Every seat
// faces the table and has its nav node on one of four aisles around it,
// HQ_SOFT_SEAT_AISLE in front of the seat; the south aisle leads east to the
// group's door, with a standing spot on a short spur off that corridor.
//
//        lamp [======= sofa B =======]
//        [s]  + - - north aisle - - -+- -+     spot (standing ring)
//        [o]  |    +-------+         |      [chair]  |
//        [f]  |    | table |         |      [  E  ]  |
//        [a]  |    +-------+         |               |
//        [A]  + - - south aisle - - -+ - - - - - - - + - - - door
//    monolith        [chair S]
const LOUNGE = {
  /** Sofa A's origin from the west wall: its back 0.1 m off the wall. */
  sofaAU: 0.55,
  /** Aisle centre to table centre, across the table's 0.6 m width. */
  tableGap: 0.625,
  /** Sofa B's centre east of the table's, so its west end clears the lamp. */
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
  /** Earliest first group centre from the north glass; group pitch range. */
  firstGroup: 7.1,
  pitch: 5.3,
  maxPitch: 6,
  maxGroups: 4,
} as const;

type Tier = { westW: number; officeW: number; officeD: number };

// West column width and AM7 office size grow with the hall.
const TIERS: Record<HqCapacity, Tier> = {
  100: { westW: 8, officeW: 9, officeD: 8 },
  300: { westW: 9, officeW: 11, officeD: 9 },
  1000: { westW: 11, officeW: 13, officeD: 10 },
};

/** Picks the pod grid closest to a pleasant hall aspect with few empty slots. */
function chooseGrid(pods: number): { cols: number; rows: number } {
  let best = { cols: pods, rows: 1 };
  let bestScore = Infinity;
  for (let cols = 1; cols <= pods; cols++) {
    const rows = Math.ceil(pods / cols);
    const empty = rows * cols - pods;
    const aspect = (cols * (HQ_POD_WIDTH + POD.aisle)) / (rows * (HQ_POD_DEPTH + POD.aisle));
    const score = Math.abs(Math.log(aspect / 1.3)) + empty / cols;
    if (score < bestScore - 1e-9) {
      bestScore = score;
      best = { cols, rows };
    }
  }
  return best;
}

/** Gap widths between consecutive pod columns (or rows); big blocks get avenues. */
function gapWidths(n: number): number[] {
  const gaps: number[] = [];
  for (let i = 0; i < n - 1; i++) gaps.push(POD.aisle);
  if (n >= 10) {
    const avenues = Math.floor((n - 1) / 6);
    for (let k = 1; k <= avenues; k++) {
      const after = Math.round((k * n) / (avenues + 1)) - 1;
      if (after >= 0 && after < n - 1) gaps[after] = HQ_AVENUE;
    }
  }
  return gaps;
}

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
  const { westW, officeW, officeD } = tier;
  const aisle = POD.aisle;
  const plazaD = officeD;

  // --- Pod grid ---------------------------------------------------------
  const podCount = Math.ceil(capacity / DESKS_PER_POD);
  const { cols, rows } = chooseGrid(podCount);
  const gapX = gapWidths(cols);
  const gapZ = gapWidths(rows);
  const podsW = cols * HQ_POD_WIDTH + gapX.reduce((a, b) => a + b, 0);
  const podsD = rows * HQ_POD_DEPTH + gapZ.reduce((a, b) => a + b, 0);

  const W = westW + aisle + podsW + aisle;
  // The west column (server room, meeting room, cyber-range, lounge) needs ~27 m.
  const D = Math.max(plazaD + aisle + podsD + aisle, plazaD + 27);
  const x0 = -W / 2;
  const x1 = W / 2;
  const z0 = -D / 2;
  const z1 = D / 2;
  const bounds: HqRect = { x0: round3(x0), z0: round3(z0), x1: round3(x1), z1: round3(z1) };

  const podX0 = x0 + westW + aisle;
  const podZ0 = z0 + plazaD + aisle;
  const colX: number[] = [];
  for (let c = 0, x = podX0; c < cols; c++) {
    colX.push(x + HQ_POD_WIDTH / 2);
    x += HQ_POD_WIDTH + (gapX[c] ?? 0);
  }
  const rowZ: number[] = [];
  for (let r = 0, z = podZ0; r < rows; r++) {
    rowZ.push(z + HQ_POD_DEPTH / 2);
    z += HQ_POD_DEPTH + (gapZ[r] ?? 0);
  }
  // Aisle centre lines: west of each column / north of each row, plus the last.
  const vAisles: number[] = [x0 + westW + aisle / 2];
  for (let c = 0; c < cols - 1; c++) vAisles.push(colX[c] + HQ_POD_WIDTH / 2 + gapX[c] / 2);
  vAisles.push(colX[cols - 1] + HQ_POD_WIDTH / 2 + aisle / 2);
  const hAisles: number[] = [z0 + plazaD + aisle / 2];
  for (let r = 0; r < rows - 1; r++) hAisles.push(rowZ[r] + HQ_POD_DEPTH / 2 + gapZ[r] / 2);
  hAisles.push(rowZ[rows - 1] + HQ_POD_DEPTH / 2 + aisle / 2);
  const westAisleX = vAisles[0];
  const northAisleZ = hAisles[0];
  const southAisleZ = hAisles[hAisles.length - 1];

  // --- Zones ------------------------------------------------------------
  const ox0 = x1 - officeW;
  const oz1 = z0 + officeD;
  const am7Office: HqRect = { x0: round3(ox0), z0: round3(z0), x1: round3(x1), z1: round3(oz1) };

  const colZ0 = z0 + plazaD;
  const colLen = z1 - colZ0;
  const serverL = Math.max(6, colLen * 0.24);
  const meetL = Math.max(5.5, colLen * 0.2);
  const serverRoom: HqRect = { x0: round3(x0), z0: round3(colZ0), x1: round3(x0 + westW), z1: round3(colZ0 + serverL) };
  // The west column, north→south: server room, one meeting room, the
  // cyber-range (a training bay), then the lounge fills the rest. The
  // cyber-range takes the slot a second meeting room used to hold.
  const meetingRooms: HqRect[] = [
    {
      x0: round3(x0),
      z0: round3(colZ0 + serverL),
      x1: round3(x0 + westW),
      z1: round3(colZ0 + serverL + meetL),
    },
  ];
  const cyberRange: HqRect = {
    x0: round3(x0),
    z0: round3(colZ0 + serverL + meetL),
    x1: round3(x0 + westW),
    z1: round3(colZ0 + serverL + meetL * 2),
  };
  const lounge: HqRect = { x0: round3(x0), z0: cyberRange.z1, x1: round3(x0 + westW), z1: round3(z1) };

  const mapCx = (x0 + ox0) / 2;
  const mapW = Math.min(MAP_MAX_WIDTH, W * MAP_SHARE, ox0 - x0 - 2);
  const mapWall: HqMapWall = {
    x: round3(mapCx),
    y: MAP_BOTTOM + MAP_HEIGHT / 2,
    z: round3(z0),
    width: round3(mapW),
    height: MAP_HEIGHT,
  };

  const nav = new HqNavBuilder();
  const props: HqProp[] = [];
  const partitions: HqSegment[] = [];
  const addProp = (kind: HqPropKind, x: number, z: number, rotY = 0) =>
    props.push({ kind, x: round3(x), z: round3(z), rotY });

  // --- Aisle lines --------------------------------------------------------
  const plazaLineZ = z0 + plazaD - 2.6;
  const plazaX1 = ox0 - 1.5;
  // Just east of the west aisle's south end, so the entrance cut centred on
  // it stays clear of the lounge glass; linked to the aisle below.
  const spawn = { x: round3(Math.max(westAisleX, x0 + westW + ENTRANCE_CLEAR)), z: round3(z1 - 0.5) };
  const vLines = vAisles.map((x, i) => {
    const inPlaza = x < plazaX1;
    const top = inPlaza ? plazaLineZ : northAisleZ;
    const bottom = i === 0 ? spawn.z : southAisleZ;
    return new NavLine(true, x, top, bottom);
  });
  const hLines = hAisles.map((z) => new NavLine(false, z, westAisleX, vAisles[vAisles.length - 1]));
  const plazaLine = new NavLine(false, plazaLineZ, x0 + 1.5, plazaX1);
  for (const v of vLines) {
    for (const z of hAisles) v.add(z);
    v.add(plazaLineZ);
    plazaLine.add(v.fixed);
  }
  for (const h of hLines) for (const x of vAisles) h.add(x);
  const westLine = vLines[0];
  const northLine = hLines[0];

  // --- Pods and desks -----------------------------------------------------
  // The partial row (if any) is the northmost one, packed to the west, so the
  // spare slots open up the space in front of AM7's office.
  const empty = rows * cols - podCount;
  type Slot = { c: number; r: number; x: number; z: number };
  const used: Slot[] = [];
  const spare: Slot[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const slot = { c, r, x: colX[c], z: rowZ[r] };
      if (r === 0 && c >= cols - empty) spare.push(slot);
      else used.push(slot);
    }
  }
  // Desks fill from the heart of the room outward, so a small team sits
  // together near the map and the lead's office instead of in one corner.
  const anchorX = (colX[0] + colX[cols - 1]) / 2;
  const anchorZ = podZ0 + podsD * 0.35;
  used.sort((a, b) => {
    const da = (a.x - anchorX) ** 2 + (a.z - anchorZ) ** 2;
    const db = (b.x - anchorX) ** 2 + (b.z - anchorZ) ** 2;
    return da - db || a.r - b.r || a.c - b.c;
  });

  const desks: HqDesk[] = [];
  const halfRow = POD.rowGap / 2;
  const deskNodes: Array<{ line: NavLine; x: number; desk: number }> = [];
  used.forEach((slot, podId) => {
    const northLineRef = hLines[slot.r];
    const southLineRef = hLines[slot.r + 1];
    const seats = [
      { dx: -POD.deskPitchX / 2, dz: -halfRow, rot: 0, line: northLineRef },
      { dx: POD.deskPitchX / 2, dz: -halfRow, rot: 0, line: northLineRef },
      { dx: -POD.deskPitchX / 2, dz: halfRow, rot: Math.PI, line: southLineRef },
      { dx: POD.deskPitchX / 2, dz: halfRow, rot: Math.PI, line: southLineRef },
    ];
    for (const s of seats) {
      if (desks.length >= capacity) return;
      const index = desks.length;
      const x = slot.x + s.dx;
      s.line.add(x);
      deskNodes.push({ line: s.line, x, desk: index });
      desks.push(
        makeSeat(index, `hq-desk-${String(index).padStart(4, "0")}`, x, slot.z + s.dz, s.rot, -1, podId),
      );
    }
  });
  const usedPods = used.slice(0, Math.ceil(desks.length / DESKS_PER_POD));

  // --- AM7 office ---------------------------------------------------------
  // Far enough from the west glass for a dark plant on either side, inside.
  const officeDoorX = ox0 + 2.2;
  pushWallWithDoor(partitions, ox0, z0, ox0, oz1, null);
  pushWallWithDoor(partitions, ox0, oz1, x1, oz1, officeDoorX - ox0);
  northLine.add(officeDoorX);
  const leadX = ox0 + officeW * 0.6;
  const leadZ = z0 + 2.4 + (officeD - 8) * 0.3;
  const officeInside = nav.node(officeDoorX, oz1 - 1.1);
  // The command-arc desk wraps round the chair's front and sides, so AM7
  // comes in from behind the chair: round the desk's west pod, then between
  // the pods to the seat.
  const leadRound = nav.node(leadX - 2.2, leadZ + 0.1);
  const leadNode = nav.node(leadX - 1.0, leadZ - 1.1);
  nav.link(officeInside, leadRound);
  nav.link(leadRound, leadNode);
  addProp("exec_desk", leadX, leadZ, 0);
  addProp("exec_chair", leadX, leadZ, 0);
  // A wall of shelves behind AM7 from the wall screen (2.2 m, centred at
  // ox0 + 2.4) to the data monolith (0.9 m base at x1 - 0.6): as many whole
  // 2 m units as fit, side by side and centred, 0.1 m clear of both.
  {
    const from = ox0 + 2.4 + 2.2 / 2 + 0.1;
    const to = x1 - 0.6 - 0.9 / 2 - 0.1;
    const units = Math.max(1, Math.floor((to - from) / EXEC_SHELF_WIDTH + 1e-6));
    const start = (from + to) / 2 - (units * EXEC_SHELF_WIDTH) / 2;
    for (let k = 0; k < units; k++) addProp("exec_shelf", start + EXEC_SHELF_WIDTH * (k + 0.5), z0 + 0.25, 0);
  }
  // props.glb frames: origin at the footprint centre, front +Z; the wall
  // screen body is 5 cm deep and hangs 2.5 cm off the wall.
  props.push({ kind: "wall_screen", x: round3(ox0 + 2.4), z: round3(z0 + 0.025), rotY: 0, screen: HQ_WALL_SCREEN.exec });
  addProp("sofa", x1 - 0.7, oz1 - 2.6, -HALF_PI);
  addProp("coffee_table", x1 - 1.9, oz1 - 2.6, -HALF_PI);
  addProp("floor_lamp", x1 - 0.55, oz1 - 4.2);
  // The only plants in the HQ: two dark ones in the office's south corners,
  // one west of the door and one past the sofa, their leaves just clear of
  // the glass.
  const plantInset = HQ_PROP_FOOTPRINT.dark_plant[0] / 2 + 0.08;
  addProp("dark_plant", ox0 + plantInset, oz1 - plantInset);
  addProp("dark_plant", x1 - plantInset, oz1 - plantInset);
  // The work wall behind AM7: a server pillar at its west end, clear of the
  // wall screen, and a data monolith at its east end, clear of the shelf.
  addProp("server_pillar", ox0 + 0.6, z0 + 0.45);
  addProp("data_monolith", x1 - 0.6, z0 + 0.35);

  // --- Map plaza ----------------------------------------------------------
  const socialSpots: HqSocialSpot[] = [];
  const spotNodes: Array<{ spot: HqSocialSpot; node: number }> = [];
  const addSpot = (kind: HqSocialSpotKind, x: number, z: number, rotY: number, cap: number) => {
    const spot: HqSocialSpot = { kind, x: round3(x), z: round3(z), rotY, capacity: cap, navNode: -1 };
    socialSpots.push(spot);
    const node = nav.node(spot.x, spot.z);
    spotNodes.push({ spot, node });
    return node;
  };
  const mapSpotCount = Math.max(3, Math.min(8, Math.round(mapW / 5)));
  const mapSpotZ = z0 + Math.min(3.4, plazaD * 0.42);
  for (let i = 0; i < mapSpotCount; i++) {
    const x = mapCx + (i - (mapSpotCount - 1) / 2) * (mapW / mapSpotCount);
    const node = addSpot("map", x, mapSpotZ, Math.PI, 3);
    plazaLine.add(x);
    nav.link(node, nav.node(x, plazaLineZ));
  }
  // Data monoliths frame the map and line the rest of the north wall.
  for (const side of [-1, 1]) {
    for (let x = mapCx + side * (mapW / 2 + 1); x > x0 + 0.6 && x < ox0 - 0.6; x += side * 4.5) {
      addProp("data_monolith", x, z0 + 0.3);
    }
  }

  // --- West column: server room, meeting rooms, lounge ---------------------
  const doorX = x0 + westW;
  // Server room: rows of racks facing south, a walkway along the glass.
  {
    const rackW = 0.6;
    const rackD = 1.1;
    const rx0 = serverRoom.x0 + 0.5;
    const racks = Math.floor((doorX - 2 - rx0) / rackW);
    const rowsZ: number[] = [];
    for (let z = serverRoom.z0 + 0.6 + rackD / 2; z + rackD / 2 + 1.4 <= serverRoom.z1 - 0.2; z += 2.4) rowsZ.push(z);
    for (const z of rowsZ) {
      for (let k = 0; k < racks; k++) addProp("server_rack", rx0 + rackW * (k + 0.5), z, 0);
    }
    const lastRow = rowsZ[rowsZ.length - 1] ?? serverRoom.z0 + 1.1;
    const spotZ = lastRow + rackD / 2 + 0.7;
    const spotX = rx0 + (racks * rackW) / 2;
    pushWallWithDoor(partitions, serverRoom.x0, serverRoom.z0, doorX, serverRoom.z0, null);
    pushWallWithDoor(partitions, doorX, serverRoom.z0, doorX, serverRoom.z1, spotZ - serverRoom.z0);
    pushWallWithDoor(partitions, serverRoom.x0, serverRoom.z1, doorX, serverRoom.z1, null);
    const node = addSpot("server", spotX, spotZ, Math.PI, 3);
    westLine.add(spotZ);
    nav.link(node, nav.node(westAisleX, spotZ));
  }
  // Meeting rooms: table(s) with chairs, a standing spot between table and door.
  meetingRooms.forEach((room, i) => {
    const cz = (room.z0 + room.z1) / 2;
    const ax0 = room.x0 + 0.6;
    const ax1 = doorX - 3.2;
    const tx = (ax0 + ax1) / 2;
    const alongZ = room.z1 - room.z0 - 1.2 > ax1 - ax0;
    if (alongZ) {
      const tables = Math.max(1, Math.min(3, Math.floor((room.z1 - room.z0 - 2.4) / 3.4)));
      for (let t = 0; t < tables; t++) {
        const tz = cz + (t - (tables - 1) / 2) * 3.3;
        addProp("meeting_table", tx, tz, HALF_PI);
        for (const dz of [-1.1, 0, 1.1]) {
          addProp("meeting_chair", tx - 1.05, tz + dz, HALF_PI);
          addProp("meeting_chair", tx + 1.05, tz + dz, -HALF_PI);
        }
      }
    } else {
      addProp("meeting_table", tx, cz, 0);
      for (const dx of [-1.1, 0, 1.1]) {
        addProp("meeting_chair", tx + dx, cz - 1.05, 0);
        addProp("meeting_chair", tx + dx, cz + 1.05, Math.PI);
      }
    }
    addProp("data_monolith", room.x0 + 0.3, i === 0 ? room.z0 + 0.6 : room.z1 - 0.6, HALF_PI);
    pushWallWithDoor(partitions, doorX, room.z0, doorX, room.z1, cz - room.z0);
    pushWallWithDoor(partitions, room.x0, room.z1, doorX, room.z1, null);
    const node = addSpot("meeting", doorX - 1.9, cz, -HALF_PI, 6);
    westLine.add(cz);
    nav.link(node, nav.node(westAisleX, cz));
  });
  // Cyber-range: a training bay. Target rigs (blinking pillars and monoliths)
  // line the west wall; hackers drill at a row of stations facing them. Same
  // glass-and-door shell as a meeting room, so aisles reach it through the door.
  {
    const room = cyberRange;
    const cz = (room.z0 + room.z1) / 2;
    addProp("data_monolith", room.x0 + 0.4, room.z0 + 0.7, HALF_PI);
    addProp("data_monolith", room.x0 + 0.4, cz, HALF_PI);
    addProp("data_monolith", room.x0 + 0.4, room.z1 - 0.7, HALF_PI);
    pushWallWithDoor(partitions, doorX, room.z0, doorX, room.z1, cz - room.z0);
    pushWallWithDoor(partitions, room.x0, room.z1, doorX, room.z1, null);
    const node = addSpot("cyberrange", doorX - 2.2, cz, -HALF_PI, 6);
    westLine.add(cz);
    nav.link(node, nav.node(westAisleX, cz));
  }
  // Lounge: smoked glass like the meeting rooms, a door per way in. Coffee
  // bar on the west wall between two data monoliths, then seating groups.
  const loungeSeats: HqSeat[] = [];
  const loungeGroups: HqLoungeGroup[] = [];
  const loungeLines: NavLine[] = [];
  const seatAisles: Vec2[] = [];
  {
    const lx0 = lounge.x0;
    const doors: number[] = [];
    const coffeeZ = lounge.z0 + LOUNGE.coffeeV;
    addProp("coffee_bar", lx0 + 0.45, coffeeZ, HALF_PI);
    addProp("data_monolith", lx0 + 0.3, coffeeZ - LOUNGE.coffeeMonolith, HALF_PI);
    addProp("data_monolith", lx0 + 0.3, coffeeZ + LOUNGE.coffeeMonolith, HALF_PI);
    const coffeeNode = addSpot("coffee", lx0 + 2.4, coffeeZ, -HALF_PI, 5);
    westLine.add(coffeeZ);
    nav.link(coffeeNode, nav.node(westAisleX, coffeeZ));
    doors.push(coffeeZ - lounge.z0);

    // As many groups as fit below the coffee bar (at most four), spread evenly.
    const room = Math.max(0, lounge.z1 - lounge.z0 - LOUNGE.south - 0.3 - LOUNGE.firstGroup);
    const groups = Math.max(1, Math.min(LOUNGE.maxGroups, 1 + Math.floor(room / LOUNGE.pitch)));
    const pitch = groups > 1 ? Math.min(LOUNGE.maxPitch, room / (groups - 1)) : 0;
    const first = LOUNGE.firstGroup + (room - pitch * (groups - 1)) / 2;
    const { northAisleV: nv, southAisleV: sv } = LOUNGE;
    // Seat root to prop origin, and seat root to its aisle node, per kind.
    const sofaReach = HQ_SOFA_SEAT_DEPTH + HQ_SOFT_SEAT_AISLE;
    const chairReach = HQ_LOUNGE_CHAIR_SEAT_DEPTH + HQ_SOFT_SEAT_AISLE;
    // Centimetre grid, so aisle nodes computed twice land on the same key.
    const wu = round2(LOUNGE.sofaAU + sofaReach);
    const tableU = round2(wu + LOUNGE.tableGap);
    const eu = round2(tableU + LOUNGE.tableGap);
    const sofaBU = tableU + LOUNGE.sofaBShift;

    for (let g = 0; g < groups; g++) {
      const gz = round2(lounge.z0 + first + g * pitch);
      const at = (u: number, v: number) => ({ x: round3(lx0 + u), z: round3(gz + v) });
      const sofaA = at(wu - sofaReach, 0);
      const sofaB = at(sofaBU, nv - sofaReach);
      const chairE = at(eu + chairReach, 0);
      const chairS = at(tableU, sv + chairReach);
      const table = at(tableU, 0);
      addProp("sofa", sofaA.x, sofaA.z, HALF_PI);
      addProp("sofa", sofaB.x, sofaB.z, 0);
      addProp("lounge_chair", chairE.x, chairE.z, -HALF_PI);
      addProp("lounge_chair", chairS.x, chairS.z, Math.PI);
      addProp("coffee_table", table.x, table.z, HALF_PI);
      // A lamp in the corner of the L, a monolith closing the group to the
      // south, a dashboard on the wall above the wall sofa (hung like AM7's).
      addProp("floor_lamp", sofaA.x, sofaB.z);
      addProp("data_monolith", lx0 + 0.3, gz + 1.75, HALF_PI);
      // The lounge screens take turns: news, business, radio.
      props.push({ kind: "wall_screen", x: round3(lx0 + 0.025), z: round3(gz), rotY: HALF_PI, screen: LOUNGE_CHANNELS[g % LOUNGE_CHANNELS.length] });
      const group = loungeGroups.length;
      loungeGroups.push({ tableX: table.x, tableZ: table.z });

      // Four aisles around the table; every seat's node lies on one of them.
      const west = new NavLine(true, lx0 + wu, gz + nv, gz + sv);
      const east = new NavLine(true, lx0 + eu, gz + nv, gz + sv);
      const north = new NavLine(false, gz + nv, lx0 + wu, lx0 + sofaBU + SOFA_SEAT_PITCH);
      const south = new NavLine(false, gz + sv, lx0 + wu, lx0 + eu);
      north.add(lx0 + eu);
      loungeLines.push(west, east, north, south);
      const seatsOn = (prop: Vec2, rotY: number, depth: number, offsets: readonly number[], line: NavLine) => {
        for (const lx of offsets) {
          const root = seatToWorld(prop.x, prop.z, rotY, lx, depth);
          const approach = seatToWorld(prop.x, prop.z, rotY, lx, depth + WORKSTATION.approachOffset);
          const aisle = seatToWorld(prop.x, prop.z, rotY, lx, depth + HQ_SOFT_SEAT_AISLE);
          line.add(line.vertical ? aisle.z : aisle.x);
          seatAisles.push({ x: aisle.x, z: aisle.z });
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
      seatsOn(sofaA, HALF_PI, HQ_SOFA_SEAT_DEPTH, along, west);
      seatsOn(sofaB, 0, HQ_SOFA_SEAT_DEPTH, along, north);
      seatsOn(chairE, -HALF_PI, HQ_LOUNGE_CHAIR_SEAT_DEPTH, [0], east);
      seatsOn(chairS, Math.PI, HQ_LOUNGE_CHAIR_SEAT_DEPTH, [0], south);

      // South aisle -> corridor -> door -> the west aisle outside. The
      // standing spot hangs off the corridor on a short spur to the north,
      // turned so the spur comes in between two of its four places: nobody
      // stands where people walk.
      const doorZ = gz + sv;
      const corridor = nav.node(lx0 + LOUNGE.spotU, doorZ);
      nav.link(nav.node(lx0 + eu, doorZ), corridor);
      westLine.add(doorZ);
      nav.link(corridor, nav.node(westAisleX, doorZ));
      const spotNode = addSpot("lounge", lx0 + LOUNGE.spotU, gz + LOUNGE.spotV, -Math.PI / 4, 4);
      nav.link(spotNode, corridor);
      doors.push(doorZ - lounge.z0);
    }
    pushWallWithDoors(partitions, doorX, lounge.z0, doorX, lounge.z1, doors);
  }

  // --- Tech on the work floor ----------------------------------------------
  // A server pillar at the east end of every pod, two monoliths on every empty
  // pod slot, monoliths along the low south and east walls. Those face out,
  // toward the camera (south-east), so it sees their red slits, not their backs.
  usedPods.forEach((slot) => {
    addProp("server_pillar", slot.x + HQ_POD_WIDTH / 2 + 0.45, slot.z, 0);
  });
  colX.forEach((px, c) => {
    if (c % 2 === 0 && Math.abs(px - spawn.x) > 3) addProp("data_monolith", px, z1 - 0.3, 0);
  });
  rowZ.forEach((pz, r) => {
    if (r % 2 === 0) addProp("data_monolith", x1 - 0.3, pz, HALF_PI);
  });

  // --- Nav graph ----------------------------------------------------------
  westLine.add(spawn.z);
  for (const line of [...vLines, ...hLines, plazaLine, ...loungeLines]) line.finish(nav);
  nav.link(nav.node(westAisleX, spawn.z), nav.node(spawn.x, spawn.z));
  nav.link(nav.node(officeDoorX, northAisleZ), officeInside);
  const navGraph = nav.build();
  for (const { line, x, desk } of deskNodes) desks[desk].navNode = nav.find(x, line.fixed);
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

  return {
    capacity,
    bounds,
    wallHeight: HQ_WALL_HEIGHT,
    desks,
    leadDesk,
    am7Office,
    meetingRooms,
    cyberRange,
    lounge,
    serverRoom,
    mapWall,
    partitions,
    props,
    socialSpots,
    loungeSeats,
    loungeGroups,
    nav: navGraph,
    spawn,
    focus: { x: 0, z: 0, radius: round3(Math.hypot(W, D) / 2) },
  };
}
