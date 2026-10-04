// Living workstations, wave 0: the small rhythms that keep the hall from
// moving in lockstep, with the clips the character already has. Pure (no
// three.js, no sim state), so every rule here is tested on its own.
//
// The sim keeps one extra generator per agent for all of this (`beat`,
// seeded from the id hash), separate from the one its routes and outings
// draw from, so adding a beat never shifts anyone's route.

import type { HqRng } from "./rng";

// --- Timing ------------------------------------------------------------------------

/** No beat (a pose held at one's own desk) is shorter than this. */
export const BEAT_MIN = 6;
/** Per-agent playback rate of standing and seated loops. */
export const TEMPO_MIN = 0.92;
export const TEMPO_MAX = 1.08;
/** A working hacker's typing tempo during a mission (mapped from the agent's own tempo). */
export const MISSION_TEMPO_MIN = 1.08;
export const MISSION_TEMPO_MAX = 1.18;
/** How long after a briefing's start or end each agent reacts (stands up / sits down). */
export const REACTION_MIN = 0.15;
export const REACTION_MAX = 1.4;

/** One speaker at a time per social spot: a turn, then a short pause before the next one. */
export const SPOT_TURN_MIN = 4;
export const SPOT_TURN_MAX = 9;
export const SPOT_GAP_MIN = 0.4;
export const SPOT_GAP_MAX = 1.5;

/** AM7 at someone's shoulder, seconds (a mission's rounds are shorter and more frequent). */
export const LEAD_VISIT_MIN = 8;
export const LEAD_VISIT_MAX = 18;
export const MISSION_LEAD_VISIT_MIN = 6;
export const MISSION_LEAD_VISIT_MAX = 12;
export const MISSION_LEAD_GAP_MIN = 25;
export const MISSION_LEAD_GAP_MAX = 60;

/** A colleague looking over a working hacker's shoulder, seconds on the spot (a mission's help is short). */
export const PEER_VISIT_MIN = 15;
export const PEER_VISIT_MAX = 40;
export const HELP_VISIT_MIN = 10;
export const HELP_VISIT_MAX = 20;
/** The guest alternates talking and listening. */
export const GUEST_TALK_MIN = 3;
export const GUEST_TALK_MAX = 7;
export const GUEST_QUIET_MIN = 2;
export const GUEST_QUIET_MAX = 5;
/** Hosts are at most this many rows away, and this many desks either way along the row. */
export const PEER_ROWS = 2;
export const PEER_DESKS = 4;
/** At most one standing guest within this many desks either way in a row. */
export const GUEST_SPACING = 3;

// --- Mission mode ------------------------------------------------------------------

/** Longest a mission lasts when nobody ends it (seconds). */
export const MISSION_MAX_DEFAULT = 600;
/** Whoever is away when a mission starts heads back after this long, at a brisk walk. */
export const RETURN_DELAY_MIN = 0.5;
export const RETURN_DELAY_MAX = 4;
export const BRISK_FACTOR = 1.15;
/** After a mission everyone stays on duty a little longer, each for their own while. */
export const RELAX_MIN = 3;
export const RELAX_MAX = 60;
/** ...and their first break comes this long after the mission (through the departure limiter). */
export const RELAX_OUTING_MIN = 45;
export const RELAX_OUTING_MAX = 240;

// --- Departures ----------------------------------------------------------------------

/** Desk departures (breaks, visits) per second, and how many may bunch up. Briefings are not limited. */
export const DEPART_PER_SEC = 1.5;
export const DEPART_BURST = 2;

/** Concurrent over-the-shoulder visits by colleagues (AM7 not counted). */
export function peerVisitLimit(agents: number): number {
  return Math.max(2, Math.floor(0.03 * agents));
}

/** Concurrent over-the-shoulder help during a mission. */
export function helpVisitLimit(agents: number): number {
  return Math.max(1, Math.floor(0.01 * agents));
}

// --- Traits and beats ----------------------------------------------------------------

