// The archive station by the entrance: the docking bay where the archive cart
// fills up, the lanes a hauler pushes it along (out through the entrance to
// the intake chute on the apron, and back), and the nav spur he walks in on.
// Pure and deterministic, like the rest of the layout.
//
// Plan, round the entrance cut in the south curb (x = spawn.x, z = bounds.z1;
// north is up, the hall above the curb, the apron below it):
//
//      spur  W--------------------------T (approach, entry/leave node)
//            |    <---- laneOut ---<     |  laneOut: pull the cart back out
//   west     |   /  (W at z1-3.57)   )   |  of the bay (reverse), swing its
//   walkway  |  |   >-- laneBack -->-.   v  nose west, push it west, turn
//            |  |  | (E at z1-3.75)   \  stand                south through
//            |  |  |                   | [bay]  the bay backs    the entrance
//   =========|==|==|===== curb ========+=====  onto the curb,     to the
//            | [chute] |  (entrance cut)       mouth north        handover
//            |  |  U   |                                          beside the
//            apron: handover, then a U-turn east and back north   chute
//
// The cart parks nose in (the bay's bumper wall and gauge at its back, the
// handle toward the hall), so it leaves handle first: the first stretch of
// laneOut is a pull (HqArchiveLane.reverse). Everything else is pushed nose
// first. The pusher's root is the lane sample; the cart's origin is always
// root + forward * HQ_ARCHIVE_CART.reach.

import { HQ_ARCHIVE_CART } from "./config";
import type { HqNavBuilder } from "./nav";
import type { HqArchiveLane, HqArchiveStation, HqNavGraph, HqPose, HqRect, Vec2 } from "./types";

/** Half the entrance cut in the south curb (render/environment/palette.ts ENTRANCE_WIDTH / 2). */
export const HQ_ENTRANCE_HALF_WIDTH = 1.6;
/** Depth of the low south curb (render/environment/palette.ts WALL_THICKNESS). */
export const HQ_CURB_DEPTH = 0.25;

/**
 * Station offsets: u is metres east of spawn.x, v metres south of bounds.z1
 * (negative = inside the hall). Tested for every hall size in hqLayout.test.ts.
 */
export const HQ_ARCHIVE = {
  /** Bay centre east of the spawn. */
  bayU: 3.9,
  /** Gap between the bay's back and the south curb. */
  bayBack: 0.02,
  /** The parked cart's origin sits this far from the bay centre toward its bumper. */
  cartInBay: 0.025,
  /** Straight pull out of the bay until the front casters clear its guide rails. */
  pullOut: 1.1,
  /** The pull then swings the cart's nose west on this radius. */
  pullTurnR: 0.75,
  /** The pusher's x (from spawn.x) through the entrance on the way out, and the turn into it. */
  outX: -0.5,
  outTurnR: 1.6,
  /** The pusher's root at the handover, south of the curb. */
  handoverV: 1.8,
  /** The U-turn on the apron (east), back into the hall. */
  uTurnR: 0.7,
  /** laneBack runs east at this v to the bay, then turns south into it. */
  laneV: -3.75,
  laneTurnR: 0.75,
  /** The hauler's approach point, behind the stand along the cart's heading. */
  approach: 0.8,
  /** Longest distance between two lane samples. */
  step: 0.1,
  /** The apron outside the entrance, centred on it. */
  apron: { halfWidth: 2.4, depth: 4.0 },
  /** No-stop: the doorway band (inside the curb) and the door area's half width round spawn.x. */
  noStopBand: 0.6,
  doorHalf: 2.6,
  /** No-stop: the cart or the pusher within this of a walkway (a nav edge off the station's spur). */
  noStopEdge: 0.45,
  /** Stoppable stretches shorter than this between two no-stop ones count as no-stop. */
  noStopMinGap: 0.5,
  /** Chute centre (u, v); its slot faces east, toward the cart at the handover. */
  chute: { u: -1.29, v: 2.85 },
} as const;

/** archive_bay in its own frame (mouth toward +Z): its size and the bumper wall across its back. */
export const HQ_ARCHIVE_BAY = { width: 0.95, depth: 1.4, bumperZ0: -0.7, bumperZ1: -0.543 } as const;
/** archive_chute in its own frame (slot toward +Z): size, the feed lip's front and the slot mouth. */
export const HQ_ARCHIVE_CHUTE = { width: 0.7, depth: 0.6, lip: 0.3, slot: 0.16 } as const;
/** The pusher's body on the floor, round his root (half width across, half depth along his heading). */
export const HQ_ARCHIVE_BODY = { halfWidth: 0.32, halfDepth: 0.25 } as const;

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Local (lx, lz) of a frame at (x, z) turned by rotY, to world (rotY 0 faces +Z; +X is local left). */
function toWorld(x: number, z: number, rotY: number, lx: number, lz: number): Vec2 {
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  return { x: x + lx * c + lz * s, z: z - lx * s + lz * c };
}

