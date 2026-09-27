// Crowd simulation for the HQ: desk assignment, routing over the aisle graph
// and a small behaviour state machine per agent. Output is the struct-of-arrays
// `frame` the renderers read every frame.
//
// Lounge breaks: an idle agent heading for the lounge takes a free sofa or
// lounge chair seat when there is one (reserved, so never double-booked),
// sits there for a while looking at whoever else sits in the group, then
// stands up and walks back to its desk. With every seat taken it stands at
// the group's standing spot instead.
//
// Hot-path rules: update() allocates nothing (agents, waypoint buffers, the
// spatial hash and scratch arrays are sized in the constructor / setAgents),
// timers run on an internal clock advanced by the clamped dt, and every random
// choice comes from a seeded per-agent generator, so a run replays exactly.

import {
  HQ_AGENT_RADIUS,
  HQ_BLEND_TIME,
  HQ_CLIP_INFO,
  HQ_CLIPS,
  HQ_LEAD_AGENT_IDS,
  HQ_LEAD_AGENT_NAME,
  HQ_WALK_SPEED,
  HqClip,
  POD,
  WORKSTATION,
} from "./config";
import { HQ_LEAD_VIA, HQ_PROP_FOOTPRINT } from "./layout";
import { hqRoleFamily } from "./roles";
import { findPath, navNodeCount, nearestNode } from "./nav";
import { HqRng, hashString, mixSeed } from "./rng";
import {
  HQ_PLACE,
  HQ_STATUS_CODE,
  type HqAgentFrame,
  type HqAgentInput,
  type HqLayout,
  type HqRect,
  type HqSocialSpotKind,
} from "./types";

const MAX_DT = 0.1;
/** Waypoints per agent; longer routes are continued when the end is reached. */
const MAX_WP = 64;
const TAIL_MAX = 2;
/** Path queries per update, so a mass status flip is spread over frames. */
const ROUTES_PER_UPDATE = 24;
const HEAD_STANDING = 1.62;
const HEAD_SEATED = 1.22;
const TURN_RATE = 7;
const STAND_TURN_RATE = 3.5;
const SEPARATION_RADIUS = HQ_AGENT_RADIUS * 2.3;
const MAX_OFFSET = 0.4;
const HASH_CELL = 1;
const QUEUE_MAX = 16;
const QUEUE_SPACING = 0.9;
const MAX_SLOTS = 24;
const TWO_PI = Math.PI * 2;
/** Seconds on a lounge seat. */
const LOUNGE_SIT_MIN = 35;
const LOUNGE_SIT_MAX = 90;
/** Where a lone sitter looks: the coffee table's top. */
const TABLE_LOOK_Y = 0.45;
/** Facing error (rad) under which a walker at a lounge seat starts to sit. */
const SIT_ALIGN = 0.05;
/** A standing place keeps this far inside its room's glass and off every prop. */
const SLOT_CLEAR = 0.4;
/** ...and this far off every aisle but its spot's own spur: walker and stander just pass. */
const AISLE_CLEAR = HQ_AGENT_RADIUS * 2;

const WORKING = HQ_STATUS_CODE.working;
const IDLE = HQ_STATUS_CODE.idle;
const ERROR = HQ_STATUS_CODE.error;

const CLIP_DURATION = HQ_CLIPS.map((name) => HQ_CLIP_INFO[name].duration);
const CLIP_LOOP = HQ_CLIPS.map((name) => HQ_CLIP_INFO[name].loop);
const WALK_NATIVE_SPEED = HQ_CLIP_INFO.Walk.speed;
const SIT_DOWN_DURATION = HQ_CLIP_INFO.SitDown.duration;

// What an agent is doing.
const M_WALK = 0;
const M_SIT = 1; // SitDown forward
const M_SEATED = 2;
const M_RISE = 3; // SitDown in reverse
const M_STAND = 4;

// Where an agent is heading (dest) or standing (place).
const D_NONE = 0;
const D_SEAT = 1; // sit at a desk
const D_ERROR = 2; // stand beside the desk
const D_SPOT = 3; // a social spot slot
const D_VISIT = 4; // the lead standing by someone's desk
const D_LOUNGE = 5; // sit on a lounge seat

const SPOT_KINDS: HqSocialSpotKind[] = ["coffee", "map", "lounge", "meeting", "server", "cyberrange"];
const K_COFFEE = 0;
const K_MAP = 1;
const K_LOUNGE = 2;
const K_MEETING = 3;
const K_SERVER = 4;
const K_CYBER = 5;
// Seconds spent at each kind of spot (a cyber-range drill runs a while).
const STAY_MIN = [20, 15, 30, 30, 15, 35];
const STAY_MAX = [45, 35, 60, 90, 30, 80];

class Agent {
  readonly id: string;
  readonly rng: HqRng;
  readonly speed: number;
  name = "";
  /** hqRoleFamily of the agent's role: what its monitors show. */
  roleFamily = 0;
  status: number = IDLE;
  lead = false;
  seat = -1;
  /** Position in the frame (setAgents order). */
  index = 0;
  alive = true;

  mode = M_STAND;
  // Base point on the route, plus a small separation offset.
  bx = 0;
  bz = 0;
  ox = 0;
  oz = 0;
  x = 0;
  z = 0;
  facing = 0;
  dirX = 0;
  dirZ = 1;
  moving = false;

  readonly wpX = new Float32Array(MAX_WP);
  readonly wpZ = new Float32Array(MAX_WP);
  /** Graph node of the waypoint, -1 for off-graph points (desk, slot). */
  readonly wpNode = new Int32Array(MAX_WP);
  wpCount = 0;
  wpIdx = 0;
  wpMore = false;
  needsRoute = false;

  dest = D_NONE;
  destSeat = -1;
  destSpot = -1;
  destSlot = -1;
  place = D_NONE;
  placeSeat = -1;
  placeSpot = -1;
  placeSlot = -1;
  /** Reserved social spot slot (outing or overflow hangout). */
  spot = -1;
  slot = -1;
  /** Reserved lounge seat (seat-array index), and the one it is sitting on. */
  lounge = -1;
  held = -1;

  clip: number = HqClip.Idle;
  clipTime = 0;
  clipRate = 1;
  prevClip: number = HqClip.Idle;
  prevTime = 0;
  prevRate = 1;
  blend = 1;

  lookX = 0;
  lookY = HEAD_STANDING;
  lookZ = 0;
  lookW = 0;
  wantX = 0;
  wantY = HEAD_STANDING;
  wantZ = 0;
  wantW = 0;

  nextOuting = 0;
  leaveAt = 0;
  talking = false;
  talkToggleAt = 0;
  visitTarget: Agent | null = null;
  visitor: Agent | null = null;

  constructor(id: string, seed: number) {
    this.id = id;
    this.rng = new HqRng(mixSeed(seed, hashString(id)));
    this.speed = HQ_WALK_SPEED * this.rng.range(0.93, 1.07);
    this.clipTime = this.rng.range(0, 3);
  }
}

function wrapAngle(a: number): number {
  a %= TWO_PI;
  if (a > Math.PI) a -= TWO_PI;
  else if (a < -Math.PI) a += TWO_PI;
  return a;
}

function turnToward(current: number, target: number, maxStep: number): number {
  const d = wrapAngle(target - current);
  if (Math.abs(d) <= maxStep) return wrapAngle(target);
  return wrapAngle(current + Math.sign(d) * maxStep);
}

function wrapClip(clip: number, t: number): number {
  const dur = CLIP_DURATION[clip];
  if (CLIP_LOOP[clip]) {
    if (t >= dur || t < 0) t -= dur * Math.floor(t / dur);
    return t;
  }
  return t < 0 ? 0 : t > dur ? dur : t;
}

function leadIdRank(id: string): number {
  const lower = id.trim().toLowerCase();
  return (HQ_LEAD_AGENT_IDS as readonly string[]).indexOf(lower);
}

export type HqSimulationOptions = {
  seed?: number;
  /** Persisted desk assignments (agent id -> desk index). */
  assignments?: Record<string, number>;
};

export class HqSimulation {
  readonly layout: HqLayout;
  readonly frame: HqAgentFrame;
  /** Per layout.desks index: -1 empty, else HQ_STATUS_CODE of the assigned agent. */
  readonly deskStatus: Int8Array;
  /** Role family (core/roles.ts) of the agent at each desk, 0 when empty. */
  readonly deskRole: Uint8Array;
  onAssignmentsChange?: (assignments: Record<string, number>) => void;

  private readonly seed: number;
  private time = 0;
  private agents: Agent[] = [];
  private byId = new Map<string, Agent>();
  private assignments = new Map<string, number>();
  private warmStarted = false;
  private leadStatus = -1;

  // Seats: layout.desks, then the lead desk at index `leadSeat`, then the
  // lounge seats from `loungeBase` on.
  private readonly leadSeat: number;
  private readonly loungeBase: number;
  private readonly seatX: Float32Array;
  private readonly seatZ: Float32Array;
  private readonly seatRot: Float32Array;
  private readonly apprX: Float32Array;
  private readonly apprZ: Float32Array;
  private readonly viaX: Float32Array;
  private readonly viaZ: Float32Array;
  private readonly visitX: Float32Array;
  private readonly visitZ: Float32Array;
  private readonly monX: Float32Array;
  private readonly monZ: Float32Array;
  private readonly kbX: Float32Array;
  private readonly kbZ: Float32Array;
  private readonly headX: Float32Array;
  private readonly headZ: Float32Array;
  private readonly errFacing: Float32Array;
  private readonly seatNode: Int32Array;

