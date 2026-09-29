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
// The archive cart: a wheeled cage parked in its bay by the entrance fills up
// as the server's clutter grows (setArchiveFill). When the server has cleaned
// up (startArchiveRun), an idle hacker walks over, pulls it out of the bay,
// pushes it out through the entrance to the intake chute on the apron, hands
// the load over and brings it back. A briefing interrupts that: on a
// stoppable stretch the cart is left exactly where it stands and the hauler
// runs to his desk like everyone else; in the doorway or across a walkway he
// first pushes on until it is clear. Afterwards he walks back and finishes.
//
// Living workstations (core/beats.ts): nobody moves in lockstep. Every loop
// starts at a random frame and plays at the agent's own tempo; the hall
// stands up for a briefing and sits down after it over a second or so; a
// group at a social spot has one speaker at a time; a free hacker at their
// desk switches between leaning back and typing on their own beat, and now
// and then walks over to look over a working neighbour's shoulder (AM7's
// visits use the same shoulder place). Leaving one's desk goes through a
// departure limiter, so a crowd never gets up at once.
//
// Mission mode («боевая задача», startMission/endMission, on for every
// briefing): no breaks, whoever is away walks briskly back, free hackers stay
// on duty at their desks, AM7 makes short rounds, the cyber-range is off.
// Afterwards each agent relaxes at their own moment and the first breaks are
// spread over minutes.
//
// Hot-path rules: update() allocates nothing (agents, waypoint buffers, the
// spatial hash and scratch arrays are sized in the constructor / setAgents),
// timers run on an internal clock advanced by the clamped dt, and every random
// choice comes from a seeded per-agent generator, so a run replays exactly.
// Beats draw from a second per-agent generator (`beat`), so they never shift
// the routes and outings the first one decides.