export type HqBeatTraits = {
  /** How readily the agent goes over to a colleague, 0.3..1. */
  social: number;
  /** How often the agent changes what it is doing (beat length factor), 0.6..1.5. */
  fidget: number;
  /** Playback rate of loops, TEMPO_MIN..TEMPO_MAX. */
  tempo: number;
};

/** An agent's traits, drawn once from its beat generator. */
export function rollTraits(rng: HqRng): HqBeatTraits {
  const social = rng.range(0.3, 1);
  const fidget = rng.range(0.6, 1.5);
  const tempo = rng.range(TEMPO_MIN, TEMPO_MAX);
  return { social, fidget, tempo };
}

/** Typing tempo during a mission: the agent's tempo mapped onto MISSION_TEMPO_MIN..MAX. */
export function missionTempo(tempo: number): number {
  const t = (tempo - TEMPO_MIN) / (TEMPO_MAX - TEMPO_MIN);
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return MISSION_TEMPO_MIN + (MISSION_TEMPO_MAX - MISSION_TEMPO_MIN) * k;
}

export function reactionDelay(rng: HqRng): number {
  return rng.range(REACTION_MIN, REACTION_MAX);
}

// --- What a hacker at their own desk does next (wave 1: the living-workstation clips) ---

/** Beats. The sim turns each into an act and the act into a clip. */
export const BEAT_IDLE = 0; // SitIdle: leaning back from the screen, the mouse
export const BEAT_TYPE = 1; // SitType / SitType2 (the agent's own variant)
export const BEAT_VISIT = 2; // over to a working colleague's shoulder (StandLookOver; the host SitShowScreen)
export const BEAT_READ = 3; // SitRead: reading, scrolling, a hand to the brow
export const BEAT_LEAN = 4; // SitLeanBack: leaning back to think
export const BEAT_TURN = 5; // SitTurnL/R: a word with the neighbour, both seated
export const BEAT_STRETCH = 6; // SitStretch: once, then back to the keys
export const BEAT_COUNT = 7;

/**
 * Weights per beat (index = BEAT_*). TURN and VISIT are multiplied by the
 * agent's `social`. Working: mostly typing, reading, now and then leaning
 * back, a word with the neighbour or a stretch. Free: sitting back, reading,
 * thinking, talking, a visit. On duty (a mission) only work: typing and
 * reading, a short word with the neighbour, a free hacker's short help.
 */
const WORK_WEIGHTS: readonly number[] = [0, 55, 0, 25, 6, 6, 4];
const FREE_WEIGHTS: readonly number[] = [30, 0, 7, 15, 15, 15, 6];
const DUTY_WORK_WEIGHTS: readonly number[] = [0, 80, 0, 15, 0, 5, 0];
const DUTY_FREE_WEIGHTS: readonly number[] = [0, 30, 3, 70, 0, 5, 0];

export function beatWeights(working: boolean, duty: boolean): readonly number[] {
  if (duty) return working ? DUTY_WORK_WEIGHTS : DUTY_FREE_WEIGHTS;
  return working ? WORK_WEIGHTS : FREE_WEIGHTS;
}

/** Picks a hacker's next beat at their own desk. Allocation-free. */
export function pickBeat(working: boolean, duty: boolean, social: number, rng: HqRng): number {
  const w = beatWeights(working, duty);
  let total = 0;
  for (let b = 0; b < BEAT_COUNT; b++) total += b === BEAT_TURN || b === BEAT_VISIT ? w[b] * social : w[b];
  let r = rng.next() * total;
  for (let b = 0; b < BEAT_COUNT; b++) {
    const wb = b === BEAT_TURN || b === BEAT_VISIT ? w[b] * social : w[b];
    if (r < wb) return b;
    r -= wb;
  }
  return working ? BEAT_TYPE : duty ? BEAT_READ : BEAT_IDLE;
}

/**
 * How long a timed beat lasts (seconds): reading, leaning back, a word with
 * the neighbour (short on duty). Typing and sitting idle last until the next
 * beat (0 here); a stretch is one pass of its clip (the sim times it).
 */