  // Lounge seats (index k = seat - loungeBase): group, reservation, sitter.
  private readonly loungeGroup: Int32Array;
  /** First lounge seat of each group, plus the total at the end. */
  private readonly groupStart: Int32Array;
  private readonly loungeReserved: Array<Agent | null>;
  private readonly loungeHeld: Array<Agent | null>;

  // Social spots.
  private readonly spotKind: Uint8Array;
  private readonly spotNode: Int32Array;
  private readonly spotAgents: Array<Agent | null>;
  /** Per spot slot: 1 where someone can stand (in the spot's room, off props and aisles). */
  private readonly slotOk: Uint8Array;

  // Routing scratch.
  private readonly spawnNode: number;
  private readonly pathBuf: Int32Array;
  private readonly scrX = new Float32Array(MAX_WP);
  private readonly scrZ = new Float32Array(MAX_WP);
  private readonly scrN = new Int32Array(MAX_WP);
  private tmpX = 0;
  private tmpZ = 0;

  // Spatial hash (dense integer cell keys over the hall plus the entrance queue).
  private readonly hx0: number;
  private readonly hz0: number;
  private readonly hcols: number;
  private readonly hrows: number;
  private readonly hashStart: Int32Array;
  private readonly hashFill: Int32Array;
  private hashItems = new Int32Array(0);
  private agentCell = new Int32Array(0);

  private readonly focus = { x: 0, y: 0, z: 0 };