function box(x: number, z: number, rotY: number, lx0: number, lx1: number, lz0: number, lz1: number): Vec2[] {
  return [
    toWorld(x, z, rotY, lx0, lz0),
    toWorld(x, z, rotY, lx1, lz0),
    toWorld(x, z, rotY, lx1, lz1),
    toWorld(x, z, rotY, lx0, lz1),
  ];
}

/**
 * Floor footprints of the pushing assembly for a pusher root at (x, z) and a
 * cart heading rotY: the cart (its origin `reach` ahead) and the pusher's body.
 */
export function archiveAssembly(x: number, z: number, rotY: number): { cart: Vec2[]; body: Vec2[] } {
  const c = HQ_ARCHIVE_CART;
  const w = c.width / 2;
  const b = HQ_ARCHIVE_BODY;
  return {
    cart: box(x, z, rotY, -w, w, c.reach - c.tail, c.reach + c.nose),
    body: box(x, z, rotY, -b.halfWidth, b.halfWidth, -b.halfDepth, b.halfDepth),
  };
}

/** Footprint of the parked-cart bay's bumper wall and gauge tower (the part a cart must never touch). */
export function archiveBumperPoly(bay: HqPose): Vec2[] {
  const b = HQ_ARCHIVE_BAY;
  return box(bay.x, bay.z, bay.rotY, -b.width / 2, b.width / 2, b.bumperZ0, b.bumperZ1);
}

/** Footprint of the chute, feed lip included. */
export function archiveChutePoly(chute: HqPose): Vec2[] {
  const c = HQ_ARCHIVE_CHUTE;
  return box(chute.x, chute.z, chute.rotY, -c.width / 2, c.width / 2, -c.depth / 2, c.lip);
}

function pointSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

function segmentsCross(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const cross = (ox: number, oz: number, px: number, pz: number, qx: number, qz: number) =>
    (px - ox) * (qz - oz) - (pz - oz) * (qx - ox);
  const d1 = cross(cx, cz, dx, dz, ax, az);
  const d2 = cross(cx, cz, dx, dz, bx, bz);
  const d3 = cross(ax, az, bx, bz, cx, cz);
  const d4 = cross(ax, az, bx, bz, dx, dz);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function insideConvex(poly: readonly Vec2[], x: number, z: number): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = (b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x);
    if (Math.abs(c) < 1e-12) continue;
    if (sign === 0) sign = Math.sign(c);
    else if (Math.sign(c) !== sign) return false;
  }
  return true;
}

/** Distance from a convex polygon to the segment a-b (0 when they touch or overlap). */
export function polySegmentDistance(poly: readonly Vec2[], ax: number, az: number, bx: number, bz: number): number {
  if (insideConvex(poly, ax, az) || insideConvex(poly, bx, bz)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    if (segmentsCross(p.x, p.z, q.x, q.z, ax, az, bx, bz)) return 0;
    best = Math.min(
      best,
      pointSegment(p.x, p.z, ax, az, bx, bz),
      pointSegment(ax, az, p.x, p.z, q.x, q.z),
      pointSegment(bx, bz, p.x, p.z, q.x, q.z),
    );
  }
  return best;
}

/** A turtle that samples a lane: straights and arcs, forward or reverse. */
class LaneBuilder {
  readonly xs: number[];
  readonly zs: number[];
  readonly hs: number[];
  /** Per sample: 1 when the move that reached it was a reverse. The first sample copies the second. */
  readonly rev: number[];
  x: number;
  z: number;
  h: number;

  constructor(start: HqPose) {
    this.x = start.x;
    this.z = start.z;
    this.h = start.rotY;
    this.xs = [start.x];
    this.zs = [start.z];
    this.hs = [start.rotY];
    this.rev = [0];
  }

  private push(reverse: boolean): void {
    this.xs.push(this.x);
    this.zs.push(this.z);
    this.hs.push(this.h);
    this.rev.push(reverse ? 1 : 0);
  }