import {
  HQ_AGENT_RADIUS,
  HQ_ARCHIVE_CART,
  HQ_BLEND_TIME,
  HQ_CLIP_FPS,
  HQ_CLIP_INFO,
  HQ_CLIPS,
  HQ_LEAD_AGENT_IDS,
  HQ_LEAD_AGENT_NAME,
  HQ_PUSH_GRIP,
  HQ_SHOULDER,
  HQ_WALK_SPEED,
  HqClip,
  POD,
  WORKSTATION,
} from "./config";
import { HQ_ENTRANCE_HALF_WIDTH } from "./archiveLayout";
import {
  BEAT_IDLE,
  BEAT_LEAN,
  BEAT_MIN,
  BEAT_READ,
  BEAT_STRETCH,
  BEAT_TURN,
  BEAT_TYPE,
  BEAT_VISIT,
  BRISK_FACTOR,
  EXHALE_SHARE,
  GUEST_SPACING,
  HqDepartureLimiter,
  LISTEN_IDLE,
  LISTEN_SLOW,
  LISTEN_SLOW_TEMPO,
  LEAD_VISIT_MAX,
  LEAD_VISIT_MIN,
  MISSION_LEAD_GAP_MAX,
  MISSION_LEAD_GAP_MIN,
  MISSION_LEAD_VISIT_MAX,
  MISSION_LEAD_VISIT_MIN,
  MISSION_MAX_DEFAULT,
  RELAX_MAX,
  RELAX_MIN,
  RELAX_OUTING_MAX,
  RELAX_OUTING_MIN,
  RETURN_DELAY_MAX,
  RETURN_DELAY_MIN,
  SPOT_GAP_MAX,
  SPOT_GAP_MIN,
  SPOT_TURN_MAX,
  SPOT_TURN_MIN,
  STRETCH_GAP,
  beatPause,
  beatSeconds,
  buildDeskNeighbourhood,
  guestNearby,
  helpVisitLimit,
  leanLimit,
  listenStyle,
  missionTempo,
  pairLimit,
  peerVisitLimit,
  peerVisitSeconds,
  pickBeat,
  reactionDelay,
  rollTraits,
  seatedNeighbours,
  stretchLimit,
  type HqDeskNeighbourhood,
} from "./beats";
import { HQ_LEAD_VIA, HQ_PROP_FOOTPRINT } from "./layout";
import { hqRoleFamily } from "./roles";
import { findPath, navNodeCount, nearestNode } from "./nav";
import { HqRng, hashString, mixSeed } from "./rng";
import {
  HQ_PLACE,
  HQ_STATUS_CODE,
  type HqAgentFrame,
  type HqAgentInput,
  type HqArchiveEvent,
  type HqArchiveLane,
  type HqArchiveView,
  type HqLayout,
  type HqMissionView,
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
const CLIP_BLEND = HQ_CLIPS.map((name) => HQ_CLIP_INFO[name].blend);
/** Distance-driven clips (Walk, Run, Push): fades to and from them stay short. */
const CLIP_LOCO = HQ_CLIPS.map((name) => HQ_CLIP_INFO[name].speed > 0);
/** Held loop inside intro/hold/outro clips (seconds), -1 when the clip has none. */
const CLIP_HOLD0 = HQ_CLIPS.map((name) => HQ_CLIP_INFO[name].hold?.[0] ?? -1);
const CLIP_HOLD1 = HQ_CLIPS.map((name) => HQ_CLIP_INFO[name].hold?.[1] ?? -1);
/**
 * Released inside a held loop with more than this left of it (seconds), the
 * clip crossfades to the loop's end instead of playing the rest: a guest
 * leaves, a briefing starts, within about a second (a briefing's reaction
 * delay of up to 1.4 s covers the longest outro, SitLeanBack's 1 s).
 */
const RELEASE_PLAY = 0.4;
/** A stretch's act lasts its clip plus the fade back to typing. */
const STRETCH_SECONDS = HQ_CLIP_INFO.SitStretch.duration + 0.6;

/** Crossfade from one clip to another: HQ_BLEND_TIME around locomotion, else the target's own. */
function blendTime(from: number, to: number): number {
  if (CLIP_LOCO[from] || CLIP_LOCO[to]) return HQ_BLEND_TIME;
  const t = CLIP_BLEND[to];
  return t > 0 ? t : HQ_BLEND_TIME;
}

/** Salt of the per-agent beat generator (kept apart from the route generator). */
const BEAT_SALT = 0xbea75eed;
// What a hacker does at their own desk (the seated clip it picks, seatedClip).
const ACT_IDLE = 0; // SitIdle
const ACT_TYPE = 1; // SitType / SitType2 (typeVariant)
const ACT_READ = 2; // SitRead
const ACT_LEAN = 3; // SitLeanBack
const ACT_STRETCH = 4; // SitStretch, once
const ACT_TURN_L = 5; // SitTurnL: talking with the left neighbour (pair)
const ACT_TURN_R = 6; // SitTurnR
const WALK_NATIVE_SPEED = HQ_CLIP_INFO.Walk.speed;
const RUN_NATIVE_SPEED = HQ_CLIP_INFO.Run.speed;
/**
 * When a briefing starts, everyone away from their desk jogs back to it: this
 * many times their walking pace. The last RUN_SETTLE metres are walked, so they
 * do not skid into the desk.
 */
const RUN_FACTOR = 2.3;
const RUN_SETTLE = 1.5;
const SIT_DOWN_DURATION = HQ_CLIP_INFO.SitDown.duration;

// What an agent is doing.
const M_WALK = 0;
const M_SIT = 1; // SitDown forward
const M_SEATED = 2;
const M_RISE = 3; // SitDown in reverse
const M_STAND = 4;
const M_PUSH = 5; // at the archive cart's handle: gripping, pushing or handing over

// Where an agent is heading (dest) or standing (place).
const D_NONE = 0;
const D_SEAT = 1; // sit at a desk
const D_ERROR = 2; // stand beside the desk
const D_SPOT = 3; // a social spot slot
const D_VISIT = 4; // a guest (the lead or a colleague) at a seated hacker's shoulder
const D_LOUNGE = 5; // sit on a lounge seat
const D_BRIEF = 6; // stand at one's own desk and listen to the lead's briefing
const D_PODIUM = 7; // the lead at the podium in front of the rows, briefing the floor
const D_CART = 8; // walking to the archive cart's handle
const D_PUSH = 9; // pushing the cart (also the briefing-time clearing push)

/**
 * A briefing's rhythm at the podium: the lead addresses the rows for a while,
 * then plays Present once — a half turn to his right, an open hand toward the
 * video wall's west wing (the task), and back to the rows — and so on.
 */
const PODIUM_TALK = 8.4;
const PRESENT_DURATION = HQ_CLIP_INFO.Present.duration;
const PODIUM_CYCLE = PODIUM_TALK + PRESENT_DURATION;
/**
 * The root turns this far to the lead's right (rad) while presenting, so the
 * clip's open hand lands on the wall's west wing rather than past its end.
 */
const PRESENT_YAW = -0.18;
/** After a briefing the tribune sinks once the lead is this far (m) from his spot behind it. */
const TRIBUNE_LEAVE_DISTANCE = 1.6;
/** Longest a briefing waits, once asked to end, for the lead to have his say. */
const BRIEFING_END_GRACE = 45;
/** Default briefing length when the host gives none (seconds). */
const BRIEFING_DEFAULT = 120;

const SPOT_KINDS: HqSocialSpotKind[] = ["coffee", "map", "lounge", "meeting", "server"];
const K_COFFEE = 0;
const K_MAP = 1;
const K_LOUNGE = 2;
const K_MEETING = 3;
const K_SERVER = 4;
// Seconds spent at each kind of spot.
const STAY_MIN = [20, 15, 30, 30, 15];
const STAY_MAX = [45, 35, 60, 90, 30];

// The cyber-range is not a place agents walk to: a working hacker enters it
// from their own workstation, seated, for a while, then drops back to normal
// work. RANGE_MIN/MAX is a session's length; NEXT_MIN/MAX the gap between them.
const RANGE_MIN = 40;
const RANGE_MAX = 80;
const RANGE_NEXT_MIN = 300;
const RANGE_NEXT_MAX = 600;

// --- The archive cart ---------------------------------------------------------

/**
 * HQ_PLACE code of an agent hauling the archive cart (hover card «вывозит
 * архив»): the next free code after HQ_PLACE.podium.
 */
export const HQ_PLACE_ARCHIVE = 5;

const ARC_PARKED = 0; // in its bay
const ARC_FETCH = 1; // the hauler walks to the handle, then grips it
const ARC_PUSH = 2; // pushing along laneOut or laneBack
const ARC_HANDOVER = 3; // the load goes into the chute
const ARC_LEFT = 4; // left standing where it is, waiting for its hauler (or a new one)

const CART_REACH = HQ_ARCHIVE_CART.reach;
const PUSH_NATIVE_SPEED = HQ_CLIP_INFO.Push.speed;
/** The Push frame a pusher holds while the cart stands still. */
const PUSH_HOLD_TIME = HQ_PUSH_GRIP.holdFrame / HQ_CLIP_FPS;
/** Cruising speed behind the cart (m/s), scaled by the agent's own pace. */
const PUSH_SPEED = 1.0;
const PUSH_ACCEL = 0.7;
const PUSH_DECEL = 0.9;
/** Braking for someone in front of the cart. */
const HOLD_DECEL = 1.5;
/** Hands on the grip bar before the first step. */
const GRIP_SECONDS = 0.45;
/** The handover: four tiers into the chute; the load counts as delivered at HANDOVER_EVENT. */
const HANDOVER_SECONDS = 3.6;
const HANDOVER_EVENT = 2.9;
const HANDOVER_HURRY_SECONDS = 1.5;
/** Pace while clearing the doorway or a walkway for a briefing. */
const CLEAR_HURRY = 1.25;
/** The door area the pusher keeps clear of walkers before entering it, and the longest wait. */
const DOOR_DEPTH = 1.2;
const DOOR_HALF = 2.6;
const DOOR_WAIT_MAX = 12;
/** Someone this close in front of the cart stops it; after FRONT_WAIT_MAX it edges on for a moment. */
const FRONT_STOP_R = 0.55;
const FRONT_STOP_AHEAD = 0.75;
const FRONT_STOP_BEHIND = 0.6;
const FRONT_WAIT_MAX = 3;
const FRONT_IGNORE = 1.5;
/** After a briefing the hauler walks back to a left cart after this long. */
const RESUME_MIN = 3;
const RESUME_MAX = 8;
/** A run asked for during a briefing starts this long after it. */
const BRIEF_START_DELAY = 10;
/** A cart whose hauler is gone is taken over after this long; nobody free: retry every RUN_RETRY. */
const REASSIGN_DELAY = 6;
const RUN_RETRY = 5;
/**
 * A left cart nobody idle has taken over for this long goes to any hacker at
 * his desk (working ones too, not in error): it must not stand out there for good.
 */
const REASSIGN_RELAX = 60;
/** A run nobody is free for this long is applied without a trip ("auto"). */
const PENDING_MAX = 600;
/** Who pushed last is not picked again while anyone else can go. */
const RECENT_PUSHERS = 3;
/** Runs merged after a handover start this long after the cart is parked. */
const NEXT_RUN_COOLDOWN = 20;
/** Walkers keep off two discs along the cart's axis. */
const CART_GHOST_R = 0.55;
const CART_GHOST_OFFSET = 0.3;
/** The hauler walks up to the handle from this far behind it. */
const APPROACH_BACK = 0.8;
/** A new hauler walks to the handle from a nav node he can see it from, this far off the cart's sides. */
const SIGHT_CLEAR = 0.3;
/** Fill (0..1) at which each load tier appears; a tier goes again only this much lower, for LEVEL_DROP_AFTER. */
const LEVEL_UP: readonly number[] = [0.15, 0.4, 0.65, 0.88];
const LEVEL_HYSTERESIS = 0.05;
const LEVEL_RISE_GAP = 1.5;
const LEVEL_DROP_AFTER = 60;
/** After a handover the old fill is ignored this long, unless a new one arrives. */
const FILL_SETTLE = 30;
/** Run ids remembered so a repeated startArchiveRun is a no-op. */
const RECENT_RUN_IDS = 8;

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
  /** Length of the current crossfade (blendTime of the two clips). */
  blendDur = HQ_BLEND_TIME;

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
  visitTarget: Agent | null = null;
  visitor: Agent | null = null;
  /** The host's desk while visiting (guest spacing is kept per desk), -1 otherwise. */
  visitSeat = -1;
  /** A colleague's visit (counted against the peer limit), and whether it is a mission's short help. */
  peerVisit = false;
  helping = false;
  /** Cyber-range from the workstation: on it now, until when, and when next. */
  onRange = false;
  rangeUntil = 0;
  nextRange = 0;

  // --- Beats (core/beats.ts), all drawn from `beat` -------------------------
  /** Seeded from the id hash, apart from `rng`: beats never shift routes or outings. */
  readonly beat: HqRng;
  readonly social: number;
  readonly fidget: number;
  /** Playback rate of this agent's loops, and of its typing during a mission. */
  readonly tempo: number;
  readonly missionRate: number;
  /** The sim's tempoEpoch the current loop's rate was set in (see HqSimulation.tempoEpoch). */
  rateEpoch = 0;
  /** At their own desk: ACT_* (the seated clip), and until when a timed act lasts. */
  act = ACT_IDLE;
  actUntil = 0;
  /** When the current act began (nobody is pulled out of an act younger than BEAT_MIN). */
  actSince = 0;
  nextBeat = 0;
  /** Typing clip of this sitting: SitType or SitType2. */
  typeVariant: number = HqClip.SitType;
  /** Talking with a seated neighbour (both in ACT_TURN_*), and whether this one listens first. */
  pair: Agent | null = null;
  pairSecond = false;
  lastStretch = -Infinity;
  /** The first beat after a mission is a breath out (a stretch or a lean back). */
  exhale = false;
  /** LISTEN_* (beats.ts): how this agent listens standing. */
  readonly listenStyle: number;
  /** Intro/hold/outro clips: looping inside the hold (false: playing the outro, or backing out of the intro). */
  holdOn = false;
  /** Pending jump into the hold (seconds), taken once when the hold is first reached (a pair's second voice). */
  holdShift = 0;
  /** Reaction delay: standing up for a briefing / sitting down after it waits until then. */
  holdUntil = 0;
  /** A mission started while away: head back to the desk from then on. */
  returnAt = 0;
  /** After a mission: still on duty until then. */
  relaxAt = 0;

  constructor(id: string, seed: number) {
    this.id = id;
    const idHash = hashString(id) >>> 0;
    this.rng = new HqRng(mixSeed(seed, idHash));
    this.speed = HQ_WALK_SPEED * this.rng.range(0.93, 1.07);
    this.clipTime = this.rng.range(0, 3);
    // Stagger who is first eligible for the cyber-range from the id hash (not
    // the rng, so the crowd's seeded behaviour is untouched) — otherwise every
    // hacker would enter at once when the office fills up.
    this.nextRange = idHash % (RANGE_NEXT_MAX + 1);
    this.beat = new HqRng(mixSeed(mixSeed(seed, BEAT_SALT), idHash));
    const traits = rollTraits(this.beat);
    this.social = traits.social;
    this.fidget = traits.fidget;
    this.tempo = traits.tempo;
    this.missionRate = missionTempo(traits.tempo);
    this.nextBeat = this.beat.range(BEAT_MIN, 45);
    this.listenStyle = listenStyle(idHash);
    this.typeVariant = (idHash >>> 5) % 2 === 0 ? HqClip.SitType : HqClip.SitType2;
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

/** Places at an agent's own desk: the chair, beside it (error), standing at it (briefing). */
function atDesk(place: number): boolean {
  return place === D_SEAT || place === D_ERROR || place === D_BRIEF;
}

/** Load tiers (0..4) a fill level shows. */
function archiveLevelFor(fill: number): number {
  let level = 0;
  while (level < 4 && fill >= LEVEL_UP[level]) level++;
  return level;
}

/**
 * Whether segment a-b passes through the box centred on (cx, cz), turned by
 * rotY, spanning [back, front] along its heading and ±half across it.
 */
function segmentHitsBox(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  rotY: number,
  back: number,
  front: number,
  half: number,
): boolean {
  const hx = Math.sin(rotY);
  const hz = Math.cos(rotY);
  // Into the box frame: u along the heading, w across it.
  const au = (ax - cx) * hx + (az - cz) * hz;
  const aw = (ax - cx) * hz - (az - cz) * hx;
  const du = (bx - cx) * hx + (bz - cz) * hz - au;
  const dw = (bx - cx) * hz - (bz - cz) * hx - aw;
  // Liang–Barsky: clip the segment's parameter range against each slab.
  let t0 = 0;
  let t1 = 1;
  for (let k = 0; k < 4; k++) {
    const p = k === 0 ? -du : k === 1 ? du : k === 2 ? -dw : dw;
    const q = k === 0 ? au - back : k === 1 ? front - au : k === 2 ? aw + half : half - aw;
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return t0 <= t1;
}

function segmentsCross(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  return d1 * d2 < 0 && d3 * d4 < 0;
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
  /**
   * Archive cart events (taken, paused, resumed, reassigned, handover, parked,
   * auto). Called synchronously from update() or startArchiveRun; each event
   * is a new object (they are rare), safe to keep.
   */
  onArchiveEvent?: (e: HqArchiveEvent) => void;

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
  /** A guest's place at the seat's shoulder (HQ_SHOULDER), facing the centre monitor. */
  private readonly shX: Float32Array;
  private readonly shZ: Float32Array;
  private readonly shRot: Float32Array;
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
  /** One speaker at a time per spot: who has the word, until when (or the pause before the next turn), who had it last. */
  private readonly spotSpeaker: Array<Agent | null>;
  private readonly spotTurnUntil: Float64Array;
  private readonly spotLast: Array<Agent | null>;

  // Over-the-shoulder visits: desk rows and near desks, guests per desk, who sits where.
  private readonly nb: HqDeskNeighbourhood;
  private readonly deskGuest: Uint8Array;
  private readonly deskAgent: Array<Agent | null>;
  /** Colleagues' visits under way (AM7's not counted). */
  private visitCount = 0;
  /** Per desk: the seated neighbour's desk on the sitter's left / right (-1: none). */
  private readonly nbLeft: Int32Array;
  private readonly nbRight: Int32Array;
  /** Concurrent acts over the hall (their limits scale with the agent count). */
  private leanCount = 0;
  private stretchCount = 0;
  private pairCount = 0;
  /** Leaving one's desk for a break or a visit (briefings and mission returns are not limited). */
  private readonly departures = new HqDepartureLimiter();

  // Mission mode.
  /**
   * Bumped whenever loop tempos change regime (a mission starts or ends):
   * seated agents re-read their rate then, not every frame (a float returned
   * per agent per frame would allocate).
   */
  private tempoEpoch = 1;
  private missionActive = false;
  private missionSince = 0;
  private missionUntil = 0;
  private readonly missionView: HqMissionView = { active: false, elapsed: 0, remaining: 0 };

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

  // Briefing: the lead at the podium, everyone with a desk standing at it.
  private briefingActive = false;
  private briefingUntil = 0;
  /**
   * The screen asked to end the briefing before the lead had his say: it
   * winds down once he has stood behind the tribune for a full cycle (or at
   * briefingEndBy, if he never gets there).
   */
  private briefingEndRequested = false;
  private briefingEndBy = 0;
  /** When the lead reached the podium: the rhythm of talking and presenting starts there. */
  private podiumSince = 0;
  private briefingSpeaking = true;
  /**
   * The creator has just signed in: until creatorAckUntil the lead turns to
   * the viewer (creatorX/Y/Z, the camera) — standing he faces it, seated he
   * takes his hands off the keys and looks up at it.
   */
  private creatorAckUntil = 0;
  private creatorX = 0;
  private creatorY = 0;
  private creatorZ = 0;
  private leadAgent: Agent | null = null;
  /** The podium: the stage walkway's point on the rows' axis, facing the rows. */
  private readonly podiumNode: number;
  private readonly podiumX: number;
  private readonly podiumZ: number;
  private readonly podiumFacing: number;

  // The archive cart (layout.archive). Lane 0 is laneOut, 1 laneBack.
  private readonly arcLanes: readonly [HqArchiveLane, HqArchiveLane];
  /** laneOut: where the pusher waits for a clear doorway (the last sample before its first no-stop one). */
  private readonly arcHoldS: number;
  private readonly arcRng: HqRng;
  private arcPhase = ARC_PARKED;
  /** Who has the run: fetching, pushing, or (LEFT) due back after a briefing. */
  private arcAgent: Agent | null = null;
  private arcLane = 0;
  private arcS = 0;
  private arcIdx = 0;
  private arcV = 0;
  private arcGripT = 0;
  /** Handover progress 0..1. */
  private arcHandF = 0;
  /** The handover event of this run has fired (the load is gone). */
  private arcHanded = false;
  /** Briefing: pushing on until the cart can be left (arcStopS, or the lane's end). */
  private arcClearing = false;
  private arcStopS = -1;
  private arcDoorWait = 0;
  private arcFrontWait = 0;
  private arcFrontIgnoreUntil = 0;
  private arcResumeAt = -1;
  private arcReassignAt = -1;
  private arcPrevAgent: Agent | null = null;
  /** When the last hauler was dropped (the cart then waits for a new one). */
  private arcDroppedAt = 0;
  private arcPaused = false;
  // The pose the hauler walks to (his root at the handle), and the way in.
  private arcGrabX = 0;
  private arcGrabZ = 0;
  private arcGrabRot = 0;
  private arcGrabNode = -1;
  private arcGrabQ = false;
  private arcQX = 0;
  private arcQZ = 0;
  private arcFetchSerial = 0;
  // The cart's origin and heading.
  private arcCartX: number;
  private arcCartZ: number;
  private arcCartRot: number;
  // The run in progress ("" when none) and one waiting to start.
  private arcRunId = "";
  private arcFreed = 0;
  private pendRunId = "";
  private pendFreed = 0;
  private pendSince = 0;
  private pendNotBefore = 0;
  // Load.
  private arcFill = 0;
  private arcFillSeen = false;
  private arcLevel = 0;
  private arcLevelRiseAt = 0;
  private arcBelowSince = -1;
  private arcFillSettleUntil = 0;
  private arcRunsEnabled = true;
  private readonly arcRecent: string[] = new Array<string>(RECENT_PUSHERS).fill("");
  private arcRecentNext = 0;
  private readonly arcRunIds: string[] = new Array<string>(RECENT_RUN_IDS).fill("");
  private arcRunIdNext = 0;
  private readonly arcView: HqArchiveView;
  private tmpH = 0;

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
    this.shX = new Float32Array(n);
    this.shZ = new Float32Array(n);
    this.shRot = new Float32Array(n);
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
      local(s, centre.x, centre.z);
      this.monX[i] = this.tmpX;
      this.monZ[i] = this.tmpZ;
      // Behind the sitter's right shoulder, looking at the centre monitor: a
      // straight step in from the ring node behind the chair.
      local(s, HQ_SHOULDER.x, HQ_SHOULDER.z);
      this.shX[i] = this.tmpX;
      this.shZ[i] = this.tmpZ;
      this.shRot[i] = Math.atan2(this.monX[i] - this.tmpX, this.monZ[i] - this.tmpZ);
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
      this.shX[i] = s.approach.x;
      this.shZ[i] = s.approach.z;
      this.shRot[i] = s.rotY;
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
    this.spotSpeaker = new Array<Agent | null>(spots.length).fill(null);
    this.spotLast = new Array<Agent | null>(spots.length).fill(null);
    this.spotTurnUntil = new Float64Array(spots.length);

    this.nb = buildDeskNeighbourhood(desks, layout.arena);
    {
      const side = seatedNeighbours(desks, this.nb);
      this.nbLeft = side.left;
      this.nbRight = side.right;
    }
    this.deskGuest = new Uint8Array(desks.length);
    this.deskAgent = new Array<Agent | null>(desks.length).fill(null);

    this.spawnNode = nearestNode(layout.nav, layout.spawn.x, layout.spawn.z);
    this.pathBuf = new Int32Array(Math.max(1, navNodeCount(layout.nav)));
    {
      // Behind the tribune, facing the rows with the video wall at his back.
      const { standX, standZ, rotY } = layout.tribune;
      this.podiumNode = nearestNode(layout.nav, standX, standZ);
      this.podiumX = this.podiumNode >= 0 ? pos[this.podiumNode * 2] : standX;
      this.podiumZ = this.podiumNode >= 0 ? pos[this.podiumNode * 2 + 1] : standZ;
      this.podiumFacing = rotY;
    }

    {
      const arc = layout.archive;
      this.arcLanes = [arc.laneOut, arc.laneBack];
      const out = arc.laneOut;
      let first = 0;
      while (first < out.noStop.length && !out.noStop[first]) first++;
      this.arcHoldS = first > 0 && first < out.noStop.length ? out.s[first - 1] : first > 0 ? out.s[out.s.length - 1] : 0;
      this.arcRng = new HqRng(mixSeed(this.seed, 0xa7c417e));
      this.arcCartX = arc.cart.x;
      this.arcCartZ = arc.cart.z;
      this.arcCartRot = arc.cart.rotY;
      this.arcView = {
        x: arc.cart.x,
        z: arc.cart.z,
        rotY: arc.cart.rotY,
        level: 0,
        unload: 0,
        gate: 0,
        chute: 0,
        phase: "parked",
        pusherId: null,
      };
    }

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
   * Starts (or extends) a briefing: the lead walks to the podium in front of
   * the rows and addresses the floor; everyone with a desk comes back to it
   * and stands there facing the lead; everyone else turns to listen. It ends
   * after `seconds` or at endBriefing. Each hacker reacts in their own time
   * (REACTION_MIN..MAX), so the hall does not rise as one. A briefing is the
   * start of a mission: startMission() is implied and outlasts the briefing.
   */
  startBriefing(seconds = BRIEFING_DEFAULT): void {
    if (!this.briefingActive) {
      this.briefingActive = true;
      this.briefingSpeaking = true;
      for (const a of this.agents) {
        if (a.lead || a.seat >= 0) {
          this.releaseSpot(a);
          this.releaseLounge(a);
          this.endVisit(a);
          this.endPair(a);
          a.onRange = false;
          if (!a.lead && a !== this.arcAgent) a.holdUntil = this.time + reactionDelay(a.beat);
          // A held gesture winds down while they react, so they rise on time.
          if (a.seat >= 0 && !a.lead) {
            this.setAct(a, this.baseAct(a, true));
            a.actUntil = 0;
            this.releaseGesture(a);
          }
        }
      }
      this.archiveBriefingStarts();
      this.updateArchiveView(0);
    }
    this.briefingUntil = this.time + Math.max(1, seconds);
    this.briefingEndRequested = false;
    this.startMission(Math.max(MISSION_MAX_DEFAULT, seconds));
  }

  /**
   * Ends the briefing: the lead goes back to the island, everyone back to work.
   * If the lead has not yet had his say behind the tribune (one full cycle of
   * addressing the rows and presenting the wall), it winds down once he has,
   * or after BRIEFING_END_GRACE seconds at most. `briefing.active` holds until then.
   */
  endBriefing(): void {
    if (!this.briefingActive) return;
    if (this.leadHasBriefed()) {
      this.finishBriefing();
      return;
    }
    if (!this.briefingEndRequested) {
      this.briefingEndRequested = true;
      this.briefingEndBy = this.time + BRIEFING_END_GRACE;
    }
  }

  /** Whether the lead (if any) has stood behind the tribune for a full cycle. */
  private leadHasBriefed(): boolean {
    const lead = this.leadAgent;
    if (!lead) return true;
    return lead.place === D_PODIUM && lead.mode === M_STAND && this.time - this.podiumSince >= PODIUM_CYCLE;
  }

  private finishBriefing(): void {
    if (!this.briefingActive) return;
    this.briefingActive = false;
    this.briefingEndRequested = false;
    for (const a of this.agents) {
      if (a.seat >= 0 || a.lead) a.nextOuting = this.time + a.rng.range(30, 120);
      // Back into the chair, each at their own moment.
      if (a.seat >= 0 && !a.lead && a !== this.arcAgent) a.holdUntil = this.time + reactionDelay(a.beat);
    }
    this.archiveBriefingEnds();
  }

  // --- Mission mode -------------------------------------------------------------

  /**
   * Mission mode («боевая задача»): nobody goes on a break; whoever is away
   * (a spot, the lounge, a colleague's desk) heads back at a brisk walk after
   * RETURN_DELAY_MIN..MAX; free hackers stay on duty at their desks (typing
   * or reading, the only interaction a short over-the-shoulder help); AM7
   * makes short rounds of the working floor; the cyber-range is off. It ends
   * at endMission() or after `maxSeconds`. Calling it while active only moves
   * the end later. startBriefing() calls it.
   */
  startMission(maxSeconds = MISSION_MAX_DEFAULT): void {
    const span = Number.isFinite(maxSeconds) && maxSeconds > 0 ? maxSeconds : MISSION_MAX_DEFAULT;
    const until = this.time + Math.max(1, span);
    if (this.missionActive) {
      if (until > this.missionUntil) this.missionUntil = until;
      return;
    }
    const now = this.time;
    this.missionActive = true;
    this.missionSince = now;
    this.missionUntil = until;
    this.tempoEpoch++;
    for (const a of this.agents) {
      a.onRange = false;
      a.relaxAt = 0;
      if (a.lead) {
        // Off the map, onto the floor: the first round soon.
        if (a.spot >= 0) this.releaseSpot(a);
        if (!a.visitTarget) a.nextOuting = Math.min(a.nextOuting, now + a.beat.range(8, 25));
        continue;
      }
      if (a.seat < 0 || a === this.arcAgent) continue;
      // Away: back to the desk, each after their own moment (think()).
      a.returnAt = now + a.beat.range(RETURN_DELAY_MIN, RETURN_DELAY_MAX);
      // At the desk: settle into duty over the next few seconds, not all at once.
      if (a.nextBeat > now + BEAT_MIN) a.nextBeat = now + a.beat.range(0.5, BEAT_MIN);
      // Nobody leans back or sits idle on duty; a word with the neighbour is cut short.
      if (a.act === ACT_LEAN || a.act === ACT_IDLE) {
        this.setAct(a, this.baseAct(a, true));
        a.actUntil = 0;
      }
      if (a.pair && a.actUntil > now + 6) a.actUntil = now + a.beat.range(2, 6);
    }
  }

  /**
   * Ends mission mode. Everyone relaxes at their own moment (RELAX_MIN..MAX
   * from now: until then they stay on duty), and the first breaks come
   * RELAX_OUTING_MIN..MAX from now, through the departure limiter — the floor
   * does not rush to the coffee bar together. A briefing still running keeps
   * the floor until it ends.
   */
  endMission(): void {
    if (!this.missionActive) return;
    this.missionActive = false;
    this.tempoEpoch++;
    const now = this.time;
    for (const a of this.agents) {
      if (a.lead) {
        if (!a.visitTarget) a.nextOuting = now + a.beat.range(30, 90);
        continue;
      }
      if (a.seat < 0) continue;
      a.relaxAt = now + a.beat.range(RELAX_MIN, RELAX_MAX);
      a.nextOuting = now + a.beat.range(RELAX_OUTING_MIN, RELAX_OUTING_MAX);
      if (a.nextBeat < a.relaxAt) a.nextBeat = a.relaxAt;
      // Some breathe out when their duty ends: a stretch or a lean back first.
      a.exhale = a.beat.chance(EXHALE_SHARE);
      // Nobody drops into the cyber-range the moment the mission is over either.
      const range = now + a.beat.range(30, 300);
      if (a.nextRange < range) a.nextRange = range;
    }
  }

  /** Mission mode as it stands (always the same object, updated on read). */
  get mission(): Readonly<HqMissionView> {
    const v = this.missionView;
    const on = this.missionActive;
    v.active = on;
    v.elapsed = on ? this.time - this.missionSince : 0;
    v.remaining = on ? Math.max(0, this.missionUntil - this.time) : 0;
    return v;
  }

  /** On duty: during a mission, and after it until the agent's own relaxAt. */
  private onDuty(a: Agent): boolean {
    return this.missionActive || this.time < a.relaxAt;
  }

  /** Whether the lead is speaking (Talk) or listening (Idle) at the podium. */
  setBriefingSpeaking(speaking: boolean): void {
    this.briefingSpeaking = speaking;
  }

  /**
   * The creator has signed in: for `seconds` the lead acknowledges them,
   * turned to the viewer (setCreatorPoint): standing he turns to face it and
   * stands still (Idle, so no chatter murmur over the spoken greeting); in his
   * chair he stops typing and looks up at it. A briefing, the podium and the
   * archive cart keep priority; nothing else changes.
   */
  acknowledgeCreator(seconds: number): void {
    this.creatorAckUntil = this.time + Math.max(0, seconds);
  }

  /** Where the viewer is (the camera), for acknowledgeCreator; may be updated every frame. */
  setCreatorPoint(x: number, y: number, z: number): void {
    this.creatorX = x;
    this.creatorY = y;
    this.creatorZ = z;
  }

  /** Whether the lead is acknowledging the creator right now. */
  get creatorAck(): boolean {
    return this.time < this.creatorAckUntil;
  }

  /** The lead acknowledging the creator, outside a briefing. */
  private acknowledging(a: Agent): boolean {
    return a.lead && !this.briefingActive && this.time < this.creatorAckUntil;
  }

  /**
   * Whether the tribune should stand raised: for the whole briefing, and after
   * it until the lead has stepped away from it (it then sinks back into the floor).
   */
  get tribuneUp(): boolean {
    if (this.briefingActive) return true;
    const lead = this.leadAgent;
    return Boolean(lead && Math.hypot(lead.x - this.podiumX, lead.z - this.podiumZ) < TRIBUNE_LEAVE_DISTANCE);
  }

  /** The briefing's state: running, and whether the lead has reached the podium. */
  get briefing(): { active: boolean; leadAtPodium: boolean } {
    const lead = this.leadAgent;
    return {
      active: this.briefingActive,
      leadAtPodium: Boolean(this.briefingActive && lead && lead.place === D_PODIUM && lead.mode === M_STAND),
    };
  }

  // --- The archive cart: public API -------------------------------------------

  /**
   * The archive cart as the renderer and host see it. Always the same object,
   * updated in place by update(); read it, do not keep a copy of its fields.
   */
  get archive(): Readonly<HqArchiveView> {
    return this.arcView;
  }

  /**
   * How full the server's clutter is (0..1): the parked cart shows 0..4 load
   * tiers with hysteresis. The first call sets the tiers at once (a reload
   * shows the cart as full as it is); later ones rise one tier per 1.5 s.
   */
  setArchiveFill(fill: number): void {
    const f = Number.isFinite(fill) ? Math.min(1, Math.max(0, fill)) : 0;
    this.arcFill = f;
    this.arcFillSettleUntil = 0;
    if (!this.arcFillSeen) {
      this.arcFillSeen = true;
      if (this.arcPhase === ARC_PARKED && !this.arcRunId) {
        this.arcLevel = archiveLevelFor(f);
        this.arcView.level = this.arcLevel;
      }
    }
  }

  /**
   * Whether cart runs are walked at all (the host turns them off when the
   * character has no Push clip): while off, every run is applied at once
   * ("auto", no trip). A run already under way finishes.
   */
  setArchiveRunsEnabled(on: boolean): void {
    this.arcRunsEnabled = Boolean(on);
  }

  /**
   * The server freed `freedBytes` in run `runId`: an idle hacker takes the
   * cart out. Returns who, when someone was picked right away; null when the
   * run waits (a briefing, nobody free), joins the run under way, is applied
   * without a trip, or was seen before (the last RECENT_RUN_IDS ids).
   */
  startArchiveRun(runId: string, freedBytes: number): { agentId: string; name: string } | null {
    if (typeof runId !== "string" || !runId) return null;
    if (this.arcRunIds.includes(runId)) return null;
    this.arcRunIds[this.arcRunIdNext] = runId;
    this.arcRunIdNext = (this.arcRunIdNext + 1) % RECENT_RUN_IDS;
    const freed = Number.isFinite(freedBytes) && freedBytes > 0 ? freedBytes : 0;
    if (this.arcRunId && !this.arcHanded) {
      // Still on its way out: this clean-up goes in the same load.
      this.arcFreed += freed;
      return null;
    }
    if (!this.arcRunsEnabled) {
      this.applyArchiveAuto(runId, freed);
      return null;
    }
    if (this.arcRunId) {
      // Already handed over: one more run once the cart is back.
      this.queueArchiveRun(runId, freed, Infinity);
      return null;
    }
    if (this.pendRunId) {
      this.queueArchiveRun(runId, freed, this.pendNotBefore);
      return null;
    }
    if (!this.briefingActive) {
      const hauler = this.pickHauler(null);
      if (hauler) {
        this.beginArchiveRun(runId, freed, hauler);
        return { agentId: hauler.id, name: hauler.name };
      }
    }
    this.queueArchiveRun(runId, freed, this.briefingActive ? this.time : this.time + RUN_RETRY);
    return null;
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
      // A new status starts from the plain pose (typing when working, leaning back when free),
      // and its loop's tempo is looked at again (typing speeds up on a mission only when working).
      if (status !== agent.status) {
        this.endPair(agent);
        this.setAct(agent, status === WORKING ? ACT_TYPE : ACT_IDLE);
        agent.actUntil = 0;
        agent.rateEpoch = 0;
      }
      // The cyber-range only makes sense while the hacker is working.
      if (status !== WORKING) agent.onRange = false;
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
      this.endPair(agent);
      this.setAct(agent, ACT_IDLE);
      if (agent.visitor) agent.visitor = null;
    }

    for (const agent of next) {
      const wasLead = agent.lead;
      agent.lead = agent === lead;
      if (wasLead && !agent.lead) this.endVisit(agent);
    }
    this.leadAgent = lead;

    this.assignDesks(next, nextById);
    this.deskAgent.fill(null);
    for (const agent of next) {
      if (!agent.lead && agent.seat >= 0 && agent.seat < this.deskAgent.length) this.deskAgent[agent.seat] = agent;
    }

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
    this.departures.refill(step);
    if (this.missionActive && this.time >= this.missionUntil) this.endMission();
    if (this.briefingActive && this.time >= this.briefingUntil) this.finishBriefing();
    else if (this.briefingEndRequested && (this.leadHasBriefed() || this.time >= this.briefingEndBy)) this.finishBriefing();
    this.stepArchive(step);
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
    this.updateArchiveView(step);
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
        this.setAct(a, a.status === WORKING ? ACT_TYPE : ACT_IDLE);
        a.clip = a.status === WORKING ? (a.lead ? HqClip.SitType : a.typeVariant) : HqClip.SitIdle;
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
    a.clipRate = this.loopRate(a, a.clip);
    a.rateEpoch = this.tempoEpoch;
    a.prevClip = a.clip;
    a.prevTime = a.clipTime;
    a.blend = 1;
    this.syncPosition(a);
    this.initLook(a);
  }

  /** New agents line up outside the entrance and walk in one after another. */
  private enterFromSpawn(a: Agent, queueIndex: number): void {
    const spawn = this.layout.spawn;
    // The archive cart is in the doorway: line up further out.
    if (this.cartInDoorArea()) queueIndex += 4;
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
    if (this.briefingActive && (a.lead || a.seat >= 0)) {
      // The briefing holds the lead and everyone with a desk: no outings.
      if (a.spot >= 0) this.releaseSpot(a);
      if (a.lounge >= 0) this.releaseLounge(a);
      if (a.visitTarget) this.endVisit(a);
      return;
    }
    if (a === this.arcAgent && !a.lead) {
      // Hauling the archive cart (or due back at it): no outings, no range.
      if (a.spot >= 0) this.releaseSpot(a);
      if (a.lounge >= 0) this.releaseLounge(a);
      a.onRange = false;
      return;
    }
    if (a.lead) {
      if (a.status === ERROR) {
        this.releaseSpot(a);
        this.endVisit(a);
        return;
      }
      const t = a.visitTarget;
      if (t) {
        const done = a.place === D_VISIT && a.mode === M_STAND && now >= a.leaveAt;
        if (!this.hostValid(a, t) || done) {
          this.endVisit(a);
          // A mission's rounds come thick and fast.
          a.nextOuting = this.missionActive
            ? now + a.beat.range(MISSION_LEAD_GAP_MIN, MISSION_LEAD_GAP_MAX)
            : now + a.rng.range(60, 150);
        }
      } else if (a.spot >= 0) {
        if (this.missionActive) {
          // No time for the map: back to the floor.
          this.releaseSpot(a);
          a.nextOuting = now + a.beat.range(MISSION_LEAD_GAP_MIN, MISSION_LEAD_GAP_MAX);
        } else if (a.place === D_SPOT && a.mode === M_STAND && now >= a.leaveAt) {
          this.releaseSpot(a);
          a.nextOuting = now + a.rng.range(60, 150);
        }
      } else if (a.mode === M_SEATED && now >= a.nextOuting) {
        if (this.missionActive) {
          if (!this.startVisit(a)) a.nextOuting = now + a.beat.range(10, 20);
        } else if (!(a.rng.chance(0.6) && this.startVisit(a)) && !this.reserveOuting(a, K_MAP)) {
          a.nextOuting = now + a.rng.range(20, 40);
        }
      }
      return;
    }
    if (a.seat >= 0) {
      const duty = this.onDuty(a);
      // Cyber-range: a working hacker enters it from their own workstation,
      // stays seated for a session, then drops back to ordinary work. Never
      // during a mission: that is the real operation, not a drill.
      if (this.missionActive) {
        a.onRange = false;
      } else if (a.status === WORKING && a.place === D_SEAT && a.mode === M_SEATED) {
        if (a.onRange) {
          if (now >= a.rangeUntil) {
            a.onRange = false;
            a.nextRange = now + a.rng.range(RANGE_NEXT_MIN, RANGE_NEXT_MAX);
          }
        } else if (now >= a.nextRange) {
          a.onRange = true;
          a.rangeUntil = now + a.rng.range(RANGE_MIN, RANGE_MAX);
        }
      } else if (a.onRange) {
        a.onRange = false;
      }
      if (a.visitTarget) {
        // At (or on the way to) a working colleague's shoulder.
        const done = a.place === D_VISIT && a.mode === M_STAND && now >= a.leaveAt;
        // A mission recalls a plain visit (its own short help stays).
        const recalled = this.missionActive && !a.helping && now >= a.returnAt;
        if (a.status !== IDLE || !this.hostValid(a, a.visitTarget) || done || recalled) {
          this.endVisit(a);
          a.nextBeat = now + a.beat.range(BEAT_MIN, 2 * BEAT_MIN);
        }
      } else if (a.spot >= 0) {
        if (a.status !== IDLE) this.releaseSpot(a);
        else if (duty && now >= a.returnAt) this.releaseSpot(a);
        else if (a.place === D_SPOT && a.mode === M_STAND && now >= a.leaveAt) {
          this.releaseSpot(a);
          a.nextOuting = now + a.rng.range(90, 300);
        }
      } else if (a.lounge >= 0) {
        // The seat stays held until the agent has stood up (releaseHold).
        if (a.status !== IDLE) this.releaseLounge(a);
        else if (duty && now >= a.returnAt) this.releaseLounge(a);
        else if (a.place === D_LOUNGE && a.mode === M_SEATED && now >= a.leaveAt) {
          this.releaseLounge(a);
          a.nextOuting = now + a.rng.range(90, 300);
        }
      } else if (a.mode === M_SEATED && a.place === D_SEAT && (a.status === IDLE || a.status === WORKING)) {
        this.deskActs(a, duty);
      } else if (a.pair) {
        this.endPair(a);
      }
      return;
    }
    // No desk (more agents than desks): hang out in the lounge, drift between spots.
    // A visit started from a desk this agent no longer has ends here.
    if (a.visitTarget) this.endVisit(a);
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
    if (a === this.arcAgent) {
      const phase = this.arcPhase;
      if (phase === ARC_PUSH || phase === ARC_HANDOVER) {
        // A briefing leaves the cart standing, unless it first has to be cleared.
        if (!this.briefingActive || this.arcClearing) return D_PUSH;
      } else if (!this.briefingActive) {
        if (phase === ARC_FETCH) return D_CART;
        // Back at the desk after a briefing, about to go back to the cart: wait standing.
        if (phase === ARC_LEFT && a.seat >= 0 && a.status !== ERROR) return D_BRIEF;
      }
    }
    if (this.briefingActive) {
      if (a.lead) return D_PODIUM;
      if (a.seat >= 0) return D_BRIEF;
    }
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
    // Reaction delay (a briefing's start or end): whoever is sitting or
    // standing still keeps at it a moment longer. Walkers turn at once.
    if (a.holdUntil > this.time && a.mode !== M_WALK && a.mode !== M_PUSH) return;
    const kind = this.intentKind(a);
    let seat = -1;
    let spot = -1;
    let slot = -1;
    if (kind === D_SEAT || kind === D_ERROR || kind === D_BRIEF) seat = a.seat;
    else if (kind === D_LOUNGE) seat = a.lounge;
    else if (kind === D_VISIT) seat = a.visitTarget ? a.visitTarget.seat : -1;
    else if (kind === D_SPOT) {
      spot = a.spot;
      slot = a.slot;
    } else if (kind === D_CART) {
      // A new fetch (another grab pose) is a new destination.
      spot = this.arcFetchSerial;
    }
    if (a.mode === M_PUSH) {
      if (kind === D_CART || kind === D_PUSH) {
        a.dest = kind;
        a.destSeat = seat;
        a.destSpot = spot;
        a.destSlot = slot;
        return;
      }
      this.leaveCart(a, this.clearNodeNear(a.bx, a.bz));
    }
    if (kind === a.dest && seat === a.destSeat && spot === a.destSpot && slot === a.destSlot) return;
    // A held gesture (leaning back, a word with the neighbour, a hand on a
    // colleague's chair) plays its outro first: at most about a second.
    // A stretch is simply crossfaded out of (its arms are clear of the desk).
    if ((a.mode === M_SEATED || a.mode === M_STAND) && a.clip !== HqClip.SitStretch && !this.gestureDone(a)) {
      this.releaseGesture(a);
      return;
    }
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

  /** AM7 drops by a working hacker: to their shoulder, never next to another guest. */
  private startVisit(a: Agent): boolean {
    const n = this.agents.length;
    if (n < 2) return false;
    for (let k = 0; k < 16; k++) {
      const t = this.agents[a.rng.int(n)];
      if (t === a || t.lead || t.seat < 0 || t.status !== WORKING || t.mode !== M_SEATED || t.visitor) continue;
      if (t.place !== D_SEAT || t.seat >= this.deskGuest.length || !this.canHost(t)) continue;
      if (guestNearby(this.nb, this.deskGuest, t.seat, GUEST_SPACING)) continue;
      this.beginVisit(a, t, false, false);
      return true;
    }
    return false;
  }

  /**
   * A free hacker walks over to a working neighbour (at most PEER_ROWS rows
   * and PEER_DESKS desks away) and looks over their shoulder: within the
   * concurrent limit (a mission's help limit on duty), never next to another
   * guest, and through the departure limiter.
   */
  private startPeerVisit(a: Agent, duty: boolean): boolean {
    const n = this.agents.length;
    const cap = duty ? helpVisitLimit(n) : peerVisitLimit(n);
    if (this.visitCount >= cap) return false;
    const s = a.seat;
    if (s < 0 || s >= this.deskGuest.length) return false;
    const nb = this.nb;
    const start = nb.nearStart[s];
    const count = nb.nearStart[s + 1] - start;
    if (count <= 0) return false;
    const offset = a.beat.int(count);
    for (let k = 0; k < count; k++) {
      const desk = nb.near[start + ((offset + k) % count)];
      const t = this.deskAgent[desk];
      if (!t || t === a || !t.alive || t.lead || t.seat !== desk || t === this.arcAgent) continue;
      if (t.status !== WORKING || t.mode !== M_SEATED || t.place !== D_SEAT || t.visitor || !this.canHost(t)) continue;
      if (guestNearby(nb, this.deskGuest, desk, GUEST_SPACING)) continue;
      if (!this.departures.take()) return false;
      this.beginVisit(a, t, true, duty);
      return true;
    }
    return false;
  }

  /** A host is at work at the screen: typing or reading, not in a pair or a held gesture. */
  private canHost(t: Agent): boolean {
    return !t.pair && (t.act === ACT_TYPE || t.act === ACT_READ) && this.gestureDone(t);
  }

  private beginVisit(a: Agent, t: Agent, peer: boolean, help: boolean): void {
    a.visitTarget = t;
    t.visitor = a;
    a.visitSeat = t.seat;
    this.deskGuest[t.seat]++;
    a.peerVisit = peer;
    a.helping = help;
    if (peer) this.visitCount++;
  }

  /** The host of a visit can still be visited: present, working, in their own chair. */
  private hostValid(a: Agent, t: Agent): boolean {
    return (
      t.alive &&
      t.seat >= 0 &&
      t.seat === a.visitSeat &&
      t.status === WORKING &&
      t.place === D_SEAT &&
      (t.mode === M_SEATED || t.mode === M_SIT)
    );
  }

  private endVisit(a: Agent): void {
    const t = a.visitTarget;
    if (!t) return;
    if (t.visitor === a) t.visitor = null;
    a.visitTarget = null;
    const s = a.visitSeat;
    if (s >= 0 && s < this.deskGuest.length && this.deskGuest[s] > 0) this.deskGuest[s]--;
    a.visitSeat = -1;
    if (a.peerVisit && this.visitCount > 0) this.visitCount--;
    a.peerVisit = false;
    a.helping = false;
  }

  // --- Acts at one's own desk (core/beats.ts) ---------------------------------------

  /** The plain act of a hacker at their desk: typing when working; free, sitting back (reading on duty). */
  private baseAct(a: Agent, duty: boolean): number {
    return a.status === WORKING ? ACT_TYPE : duty ? ACT_READ : ACT_IDLE;
  }

  /** Changes the act, keeping the hall's concurrent counts. */
  private setAct(a: Agent, act: number): void {
    if (a.act === act) return;
    if (a.act === ACT_LEAN) this.leanCount--;
    else if (a.act === ACT_STRETCH) this.stretchCount--;
    a.act = act;
    a.actSince = this.time;
    if (act === ACT_LEAN) this.leanCount++;
    else if (act === ACT_STRETCH) this.stretchCount++;
  }

  /**
   * A hacker seated at their own desk, working or free: a timed act runs out,
   * a free one may go on a break, and a new beat is picked when it is due.
   * Hosting a visit holds everything else.
   */
  private deskActs(a: Agent, duty: boolean): void {
    const now = this.time;
    if (a.pair && !this.pairValid(a)) this.endPair(a);
    if (a.actUntil > 0 && now >= a.actUntil) {
      if (a.pair) this.endPair(a);
      else {
        this.setAct(a, this.baseAct(a, duty));
        a.actUntil = 0;
        a.nextBeat = now + beatPause(duty, a.fidget, a.beat, a.status === WORKING);
      }
    }
    if (a.visitor || a.actUntil > 0 || a.pair) return;
    if (a.status === IDLE && !duty && now >= a.nextOuting) {
      if (!this.gestureDone(a)) return;
      // One departure at a time across the hall: otherwise wait a moment.
      if (!this.departures.take()) a.nextOuting = now + a.beat.range(0.3, 1.5);
      else if (!this.reserveOuting(a, -1)) {
        this.departures.refund();
        a.nextOuting = now + a.rng.range(20, 60);
      }
      return;
    }
    if (now >= a.nextBeat) this.seatBeat(a, duty);
  }

  /**
   * Picks and starts a beat at one's own desk. A beat that cannot happen now
   * (a limit, nobody to talk to) leaves the plain act until the next one.
   */
  private seatBeat(a: Agent, duty: boolean): void {
    const now = this.time;
    const working = a.status === WORKING;
    const n = this.agents.length;
    let beat = pickBeat(working, duty, a.social, a.beat);
    if (a.exhale) {
      a.exhale = false;
      if (!duty) beat = a.beat.chance(0.5) ? BEAT_STRETCH : BEAT_LEAN;
    }
    a.nextBeat = now + beatPause(duty, a.fidget, a.beat, working);
    switch (beat) {
      case BEAT_VISIT:
        if (!working && this.startPeerVisit(a, duty)) {
          a.nextBeat = now + BEAT_MIN;
          return;
        }
        break;
      case BEAT_TURN:
        if (!a.onRange && this.startPair(a, duty)) return;
        break;
      case BEAT_LEAN:
        if (!a.onRange && this.leanCount < leanLimit(n)) {
          this.setAct(a, ACT_LEAN);
          a.actUntil = now + beatSeconds(beat, working, duty, a.beat);
          return;
        }
        break;
      case BEAT_STRETCH:
        if (this.stretchCount < stretchLimit(n) && now - a.lastStretch >= STRETCH_GAP) {
          this.setAct(a, ACT_STRETCH);
          a.lastStretch = now;
          a.actUntil = now + STRETCH_SECONDS;
          return;
        }
        break;
      case BEAT_READ:
        this.setAct(a, ACT_READ);
        a.actUntil = now + beatSeconds(beat, working, duty, a.beat);
        return;
      case BEAT_TYPE:
        this.setAct(a, ACT_TYPE);
        return;
      case BEAT_IDLE:
        this.setAct(a, ACT_IDLE);
        return;
      default:
        break;
    }
    this.setAct(a, this.baseAct(a, duty));
  }

  /** Can `b` (at desk `desk`) turn to talk with a neighbour right now? */
  private pairFree(b: Agent, desk: number): boolean {
    return (
      b.alive &&
      !b.lead &&
      b.seat === desk &&
      b.mode === M_SEATED &&
      b.place === D_SEAT &&
      (b.status === WORKING || b.status === IDLE) &&
      !b.pair &&
      !b.visitor &&
      !b.visitTarget &&
      b.spot < 0 &&
      b.lounge < 0 &&
      !b.onRange &&
      b !== this.arcAgent &&
      b.actUntil === 0 &&
      this.time - b.actSince >= BEAT_MIN &&
      b.holdUntil <= this.time &&
      this.gestureDone(b)
    );
  }

  /**
   * A word with a seated neighbour: both turn to each other (SitTurnL/R), the
   * one who starts talks first while the other listens, then they swap
   * (the second gets its clip half a loop on, holdShift). Within the hall's
   * pair limit; only with a neighbour who is sitting at their desk and free.
   */
  private startPair(a: Agent, duty: boolean): boolean {
    if (this.pairCount >= pairLimit(this.agents.length, duty)) return false;
    const s = a.seat;
    if (s < 0 || s >= this.nbLeft.length || !this.pairFree(a, s)) return false;
    const leftFirst = a.beat.chance(0.5);
    for (let k = 0; k < 2; k++) {
      const left = (k === 0) === leftFirst;
      const d = left ? this.nbLeft[s] : this.nbRight[s];
      if (d < 0) continue;
      const b = this.deskAgent[d];
      if (!b || b === a || !this.pairFree(b, d)) continue;
      a.pair = b;
      b.pair = a;
      a.pairSecond = false;
      b.pairSecond = true;
      this.setAct(a, left ? ACT_TURN_L : ACT_TURN_R);
      this.setAct(b, left ? ACT_TURN_R : ACT_TURN_L);
      a.actUntil = b.actUntil = this.time + beatSeconds(BEAT_TURN, a.status === WORKING, duty, a.beat);
      this.pairCount++;
      return true;
    }
    return false;
  }

  /** Both of a pair still sit at their desks, free to talk. */
  private pairValid(a: Agent): boolean {
    const b = a.pair;
    if (!b || b.pair !== a || this.briefingActive) return false;
    for (let k = 0; k < 2; k++) {
      const x = k === 0 ? a : b;
      if (!x.alive || x.mode !== M_SEATED || x.place !== D_SEAT || x.visitor || x.visitTarget) return false;
      if (x.status !== WORKING && x.status !== IDLE) return false;
    }
    return true;
  }

  /** Ends a seated pair: both turn back to their screens (their clips play the outro). */
  private endPair(a: Agent): void {
    const b = a.pair;
    if (!b) return;
    a.pair = null;
    if (b.pair === a) b.pair = null;
    if (this.pairCount > 0) this.pairCount--;
    this.pairEnded(a);
    this.pairEnded(b);
  }

  private pairEnded(x: Agent): void {
    const duty = this.onDuty(x);
    this.setAct(x, this.baseAct(x, duty));
    x.actUntil = 0;
    x.pairSecond = false;
    const next = this.time + beatPause(duty, x.fidget, x.beat, x.status === WORKING);
    if (x.nextBeat < next) x.nextBeat = next;
  }

  /** A guest has arrived at this hacker's shoulder: they show their screen (SitShowScreen). */
  private hosting(a: Agent): boolean {
    const v = a.visitor;
    return v !== null && v.visitTarget === a && v.place === D_VISIT && v.mode === M_STAND;
  }

  /**
   * Whether the current clip may be left now: loops always; a one-shot
   * gesture (SitStretch) or an intro/hold/outro clip only once played out
   * (or backed out of its intro). They start and end on the base pose, so
   * the next crossfade never drags hands through the desk or the chair.
   */
  private gestureDone(a: Agent): boolean {
    const c = a.clip;
    if (CLIP_LOOP[c] || c === HqClip.SitDown) return true;
    return a.clipRate < 0 ? a.clipTime <= 1e-3 : a.clipTime >= CLIP_DURATION[c] - 1e-3;
  }

  /**
   * Lets an intro/hold/outro clip finish: from the intro it backs out
   * (plays backward to its first frame); in the hold, the rest of the loop
   * plays when it is short, else the clip crossfades to the hold's end;
   * then the outro plays.
   */
  private releaseGesture(a: Agent): void {
    const c = a.clip;
    const h0 = CLIP_HOLD0[c];
    if (h0 < 0 || !a.holdOn) return;
    a.holdOn = false;
    a.holdShift = 0;
    if (a.clipTime < h0) {
      if (a.clipRate > 0) a.clipRate = -a.clipRate;
      return;
    }
    const rate = a.clipRate > 0 ? a.clipRate : 1;
    const h1 = CLIP_HOLD1[c];
    if ((h1 - a.clipTime) / rate > RELEASE_PLAY) {
      a.prevClip = c;
      a.prevTime = a.clipTime;
      a.prevRate = rate;
      a.clipTime = h1;
      a.blend = 0;
      a.blendDur = CLIP_BLEND[c];
    }
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
    const rooms: HqRect[] = [...layout.meetingRooms, ...layout.lounges, ...layout.serverRooms, layout.am7Office];
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
    const line = this.spotKind[spot] === K_MAP || this.spotKind[spot] === K_SERVER;
    for (let s = 0; s < cap; s++) {
      if (this.spotAgents[base + s] || !this.slotOk[base + s]) continue;
      const score = line ? Math.abs(s - mid) : s;
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }
    if (best >= 0 || !allowOverflow) return best;
    // Circles overflow into one more ring only: its places sit between the
    // first ring's, so walkers pass between people. Further rings line up
    // behind the first, and anyone walking out to them would walk through
    // someone; the crowd goes to another spot instead.
    const end = line ? MAX_SLOTS : Math.min(MAX_SLOTS, cap * 2);
    for (let s = cap; s < end; s++) if (!this.spotAgents[base + s] && this.slotOk[base + s]) return s;
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
      kind = r < 0.35 ? K_COFFEE : r < 0.65 ? K_MAP : r < 0.85 ? K_LOUNGE : r < 0.95 ? K_MEETING : K_SERVER;
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
    if (kind === K_MAP || kind === K_SERVER) {
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

  /** At the podium: true while the lead plays Present (after each PODIUM_TALK of addressing the rows). */
  private podiumPresenting(): boolean {
    const t = this.time - this.podiumSince;
    return t - Math.floor(t / PODIUM_CYCLE) * PODIUM_CYCLE >= PODIUM_TALK;
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

  /** Standing at a spot (arrived, not just on the way). */
  private standsAt(b: Agent, spot: number): boolean {
    return b.alive && b.mode === M_STAND && b.place === D_SPOT && b.placeSpot === spot;
  }

  /**
   * Who has the word at a spot: one speaker at a time, for SPOT_TURN_MIN..MAX
   * seconds, then a short pause and someone else (anyone but the last one
   * when there is a choice). Null during a pause or with fewer than two there.
   * `by` is whoever asks this frame; its beat generator makes the choices.
   */
  private spotTalker(spot: number, by: Agent): Agent | null {
    const now = this.time;
    let s = this.spotSpeaker[spot];
    if (s && (now >= this.spotTurnUntil[spot] || !this.standsAt(s, spot))) {
      this.spotLast[spot] = s;
      this.spotSpeaker[spot] = null;
      s = null;
      this.spotTurnUntil[spot] = now + by.beat.range(SPOT_GAP_MIN, SPOT_GAP_MAX);
    }
    if (!s && now >= this.spotTurnUntil[spot]) {
      s = this.pickSpeaker(spot, by);
      if (s) {
        this.spotSpeaker[spot] = s;
        this.spotTurnUntil[spot] = now + by.beat.range(SPOT_TURN_MIN, SPOT_TURN_MAX);
      }
    }
    return s;
  }

  private pickSpeaker(spot: number, by: Agent): Agent | null {
    const base = spot * MAX_SLOTS;
    const last = this.spotLast[spot];
    let total = 0;
    let fresh = 0;
    for (let k = 0; k < MAX_SLOTS; k++) {
      const b = this.spotAgents[base + k];
      if (!b || !this.standsAt(b, spot)) continue;
      total++;
      if (b !== last) fresh++;
    }
    if (total < 2) return null;
    const skipLast = fresh > 0;
    let pick = by.beat.int(skipLast ? fresh : total);
    for (let k = 0; k < MAX_SLOTS; k++) {
      const b = this.spotAgents[base + k];
      if (!b || !this.standsAt(b, spot) || (skipLast && b === last)) continue;
      if (pick === 0) return b;
      pick--;
    }
    return null;
  }

  // --- Routing --------------------------------------------------------------

  private destAnchor(a: Agent): number {
    if (a.dest === D_SPOT) return this.spotNode[a.destSpot];
    if (a.dest === D_PODIUM) return this.podiumNode;
    if (a.dest === D_CART) return this.arcGrabNode;
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
      case D_BRIEF:
        // A briefing is listened to standing at one's own chair.
        n = this.pushWp(n, this.viaX[s], this.viaZ[s], -1);
        return this.pushWp(n, this.apprX[s], this.apprZ[s], -1);
      case D_ERROR:
        return this.pushWp(n, this.viaX[s], this.viaZ[s], -1);
      case D_LOUNGE:
        // The seat's nav node is the aisle point right in front of it.
        return this.pushWp(n, this.apprX[s], this.apprZ[s], -1);
      case D_VISIT:
        // From the ring node behind the host's chair straight to their shoulder.
        return this.pushWp(n, this.shX[s], this.shZ[s], -1);
      case D_SPOT:
        this.slotPosition(a.destSpot, a.destSlot);
        return this.pushWp(n, this.tmpX, this.tmpZ, -1);
      case D_CART:
        // Up behind the handle along the cart's heading.
        if (this.arcGrabQ) n = this.pushWp(n, this.arcQX, this.arcQZ, -1);
        return this.pushWp(n, this.arcGrabX, this.arcGrabZ, -1);
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
    const sameDesk = !walking && a.placeSeat === a.destSeat && atDesk(a.place) && atDesk(a.dest) && a.place !== a.dest;
    if (sameDesk) {
      // Between the chair and the spot beside the desk: no detour via the aisle.
      n = this.pushTail(a, 0);
      if (a.dest === D_SEAT || a.dest === D_BRIEF) {
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
      if (a.place === D_SEAT || a.place === D_BRIEF) n = this.pushWp(n, this.viaX[seat], this.viaZ[seat], -1);
      start =
        a.place === D_SPOT ? this.spotNode[a.placeSpot] : a.place === D_PODIUM ? this.podiumNode : seat >= 0 ? this.seatNode[seat] : -1;
      if (start >= 0) {
        this.nodePos(start);
        n = this.pushWp(n, this.tmpX, this.tmpZ, start);
      }
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
          this.setLoop(a, this.seatedClip(a));
        }
        break;
      case M_SEATED: {
        const clip = this.seatedClip(a);
        if (a.clip !== clip) {
          // A gesture plays out (or backs out of its intro) before the next clip.
          if (this.gestureDone(a)) this.setLoop(a, clip);
          else this.releaseGesture(a);
        } else if (a.rateEpoch !== this.tempoEpoch && a.clipRate > 0) {
          // A mission started or ended, or the status changed: re-read the tempo once.
          a.clipRate = this.loopRate(a, clip);
          a.rateEpoch = this.tempoEpoch;
        }
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
      case M_PUSH:
        this.stepCart(a, dt);
        break;
      default:
        this.stepStand(a, dt);
    }
    // Clips: the current one advances at its rate (Walk is distance-driven),
    // the previous one keeps playing underneath the crossfade.
    if (a.mode !== M_SIT && a.mode !== M_RISE) a.clipTime += a.clipRate * dt;
    if (a.holdOn && a.clipRate > 0) {
      // Intro/hold/outro clips loop inside their hold while the act lasts.
      const h0 = CLIP_HOLD0[a.clip];
      if (h0 >= 0 && a.clipTime >= h0) {
        if (a.holdShift > 0) {
          a.clipTime += a.holdShift;
          a.holdShift = 0;
        }
        const h1 = CLIP_HOLD1[a.clip];
        if (a.clipTime >= h1) a.clipTime = h0 + ((a.clipTime - h0) % (h1 - h0));
      }
    }
    a.clipTime = wrapClip(a.clip, a.clipTime);
    if (a.blend < 1) {
      a.prevTime = wrapClip(a.prevClip, a.prevTime + a.prevRate * dt);
      a.blend = Math.min(1, a.blend + dt / a.blendDur);
    }
    this.syncPosition(a);
    this.desiredLook(a);
  }

  /**
   * At one's own desk: the act's clip (core/beats.ts picks the acts), or
   * showing the screen to a guest who has arrived at the shoulder. Elsewhere
   * (the lounge) sitting idle. The lead types while working, as before.
   */
  private seatedClip(a: Agent): number {
    if (a.place !== D_SEAT) return HqClip.SitIdle;
    // Hands off the keys while looking up at the creator.
    if (this.acknowledging(a)) return HqClip.SitIdle;
    if (a.lead) return a.status === WORKING ? HqClip.SitType : HqClip.SitIdle;
    if (this.hosting(a)) return HqClip.SitShowScreen;
    switch (a.act) {
      case ACT_TYPE:
        // Free but on duty: the second variant (reading and clicking through).
        return a.status !== WORKING && this.onDuty(a) ? HqClip.SitType2 : a.typeVariant;
      case ACT_READ:
        return HqClip.SitRead;
      case ACT_LEAN:
        return HqClip.SitLeanBack;
      case ACT_STRETCH:
        return HqClip.SitStretch;
      case ACT_TURN_L:
        return HqClip.SitTurnL;
      case ACT_TURN_R:
        return HqClip.SitTurnR;
      default:
        return HqClip.SitIdle;
    }
  }

  /** A standing listener's clip (a briefing, a spot's speaker): StandListen or Idle, per agent. */
  private listenClip(a: Agent): number {
    return a.listenStyle === LISTEN_IDLE ? HqClip.Idle : HqClip.StandListen;
  }

  /** Playback rate of a loop for this agent: its own tempo; typing speeds up on a mission. */
  private loopRate(a: Agent, clip: number): number {
    // Present is timed from its start; a seated pair keeps its half-loop offset at one rate.
    if (clip === HqClip.Present || clip === HqClip.SitTurnL || clip === HqClip.SitTurnR) return 1;
    if ((clip === HqClip.SitType || clip === HqClip.SitType2) && this.missionActive && a.status === WORKING) {
      return a.missionRate;
    }
    if (clip === HqClip.StandListen && a.listenStyle === LISTEN_SLOW) return a.tempo * LISTEN_SLOW_TEMPO;
    return a.tempo;
  }

  /**
   * Enters a standing or seated loop at a random frame and the agent's own
   * tempo, so nobody moves in step with anyone else (not for Present, whose
   * gesture is timed from its start, nor for the distance-driven gaits).
   * Gestures (one shots, intro/hold/outro clips) start at their first frame,
   * the base pose; a pair's second voice gets its half-loop offset.
   */
  private setLoop(a: Agent, clip: number): void {
    const rate = this.loopRate(a, clip);
    a.rateEpoch = this.tempoEpoch;
    if (clip === a.clip) {
      a.clipRate = rate;
      return;
    }
    const time = clip === HqClip.Present || !CLIP_LOOP[clip] ? 0 : a.beat.next() * CLIP_DURATION[clip];
    this.setClip(a, clip, time, rate);
    if ((clip === HqClip.SitTurnL || clip === HqClip.SitTurnR) && a.pairSecond) {
      a.holdShift = 0.5 * (CLIP_HOLD1[clip] - CLIP_HOLD0[clip]);
    }
  }

  private setClip(a: Agent, clip: number, time: number, rate: number): void {
    if (clip === a.clip) {
      a.clipRate = rate;
      return;
    }
    const fade = blendTime(a.clip, clip);
    a.holdOn = CLIP_HOLD0[clip] >= 0;
    a.holdShift = 0;
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
      a.blendDur = fade;
      return;
    }
    a.prevClip = a.clip;
    a.prevTime = a.clipTime;
    a.prevRate = a.clipRate === 0 ? 1 : a.clipRate;
    a.clip = clip;
    a.clipTime = time;
    a.clipRate = rate;
    a.blend = 0;
    a.blendDur = fade;
  }

  private stepWalk(a: Agent, index: number, dt: number): void {
    if (a.wpIdx >= a.wpCount) {
      if (a.needsRoute || a.wpMore) {
        if (a.wpMore) a.needsRoute = true;
        a.moving = false;
        this.setLoop(a, HqClip.Idle);
        return;
      }
      if (a.dest === D_LOUNGE && !this.turnToSit(a, dt)) return;
      this.arrive(a);
      return;
    }
    const slow = this.separate(a, index, dt);
    let tx = a.wpX[a.wpIdx];
    let tz = a.wpZ[a.wpIdx];
    let dx = tx - a.bx;
    let dz = tz - a.bz;
    let dist = Math.hypot(dx, dz);
    // Called to a briefing: back to the desk at a run, walking the last steps.
    const hurry =
      this.briefingActive && a.dest === D_BRIEF && !(a.wpIdx === a.wpCount - 1 && dist < RUN_SETTLE && !a.wpMore);
    const gait = hurry ? HqClip.Run : HqClip.Walk;
    if (a.clip !== gait) this.setClip(a, gait, 0, 0);
    let want = dist > 1e-3 ? Math.atan2(dx, dz) : a.facing;
    if (a.wpIdx === a.wpCount - 1 && dist < 0.55 && !a.wpMore) {
      // Line up with the desk while taking the last steps. A lounge seat is
      // walked up to face first; the walker turns round on the spot (turnToSit).
      if (a.dest === D_SEAT || a.dest === D_BRIEF) want = this.seatRot[a.destSeat];
      else if (a.dest === D_ERROR) want = this.errFacing[a.destSeat];
      else if (a.dest === D_VISIT) want = this.shRot[a.destSeat];
      else if (a.dest === D_PODIUM) want = this.podiumFacing;
      else if (a.dest === D_CART) want = this.arcGrabRot;
    }
    a.facing = turnToward(a.facing, want, TURN_RATE * dt);
    const err = Math.abs(wrapAngle(want - a.facing));
    // A mission calls whoever is away back to their desk at a brisk walk.
    const brisk = !hurry && this.missionActive && a.dest === D_SEAT && !a.lead;
    let speed = a.speed * (hurry ? RUN_FACTOR : brisk ? BRISK_FACTOR : 1) * slow;
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
    a.clipTime += moved / (hurry ? RUN_NATIVE_SPEED : WALK_NATIVE_SPEED);

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
    if (a.clip !== HqClip.Idle) this.setLoop(a, HqClip.Idle);
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
    if (this.arcPhase !== ARC_PARKED && (a !== this.arcAgent || this.arcPhase !== ARC_FETCH)) {
      // Out of its bay the archive cart is two discs along its axis: step
      // aside of it, and wait while it rolls across in front. The hauler too
      // once he has let go of it (off to a briefing); only on his way up to
      // the handle does he walk right up to it.
      const hx = Math.sin(this.arcCartRot);
      const hz = Math.cos(this.arcCartRot);
      const reach = CART_GHOST_R + HQ_AGENT_RADIUS * 0.75;
      const rolling = this.arcV > 0.05;
      for (let g = -1; g <= 1; g += 2) {
        const dx = a.x - (this.arcCartX + hx * CART_GHOST_OFFSET * g);
        const dz = a.z - (this.arcCartZ + hz * CART_GHOST_OFFSET * g);
        const d2 = dx * dx + dz * dz;
        if (d2 >= reach * reach) continue;
        const d = Math.sqrt(d2 > 1e-8 ? d2 : 1e-8);
        const push = ((reach - d) / reach) * 2.5;
        const side = dx * rx + dz * rz >= 0 ? 1 : -1;
        pushX += rx * side * push;
        pushZ += rz * side * push;
        if (rolling && -(dx * fx + dz * fz) / d > 0.3) {
          slow = Math.min(slow, Math.max(0, (d - CART_GHOST_R) / (reach - CART_GHOST_R + 0.3)));
        }
      }
    }
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
        // Back in one's own chair: the plain pose first, the next beat a while
        // later, and this sitting's typing variant.
        this.setAct(a, this.baseAct(a, this.onDuty(a)));
        a.actUntil = 0;
        a.actSince = this.time;
        a.typeVariant = a.beat.chance(0.5) ? HqClip.SitType : HqClip.SitType2;
        if (a.nextBeat < this.time + BEAT_MIN) a.nextBeat = this.time + a.beat.range(BEAT_MIN, 3 * BEAT_MIN);
        this.setClip(a, HqClip.SitDown, 0, 1);
        return;
      case D_ERROR:
        a.mode = M_STAND;
        a.place = D_ERROR;
        a.placeSeat = s;
        this.setLoop(a, HqClip.Idle);
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
        // Listening first: the spot's speaker turns (spotTalker) say who talks.
        this.setLoop(a, HqClip.Idle);
        return;
      }
      case D_VISIT:
        a.mode = M_STAND;
        a.place = D_VISIT;
        a.placeSeat = s;
        if (a.lead) {
          a.leaveAt =
            this.time +
            (this.missionActive
              ? a.beat.range(MISSION_LEAD_VISIT_MIN, MISSION_LEAD_VISIT_MAX)
              : a.rng.range(LEAD_VISIT_MIN, LEAD_VISIT_MAX));
        } else {
          a.leaveAt = this.time + peerVisitSeconds(a.helping, a.beat);
        }
        this.setLoop(a, HqClip.StandLookOver);
        return;
      case D_BRIEF:
        a.mode = M_STAND;
        a.place = D_BRIEF;
        a.placeSeat = s;
        this.setLoop(a, this.briefingActive ? this.listenClip(a) : HqClip.Idle);
        return;
      case D_PODIUM:
        a.mode = M_STAND;
        a.place = D_PODIUM;
        a.placeSeat = -1;
        this.podiumSince = this.time;
        this.setLoop(a, this.briefingSpeaking ? HqClip.Talk : HqClip.Idle);
        return;
      case D_CART:
        if (a === this.arcAgent && this.arcPhase === ARC_FETCH) {
          this.gripCart(a);
          return;
        }
        a.mode = M_STAND;
        a.place = D_NONE;
        this.setLoop(a, HqClip.Idle);
        return;
      default:
        a.mode = M_STAND;
        a.place = D_NONE;
        this.setLoop(a, HqClip.Idle);
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
        // One speaker at a time: the speaker turns to the nearest listener,
        // the others to the speaker (to the nearest one during a pause) and listen.
        const speaker = this.spotTalker(a.placeSpot, a);
        clip = speaker === a ? HqClip.Talk : this.listenClip(a);
        const to = speaker && speaker !== a ? speaker : partner;
        want = Math.atan2(to.x - a.x, to.z - a.z);
      } else {
        const spot = this.layout.socialSpots[a.placeSpot];
        const kind = this.spotKind[a.placeSpot];
        want =
          kind === K_MAP || kind === K_SERVER ? spot.rotY : Math.atan2(spot.x - a.x, spot.z - a.z);
      }
    } else if (a.place === D_VISIT && a.visitTarget) {
      // At the host's shoulder, facing their screen, a hand on their chair
      // back, pointing at the screen now and then (AM7 and colleagues alike).
      want = this.shRot[a.placeSeat];
      clip = HqClip.StandLookOver;
    } else if (a.place === D_PODIUM) {
      // Facing the rows, talking; every cycle the Present clip turns him to
      // show the wall (the turn is in the clip: the feet stay planted).
      if (this.podiumPresenting()) {
        want = wrapAngle(this.podiumFacing + PRESENT_YAW);
        clip = HqClip.Present;
      } else {
        want = this.podiumFacing;
        if (this.briefingSpeaking) clip = HqClip.Talk;
      }
    }
    if (this.briefingActive && (a.place === D_BRIEF || a.place === D_SPOT) && a !== this.leadAgent) {
      // Listening: turned to the lead (or to the podium until the lead gets there).
      const lead = this.leadAgent;
      const tx = lead ? lead.x : this.podiumX;
      const tz = lead ? lead.z : this.podiumZ;
      want = Math.atan2(tx - a.x, tz - a.z);
      clip = this.listenClip(a);
    }
    if (this.acknowledging(a) && a.place !== D_PODIUM) {
      // Turned to the creator, standing still to attention. Not Talk: that
      // would bring the crowd's murmur and chatter captions over the HQ's
      // spoken greeting.
      want = Math.atan2(this.creatorX - a.x, this.creatorZ - a.z);
      clip = HqClip.Idle;
    }
    a.facing = turnToward(a.facing, want, STAND_TURN_RATE * dt);
    if (a.clip !== clip) {
      // The hand comes off the chair back before anything else (the outro).
      if (this.gestureDone(a)) this.setLoop(a, clip);
      else this.releaseGesture(a);
    }
  }

  private syncPosition(a: Agent): void {
    a.x = a.bx + a.ox;
    a.z = a.bz + a.oz;
  }

  /** Where the head should look (wantX/Y/Z/W). */
  private desiredLook(a: Agent): void {
    // At the cart: stepCart has set the look.
    if (a.mode === M_PUSH) return;
    if (this.acknowledging(a) && a.place !== D_PODIUM && (a.mode === M_SEATED || a.mode === M_STAND)) {
      // Looking up at the creator (the viewer's camera).
      a.wantX = this.creatorX;
      a.wantY = this.creatorY;
      a.wantZ = this.creatorZ;
      a.wantW = 1;
      return;
    }
    switch (a.mode) {
      case M_SEATED:
      case M_SIT:
      case M_RISE: {
        const s = a.placeSeat;
        if (a.place === D_LOUNGE) {
          this.loungeLook(a, s);
          return;
        }
        const p = a.pair;
        if (a.mode === M_SEATED && a.clip === HqClip.SitShowScreen) {
          // Showing the screen: the clip turns the head up to the guest now
          // and then; the look-at only keeps it on the screen, lightly.
          a.wantX = this.monX[s];
          a.wantY = WORKSTATION.monitors[1].y;
          a.wantZ = this.monZ[s];
          a.wantW = 0.2;
        } else if (a.mode === M_SEATED && p && p.placeSeat >= 0 && (a.clip === HqClip.SitTurnL || a.clip === HqClip.SitTurnR)) {
          // A word with the neighbour: the clip turns to them; the look-at meets their eyes.
          a.wantX = this.headX[p.placeSeat];
          a.wantY = HEAD_SEATED;
          a.wantZ = this.headZ[p.placeSeat];
          a.wantW = 0.7;
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
    if (a.place === D_PODIUM) {
      // Addressing the rows: over the front rows' heads. While presenting the
      // clip turns the head far past what look-at allows, so it leads alone.
      a.wantX = a.x + Math.sin(this.podiumFacing) * 8;
      a.wantY = HEAD_STANDING;
      a.wantZ = a.z + Math.cos(this.podiumFacing) * 8;
      a.wantW = this.podiumPresenting() ? 0 : 0.6;
      return;
    }
    if (this.briefingActive && (a.place === D_BRIEF || a.place === D_SPOT) && a !== this.leadAgent) {
      const lead = this.leadAgent;
      a.wantX = lead ? lead.x : this.podiumX;
      a.wantY = HEAD_STANDING;
      a.wantZ = lead ? lead.z : this.podiumZ;
      a.wantW = 0.95;
      return;
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
      // Over the shoulder: the clip reads the screen and glances down at the
      // host; the look-at keeps the eyes on the screen, lightly.
      const s = a.visitTarget.placeSeat >= 0 ? a.visitTarget.placeSeat : a.placeSeat;
      a.wantX = this.monX[s];
      a.wantY = WORKSTATION.monitors[1].y;
      a.wantZ = this.monZ[s];
      a.wantW = 0.3;
      return;
    }
    if (a.place === D_SPOT) {
      const partner = this.partnerOf(a);
      if (partner) {
        // Listeners watch the speaker; the speaker (or everyone in a pause) the nearest one.
        const sp = this.spotSpeaker[a.placeSpot];
        const to = sp && sp !== a && this.standsAt(sp, a.placeSpot) ? sp : partner;
        a.wantX = to.x;
        a.wantY = HEAD_STANDING;
        a.wantZ = to.z;
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

  // --- The archive cart ----------------------------------------------------------

  /** Once per update, before the agents: hauler checks, resuming, reassigning, pending runs, load. */
  private stepArchive(dt: number): void {
    const now = this.time;
    const hauler = this.arcAgent;
    if (hauler && !this.haulerValid(hauler)) this.dropHauler(hauler);
    if (this.arcPhase === ARC_HANDOVER && !this.arcAgent && this.advanceHandover(this.arcPrevAgent, dt)) {
      // The load has gone into the chute without him: the cart waits at the start of the way back.
      this.startLaneBack();
      this.arcPhase = ARC_LEFT;
    }

    if (this.arcPhase === ARC_LEFT && !this.briefingActive) {
      const a = this.arcAgent;
      if (a) {
        if (this.arcResumeAt < 0) this.arcResumeAt = now + this.arcRng.range(RESUME_MIN, RESUME_MAX);
        else if (now >= this.arcResumeAt) {
          this.arcResumeAt = -1;
          this.startFetch();
        }
      } else if (now >= this.arcReassignAt) {
        const next = this.pickHauler(this.arcPrevAgent, now - this.arcDroppedAt >= REASSIGN_RELAX);
        if (next) {
          const previousName = this.arcPrevAgent ? this.arcPrevAgent.name : "";
          // The new hauler takes it over; nobody "comes back" for it.
          this.arcPaused = false;
          this.assignHauler(next);
          this.emitArchive("reassigned", this.arcRunId, next, this.arcFreed, previousName);
        } else {
          this.arcReassignAt = now + RUN_RETRY;
        }
      }
    }

    if (this.pendRunId && this.arcPhase === ARC_PARKED && !this.arcRunId) {
      if (!this.arcRunsEnabled || now - this.pendSince >= PENDING_MAX) {
        const id = this.pendRunId;
        const freed = this.pendFreed;
        this.pendRunId = "";
        this.pendFreed = 0;
        this.applyArchiveAuto(id, freed);
      } else if (!this.briefingActive && now >= this.pendNotBefore) {
        const next = this.pickHauler(null);
        if (next) {
          const id = this.pendRunId;
          const freed = this.pendFreed;
          this.pendRunId = "";
          this.pendFreed = 0;
          this.beginArchiveRun(id, freed, next);
        } else {
          this.pendNotBefore = now + RUN_RETRY;
        }
      }
    }

    // Load tiers while the cart stands in its bay between runs.
    if (this.arcPhase === ARC_PARKED && !this.arcRunId && this.arcFillSeen) {
      const want = archiveLevelFor(this.arcFill);
      const level = this.arcLevel;
      if (want > level) {
        this.arcBelowSince = -1;
        if (now >= this.arcFillSettleUntil && now >= this.arcLevelRiseAt) {
          this.arcLevel = level + 1;
          this.arcLevelRiseAt = now + LEVEL_RISE_GAP;
        }
      } else if (level > 0 && this.arcFill < LEVEL_UP[level - 1] - LEVEL_HYSTERESIS) {
        if (this.arcBelowSince < 0) this.arcBelowSince = now;
        else if (now - this.arcBelowSince >= LEVEL_DROP_AFTER) {
          this.arcLevel = want;
          this.arcBelowSince = -1;
        }
      } else {
        this.arcBelowSince = -1;
      }
    }
  }

  /** A hauler keeps the run while present, not the lead, not in error, with a desk. WORKING does not matter. */
  private haulerValid(a: Agent): boolean {
    return a.alive && !a.lead && a.status !== ERROR && a.seat >= 0;
  }

  /** Who may be sent for the cart now (relaxed: working hackers at their desks too). */
  private haulerEligible(a: Agent, relaxed: boolean): boolean {
    if (!a.alive || a.lead || a.seat < 0) return false;
    if (relaxed ? a.status === ERROR : a.status !== IDLE || a.onRange) return false;
    if (a.visitor || a.visitTarget || a === this.arcAgent) return false;
    return (a.place === D_SEAT && a.mode === M_SEATED) || (a.place === D_SPOT && a.mode === M_STAND);
  }

  private recentPusher(a: Agent): boolean {
    for (let k = 0; k < RECENT_PUSHERS; k++) if (this.arcRecent[k] === a.id) return true;
    return false;
  }

  /** Seeded, uniform over the eligible agents; the last RECENT_PUSHERS pushers only when nobody else can go. */
  private pickHauler(exclude: Agent | null, relaxed = false): Agent | null {
    const agents = this.agents;
    let count = 0;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (a !== exclude && this.haulerEligible(a, relaxed) && !this.recentPusher(a)) count++;
    }
    const allowRecent = count === 0;
    if (allowRecent) {
      for (let i = 0; i < agents.length; i++) if (agents[i] !== exclude && this.haulerEligible(agents[i], relaxed)) count++;
    }
    if (count === 0) return null;
    let k = this.arcRng.int(count);
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (a === exclude || !this.haulerEligible(a, relaxed) || (!allowRecent && this.recentPusher(a))) continue;
      if (k === 0) return a;
      k--;
    }
    return null;
  }

  private beginArchiveRun(runId: string, freed: number, hauler: Agent): void {
    this.arcRunId = runId;
    this.arcFreed = freed;
    this.arcHanded = false;
    this.arcDoorWait = 0;
    this.arcPaused = false;
    this.arcPrevAgent = null;
    // From now until the handover the load shows at least one tier.
    if (this.arcLevel < 1) this.arcLevel = 1;
    this.assignHauler(hauler);
    this.updateArchiveView(0);
    this.emitArchive("taken", runId, hauler, freed);
  }

  private assignHauler(a: Agent): void {
    this.releaseSpot(a);
    this.releaseLounge(a);
    this.endVisit(a);
    a.onRange = false;
    if (a.nextRange < this.time + 240) a.nextRange = this.time + 240;
    this.arcAgent = a;
    this.arcRecent[this.arcRecentNext] = a.id;
    this.arcRecentNext = (this.arcRecentNext + 1) % RECENT_PUSHERS;
    this.arcResumeAt = -1;
    this.arcReassignAt = -1;
    this.arcClearing = false;
    this.arcStopS = -1;
    this.startFetch();
  }

  /** The hauler walks to the handle of the cart where it stands. */
  private startFetch(): void {
    this.arcPhase = ARC_FETCH;
    this.arcV = 0;
    this.arcGripT = 0;
    this.arcFetchSerial++;
    const lane = this.arcLanes[this.arcLane];
    this.arcIdx = this.laneAt(lane, this.arcS, this.arcIdx);
    this.arcGrabX = this.tmpX;
    this.arcGrabZ = this.tmpZ;
    this.arcGrabRot = this.tmpH;
    if (this.arcLane === 0 && this.arcS <= 0) {
      // In the bay: from the station's own spur, which ends right behind the handle.
      this.arcGrabNode = this.layout.archive.entryNode;
      this.arcGrabQ = false;
    } else {
      this.arcQX = this.arcGrabX - Math.sin(this.arcGrabRot) * APPROACH_BACK;
      this.arcQZ = this.arcGrabZ - Math.cos(this.arcGrabRot) * APPROACH_BACK;
      this.arcGrabNode = this.clearNodeNear(this.arcQX, this.arcQZ);
      this.arcGrabQ = true;
    }
  }

  /** The hauler is gone, in error or the lead now: the cart stays where it is and someone else takes over. */
  private dropHauler(a: Agent): void {
    if (a.alive && a.mode === M_PUSH) this.leaveCart(a, this.clearNodeNear(a.bx, a.bz));
    this.arcAgent = null;
    this.arcPrevAgent = a;
    this.arcDroppedAt = this.time;
    // Mid-handover the load still rolls into the chute (stepArchive), then the cart waits.
    if (this.arcPhase !== ARC_PARKED && this.arcPhase !== ARC_HANDOVER) this.arcPhase = ARC_LEFT;
    this.arcV = 0;
    this.arcClearing = false;
    this.arcStopS = -1;
    this.arcResumeAt = -1;
    this.arcReassignAt = this.time + REASSIGN_DELAY;
  }

  private queueArchiveRun(runId: string, freed: number, notBefore: number): void {
    if (!this.pendRunId) {
      this.pendSince = this.time;
      this.pendFreed = 0;
      this.pendNotBefore = notBefore;
    }
    this.pendRunId = runId;
    this.pendFreed += freed;
  }

  /** The run is applied without a trip: the load is gone at once. */
  private applyArchiveAuto(runId: string, freed: number): void {
    this.arcLevel = 0;
    this.arcBelowSince = -1;
    this.arcFillSettleUntil = this.time + FILL_SETTLE;
    this.arcView.level = 0;
    this.emitArchive("auto", runId, null, freed);
  }

  private emitArchive(
    type: HqArchiveEvent["type"],
    runId: string,
    agent: Agent | null,
    freedBytes: number,
    previousName?: string,
  ): void {
    const cb = this.onArchiveEvent;
    if (!cb) return;
    const e: HqArchiveEvent = { type, runId, agentId: agent ? agent.id : null, name: agent ? agent.name : "", freedBytes };
    if (previousName !== undefined) e.previousName = previousName;
    cb(e);
  }

  /** A briefing starts: the rule for a cart under way. */
  private archiveBriefingStarts(): void {
    const a = this.arcAgent;
    if (!a) return;
    if (this.arcPhase === ARC_FETCH) {
      // Not moving yet: it stays where it is.
      this.arcPhase = ARC_LEFT;
      if (a.mode === M_PUSH) this.leaveCart(a, this.clearNodeNear(a.bx, a.bz));
    } else if (this.arcPhase === ARC_PUSH) {
      if (this.stoppableHere()) this.pauseRun(a);
      else {
        this.arcClearing = true;
        this.arcStopS = this.firstStoppable(this.arcLane, this.arcS);
      }
    } else if (this.arcPhase === ARC_HANDOVER) {
      // On the apron: hurry the handover, then push back in to the first place it may stand.
      this.arcClearing = true;
    }
  }

  private archiveBriefingEnds(): void {
    this.arcClearing = false;
    this.arcStopS = -1;
    if (this.arcPhase === ARC_LEFT) {
      if (this.arcAgent) this.arcResumeAt = this.time + this.arcRng.range(RESUME_MIN, RESUME_MAX);
      else if (this.arcReassignAt < this.time + RESUME_MIN) this.arcReassignAt = this.time + RESUME_MIN;
    }
    if (this.pendRunId && this.pendNotBefore < this.time + BRIEF_START_DELAY) this.pendNotBefore = this.time + BRIEF_START_DELAY;
  }

  /** The cart is left exactly where it stands; the hauler goes (to his desk, for the briefing). */
  private pauseRun(a: Agent): void {
    this.arcPhase = ARC_LEFT;
    this.arcV = 0;
    this.arcClearing = false;
    this.arcStopS = -1;
    this.arcPaused = true;
    this.leaveCart(a, this.clearNodeNear(a.bx, a.bz));
    this.emitArchive("paused", this.arcRunId, a, this.arcFreed);
  }

  /** Whether the cart may be left standing where it is now. */
  private stoppableHere(): boolean {
    const lane = this.arcLanes[this.arcLane];
    const i = this.laneAt(lane, this.arcS, this.arcIdx);
    if (lane.noStop[i]) return false;
    return !(i + 1 < lane.noStop.length && this.arcS > lane.s[i] + 1e-6 && lane.noStop[i + 1]);
  }

  /** Distance along a lane of its first sample from `s` on where the cart may stand, or -1. */
  private firstStoppable(laneIndex: number, s: number): number {
    const lane = this.arcLanes[laneIndex];
    for (let j = this.laneAt(lane, s, 0); j < lane.s.length; j++) {
      if (lane.s[j] >= s - 1e-6 && !lane.noStop[j]) return lane.s[j];
    }
    return -1;
  }

  /** At the handle: hands on the grip bar (Push held at its hold frame), then off. */
  private gripCart(a: Agent): void {
    a.bx = this.arcGrabX;
    a.bz = this.arcGrabZ;
    a.ox = 0;
    a.oz = 0;
    a.moving = false;
    a.mode = M_PUSH;
    a.place = D_PUSH;
    a.placeSeat = -1;
    this.arcGripT = 0;
    this.arcV = 0;
    this.setClip(a, HqClip.Push, PUSH_HOLD_TIME, 0);
  }

  /**
   * Off the cart: the (former) hauler walks away from it to a nav node he can
   * reach without walking through it; plan() routes him on from there.
   */
  private leaveCart(a: Agent, node: number): void {
    a.mode = M_WALK;
    a.moving = false;
    a.place = D_NONE;
    a.placeSeat = -1;
    a.ox = 0;
    a.oz = 0;
    a.needsRoute = false;
    a.wpMore = false;
    a.wpIdx = 0;
    a.wpCount = 0;
    if (node >= 0) {
      this.nodePos(node);
      a.wpX[0] = this.tmpX;
      a.wpZ[0] = this.tmpZ;
      a.wpNode[0] = node;
      a.wpCount = 1;
    }
  }

  /** The hauler at the cart, per frame. */
  private stepCart(a: Agent, dt: number): void {
    if (a !== this.arcAgent) {
      this.leaveCart(a, this.clearNodeNear(a.bx, a.bz));
      return;
    }
    a.ox = 0;
    a.oz = 0;
    switch (this.arcPhase) {
      case ARC_FETCH: {
        // Square up to the handle, grip, go.
        a.moving = false;
        const want = this.arcGrabRot;
        a.facing = turnToward(a.facing, want, STAND_TURN_RATE * dt);
        if (Math.abs(wrapAngle(want - a.facing)) < 0.05) this.arcGripT += dt;
        this.lookAtHandle(a);
        if (this.arcGripT < GRIP_SECONDS) return;
        a.facing = wrapAngle(want);
        a.dest = D_PUSH;
        this.arcV = 0;
        this.arcFrontWait = 0;
        const lane = this.arcLanes[this.arcLane];
        if (this.arcLane === 0 && this.arcS >= lane.s[lane.s.length - 1] - 1e-4 && !this.arcHanded) {
          this.arcPhase = ARC_HANDOVER;
        } else {
          this.arcPhase = ARC_PUSH;
          if (this.arcHanded && this.arcLane === 0) {
            // Handed over but not yet turned back: the way back starts here.
            this.arcHandF = 0;
            this.arcLane = 1;
            this.arcS = 0;
            this.arcIdx = 0;
          }
        }
        if (this.arcPaused) {
          this.arcPaused = false;
          this.emitArchive("resumed", this.arcRunId, a, this.arcFreed);
        }
        return;
      }
      case ARC_PUSH:
        this.stepPush(a, dt);
        return;
      case ARC_HANDOVER:
        this.stepHandover(a, dt);
        return;
      default:
        this.leaveCart(a, this.clearNodeNear(a.bx, a.bz));
    }
  }

  private stepPush(a: Agent, dt: number): void {
    const lane = this.arcLanes[this.arcLane];
    const len = lane.s[lane.s.length - 1];
    let end = this.arcClearing && this.arcStopS >= 0 ? this.arcStopS : len;
    const reverse = lane.reverse[this.arcIdx] === 1;
    const hx = Math.sin(this.arcCartRot);
    const hz = Math.cos(this.arcCartRot);

    // Door etiquette: before the doorway, wait (a while) for it to be clear of walkers.
    let doorWait = false;
    if (this.arcLane === 0 && !this.arcClearing && this.arcS <= this.arcHoldS + 1e-4 && this.arcDoorWait < DOOR_WAIT_MAX) {
      if (this.doorBusy(a)) {
        doorWait = true;
        if (this.arcHoldS < end) end = this.arcHoldS;
        if (this.arcS >= this.arcHoldS - 0.05) this.arcDoorWait += dt;
      }
    }
    // Someone right in front of the cart (behind the puller, while pulling).
    let hold = false;
    if (this.time >= this.arcFrontIgnoreUntil) {
      const px = reverse ? a.bx - hx * FRONT_STOP_BEHIND : this.arcCartX + hx * FRONT_STOP_AHEAD;
      const pz = reverse ? a.bz - hz * FRONT_STOP_BEHIND : this.arcCartZ + hz * FRONT_STOP_AHEAD;
      hold = this.anyoneNear(px, pz, FRONT_STOP_R, a);
      if (hold) {
        this.arcFrontWait += dt;
        if (this.arcFrontWait >= FRONT_WAIT_MAX) {
          // Nobody is making way: edge on (walkers step aside of the cart).
          this.arcFrontWait = 0;
          this.arcFrontIgnoreUntil = this.time + FRONT_IGNORE;
          hold = false;
        }
      } else {
        this.arcFrontWait = 0;
      }
    }

    const remaining = end > this.arcS ? end - this.arcS : 0;
    const cruise = ((PUSH_SPEED * a.speed) / HQ_WALK_SPEED) * (this.arcClearing ? CLEAR_HURRY : 1);
    const brake = Math.sqrt(1.8 * remaining) + 0.05;
    const target = hold ? 0 : cruise < brake ? cruise : brake;
    let v = this.arcV;
    if (target > v) v = Math.min(target, v + PUSH_ACCEL * dt);
    else v = Math.max(target, v - (hold ? HOLD_DECEL : PUSH_DECEL) * dt);
    let ds = v * dt;
    if (ds > remaining) ds = remaining;
    this.arcV = ds > 0 ? v : 0;
    this.arcS += ds;
    if (end - this.arcS < 1e-4 && ds > 0) this.arcS = end;
    this.placeOnLane(a);

    // Push is distance-driven: its feet match the floor (backward while pulling).
    if (a.clip !== HqClip.Push) this.setClip(a, HqClip.Push, PUSH_HOLD_TIME, 0);
    a.clipRate = 0;
    a.moving = ds > 1e-5;
    if (a.moving) a.clipTime += ((lane.reverse[this.arcIdx] === 1 ? -1 : 1) * ds) / PUSH_NATIVE_SPEED;
    else this.settleOnHoldFrame(a, dt, reverse);

    // Where he looks: the doorway while waiting, the cart while pulling, the lane ahead.
    if (doorWait && !a.moving) {
      a.wantX = this.layout.spawn.x;
      a.wantY = 1.5;
      a.wantZ = this.layout.bounds.z1;
      a.wantW = 0.6;
    } else if (reverse) {
      a.wantX = this.arcCartX;
      a.wantY = 0.9;
      a.wantZ = this.arcCartZ;
      a.wantW = 0.35;
    } else {
      this.laneAt(lane, this.arcS + 3, this.arcIdx);
      a.wantX = this.tmpX + Math.sin(this.tmpH) * CART_REACH;
      a.wantY = 1.2;
      a.wantZ = this.tmpZ + Math.cos(this.tmpH) * CART_REACH;
      a.wantW = 0.35;
    }

    if (this.arcS < end - 1e-4) return;
    if (this.arcClearing && this.arcStopS >= 0 && this.arcS >= this.arcStopS - 1e-4) {
      // Cleared the doorway / walkway: leave it here for the briefing.
      this.pauseRun(a);
      return;
    }
    if (this.arcS < len - 1e-4) return;
    if (this.arcLane === 0) {
      this.arcPhase = ARC_HANDOVER;
      this.arcHandF = 0;
      this.arcV = 0;
    } else {
      this.parkCart(a);
    }
  }

  private stepHandover(a: Agent, dt: number): void {
    a.moving = false;
    this.settleOnHoldFrame(a, dt, false);
    const slot = this.layout.archive.chute.slot;
    a.wantX = slot.x;
    a.wantY = 0.7;
    a.wantZ = slot.z;
    a.wantW = 0.8;
    if (!this.advanceHandover(a, dt)) return;
    this.startLaneBack();
    this.arcPhase = ARC_PUSH;
    if (this.arcClearing) this.arcStopS = this.firstStoppable(1, 0);
  }

  /** The load goes into the chute (by whoever took it out); true once it is all in. */
  private advanceHandover(by: Agent | null, dt: number): boolean {
    const duration = this.arcClearing ? HANDOVER_HURRY_SECONDS : HANDOVER_SECONDS;
    this.arcHandF += dt / duration;
    if (!this.arcHanded && this.arcHandF >= HANDOVER_EVENT / HANDOVER_SECONDS) {
      this.arcHanded = true;
      this.arcLevel = 0;
      this.arcBelowSince = -1;
      this.emitArchive("handover", this.arcRunId, by, this.arcFreed);
    }
    return this.arcHandF >= 1;
  }

  /** At the start of laneBack (where laneOut ended), at rest. */
  private startLaneBack(): void {
    this.arcHandF = 0;
    this.arcLane = 1;
    this.arcS = 0;
    this.arcIdx = 0;
    this.arcV = 0;
  }

  /** Back in the bay: the run is over; the hauler walks off the station's spur, back to work. */
  private parkCart(a: Agent): void {
    const arc = this.layout.archive;
    this.arcCartX = arc.cart.x;
    this.arcCartZ = arc.cart.z;
    this.arcCartRot = arc.cart.rotY;
    this.arcPhase = ARC_PARKED;
    this.arcLane = 0;
    this.arcS = 0;
    this.arcIdx = 0;
    this.arcV = 0;
    this.arcClearing = false;
    this.arcStopS = -1;
    this.arcAgent = null;
    const runId = this.arcRunId;
    const freed = this.arcFreed;
    this.arcRunId = "";
    this.arcFreed = 0;
    this.arcHanded = false;
    this.arcFillSettleUntil = this.time + FILL_SETTLE;
    this.arcLevelRiseAt = this.time;
    if (this.pendRunId && !(this.pendNotBefore < Infinity)) {
      this.pendNotBefore = this.time + NEXT_RUN_COOLDOWN;
      this.pendSince = this.time;
    }
    this.leaveCart(a, arc.leaveNode);
    a.nextOuting = this.time + a.rng.range(60, 200);
    this.emitArchive("parked", runId, a, freed);
  }

  /** Clip to the hold frame (forward, or backward while pulling), then still. */
  private settleOnHoldFrame(a: Agent, dt: number, backward: boolean): void {
    if (a.clip !== HqClip.Push) return;
    const dur = CLIP_DURATION[HqClip.Push];
    let d = backward ? a.clipTime - PUSH_HOLD_TIME : PUSH_HOLD_TIME - a.clipTime;
    d -= dur * Math.floor(d / dur);
    if (d <= 0.04 || d >= dur - 0.04) return;
    a.clipTime += (backward ? -1 : 1) * (d < dt ? d : dt);
  }

  private lookAtHandle(a: Agent): void {
    a.wantX = a.bx + Math.sin(this.arcGrabRot) * HQ_PUSH_GRIP.reach;
    a.wantY = HQ_PUSH_GRIP.height;
    a.wantZ = a.bz + Math.cos(this.arcGrabRot) * HQ_PUSH_GRIP.reach;
    a.wantW = 0.35;
  }

  /** The hauler's root and the cart from the lane at arcS. */
  private placeOnLane(a: Agent): void {
    this.arcIdx = this.laneAt(this.arcLanes[this.arcLane], this.arcS, this.arcIdx);
    const h = this.tmpH;
    a.bx = this.tmpX;
    a.bz = this.tmpZ;
    a.facing = wrapAngle(h);
    this.arcCartX = this.tmpX + Math.sin(h) * CART_REACH;
    this.arcCartZ = this.tmpZ + Math.cos(h) * CART_REACH;
    this.arcCartRot = a.facing;
  }

  /** Pose on a lane at distance s into tmpX/tmpZ/tmpH (unwrapped); returns the sample at or before s. */
  private laneAt(lane: HqArchiveLane, s: number, hint: number): number {
    const S = lane.s;
    const last = S.length - 1;
    let i = hint < 0 ? 0 : hint > last ? last : hint;
    while (i < last && S[i + 1] <= s) i++;
    while (i > 0 && S[i] > s) i--;
    if (i >= last) {
      this.tmpX = lane.x[last];
      this.tmpZ = lane.z[last];
      this.tmpH = lane.rotY[last];
      return last;
    }
    const span = S[i + 1] - S[i];
    let t = span > 1e-9 ? (s - S[i]) / span : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    this.tmpX = lane.x[i] + (lane.x[i + 1] - lane.x[i]) * t;
    this.tmpZ = lane.z[i] + (lane.z[i + 1] - lane.z[i]) * t;
    this.tmpH = lane.rotY[i] + (lane.rotY[i + 1] - lane.rotY[i]) * t;
    return i;
  }

  /** Any walker in the door area (the pusher waits for them before rolling into it). */
  private doorBusy(except: Agent): boolean {
    const sx = this.layout.spawn.x;
    const z0 = this.layout.bounds.z1 - DOOR_DEPTH;
    const agents = this.agents;
    for (let i = 0; i < agents.length; i++) {
      const b = agents[i];
      if (b === except || b.mode !== M_WALK) continue;
      if (b.z > z0 && Math.abs(b.x - sx) < DOOR_HALF) return true;
    }
    return false;
  }

  /** Anyone on their feet within r of (x, z), but `except`. */
  private anyoneNear(x: number, z: number, r: number, except: Agent): boolean {
    const r2 = r * r;
    const c0 = this.cellX(x - r);
    const c1 = this.cellX(x + r);
    const r0 = this.cellZ(z - r);
    const r1 = this.cellZ(z + r);
    for (let gz = r0; gz <= r1; gz++) {
      for (let gx = c0; gx <= c1; gx++) {
        const cell = gz * this.hcols + gx;
        for (let k = this.hashStart[cell], end = this.hashStart[cell + 1]; k < end; k++) {
          const b = this.agents[this.hashItems[k]];
          if (!b || b === except || b.mode === M_SEATED || b.mode === M_SIT || b.mode === M_RISE) continue;
          const dx = b.x - x;
          const dz = b.z - z;
          if (dx * dx + dz * dz < r2) return true;
        }
      }
    }
    return false;
  }

  /** Whether the cart is out of its bay in the door area (newcomers then line up further out). */
  private cartInDoorArea(): boolean {
    if (this.arcPhase === ARC_PARKED) return false;
    return (
      Math.abs(this.arcCartX - this.layout.spawn.x) < DOOR_HALF + 0.5 && this.arcCartZ > this.layout.bounds.z1 - DOOR_DEPTH
    );
  }

  /**
   * The nearest nav node that can be walked to in a straight line from (x, z):
   * not through glass or a wall, not over the south curb outside the
   * entrance, not through the cart. Only on fetch and release (rare): a scan
   * of the graph, no allocation.
   */
  private clearNodeNear(x: number, z: number): number {
    const pos = this.layout.nav.positions;
    const n = navNodeCount(this.layout.nav);
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const nx = pos[i * 2];
      const nz = pos[i * 2 + 1];
      const d = (nx - x) * (nx - x) + (nz - z) * (nz - z);
      if (d >= bestD || !this.clearSight(x, z, nx, nz)) continue;
      best = i;
      bestD = d;
    }
    return best >= 0 ? best : nearestNode(this.layout.nav, x, z);
  }

  private clearSight(ax: number, az: number, bx: number, bz: number): boolean {
    const parts = this.layout.partitions;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.kind === "glass-door") continue;
      if (segmentsCross(ax, az, bx, bz, p.ax, p.az, p.bx, p.bz)) return false;
    }
    // The south curb: only through the entrance cut.
    const cz = this.layout.bounds.z1 + 0.125;
    if ((az - cz) * (bz - cz) < 0) {
      const t = (cz - az) / (bz - az);
      const cx = ax + (bx - ax) * t;
      if (Math.abs(cx - this.layout.spawn.x) > HQ_ENTRANCE_HALF_WIDTH - HQ_AGENT_RADIUS) return false;
    }
    if (this.arcPhase === ARC_PARKED) return true;
    // Not through the cart: its footprint grown by SIGHT_CLEAR all round. A
    // rectangle, not discs along its axis, so the hauler's own spot (reach
    // behind the origin, just off the handle end) still sees the nodes behind
    // and beside him.
    return !segmentHitsBox(
      ax,
      az,
      bx,
      bz,
      this.arcCartX,
      this.arcCartZ,
      this.arcCartRot,
      -HQ_ARCHIVE_CART.tail - SIGHT_CLEAR,
      HQ_ARCHIVE_CART.nose + SIGHT_CLEAR,
      HQ_ARCHIVE_CART.width / 2 + SIGHT_CLEAR,
    );
  }

  /** The view the renderer reads (once per update). */
  private updateArchiveView(dt: number): void {
    const v = this.arcView;
    const phase = this.arcPhase;
    v.x = this.arcCartX;
    v.z = this.arcCartZ;
    v.rotY = this.arcCartRot;
    v.level = this.arcLevel;
    v.unload = phase === ARC_HANDOVER ? Math.min(1, this.arcHandF) : 0;
    const moving = phase === ARC_PUSH || phase === ARC_HANDOVER;
    const gx = this.arcCartX - this.layout.spawn.x;
    const gz = this.arcCartZ - (this.layout.bounds.z1 + 0.125);
    const gate = moving && gx * gx + gz * gz < DOOR_HALF * DOOR_HALF ? 1 : 0;
    const chute = phase === ARC_HANDOVER ? 1 : 0;
    if (dt > 0) {
      v.gate = gate > v.gate ? Math.min(gate, v.gate + 3 * dt) : Math.max(gate, v.gate - 1.5 * dt);
      v.chute = chute > v.chute ? Math.min(chute, v.chute + 4 * dt) : Math.max(chute, v.chute - 1.5 * dt);
    }
    // A cart still in its bay that nobody holds reads as parked.
    const inBay = this.arcLane === 0 && this.arcS <= 0;
    v.phase =
      phase === ARC_PARKED
        ? "parked"
        : phase === ARC_FETCH
          ? "fetch"
          : phase === ARC_PUSH
            ? this.arcLane === 0
              ? "push-out"
              : "push-back"
            : phase === ARC_HANDOVER
              ? "handover"
              : inBay
                ? "parked"
                : "left";
    v.pusherId = this.arcAgent ? this.arcAgent.id : null;
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
      // Display place for the hover card: a hacker who is on the cyber-range
      // (entered from their own workstation), on a lounge break or hauling the
      // archive cart names it; everywhere else the status label speaks for the agent.
      f.place[i] = a.onRange
        ? HQ_PLACE.cyberrange
        : a.place === D_LOUNGE
          ? HQ_PLACE.lounge
          : a.place === D_PODIUM
            ? HQ_PLACE.podium
            : a.mode === M_PUSH || a.dest === D_CART || a.dest === D_PUSH
              ? HQ_PLACE_ARCHIVE
              : this.briefingActive && (a.place === D_BRIEF || a.dest === D_BRIEF)
                ? HQ_PLACE.briefing
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