  constructor(layout: HqLayout, opts: HqSimulationOptions = {}) {
    this.layout = layout;
    this.seed = (opts.seed ?? 0x5eed) >>> 0;
    const desks = layout.desks;
    const seats = [...desks, layout.leadDesk];
    const loungeSeats = layout.loungeSeats ?? [];
    const n = seats.length + loungeSeats.length;
    this.leadSeat = desks.length;
    this.loungeBase = seats.length;
    this.seatX = new Float32Array(n);
    this.seatZ = new Float32Array(n);
    this.seatRot = new Float32Array(n);
    this.apprX = new Float32Array(n);
    this.apprZ = new Float32Array(n);
    this.viaX = new Float32Array(n);
    this.viaZ = new Float32Array(n);
    this.visitX = new Float32Array(n);
    this.visitZ = new Float32Array(n);
    this.monX = new Float32Array(n);
    this.monZ = new Float32Array(n);
    this.kbX = new Float32Array(n);
    this.kbZ = new Float32Array(n);
    this.headX = new Float32Array(n);
    this.headZ = new Float32Array(n);
    this.errFacing = new Float32Array(n);
    this.seatNode = new Int32Array(n);
    this.deskStatus = new Int8Array(desks.length).fill(-1);
    this.deskRole = new Uint8Array(desks.length);

    // Neighbour lookup so each desk is entered from its free side, not
    // through the chair of the desk next to it.
    const bucket = new Map<number, number[]>();
    const key = (x: number, z: number) => Math.round(x * 2) * 100003 + Math.round(z * 2);
    seats.forEach((s, i) => {
      const k = key(s.x, s.z);
      const list = bucket.get(k);
      if (list) list.push(i);
      else bucket.set(k, [i]);
    });
    const occupied = (x: number, z: number, self: number) => {
      const cx = Math.round(x * 2);
      const cz = Math.round(z * 2);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = bucket.get((cx + dx) * 100003 + (cz + dz));
          if (!list) continue;
          for (const j of list) {
            if (j !== self && Math.hypot(seats[j].x - x, seats[j].z - z) < 0.6) return true;
          }
        }
      }
      return false;
    };
    const local = (s: { x: number; z: number; rotY: number }, lx: number, lz: number) => {
      const c = Math.cos(s.rotY);
      const sn = Math.sin(s.rotY);
      this.tmpX = s.x + lx * c + lz * sn;
      this.tmpZ = s.z - lx * sn + lz * c;
    };
    const pos = layout.nav.positions;
    const centre = WORKSTATION.monitors[1];
    seats.forEach((s, i) => {
      this.seatX[i] = s.x;
      this.seatZ[i] = s.z;
      this.seatRot[i] = s.rotY;
      this.apprX[i] = s.approach.x;
      this.apprZ[i] = s.approach.z;
      this.seatNode[i] = s.navNode;
      local(s, POD.deskPitchX, 0);
      const plusBlocked = occupied(this.tmpX, this.tmpZ, i);
      local(s, -POD.deskPitchX, 0);
      const minusBlocked = occupied(this.tmpX, this.tmpZ, i);
      let side = 1;
      if (plusBlocked && !minusBlocked) side = -1;
      else if (!plusBlocked && !minusBlocked && s.navNode >= 0) {
        local(s, 1, 0);
        const dPlus = Math.hypot(this.tmpX - pos[s.navNode * 2], this.tmpZ - pos[s.navNode * 2 + 1]);
        local(s, -1, 0);
        const dMinus = Math.hypot(this.tmpX - pos[s.navNode * 2], this.tmpZ - pos[s.navNode * 2 + 1]);
        side = dMinus < dPlus ? -1 : 1;
      }
      // AM7's arc desk wraps round the chair's sides: step in from behind the
      // chair, on the side of its nav node (west), instead of beside it.
      if (i === this.leadSeat) local(s, HQ_LEAD_VIA.x, HQ_LEAD_VIA.z);
      else local(s, side * 0.85, 0);
      this.viaX[i] = this.tmpX;
      this.viaZ[i] = this.tmpZ;
      local(s, side * 1.15, -0.25);
      this.visitX[i] = this.tmpX;
      this.visitZ[i] = this.tmpZ;
      local(s, centre.x, centre.z);
      this.monX[i] = this.tmpX;
      this.monZ[i] = this.tmpZ;
      local(s, WORKSTATION.keyboard.x, WORKSTATION.keyboard.z);
      this.kbX[i] = this.tmpX;
      this.kbZ[i] = this.tmpZ;
      local(s, 0, 0.1);
      this.headX[i] = this.tmpX;
      this.headZ[i] = this.tmpZ;
      this.errFacing[i] = Math.atan2(this.kbX[i] - this.viaX[i], this.kbZ[i] - this.viaZ[i]);
    });

    // Lounge seats: entered straight from the aisle node in front, looking at
    // the group's coffee table ("monitor") when nobody else is sitting there.
    const groups = layout.loungeGroups ?? [];
    this.loungeGroup = new Int32Array(loungeSeats.length);
    this.groupStart = new Int32Array(groups.length + 1).fill(loungeSeats.length);
    this.loungeReserved = new Array<Agent | null>(loungeSeats.length).fill(null);
    this.loungeHeld = new Array<Agent | null>(loungeSeats.length).fill(null);
    loungeSeats.forEach((s, k) => {
      const i = this.loungeBase + k;
      const g = Math.max(0, Math.min(groups.length - 1, s.group));
      const table = groups[g] ?? { tableX: s.x, tableZ: s.z };
      this.loungeGroup[k] = g;
      if (k < this.groupStart[g]) this.groupStart[g] = k;
      this.seatX[i] = s.x;
      this.seatZ[i] = s.z;
      this.seatRot[i] = s.rotY;
      this.apprX[i] = s.approach.x;
      this.apprZ[i] = s.approach.z;
      this.seatNode[i] = s.navNode;
      this.viaX[i] = s.approach.x;
      this.viaZ[i] = s.approach.z;
      this.visitX[i] = s.approach.x;
      this.visitZ[i] = s.approach.z;
      this.monX[i] = this.kbX[i] = table.tableX;
      this.monZ[i] = this.kbZ[i] = table.tableZ;
      local(s, 0, 0.1);
      this.headX[i] = this.tmpX;
      this.headZ[i] = this.tmpZ;
      this.errFacing[i] = s.rotY;
    });
    // Seats are listed group by group; an empty group starts where the next does.
    for (let g = groups.length - 1; g >= 0; g--) {
      this.groupStart[g] = Math.min(this.groupStart[g], this.groupStart[g + 1]);
    }

    const spots = layout.socialSpots;
    this.spotKind = new Uint8Array(spots.length);
    this.spotNode = new Int32Array(spots.length);
    spots.forEach((s, i) => {
      this.spotKind[i] = Math.max(0, SPOT_KINDS.indexOf(s.kind));
      this.spotNode[i] = s.navNode;
    });
    this.spotAgents = new Array<Agent | null>(spots.length * MAX_SLOTS).fill(null);
    this.slotOk = new Uint8Array(spots.length * MAX_SLOTS);
    this.markStandingSlots();

    this.spawnNode = nearestNode(layout.nav, layout.spawn.x, layout.spawn.z);
    this.pathBuf = new Int32Array(Math.max(1, navNodeCount(layout.nav)));

    const b = layout.bounds;
    this.hx0 = b.x0 - 2;
    this.hz0 = b.z0 - 2;
    this.hcols = Math.max(1, Math.ceil((b.x1 - b.x0 + 4) / HASH_CELL));
    this.hrows = Math.max(1, Math.ceil((b.z1 - b.z0 + 6 + QUEUE_MAX * QUEUE_SPACING) / HASH_CELL));
    this.hashStart = new Int32Array(this.hcols * this.hrows + 1);
    this.hashFill = new Int32Array(this.hcols * this.hrows);

    if (opts.assignments) {
      for (const [id, desk] of Object.entries(opts.assignments)) {
        if (Number.isInteger(desk) && desk >= 0 && desk < desks.length) this.assignments.set(id, desk);
      }
    }

    this.frame = {
      count: 0,
      ids: [],
      x: new Float32Array(0),
      y: new Float32Array(0),
      z: new Float32Array(0),
      facing: new Float32Array(0),
      clip: new Uint8Array(0),
      clipTime: new Float32Array(0),
      prevClip: new Uint8Array(0),
      prevClipTime: new Float32Array(0),
      blend: new Float32Array(0),
      lookX: new Float32Array(0),
      lookY: new Float32Array(0),
      lookZ: new Float32Array(0),
      lookWeight: new Float32Array(0),
      status: new Uint8Array(0),
      lead: new Uint8Array(0),
      place: new Uint8Array(0),
    };
  }

  /** HQ_STATUS_CODE of the lead agent, or -1 when there is none. */
  get leadDeskStatus(): number {
    return this.leadStatus;
  }

  indexOf(id: string): number {
    const agent = this.byId.get(id);
    return agent ? agent.index : -1;
  }

  getAssignments(): Record<string, number> {
    return Object.fromEntries(this.assignments);
  }

  /**
   * Head position of an agent (for camera follow). The returned object is
   * reused by the next call; copy it if you keep it.
   */
  focusPoint(id: string): { x: number; y: number; z: number } | null {
    const agent = this.byId.get(id);
    if (!agent) return null;
    const seated = agent.mode === M_SEATED || agent.mode === M_SIT || agent.mode === M_RISE;
    if (seated && agent.placeSeat >= 0) {
      this.focus.x = this.headX[agent.placeSeat];
      this.focus.z = this.headZ[agent.placeSeat];
      this.focus.y = HEAD_SEATED;
    } else {
      this.focus.x = agent.x;
      this.focus.z = agent.z;
      this.focus.y = HEAD_STANDING;
    }
    return this.focus;
  }

  /** Nearest agent within `radius` of (x, z) on the floor, or -1. */
  pick(x: number, z: number, radius = 0.6): number {
    const r2 = radius * radius;
    const c0 = this.cellX(x - radius);
    const c1 = this.cellX(x + radius);
    const r0 = this.cellZ(z - radius);
    const r1 = this.cellZ(z + radius);
    let best = -1;
    let bestD = r2;
    for (let gz = r0; gz <= r1; gz++) {
      for (let gx = c0; gx <= c1; gx++) {
        const cell = gz * this.hcols + gx;
        for (let k = this.hashStart[cell], end = this.hashStart[cell + 1]; k < end; k++) {
          const i = this.hashItems[k];
          const a = this.agents[i];
          const dx = a.x - x;
          const dz = a.z - z;
          const d = dx * dx + dz * dz;
          if (d <= bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    return best;
  }

  setAgents(inputs: HqAgentInput[]): void {
    const next: Agent[] = [];
    const nextById = new Map<string, Agent>();
    const fresh = new Set<Agent>();
    // Lead: an id from HQ_LEAD_AGENT_IDS (in its order) wins over a name match.
    let lead: Agent | null = null;
    let leadScore = Infinity;
    for (const input of inputs) {
      if (!input || typeof input.id !== "string" || nextById.has(input.id)) continue;
      let agent = this.byId.get(input.id);
      if (!agent) {
        agent = new Agent(input.id, this.seed);
        fresh.add(agent);
      }
      const status = HQ_STATUS_CODE[input.status] ?? IDLE;
      if (status === IDLE && agent.status !== IDLE) {
        agent.nextOuting = this.time + agent.rng.range(30, 200);
      }
      agent.status = status;
      agent.name = typeof input.name === "string" ? input.name : "";
      agent.roleFamily = hqRoleFamily(input.role);
      const rank = leadIdRank(input.id);
      if (rank >= 0 || agent.name.trim().toLowerCase() === HQ_LEAD_AGENT_NAME.toLowerCase()) {
        const score = rank >= 0 ? rank : HQ_LEAD_AGENT_IDS.length + next.length;
        if (score < leadScore) {
          leadScore = score;
          lead = agent;
        }
      }
      agent.index = next.length;
      nextById.set(input.id, agent);
      next.push(agent);
    }
    // Agents that left: drop their links, keep their desk reservation.
    for (const agent of this.agents) {
      if (nextById.get(agent.id) === agent) continue;
      agent.alive = false;
      this.releaseSpot(agent);
      this.releaseLounge(agent);
      this.releaseHold(agent);
      this.endVisit(agent);
      if (agent.visitor) agent.visitor = null;
    }

    for (const agent of next) {
      const wasLead = agent.lead;
      agent.lead = agent === lead;
      if (wasLead && !agent.lead) this.endVisit(agent);
    }

    this.assignDesks(next, nextById);

    this.agents = next;
    this.byId = nextById;
    this.resizeBuffers(next.length);

    const warm = !this.warmStarted && next.length > 0;
    if (warm) this.warmStarted = true;
    let queued = 0;
    for (const agent of this.agents) {
      if (agent.mode === M_WALK && agent.bz > this.layout.bounds.z1) queued++;
    }
    for (const agent of this.agents) {
      if (!fresh.has(agent)) continue;
      if (warm || queued >= QUEUE_MAX) this.placeAtRest(agent);
      else this.enterFromSpawn(agent, queued++);
    }
    this.writeFrame(0);
    this.updateDeskStatus();
    this.rebuildHash();
  }

  update(dt: number, _now?: number): void {
    // `now` is accepted for the renderer's convenience; timers run on an
    // internal clock of clamped steps so a background tab does not fire them
    // all at once.
    const step = dt > 0 ? (dt < MAX_DT ? dt : MAX_DT) : 0;
    this.time += step;
    let routes = ROUTES_PER_UPDATE;
    const agents = this.agents;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      this.think(a);
      this.plan(a);
      if (a.needsRoute && routes > 0 && a.mode !== M_SEATED && a.mode !== M_SIT) {
        routes--;
        this.computeRoute(a);
      }
      this.act(a, i, step);
    }
    this.writeFrame(step);
    this.updateDeskStatus();
    this.rebuildHash();
  }

  // --- Assignment -----------------------------------------------------------

  private assignDesks(next: Agent[], nextById: Map<string, Agent>): void {
    const deskCount = this.layout.desks.length;
    const before = this.getAssignments();
    const taken = new Uint8Array(deskCount);
    const reservedByAbsent = new Uint8Array(deskCount);
    for (const [id, desk] of this.assignments) {
      if (!nextById.has(id)) reservedByAbsent[desk] = 1;
    }
    const pending: Agent[] = [];
    for (const agent of next) {
      if (agent.lead) {
        agent.seat = this.leadSeat;
        this.assignments.delete(agent.id);
        continue;
      }
      let want = agent.seat >= 0 && agent.seat < deskCount ? agent.seat : -1;
      if (want < 0) want = this.assignments.get(agent.id) ?? -1;
      if (want >= 0 && !taken[want]) {
        taken[want] = 1;
        agent.seat = want;
      } else {
        agent.seat = -1;
        pending.push(agent);
      }
    }
    let cursorFree = 0;
    let cursorAny = 0;
    for (const agent of pending) {
      while (cursorFree < deskCount && (taken[cursorFree] || reservedByAbsent[cursorFree])) cursorFree++;
      let desk = -1;
      if (cursorFree < deskCount) desk = cursorFree;
      else {
        while (cursorAny < deskCount && taken[cursorAny]) cursorAny++;
        if (cursorAny < deskCount) desk = cursorAny;
      }
      if (desk >= 0) {
        taken[desk] = 1;
        agent.seat = desk;
      }
    }
    // Rewrite the map: present agents own their desk, absent reservations stay
    // unless a present agent now sits there.
    for (const [id, desk] of [...this.assignments]) {
      if (!nextById.has(id) && taken[desk]) this.assignments.delete(id);
    }
    for (const agent of next) {
      if (agent.lead) continue;
      if (agent.seat >= 0) this.assignments.set(agent.id, agent.seat);
      else this.assignments.delete(agent.id);
    }
    const after = this.getAssignments();
    const changed =
      Object.keys(before).length !== Object.keys(after).length ||
      Object.keys(after).some((id) => before[id] !== after[id]);
    if (changed) this.onAssignmentsChange?.(after);
  }

  private resizeBuffers(n: number): void {
    const f = this.frame;
    f.count = n;
    f.ids = this.agents.map((a) => a.id);
    if (f.x.length !== n) {
      f.x = new Float32Array(n);
      f.y = new Float32Array(n);
      f.z = new Float32Array(n);
      f.facing = new Float32Array(n);
      f.clip = new Uint8Array(n);
      f.clipTime = new Float32Array(n);
      f.prevClip = new Uint8Array(n);
      f.prevClipTime = new Float32Array(n);
      f.blend = new Float32Array(n);
      f.lookX = new Float32Array(n);
      f.lookY = new Float32Array(n);
      f.lookZ = new Float32Array(n);
      f.lookWeight = new Float32Array(n);
      f.status = new Uint8Array(n);
      f.lead = new Uint8Array(n);
      f.place = new Uint8Array(n);
    }
    if (this.hashItems.length < n) {
      this.hashItems = new Int32Array(n);
      this.agentCell = new Int32Array(n);
    }
  }

  // --- Spawning -------------------------------------------------------------

  /** Puts an agent straight into its resting pose (first load). */
  private placeAtRest(a: Agent): void {
    this.think(a);
    const kind = this.intentKind(a);
    a.nextOuting = this.time + a.rng.range(15, 240);
    a.ox = a.oz = 0;
    a.wpCount = a.wpIdx = 0;
    a.needsRoute = false;
    if (kind === D_SEAT || kind === D_ERROR) {
      const s = a.seat;
      a.placeSeat = s;
      if (kind === D_SEAT) {
        a.bx = this.seatX[s];
        a.bz = this.seatZ[s];
        a.facing = this.seatRot[s];
        a.mode = M_SEATED;
        a.place = D_SEAT;
        a.clip = a.status === WORKING ? HqClip.SitType : HqClip.SitIdle;
      } else {
        a.bx = this.viaX[s];
        a.bz = this.viaZ[s];
        a.facing = this.errFacing[s];
        a.mode = M_STAND;
        a.place = D_ERROR;
        a.clip = HqClip.Idle;
      }
      a.dest = kind;
      a.destSeat = s;
    } else if (kind === D_SPOT) {
      this.slotPosition(a.spot, a.slot);
      a.bx = this.tmpX;
      a.bz = this.tmpZ;
      a.facing = this.layout.socialSpots[a.spot].rotY;
      a.mode = M_STAND;
      a.place = D_SPOT;
      a.placeSpot = a.spot;
      a.placeSlot = a.slot;
      a.dest = D_SPOT;
      a.destSpot = a.spot;
      a.destSlot = a.slot;
      a.leaveAt = this.time + a.rng.range(10, 90);
      a.clip = HqClip.Idle;
    } else {
      a.bx = this.layout.spawn.x;
      a.bz = this.layout.spawn.z;
      a.mode = M_STAND;
      a.clip = HqClip.Idle;
    }
    a.clipTime = a.rng.range(0, CLIP_DURATION[a.clip]);
    a.clipRate = 1;
    a.prevClip = a.clip;
    a.prevTime = a.clipTime;
    a.blend = 1;
    this.syncPosition(a);
    this.initLook(a);
  }

  /** New agents line up outside the entrance and walk in one after another. */
  private enterFromSpawn(a: Agent, queueIndex: number): void {
    const spawn = this.layout.spawn;
    a.bx = spawn.x;
    a.bz = this.layout.bounds.z1 + 0.8 + queueIndex * QUEUE_SPACING;
    a.facing = Math.PI;
    a.mode = M_WALK;
    a.place = D_NONE;
    a.wpX[0] = spawn.x;
    a.wpZ[0] = spawn.z;
    a.wpNode[0] = this.spawnNode;
    a.wpCount = 1;
    a.wpIdx = 0;
    a.dest = D_NONE;
    a.nextOuting = this.time + a.rng.range(60, 240);
    a.clip = a.prevClip = HqClip.Walk;
    a.clipRate = a.prevRate = 0;
    a.blend = 1;
    this.syncPosition(a);
    this.initLook(a);
  }

  private initLook(a: Agent): void {
    this.desiredLook(a);
    a.lookX = a.wantX;
    a.lookY = a.wantY;
    a.lookZ = a.wantZ;
    a.lookW = a.wantW;
  }

  // --- Decisions ------------------------------------------------------------

  /** Timers and reservations: outings, visits, overflow wandering. */
  private think(a: Agent): void {
    const now = this.time;
    // Lounge seats are for desk agents' breaks (lead and deskless agents stand).
    if (a.lounge >= 0 && (a.lead || a.seat < 0)) this.releaseLounge(a);
    if (a.lead) {
      if (a.status === ERROR) {
        this.releaseSpot(a);
        this.endVisit(a);
        return;
      }
      const t = a.visitTarget;
      if (t) {
        const valid =
          t.alive && t.seat >= 0 && t.status === WORKING && t.place === D_SEAT && (t.mode === M_SEATED || t.mode === M_SIT);
        const done = a.place === D_VISIT && a.mode === M_STAND && now >= a.leaveAt;
        if (!valid || done) {
          this.endVisit(a);
          a.nextOuting = now + a.rng.range(60, 150);
        }
      } else if (a.spot >= 0) {
        if (a.place === D_SPOT && a.mode === M_STAND && now >= a.leaveAt) {
          this.releaseSpot(a);
          a.nextOuting = now + a.rng.range(60, 150);
        }
      } else if (a.mode === M_SEATED && now >= a.nextOuting) {
        if (!(a.rng.chance(0.6) && this.startVisit(a)) && !this.reserveOuting(a, K_MAP)) {
          a.nextOuting = now + a.rng.range(20, 40);
        }
      }
      return;
    }
    if (a.seat >= 0) {
      if (a.spot >= 0) {
        if (a.status !== IDLE) this.releaseSpot(a);
        else if (a.place === D_SPOT && a.mode === M_STAND && now >= a.leaveAt) {
          this.releaseSpot(a);
          a.nextOuting = now + a.rng.range(90, 300);
        }
      } else if (a.lounge >= 0) {
        // The seat stays held until the agent has stood up (releaseHold).
        if (a.status !== IDLE) this.releaseLounge(a);
        else if (a.place === D_LOUNGE && a.mode === M_SEATED && now >= a.leaveAt) {
          this.releaseLounge(a);
          a.nextOuting = now + a.rng.range(90, 300);
        }
      } else if (a.status === IDLE && a.mode === M_SEATED && a.place === D_SEAT && now >= a.nextOuting) {
        if (!this.reserveOuting(a, -1)) a.nextOuting = now + a.rng.range(20, 60);
      }
      return;
    }
    // No desk (more agents than desks): hang out in the lounge, drift between spots.
    if (a.spot < 0) {
      if (now >= a.nextOuting) {
        this.reserveOverflow(a);
        if (a.spot < 0) a.nextOuting = now + a.rng.range(3, 8);
      }
    } else if (a.place === D_SPOT && a.mode === M_STAND && now >= a.leaveAt) {
      const spot = a.spot;
      const slot = a.slot;
      this.releaseSpot(a);
      this.reserveOverflow(a);
      if (a.spot === spot && a.slot === slot) a.leaveAt = now + a.rng.range(40, 120);
    }
  }

  private intentKind(a: Agent): number {
    if (a.seat >= 0) {
      if (a.status === ERROR) return D_ERROR;
      if (a.visitTarget) return D_VISIT;
      if (a.spot >= 0) return D_SPOT;
      if (a.lounge >= 0) return D_LOUNGE;
      return D_SEAT;
    }
    return a.spot >= 0 ? D_SPOT : D_NONE;
  }

  /** Compares what the agent should be doing with its destination. */
  private plan(a: Agent): void {
    const kind = this.intentKind(a);
    let seat = -1;
    let spot = -1;
    let slot = -1;
    if (kind === D_SEAT || kind === D_ERROR) seat = a.seat;
    else if (kind === D_LOUNGE) seat = a.lounge;
    else if (kind === D_VISIT) seat = a.visitTarget ? a.visitTarget.seat : -1;
    else if (kind === D_SPOT) {
      spot = a.spot;
      slot = a.slot;
    }
    if (kind === a.dest && seat === a.destSeat && spot === a.destSpot && slot === a.destSlot) return;
    a.dest = kind;
    a.destSeat = seat;
    a.destSpot = spot;
    a.destSlot = slot;
    switch (a.mode) {
      case M_SEATED:
        a.mode = M_RISE;
        this.setClip(a, HqClip.SitDown, SIT_DOWN_DURATION, -1);
        a.wpCount = a.wpIdx = 0;
        a.needsRoute = true;
        break;
      case M_SIT:
        a.mode = M_RISE;
        a.clipRate = -1;
        a.wpCount = a.wpIdx = 0;
        a.needsRoute = true;
        break;
      case M_RISE:
        if ((kind === D_SEAT || kind === D_LOUNGE) && kind === a.place && seat === a.placeSeat) {
          a.mode = M_SIT;
          a.clipRate = 1;
          a.wpCount = a.wpIdx = 0;
          a.needsRoute = false;
        } else {
          a.needsRoute = true;
        }
        break;
      default:
        if (kind === D_NONE) {
          a.needsRoute = false;
          a.wpMore = false;
          if (a.mode === M_WALK) a.wpCount = a.wpIdx;
        } else {
          a.needsRoute = true;
        }
    }
  }

  private startVisit(a: Agent): boolean {
    const n = this.agents.length;
    if (n < 2) return false;
    for (let k = 0; k < 16; k++) {
      const t = this.agents[a.rng.int(n)];
      if (t === a || t.lead || t.seat < 0 || t.status !== WORKING || t.mode !== M_SEATED || t.visitor) continue;
      if (t.place !== D_SEAT) continue;
      a.visitTarget = t;
      t.visitor = a;
      return true;
    }
    return false;
  }

  private endVisit(a: Agent): void {
    const t = a.visitTarget;
    if (!t) return;
    if (t.visitor === a) t.visitor = null;
    a.visitTarget = null;
  }

  // --- Lounge seats ---------------------------------------------------------

  private releaseLounge(a: Agent): void {
    if (a.lounge >= 0) {
      const k = a.lounge - this.loungeBase;
      if (this.loungeReserved[k] === a) this.loungeReserved[k] = null;
    }
    a.lounge = -1;
  }

  private releaseHold(a: Agent): void {
    if (a.held >= 0) {
      const k = a.held - this.loungeBase;
      if (this.loungeHeld[k] === a) this.loungeHeld[k] = null;
    }
    a.held = -1;
  }

  /**
   * Reserves a free lounge seat, preferring groups where someone already sits
   * or is on the way (so people end up talking). A seat is free only when
   * nobody has it reserved and nobody is still sitting on or rising from it.
   */
  private reserveLoungeSeat(a: Agent): boolean {
    const count = this.loungeReserved.length;
    let best = -1;
    let bestScore = -Infinity;
    for (let k = 0; k < count; k++) {
      if (this.loungeReserved[k] || this.loungeHeld[k]) continue;
      const g = this.loungeGroup[k];
      let company = 0;
      for (let j = this.groupStart[g], end = this.groupStart[g + 1]; j < end; j++) {
        if (this.loungeReserved[j] || this.loungeHeld[j]) company++;
      }
      const score = (company > 0 ? 1 : 0) + a.rng.next();
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
    if (best < 0) return false;
    this.loungeReserved[best] = a;
    a.lounge = this.loungeBase + best;
    return true;
  }

  /** Head target of someone on a lounge seat: the nearest other sitter in the group, else the table. */
  private loungeLook(a: Agent, seat: number): void {
    const k = seat - this.loungeBase;
    const g = this.loungeGroup[k];
    let best = -1;
    let bestD = Infinity;
    if (a.mode === M_SEATED) {
      for (let j = this.groupStart[g], end = this.groupStart[g + 1]; j < end; j++) {
        const b = this.loungeHeld[j];
        if (j === k || !b || b.mode !== M_SEATED) continue;
        const other = this.loungeBase + j;
        const dx = this.seatX[other] - this.seatX[seat];
        const dz = this.seatZ[other] - this.seatZ[seat];
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = other;
        }
      }
    }
    if (best >= 0) {
      a.wantX = this.headX[best];
      a.wantY = HEAD_SEATED;
      a.wantZ = this.headZ[best];
      a.wantW = 0.85;
    } else {
      a.wantX = this.monX[seat];
      a.wantY = TABLE_LOOK_Y;
      a.wantZ = this.monZ[seat];
      a.wantW = a.mode === M_SEATED ? 0.4 : 0.15;
    }
  }

  // --- Social spots ----------------------------------------------------------

  private releaseSpot(a: Agent): void {
    if (a.spot >= 0) {
      const idx = a.spot * MAX_SLOTS + a.slot;
      if (this.spotAgents[idx] === a) this.spotAgents[idx] = null;
    }
    a.spot = -1;
    a.slot = -1;
  }

  /**
   * Marks where someone can stand at each spot: inside the hall and inside
   * the spot's own room (a spot in the open keeps out of every room), clear
   * of the props, and clear of every aisle but the spot's own spur, so nobody
   * stands where others walk. Overflow rings reach past the furniture and the
   * glass; freeSlot skips their bad places. Runs once, in the constructor.
   */
  private markStandingSlots(): void {
    const layout = this.layout;
    const spots = layout.socialSpots;
    const rooms: HqRect[] = [...layout.meetingRooms, layout.cyberRange, layout.lounge, layout.serverRoom, layout.am7Office];
    const inside = (r: HqRect, x: number, z: number, margin: number) =>
      x >= r.x0 + margin && x <= r.x1 - margin && z >= r.z0 + margin && z <= r.z1 - margin;
    const props = layout.props;
    const pos = layout.nav.positions;
    const edges = layout.nav.edges;
    for (let i = 0; i < spots.length; i++) {
      const spot = spots[i];
      let home: HqRect | null = null;
      for (const r of rooms) {
        if (inside(r, spot.x, spot.z, 0)) {
          home = r;
          break;
        }
      }
      for (let slot = 0; slot < MAX_SLOTS; slot++) {
        this.slotPosition(i, slot);
        const x = this.tmpX;
        const z = this.tmpZ;
        let ok = inside(layout.bounds, x, z, SLOT_CLEAR);
        if (ok && home) ok = inside(home, x, z, SLOT_CLEAR);
        else if (ok) for (const r of rooms) if (inside(r, x, z, -SLOT_CLEAR)) ok = false;
        for (let p = 0; ok && p < props.length; p++) {
          const prop = props[p];
          const size = HQ_PROP_FOOTPRINT[prop.kind];
          const dx = x - prop.x;
          const dz = z - prop.z;
          if (!size || size[0] <= 0 || Math.abs(dx) > 3 || Math.abs(dz) > 3) continue;
          const c = Math.cos(prop.rotY);
          const s = Math.sin(prop.rotY);
          const ex = Math.max(0, Math.abs(dx * c - dz * s) - size[0] / 2);
          const ez = Math.max(0, Math.abs(dx * s + dz * c) - size[1] / 2);
          if (ex * ex + ez * ez < SLOT_CLEAR * SLOT_CLEAR) ok = false;
        }
        for (let e = 0; ok && e < edges.length; e += 2) {
          const a = edges[e];
          const b = edges[e + 1];
          if (a === spot.navNode || b === spot.navNode) continue;
          const ax = pos[a * 2];
          const az = pos[a * 2 + 1];
          const bx = pos[b * 2];
          const bz = pos[b * 2 + 1];
          if (x < Math.min(ax, bx) - AISLE_CLEAR || x > Math.max(ax, bx) + AISLE_CLEAR) continue;
          if (z < Math.min(az, bz) - AISLE_CLEAR || z > Math.max(az, bz) + AISLE_CLEAR) continue;
          const ux = bx - ax;
          const uz = bz - az;
          const len2 = ux * ux + uz * uz;
          const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ux + (z - az) * uz) / len2)) : 0;
          const qx = x - ax - ux * t;
          const qz = z - az - uz * t;
          if (qx * qx + qz * qz < AISLE_CLEAR * AISLE_CLEAR) ok = false;
        }
        this.slotOk[i * MAX_SLOTS + slot] = ok ? 1 : 0;
      }
    }
  }

  /** Free slot of a spot where someone can stand, centre-most first; -1 when full. */
  private freeSlot(spot: number, allowOverflow: boolean): number {
    const cap = Math.min(MAX_SLOTS, this.layout.socialSpots[spot].capacity);
    const base = spot * MAX_SLOTS;
    let best = -1;
    let bestScore = Infinity;
    const mid = (cap - 1) / 2;
    const line = this.spotKind[spot] === K_MAP || this.spotKind[spot] === K_SERVER || this.spotKind[spot] === K_CYBER;
    for (let s = 0; s < cap; s++) {
      if (this.spotAgents[base + s] || !this.slotOk[base + s]) continue;
      const score = line ? Math.abs(s - mid) : s;
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }
    if (best >= 0 || !allowOverflow) return best;
    for (let s = cap; s < MAX_SLOTS; s++) if (!this.spotAgents[base + s] && this.slotOk[base + s]) return s;
    return -1;
  }

  private nearestFreeSpot(a: Agent, kind: number, allowOverflow: boolean): number {
    const spots = this.layout.socialSpots;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < spots.length; i++) {
      if (kind >= 0 && this.spotKind[i] !== kind) continue;
      if (this.freeSlot(i, allowOverflow) < 0) continue;
      // A little randomness so everyone does not pick the same closest spot.
      const d = Math.hypot(spots[i].x - a.bx, spots[i].z - a.bz) * a.rng.range(0.7, 1.3);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private reserve(a: Agent, spot: number, allowOverflow: boolean): boolean {
    const slot = this.freeSlot(spot, allowOverflow);
    if (slot < 0) return false;
    this.spotAgents[spot * MAX_SLOTS + slot] = a;
    a.spot = spot;
    a.slot = slot;
    return true;
  }

  /** Idle outing: coffee, the map, the lounge, a meeting room or the servers. */
  private reserveOuting(a: Agent, forcedKind: number): boolean {
    let kind = forcedKind;
    if (kind < 0) {
      const r = a.rng.next();
      kind =
        r < 0.28
          ? K_COFFEE
          : r < 0.5
            ? K_MAP
            : r < 0.68
              ? K_LOUNGE
              : r < 0.76
                ? K_MEETING
                : r < 0.84
                  ? K_SERVER
                  : K_CYBER;
      // A lounge break is taken sitting down when a seat is free.
      if (kind === K_LOUNGE && this.reserveLoungeSeat(a)) return true;
    }
    let spot = this.nearestFreeSpot(a, kind, false);
    if (spot < 0 && forcedKind < 0) spot = this.nearestFreeSpot(a, -1, false);
    return spot >= 0 && this.reserve(a, spot, false);
  }

  private reserveOverflow(a: Agent): void {
    let spot = this.nearestFreeSpot(a, a.rng.chance(0.5) ? K_LOUNGE : K_COFFEE, false);
    if (spot < 0) spot = this.nearestFreeSpot(a, K_LOUNGE, false);
    if (spot < 0) spot = this.nearestFreeSpot(a, -1, false);
    if (spot >= 0) {
      this.reserve(a, spot, false);
      return;
    }
    spot = this.nearestFreeSpot(a, K_LOUNGE, true);
    if (spot < 0) spot = this.nearestFreeSpot(a, -1, true);
    if (spot >= 0) this.reserve(a, spot, true);
  }

  /** Standing position of a slot into tmpX/tmpZ. */
  private slotPosition(spot: number, slot: number): void {
    const s = this.layout.socialSpots[spot];
    const cap = Math.max(1, s.capacity);
    const ring = Math.floor(slot / cap);
    const k = slot % cap;
    const fx = Math.sin(s.rotY);
    const fz = Math.cos(s.rotY);
    const kind = this.spotKind[spot];
    if (kind === K_MAP || kind === K_SERVER || kind === K_CYBER) {
      // Side by side, facing the spot's direction; extra rows stand behind.
      const offset = (k - (cap - 1) / 2) * 0.85 + (ring % 2) * 0.42;
      this.tmpX = s.x - fz * offset - fx * ring * 0.9;
      this.tmpZ = s.z + fx * offset - fz * ring * 0.9;
    } else {
      // A circle around the spot, first slot on its facing side.
      const radius = 0.9 + ring * 0.8;
      const angle = s.rotY + (TWO_PI * (k + ring * 0.5)) / cap;
      this.tmpX = s.x + Math.sin(angle) * radius;
      this.tmpZ = s.z + Math.cos(angle) * radius;
    }
  }

  private partnerOf(a: Agent): Agent | null {
    if (a.placeSpot < 0) return null;
    const base = a.placeSpot * MAX_SLOTS;
    let best: Agent | null = null;
    let bestD = Infinity;
    for (let s = 0; s < MAX_SLOTS; s++) {
      const b = this.spotAgents[base + s];
      if (!b || b === a || b.mode !== M_STAND || b.place !== D_SPOT || b.placeSpot !== a.placeSpot) continue;
      const d = Math.abs(s - a.placeSlot);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  // --- Routing --------------------------------------------------------------

  private destAnchor(a: Agent): number {
    if (a.dest === D_SPOT) return this.spotNode[a.destSpot];
    return a.destSeat >= 0 ? this.seatNode[a.destSeat] : -1;
  }

  private pushWp(n: number, x: number, z: number, node: number): number {
    this.scrX[n] = x;
    this.scrZ[n] = z;
    this.scrN[n] = node;
    return n + 1;
  }

  /** Off-graph points from the destination's nav node to where the agent ends up. */
  private pushTail(a: Agent, n: number): number {
    const s = a.destSeat;
    switch (a.dest) {
      case D_SEAT:
        n = this.pushWp(n, this.viaX[s], this.viaZ[s], -1);
        return this.pushWp(n, this.apprX[s], this.apprZ[s], -1);
      case D_ERROR:
        return this.pushWp(n, this.viaX[s], this.viaZ[s], -1);
      case D_LOUNGE:
        // The seat's nav node is the aisle point right in front of it.
        return this.pushWp(n, this.apprX[s], this.apprZ[s], -1);
      case D_VISIT:
        return this.pushWp(n, this.visitX[s], this.visitZ[s], -1);
      case D_SPOT:
        this.slotPosition(a.destSpot, a.destSlot);
        return this.pushWp(n, this.tmpX, this.tmpZ, -1);
      default:
        return n;
    }
  }

  private nodePos(node: number): void {
    this.tmpX = this.layout.nav.positions[node * 2];
    this.tmpZ = this.layout.nav.positions[node * 2 + 1];
  }

  private computeRoute(a: Agent): void {
    a.needsRoute = false;
    a.wpMore = false;
    if (a.dest === D_NONE) {
      a.wpCount = a.wpIdx = 0;
      return;
    }
    let n = 0;
    let start = -1;
    const walking = a.mode === M_WALK && a.wpIdx < a.wpCount;
    const sameDesk =
      !walking &&
      a.placeSeat === a.destSeat &&
      ((a.place === D_SEAT && a.dest === D_ERROR) || (a.place === D_ERROR && a.dest === D_SEAT));
    if (sameDesk) {
      // Between the chair and the spot beside the desk: no detour via the aisle.
      n = this.pushTail(a, 0);
      if (a.dest === D_SEAT) {
        // Only the last point (the approach) matters from beside the desk.
        this.scrX[0] = this.scrX[n - 1];
        this.scrZ[0] = this.scrZ[n - 1];
        n = 1;
      }
      this.commitRoute(a, n);
      return;
    }

    if (walking) {
      // Keep walking to the next graph node, or back out of a desk/slot tail.
      let j = a.wpIdx;
      while (j < a.wpCount && a.wpNode[j] < 0) j++;
      if (j < a.wpCount) {
        for (let k = a.wpIdx; k <= j; k++) n = this.pushWp(n, a.wpX[k], a.wpZ[k], a.wpNode[k]);
        start = a.wpNode[j];
      } else {
        let i = a.wpIdx - 1;
        while (i >= 0 && a.wpNode[i] < 0) i--;
        if (i >= 0) {
          for (let k = a.wpIdx - 1; k >= i; k--) n = this.pushWp(n, a.wpX[k], a.wpZ[k], a.wpNode[k]);
          start = a.wpNode[i];
        }
      }
    } else if (!walking && a.place !== D_NONE) {
      // Leave the current place through its own tail.
      const seat = a.placeSeat;
      if (a.place === D_SEAT) n = this.pushWp(n, this.viaX[seat], this.viaZ[seat], -1);
      start = a.place === D_SPOT ? this.spotNode[a.placeSpot] : this.seatNode[seat];
      this.nodePos(start);
      n = this.pushWp(n, this.tmpX, this.tmpZ, start);
    }
    if (start < 0) {
      start = nearestNode(this.layout.nav, a.bx, a.bz);
      if (start < 0) {
        this.commitRoute(a, this.pushTail(a, 0));
        return;
      }
      this.nodePos(start);
      n = this.pushWp(n, this.tmpX, this.tmpZ, start);
    }

    const goal = this.destAnchor(a);
    const len = goal >= 0 ? findPath(this.layout.nav, start, goal, this.pathBuf) : 0;
    const firstPath = n;
    for (let p = 1; p < len; p++) {
      if (n >= MAX_WP - TAIL_MAX) {
        a.wpMore = true;
        break;
      }
      const node = this.pathBuf[p];
      this.nodePos(node);
      // Drop the previous path node when it sits on a straight run.
      if (n - 1 >= firstPath && n >= 2) {
        const x0 = this.scrX[n - 2];
        const z0 = this.scrZ[n - 2];
        const x1 = this.scrX[n - 1];
        const z1 = this.scrZ[n - 1];
        const ax = x1 - x0;
        const az = z1 - z0;
        const bx = this.tmpX - x1;
        const bz = this.tmpZ - z1;
        const cross = ax * bz - az * bx;
        if (Math.abs(cross) < 1e-3 * Math.hypot(ax, az) * Math.hypot(bx, bz) + 1e-6 && ax * bx + az * bz > 0) {
          n--;
        }
      }
      n = this.pushWp(n, this.tmpX, this.tmpZ, node);
    }
    if (!a.wpMore) n = this.pushTail(a, n);
    this.commitRoute(a, n);
  }

  private commitRoute(a: Agent, n: number): void {
    for (let k = 0; k < n; k++) {
      a.wpX[k] = this.scrX[k];
      a.wpZ[k] = this.scrZ[k];
      a.wpNode[k] = this.scrN[k];
    }
    a.wpCount = n;
    a.wpIdx = 0;
    if (a.mode === M_STAND || a.mode === M_WALK) {
      a.mode = M_WALK;
      a.place = D_NONE;
    }
  }

  // --- Behaviour per frame -----------------------------------------------------

  private act(a: Agent, index: number, dt: number): void {
    switch (a.mode) {
      case M_WALK:
        this.stepWalk(a, index, dt);
        break;
      case M_SIT:
        a.clipTime += dt;
        if (a.clipTime >= SIT_DOWN_DURATION) {
          a.clipTime = SIT_DOWN_DURATION;
          a.mode = M_SEATED;
          this.setClip(a, this.seatedClip(a), 0, 1);
        }
        break;
      case M_SEATED: {
        const clip = this.seatedClip(a);
        if (a.clip !== clip) this.setClip(a, clip, 0, 1);
        break;
      }
      case M_RISE:
        a.clipTime -= dt;
        if (a.clipTime <= 0) {
          a.clipTime = 0;
          const s = a.placeSeat;
          a.bx = this.apprX[s];
          a.bz = this.apprZ[s];
          a.mode = M_WALK;
          // Up from a lounge seat: only now can someone else take it.
          this.releaseHold(a);
          // A route still waiting for its turn is built from the chair.
          if (!a.needsRoute) a.place = D_NONE;
          if (a.dest === D_NONE) a.wpCount = a.wpIdx = 0;
        }
        break;
      default:
        this.stepStand(a, dt);
    }
    // Clips: the current one advances at its rate (Walk is distance-driven),
    // the previous one keeps playing underneath the crossfade.
    if (a.mode !== M_SIT && a.mode !== M_RISE) a.clipTime += a.clipRate * dt;
    a.clipTime = wrapClip(a.clip, a.clipTime);
    if (a.blend < 1) {
      a.prevTime = wrapClip(a.prevClip, a.prevTime + a.prevRate * dt);
      a.blend = Math.min(1, a.blend + dt / HQ_BLEND_TIME);
    }
    this.syncPosition(a);
    this.desiredLook(a);
  }

  /** Typing at a desk while working; sitting idle otherwise (and always in the lounge). */
  private seatedClip(a: Agent): number {
    return a.status === WORKING && a.place === D_SEAT ? HqClip.SitType : HqClip.SitIdle;
  }

  private setClip(a: Agent, clip: number, time: number, rate: number): void {
    if (clip === a.clip) {
      a.clipRate = rate;
      return;
    }
    if (clip === a.prevClip && a.blend < 1) {
      // Switching back mid-fade: swap instead of popping.
      const t = a.prevTime;
      a.prevClip = a.clip;
      a.prevTime = a.clipTime;
      a.prevRate = a.clipRate === 0 ? 1 : a.clipRate;
      a.clip = clip;
      a.clipTime = t;
      a.clipRate = rate;
      a.blend = 1 - a.blend;
      return;
    }
    a.prevClip = a.clip;
    a.prevTime = a.clipTime;
    a.prevRate = a.clipRate === 0 ? 1 : a.clipRate;
    a.clip = clip;
    a.clipTime = time;
    a.clipRate = rate;
    a.blend = 0;
  }

  private stepWalk(a: Agent, index: number, dt: number): void {
    if (a.wpIdx >= a.wpCount) {
      if (a.needsRoute || a.wpMore) {
        if (a.wpMore) a.needsRoute = true;
        a.moving = false;
        this.setClip(a, HqClip.Idle, 0, 1);
        return;
      }
      if (a.dest === D_LOUNGE && !this.turnToSit(a, dt)) return;
      this.arrive(a);
      return;
    }
    if (a.clip !== HqClip.Walk) this.setClip(a, HqClip.Walk, 0, 0);

    const slow = this.separate(a, index, dt);
    let tx = a.wpX[a.wpIdx];
    let tz = a.wpZ[a.wpIdx];
    let dx = tx - a.bx;
    let dz = tz - a.bz;
    let dist = Math.hypot(dx, dz);
    let want = dist > 1e-3 ? Math.atan2(dx, dz) : a.facing;
    if (a.wpIdx === a.wpCount - 1 && dist < 0.55 && !a.wpMore) {
      // Line up with the desk while taking the last steps. A lounge seat is
      // walked up to face first; the walker turns round on the spot (turnToSit).
      if (a.dest === D_SEAT) want = this.seatRot[a.destSeat];
      else if (a.dest === D_ERROR) want = this.errFacing[a.destSeat];
    }
    a.facing = turnToward(a.facing, want, TURN_RATE * dt);
    const err = Math.abs(wrapAngle(want - a.facing));
    let speed = a.speed * slow;
    if (err > 1.2) speed *= 0.2;
    else if (err > 0.6) speed *= 0.6;

    let remaining = speed * dt;
    let moved = 0;
    while (remaining > 1e-6 && a.wpIdx < a.wpCount) {
      tx = a.wpX[a.wpIdx];
      tz = a.wpZ[a.wpIdx];
      dx = tx - a.bx;
      dz = tz - a.bz;
      dist = Math.hypot(dx, dz);
      if (dist > 1e-6) {
        a.dirX = dx / dist;
        a.dirZ = dz / dist;
      }
      if (dist <= remaining) {
        a.bx = tx;
        a.bz = tz;
        remaining -= dist;
        moved += dist;
        a.wpIdx++;
      } else {
        a.bx += (dx / dist) * remaining;
        a.bz += (dz / dist) * remaining;
        moved += remaining;
        remaining = 0;
      }
    }
    a.moving = moved > 1e-5;
    a.clipTime += moved / WALK_NATIVE_SPEED;

    // Fade the separation offset out on the way into a desk or slot.
    if (a.wpIdx < a.wpCount && a.wpNode[a.wpIdx] < 0) {
      const left = Math.hypot(a.wpX[a.wpIdx] - a.bx, a.wpZ[a.wpIdx] - a.bz);
      if (left < 1) {
        a.ox *= left;
        a.oz *= left;
      }
    }
    if (a.wpIdx >= a.wpCount && !a.needsRoute && !a.wpMore && a.dest !== D_LOUNGE) this.arrive(a);
  }

  /** At a lounge seat's approach: turn round on the spot; true once facing the seat's way. */
  private turnToSit(a: Agent, dt: number): boolean {
    const want = this.seatRot[a.destSeat];
    if (Math.abs(wrapAngle(want - a.facing)) <= SIT_ALIGN) return true;
    a.facing = turnToward(a.facing, want, TURN_RATE * dt);
    a.moving = false;
    // Settle onto the approach point itself while turning.
    const settle = 1 - Math.min(1, 10 * dt);
    a.ox *= settle;
    a.oz *= settle;
    if (a.clip !== HqClip.Idle) this.setClip(a, HqClip.Idle, 0, 1);
    return false;
  }

  /** Light crowd separation; returns a speed factor. Offsets stay near the route. */
  private separate(a: Agent, index: number, dt: number): number {
    let slow = 1;
    let pushX = 0;
    let pushZ = 0;
    let keepRight = 0;
    const fx = a.dirX;
    const fz = a.dirZ;
    const cx = this.agentCell[index] % this.hcols;
    const cz = (this.agentCell[index] - cx) / this.hcols;
    const r2 = SEPARATION_RADIUS * SEPARATION_RADIUS;
    for (let gz = cz - 1; gz <= cz + 1; gz++) {
      if (gz < 0 || gz >= this.hrows) continue;
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        if (gx < 0 || gx >= this.hcols) continue;
        const cell = gz * this.hcols + gx;
        for (let k = this.hashStart[cell], end = this.hashStart[cell + 1]; k < end; k++) {
          const j = this.hashItems[k];
          if (j === index) continue;
          const b = this.agents[j];
          if (b.mode === M_SEATED || b.mode === M_SIT || b.mode === M_RISE) continue;
          let dx = a.x - b.x;
          let dz = a.z - b.z;
          let d2 = dx * dx + dz * dz;
          if (d2 > r2) continue;
          if (d2 < 1e-8) {
            // Exactly on top of each other: split sideways, deterministically.
            const side = index < j ? 1 : -1;
            dx = -fz * side * 0.01;
            dz = fx * side * 0.01;
            d2 = 1e-4;
          }
          const d = Math.sqrt(d2);
          const push = (SEPARATION_RADIUS - d) / SEPARATION_RADIUS;
          pushX += (dx / d) * push;
          pushZ += (dz / d) * push;
          const ahead = -(dx * fx + dz * fz) / d;
          if (ahead > 0.5) {
            if (b.mode === M_WALK && b.moving) {
              const same = b.dirX * fx + b.dirZ * fz;
              if (same > 0.3) slow = Math.min(slow, Math.max(0.3, (d - 0.3) / 0.5));
              else if (same < -0.3) keepRight += 1;
            }
          }
        }
      }
    }
    // Right-hand side of the walker (rotY 0 faces +Z, its right is -X).
    const rx = -fz;
    const rz = fx;
    a.ox += (pushX * 1.4 + rx * keepRight * 0.7) * dt;
    a.oz += (pushZ * 1.4 + rz * keepRight * 0.7) * dt;
    // Offsets are sideways only; the route itself carries the agent forward.
    const along = a.ox * fx + a.oz * fz;
    const k = Math.min(1, 3 * dt);
    a.ox -= along * fx * k;
    a.oz -= along * fz * k;
    const decay = 1 - Math.min(1, 0.4 * dt);
    a.ox *= decay;
    a.oz *= decay;
    const len = Math.hypot(a.ox, a.oz);
    if (len > MAX_OFFSET) {
      a.ox *= MAX_OFFSET / len;
      a.oz *= MAX_OFFSET / len;
    }
    return slow;
  }

  private arrive(a: Agent): void {
    a.moving = false;
    a.ox = 0;
    a.oz = 0;
    const s = a.destSeat;
    switch (a.dest) {
      case D_SEAT:
        a.bx = this.seatX[s];
        a.bz = this.seatZ[s];
        a.facing = this.seatRot[s];
        a.mode = M_SIT;
        a.place = D_SEAT;
        a.placeSeat = s;
        this.setClip(a, HqClip.SitDown, 0, 1);
        return;
      case D_ERROR:
        a.mode = M_STAND;
        a.place = D_ERROR;
        a.placeSeat = s;
        this.setClip(a, HqClip.Idle, 0, 1);
        return;
      case D_LOUNGE: {
        a.bx = this.seatX[s];
        a.bz = this.seatZ[s];
        a.facing = this.seatRot[s];
        a.mode = M_SIT;
        a.place = D_LOUNGE;
        a.placeSeat = s;
        const k = s - this.loungeBase;
        this.loungeHeld[k] = a;
        a.held = s;
        a.leaveAt = this.time + a.rng.range(LOUNGE_SIT_MIN, LOUNGE_SIT_MAX);
        this.setClip(a, HqClip.SitDown, 0, 1);
        return;
      }
      case D_SPOT: {
        a.mode = M_STAND;
        a.place = D_SPOT;
        a.placeSpot = a.destSpot;
        a.placeSlot = a.destSlot;
        const kind = this.spotKind[a.destSpot];
        a.leaveAt = this.time + a.rng.range(STAY_MIN[kind], STAY_MAX[kind]);
        a.talking = false;
        a.talkToggleAt = this.time + a.rng.range(0.5, 3);
        this.setClip(a, HqClip.Idle, 0, 1);
        return;
      }
      case D_VISIT:
        a.mode = M_STAND;
        a.place = D_VISIT;
        a.placeSeat = s;
        a.leaveAt = this.time + a.rng.range(4, 8);
        this.setClip(a, HqClip.Talk, 0, 1);
        return;
      default:
        a.mode = M_STAND;
        a.place = D_NONE;
        this.setClip(a, HqClip.Idle, 0, 1);
    }
  }

  private stepStand(a: Agent, dt: number): void {
    let want = a.facing;
    let clip: number = HqClip.Idle;
    if (a.place === D_ERROR) {
      want = this.errFacing[a.placeSeat];
    } else if (a.place === D_SPOT) {
      const partner = this.partnerOf(a);
      if (partner) {
        want = Math.atan2(partner.x - a.x, partner.z - a.z);
        if (this.time >= a.talkToggleAt) {
          a.talking = !a.talking;
          a.talkToggleAt = this.time + (a.talking ? a.rng.range(3, 7) : a.rng.range(2, 5));
        }
        if (a.talking) clip = HqClip.Talk;
      } else {
        const spot = this.layout.socialSpots[a.placeSpot];
        const kind = this.spotKind[a.placeSpot];
        // Line spots (the map, the server room, the cyber-range) face the
        // spot's direction — toward the wall/rigs — not its centre point.
        want =
          kind === K_MAP || kind === K_SERVER || kind === K_CYBER
            ? spot.rotY
            : Math.atan2(spot.x - a.x, spot.z - a.z);
      }
    } else if (a.place === D_VISIT && a.visitTarget) {
      const s = a.visitTarget.placeSeat >= 0 ? a.visitTarget.placeSeat : a.placeSeat;
      want = Math.atan2(this.headX[s] - a.x, this.headZ[s] - a.z);
      clip = HqClip.Talk;
    }
    a.facing = turnToward(a.facing, want, STAND_TURN_RATE * dt);
    if (a.clip !== clip) this.setClip(a, clip, 0, 1);
  }

  private syncPosition(a: Agent): void {
    a.x = a.bx + a.ox;
    a.z = a.bz + a.oz;
  }

  /** Where the head should look (wantX/Y/Z/W). */
  private desiredLook(a: Agent): void {
    switch (a.mode) {
      case M_SEATED:
      case M_SIT:
      case M_RISE: {
        const s = a.placeSeat;
        if (a.place === D_LOUNGE) {
          this.loungeLook(a, s);
          return;
        }
        const v = a.visitor;
        if (a.mode === M_SEATED && v && v.visitTarget === a && v.mode === M_STAND && v.place === D_VISIT) {
          // The lead dropped by: look up at him.
          a.wantX = v.x;
          a.wantY = HEAD_STANDING;
          a.wantZ = v.z;
          a.wantW = 1;
        } else {
          a.wantX = this.monX[s];
          a.wantY = WORKSTATION.monitors[1].y;
          a.wantZ = this.monZ[s];
          a.wantW = a.mode === M_SEATED ? (a.status === WORKING ? 0.5 : 0.35) : 0.15;
        }
        return;
      }
      case M_WALK: {
        const fx = Math.sin(a.facing);
        const fz = Math.cos(a.facing);
        a.wantX = a.x + fx * 3;
        a.wantY = HEAD_STANDING;
        a.wantZ = a.z + fz * 3;
        a.wantW = 0.3;
        return;
      }
      default:
        break;
    }
    if (a.place === D_ERROR) {
      const s = a.placeSeat;
      a.wantX = this.kbX[s];
      a.wantY = WORKSTATION.keyboard.y;
      a.wantZ = this.kbZ[s];
      a.wantW = 0.8;
      return;
    }
    if (a.place === D_VISIT && a.visitTarget) {
      const s = a.visitTarget.placeSeat >= 0 ? a.visitTarget.placeSeat : a.placeSeat;
      a.wantX = this.headX[s];
      a.wantY = HEAD_SEATED;
      a.wantZ = this.headZ[s];
      a.wantW = 0.9;
      return;
    }
    if (a.place === D_SPOT) {
      const partner = this.partnerOf(a);
      if (partner) {
        a.wantX = partner.x;
        a.wantY = HEAD_STANDING;
        a.wantZ = partner.z;
        a.wantW = 0.9;
        return;
      }
      if (this.spotKind[a.placeSpot] === K_MAP) {
        const map = this.layout.mapWall;
        a.wantX = map.x;
        a.wantY = map.y;
        a.wantZ = map.z;
        a.wantW = 0.7;
        return;
      }
    }
    a.wantX = a.x + Math.sin(a.facing) * 2;
    a.wantY = 1.5;
    a.wantZ = a.z + Math.cos(a.facing) * 2;
    a.wantW = 0.3;
  }

  // --- Output ---------------------------------------------------------------

  private writeFrame(dt: number): void {
    const f = this.frame;
    const k = dt > 0 ? 1 - Math.exp(-8 * dt) : 0;
    const kw = dt > 0 ? 1 - Math.exp(-4 * dt) : 0;
    let leadStatus = -1;
    const agents = this.agents;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      a.lookX += (a.wantX - a.lookX) * k;
      a.lookY += (a.wantY - a.lookY) * k;
      a.lookZ += (a.wantZ - a.lookZ) * k;
      a.lookW += (a.wantW - a.lookW) * kw;
      f.x[i] = a.x;
      f.y[i] = 0;
      f.z[i] = a.z;
      f.facing[i] = a.facing;
      f.clip[i] = a.clip;
      f.clipTime[i] = a.clipTime;
      f.prevClip[i] = a.prevClip;
      f.prevClipTime[i] = a.prevTime;
      f.blend[i] = a.blend;
      f.lookX[i] = a.lookX;
      f.lookY[i] = a.lookY;
      f.lookZ[i] = a.lookZ;
      f.lookWeight[i] = a.lookW;
      f.status[i] = a.status;
      f.lead[i] = a.lead ? 1 : 0;
      // Display place for the hover card: the cyber-range and the lounge name
      // themselves; everywhere else the status label speaks for the agent.
      f.place[i] =
        a.place === D_LOUNGE
          ? HQ_PLACE.lounge
          : a.place === D_SPOT && this.spotKind[a.placeSpot] === K_CYBER
            ? HQ_PLACE.cyberrange
            : HQ_PLACE.none;
      if (a.lead) leadStatus = a.status;
    }
    this.leadStatus = leadStatus;
  }

  private updateDeskStatus(): void {
    const ds = this.deskStatus;
    const dr = this.deskRole;
    ds.fill(-1);
    dr.fill(0);
    const agents = this.agents;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (!a.lead && a.seat >= 0 && a.seat < ds.length) {
        ds[a.seat] = a.status;
        dr[a.seat] = a.roleFamily;
      }
    }
  }

  private cellX(x: number): number {
    const c = Math.floor((x - this.hx0) / HASH_CELL);
    return c < 0 ? 0 : c >= this.hcols ? this.hcols - 1 : c;
  }

  private cellZ(z: number): number {
    const c = Math.floor((z - this.hz0) / HASH_CELL);
    return c < 0 ? 0 : c >= this.hrows ? this.hrows - 1 : c;
  }

  /** Counting sort of agents into grid cells (no allocation). */
  private rebuildHash(): void {
    const start = this.hashStart;
    const fill = this.hashFill;
    const agents = this.agents;
    start.fill(0);
    for (let i = 0; i < agents.length; i++) {
      const cell = this.cellZ(agents[i].z) * this.hcols + this.cellX(agents[i].x);
      this.agentCell[i] = cell;
      start[cell + 1]++;
    }
    const cells = this.hcols * this.hrows;
    for (let c = 0; c < cells; c++) {
      start[c + 1] += start[c];
      fill[c] = start[c];
    }
    for (let i = 0; i < agents.length; i++) this.hashItems[fill[this.agentCell[i]]++] = i;
  }
}