  straight(d: number, reverse = false): this {
    if (d < -1e-9) throw new Error(`HQ layout: archive lane straight of ${d.toFixed(3)} m`);
    if (d < 1e-9) return this;
    const n = Math.ceil(d / HQ_ARCHIVE.step - 1e-9);
    const dir = reverse ? -1 : 1;
    const fx = Math.sin(this.h) * dir;
    const fz = Math.cos(this.h) * dir;
    const x0 = this.x;
    const z0 = this.z;
    for (let i = 1; i <= n; i++) {
      this.x = x0 + (fx * d * i) / n;
      this.z = z0 + (fz * d * i) / n;
      this.push(reverse);
    }
    return this;
  }

  /**
   * Turns the heading by `delta` (positive = toward the pusher's left when
   * moving forward) on a circle of radius r. In reverse the root backs round
   * the circle: the same heading change swings the nose the other way.
   */
  arc(delta: number, r: number, reverse = false): this {
    const side = (reverse ? -1 : 1) * Math.sign(delta);
    // Centre: `side` * r along the local left (cos h, -sin h).
    const cx = this.x + side * r * Math.cos(this.h);
    const cz = this.z - side * r * Math.sin(this.h);
    const h0 = this.h;
    const n = Math.max(2, Math.ceil((Math.abs(delta) * r) / HQ_ARCHIVE.step - 1e-9));
    for (let i = 1; i <= n; i++) {
      const h = h0 + (delta * i) / n;
      this.h = h;
      this.x = cx - side * r * Math.cos(h);
      this.z = cz + side * r * Math.sin(h);
      this.push(reverse);
    }
    return this;
  }
}

type EdgeList = Array<[number, number, number, number]>;

function finishLane(t: LaneBuilder, noStopAt: (x: number, z: number, h: number) => boolean): HqArchiveLane {
  const n = t.xs.length;
  const lane: HqArchiveLane = {
    x: new Float32Array(t.xs),
    z: new Float32Array(t.zs),
    rotY: new Float32Array(t.hs),
    s: new Float32Array(n),
    noStop: new Uint8Array(n),
    reverse: new Uint8Array(t.rev),
    length: 0,
  };
  if (n > 1) lane.reverse[0] = lane.reverse[1];
  let s = 0;
  const along = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    s += Math.hypot(t.xs[i] - t.xs[i - 1], t.zs[i] - t.zs[i - 1]);
    along[i] = s;
  }
  lane.s.set(along);
  lane.length = round3(s);
  for (let i = 0; i < n; i++) lane.noStop[i] = noStopAt(t.xs[i], t.zs[i], t.hs[i]) ? 1 : 0;
  // Close short stoppable gaps between two no-stop stretches: a cart left
  // there would still stand in someone's way.
  let i = 0;
  while (i < n) {
    if (lane.noStop[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !lane.noStop[j]) j++;
    if (i > 0 && j < n && along[j] - along[i - 1] < HQ_ARCHIVE.noStopMinGap) lane.noStop.fill(1, i, j);
    i = j;
  }
  return lane;
}

export type HqArchiveStationInput = {
  nav: HqNavBuilder;
  bounds: HqRect;
  spawn: Vec2;
  /** x of the west walkway the spur branches off. */
  westAisleX: number;
  /** Adds a stop on the west walkway at z (so the spur's first node is on it). */
  addWestStop: (z: number) => void;
};

export type HqArchiveStationPlan = {
  /** Builds the lanes against the finished nav graph (their no-stop stretches depend on the walkways). */
  complete: (graph: HqNavGraph) => HqArchiveStation;
};

/**
 * Lays out the archive station and adds its nav spur (call before the nav
 * lines are finished); `complete` samples the lanes once the graph is built.
 */