export function beatSeconds(beat: number, working: boolean, duty: boolean, rng: HqRng): number {
  switch (beat) {
    case BEAT_READ:
      return working ? rng.range(20, 60) : rng.range(20, 50);
    case BEAT_LEAN:
      return working ? rng.range(15, 40) : rng.range(20, 60);
    case BEAT_TURN:
      return duty ? rng.range(6, 12) : working ? rng.range(10, 25) : rng.range(20, 45);
    default:
      return 0;
  }
}

/**
 * Seconds until the next beat, never under BEAT_MIN: working 25-70 s, free
 * 15-45 s (on duty 20-50 s), times the agent's fidget.
 */
export function beatPause(duty: boolean, fidget: number, rng: HqRng, working = false): number {
  const base = duty ? rng.range(20, 50) : working ? rng.range(25, 70) : rng.range(15, 45);
  const f = fidget > 0 ? fidget : 1;
  const t = base * f;
  return t < BEAT_MIN ? BEAT_MIN : t;
}

/** A stretch is not repeated by the same hacker within this many seconds. */
export const STRETCH_GAP = 480;

/** Concurrent limits over the hall: leaning back, stretching, seated pairs (fewer on duty). */
export function leanLimit(agents: number): number {
  return Math.max(1, Math.floor(0.08 * agents));
}
export function stretchLimit(agents: number): number {
  return Math.max(1, Math.floor(0.015 * agents));
}
export function pairLimit(agents: number, duty: boolean): number {
  return Math.max(1, Math.floor((duty ? 0.015 : 0.04) * agents));
}

/**
 * After a mission some hackers breathe out (a stretch or a lean back) as
 * their first beat off duty: this share of them.
 */
export const EXHALE_SHARE = 0.35;

/**
 * How a hacker listens standing (a briefing, a spot's speaker), from the id
 * hash: 0 StandListen (45%), 1 StandListen at a slower tempo (25%), 2 Idle
 * (30%). Hash-derived, so it draws nothing from the generators.
 */
export const LISTEN_PLAIN = 0;
export const LISTEN_SLOW = 1;
export const LISTEN_IDLE = 2;
export function listenStyle(idHash: number): number {
  const k = (idHash >>> 11) % 100;
  return k < 45 ? LISTEN_PLAIN : k < 70 ? LISTEN_SLOW : LISTEN_IDLE;
}
/** Tempo factor of the LISTEN_SLOW listeners' StandListen. */
export const LISTEN_SLOW_TEMPO = 0.86;

/** Seconds a colleague stays at the shoulder (short help during a mission). */
export function peerVisitSeconds(duty: boolean, rng: HqRng): number {
  return duty ? rng.range(HELP_VISIT_MIN, HELP_VISIT_MAX) : rng.range(PEER_VISIT_MIN, PEER_VISIT_MAX);
}

// --- A hacker in error: working the problem at their own desk ---------------------------

/** Faster loops while troubleshooting: typing (SitType2) and reading (SitRead), times the agent's tempo. */
export const ERR_TYPE_TEMPO = 1.18;
export const ERR_READ_TEMPO = 1.08;
/** Share of errors a free colleague comes over to help with, and when (seconds after the error). */
export const ERR_HELP_CHANCE = 0.3;
export const ERR_HELP_MIN = 20;
export const ERR_HELP_MAX = 60;
/** How long the hacker keeps hoping for that help (a free neighbour, the limits) before giving up. */
export const ERR_HELP_PATIENCE = 30;

/** Beats of a hacker in error. */
export const ERR_TYPE = 0; // SitType2, fast: trying a fix
export const ERR_READ = 1; // SitRead: logs, a hand to the brow
export const ERR_THINK = 2; // SitLeanBack, briefly: thinking it over
export const ERR_STAND = 3; // up at their own shoulder place (StandLookOver), leaning over the chair at the screen
const ERR_WEIGHTS: readonly number[] = [38, 32, 12, 18];

/** The next beat of a hacker in error; ERR_STAND only when `canStand`. Allocation-free. */
export function pickErrorBeat(canStand: boolean, rng: HqRng): number {
  const total = ERR_WEIGHTS[0] + ERR_WEIGHTS[1] + ERR_WEIGHTS[2] + (canStand ? ERR_WEIGHTS[3] : 0);
  let r = rng.next() * total;
  for (let b = 0; b < ERR_WEIGHTS.length; b++) {
    if (b === ERR_STAND && !canStand) break;
    if (r < ERR_WEIGHTS[b]) return b;
    r -= ERR_WEIGHTS[b];
  }
  return ERR_READ;
}

/** How long an error beat lasts (seconds, never under BEAT_MIN); standing includes the few steps there. */
export function errorBeatSeconds(beat: number, rng: HqRng): number {
  switch (beat) {
    case ERR_TYPE:
      return rng.range(8, 18);
    case ERR_THINK:
      return rng.range(BEAT_MIN, 9);
    case ERR_STAND:
      return rng.range(16, 30);
    default:
      return rng.range(8, 16);
  }
}

// --- Departure limiter -----------------------------------------------------------------

/**
 * A token bucket for leaving one's desk (breaks and visits): at most `rate`
 * per second on average and `burst` at once, so a crowd never gets up
 * together (after a mission, a status flip). Allocation-free.
 */
export class HqDepartureLimiter {
  tokens: number;

  constructor(
    readonly rate = DEPART_PER_SEC,
    readonly burst = DEPART_BURST,
  ) {
    this.tokens = burst;
  }

  refill(dt: number): void {
    const t = this.tokens + (dt > 0 ? dt : 0) * this.rate;
    this.tokens = t < this.burst ? t : this.burst;
  }

  /** Takes one departure; false when none is free now. */
  take(): boolean {
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Gives back a departure that did not happen (no free spot after all). */
  refund(): void {
    const t = this.tokens + 1;
    this.tokens = t < this.burst ? t : this.burst;
  }
}

// --- Desk neighbourhood -------------------------------------------------------------------

/**
 * The amphitheatre's desks by row and position along it, and, for every
 * desk, the desks a colleague there may walk over to (PEER_ROWS rows either
 * way, PEER_DESKS desks either way along each), nearest first. Built once.
 */
export type HqDeskNeighbourhood = {
  /** Arena row per desk (0 = the innermost). */
  row: Int16Array;
  /** Position per desk in its row, west to east. */
  pos: Int32Array;
  /** Rows as runs of `rowDesks`: row r is rowDesks[rowStart[r] .. rowStart[r + 1]). */
  rowStart: Int32Array;
  rowDesks: Int32Array;
  /** Candidate hosts per desk: near[nearStart[d] .. nearStart[d + 1]). */
  nearStart: Int32Array;
  near: Int32Array;
};

export function buildDeskNeighbourhood(
  desks: ReadonlyArray<{ x: number; z: number }>,
  arena: { x: number; z: number; rows: readonly number[] },
): HqDeskNeighbourhood {
  const n = desks.length;
  const rowCount = Math.max(1, arena.rows.length);
  const row = new Int16Array(n);
  const angle = new Float64Array(n);
  for (let d = 0; d < n; d++) {
    const dx = desks[d].x - arena.x;
    const dz = desks[d].z - arena.z;
    const r = Math.hypot(dx, dz);
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < arena.rows.length; k++) {
      const e = Math.abs(r - arena.rows[k]);
      if (e < bestD) {
        bestD = e;
        best = k;
      }
    }
    row[d] = best;
    // Arena angles run from due south (+Z), positive toward the east (+X).
    angle[d] = Math.atan2(dx, dz);
  }
  const byRow: number[][] = Array.from({ length: rowCount }, () => []);
  for (let d = 0; d < n; d++) byRow[row[d]].push(d);
  const rowStart = new Int32Array(rowCount + 1);
  const rowDesks = new Int32Array(n);
  const pos = new Int32Array(n);
  let fill = 0;
  for (let r = 0; r < rowCount; r++) {
    rowStart[r] = fill;
    byRow[r].sort((a, b) => angle[a] - angle[b] || a - b);
    byRow[r].forEach((d, k) => {
      pos[d] = k;
      rowDesks[fill + k] = d;
    });
    fill += byRow[r].length;
  }
  rowStart[rowCount] = fill;