export function buildArchiveStation(input: HqArchiveStationInput): HqArchiveStationPlan {
  const { nav, bounds, spawn, westAisleX } = input;
  const A = HQ_ARCHIVE;
  const C = HQ_ARCHIVE_CART;
  const sx = spawn.x;
  const z1 = bounds.z1;

  // The bay backs onto the curb, its mouth facing north into the hall; the
  // cart noses in (south), the handle toward the hall.
  const bayX = sx + A.bayU;
  const bay: HqPose = { x: round3(bayX), z: round3(z1 - A.bayBack - HQ_ARCHIVE_BAY.depth / 2), rotY: Math.PI };
  const cart: HqPose = { x: bay.x, z: round3(bay.z + A.cartInBay), rotY: 0 };
  const stand: HqPose = { x: bay.x, z: round3(cart.z - C.reach), rotY: 0 };
  const approach: Vec2 = { x: stand.x, z: round3(stand.z - A.approach) };

  // Spur: from the west walkway east to the approach point.
  input.addWestStop(approach.z);
  const spur: number[] = [];
  {
    const parts = Math.max(1, Math.ceil((approach.x - westAisleX) / 3 - 1e-6));
    for (let k = 0; k <= parts; k++) spur.push(nav.node(westAisleX + ((approach.x - westAisleX) * k) / parts, approach.z));
    nav.chain(spur);
  }
  const entryNode = spur[spur.length - 1];

  const chute: HqPose = { x: round3(sx + A.chute.u), z: round3(z1 + A.chute.v), rotY: Math.PI / 2 };
  const slot = toWorld(chute.x, chute.z, chute.rotY, 0, HQ_ARCHIVE_CHUTE.slot);
  const apron: HqRect = {
    x0: round3(sx - A.apron.halfWidth),
    z0: round3(z1),
    x1: round3(sx + A.apron.halfWidth),
    z1: round3(z1 + A.apron.depth),
  };
  const gateZ = round3(z1 + HQ_CURB_DEPTH / 2);
  const gate = { from: { x: round3(sx - HQ_ENTRANCE_HALF_WIDTH), z: gateZ }, to: { x: round3(sx + HQ_ENTRANCE_HALF_WIDTH), z: gateZ } };

  const complete = (graph: HqNavGraph): HqArchiveStation => {
    // Walkways near the station, without its own spur (only the hauler uses it).
    const pos = graph.positions;
    const e = graph.edges;
    const region = { x0: sx - 5, x1: bayX + 5, z0: z1 - 9, z1: z1 + 1 };
    const onSpur = (x: number, z: number) => Math.abs(z - approach.z) < 1e-3 && x >= westAisleX - 1e-3 && x <= approach.x + 1e-3;
    const walkways: EdgeList = [];
    for (let i = 0; i < e.length; i += 2) {
      const ax = pos[e[i] * 2];
      const az = pos[e[i] * 2 + 1];
      const bx = pos[e[i + 1] * 2];
      const bz = pos[e[i + 1] * 2 + 1];
      if (Math.max(ax, bx) < region.x0 || Math.min(ax, bx) > region.x1) continue;
      if (Math.max(az, bz) < region.z0 || Math.min(az, bz) > region.z1) continue;
      if (onSpur(ax, az) && onSpur(bx, bz)) continue;
      walkways.push([ax, az, bx, bz]);
    }
    const noStopAt = (x: number, z: number, h: number) => {
      const { cart: cartPoly, body } = archiveAssembly(x, z, h);
      for (const poly of [cartPoly, body]) {
        for (const p of poly) {
          if (p.z > z1 - A.noStopBand && Math.abs(p.x - sx) < A.doorHalf) return true;
        }
        for (const [ax, az, bx, bz] of walkways) {
          if (polySegmentDistance(poly, ax, az, bx, bz) < A.noStopEdge) return true;
        }
      }
      return false;
    };

    // Out: pull straight back out of the bay, swing the nose west while
    // still pulling, push west, turn south through the entrance to the handover.
    const out = new LaneBuilder(stand);
    out.straight(A.pullOut, true).arc(-Math.PI / 2, A.pullTurnR, true);
    out.straight(out.x - (sx + A.outX + A.outTurnR)).arc(Math.PI / 2, A.outTurnR);
    out.straight(z1 + A.handoverV - out.z);
    const handover: HqPose = { x: out.x, z: out.z, rotY: out.h };

    // Back: U-turn east on the apron, north into the hall, east along laneV,
    // south into the bay, nose first.
    const back = new LaneBuilder(handover);
    back.arc(Math.PI, A.uTurnR);
    back.straight(back.z - (z1 + A.laneV + A.laneTurnR)).arc(-Math.PI / 2, A.laneTurnR);
    back.straight(bayX - A.laneTurnR - back.x).arc(-Math.PI / 2, A.laneTurnR);
    back.straight(stand.z - back.z);
    // Land exactly on the stand.
    const last = back.xs.length - 1;
    back.xs[last] = stand.x;
    back.zs[last] = stand.z;
    back.hs[last] = stand.rotY;

    return {
      bay,
      cart,
      stand,
      approach,
      laneOut: finishLane(out, noStopAt),
      laneBack: finishLane(back, noStopAt),
      apron,
      chute: { ...chute, slot: { x: round3(slot.x), z: round3(slot.z) } },
      gate,
      entryNode,
      leaveNode: entryNode,
    };
  };

  return { complete };
}