  const nearStart = new Int32Array(n + 1);
  const near: number[] = [];
  const cand: Array<{ d: number; cost: number }> = [];
  for (let d = 0; d < n; d++) {
    nearStart[d] = near.length;
    cand.length = 0;
    const r0 = row[d];
    for (let r = Math.max(0, r0 - PEER_ROWS); r <= Math.min(rowCount - 1, r0 + PEER_ROWS); r++) {
      const list = byRow[r];
      if (list.length === 0) continue;
      // The desk in that row nearest by angle stands in for "straight across".
      let k0 = 0;
      if (r === r0) k0 = pos[d];
      else {
        let bestD = Infinity;
        for (let k = 0; k < list.length; k++) {
          const e = Math.abs(angle[list[k]] - angle[d]);
          if (e < bestD) {
            bestD = e;
            k0 = k;
          }
        }
      }
      for (let k = Math.max(0, k0 - PEER_DESKS); k <= Math.min(list.length - 1, k0 + PEER_DESKS); k++) {
        const e = list[k];
        if (e === d) continue;
        cand.push({ d: e, cost: Math.abs(r - r0) * 2 + Math.abs(k - k0) });
      }
    }
    cand.sort((a, b) => a.cost - b.cost || a.d - b.d);
    for (const c of cand) near.push(c.d);
  }
  nearStart[n] = near.length;
  return { row, pos, rowStart, rowDesks, nearStart, near: Int32Array.from(near) };
}

/** Whether any desk within `spacing` desks of `desk` in its row (itself included) has a guest. */
export function guestNearby(nb: HqDeskNeighbourhood, guests: Uint8Array, desk: number, spacing: number): boolean {
  if (desk < 0 || desk >= nb.row.length) return false;
  const r = nb.row[desk];
  const s0 = nb.rowStart[r];
  const s1 = nb.rowStart[r + 1];
  const p = s0 + nb.pos[desk];
  const lo = p - spacing > s0 ? p - spacing : s0;
  const hi = p + spacing < s1 - 1 ? p + spacing : s1 - 1;
  for (let k = lo; k <= hi; k++) if (guests[nb.rowDesks[k]] > 0) return true;
  return false;
}

// --- Seated neighbours --------------------------------------------------------------------------

/**
 * For every desk, the desk of the neighbour sitting beside it in the same row
 * on the sitter's left (+X in the workstation frame, `left`) and right
 * (`right`), -1 when there is none (the row's end): the next desk along the
 * row, 1.2-2.0 m to that side, less than 0.4 m ahead or behind, facing the
 * same way within ~30 deg. The seated pair clips turn to exactly that side.
 */
export function seatedNeighbours(
  desks: ReadonlyArray<{ x: number; z: number; rotY: number }>,
  nb: HqDeskNeighbourhood,
): { left: Int32Array; right: Int32Array } {
  const n = desks.length;
  const left = new Int32Array(n).fill(-1);
  const right = new Int32Array(n).fill(-1);
  for (let d = 0; d < n; d++) {
    const r = nb.row[d];
    const s0 = nb.rowStart[r];
    const s1 = nb.rowStart[r + 1];
    const k = s0 + nb.pos[d];
    const c = Math.cos(desks[d].rotY);
    const sn = Math.sin(desks[d].rotY);
    for (const kk of [k - 1, k + 1]) {
      if (kk < s0 || kk >= s1) continue;
      const e = nb.rowDesks[kk];
      const dx = desks[e].x - desks[d].x;
      const dz = desks[e].z - desks[d].z;
      // Into d's workstation frame (sim.ts `local`, inverted): +X is the sitter's left, +Z ahead.
      const lx = dx * c - dz * sn;
      const lz = dx * sn + dz * c;
      let dr = desks[e].rotY - desks[d].rotY;
      dr = Math.atan2(Math.sin(dr), Math.cos(dr));
      if (Math.abs(lx) < 1.2 || Math.abs(lx) > 2.0 || Math.abs(lz) > 0.4 || Math.abs(dr) > 0.55) continue;
      if (lx > 0) left[d] = e;
      else right[d] = e;
    }
  }
  return { left, right };
}
