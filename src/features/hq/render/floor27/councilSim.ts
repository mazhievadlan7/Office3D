/**
 * The Floor 27 council runtime: a compact simulation that drives the 27
 * androids (AM7 at the head, the 26 chiefs around the long table) and produces
 * the per-frame struct-of-arrays the crowd renderer reads (HqCrowdRuntime's
 * structural `{ frame, indexOf }` contract). It mirrors the HQ briefing's
 * gather → walk-to-place → sit pattern on a much smaller cast: when a council
 * is called the chiefs walk in from the door and take their seats, and while
 * one reports the others sit and listen, AM7 presides at the head.
 *
 * update(dt) allocates nothing: every agent's scratch is sized in the
 * constructor, so it holds the frame budget even if driven each tick.
 */

import {
  HQ_CLIP_INFO,
  HQ_CLIPS,
  HqClip,
} from "@/features/hq/core/config";
import type { HqAgentFrame } from "@/features/hq/core/types";
import { HQ_PLACE, HQ_STATUS_CODE } from "@/features/hq/core/types";
import { councilSeats, COUNCIL_DOOR, COUNCIL_HEAD, type CouncilSeat } from "./councilLayout";

const WALK_SPEED = 1.35;
const RUN_SPEED = 2.4;
/** Within this of the seat the walker slows from Run to Walk and settles. */
const SETTLE = 1.4;
/** Reached the seat: snap, face the chair, sit. */
const ARRIVE = 0.1;
/** Longest the gather waits on a chief who never arrives (seconds). */
const GATHER_CAP = 30;

type Mode = "idle" | "walk" | "sit" | "seated" | "stand";

type Agent = {
  id: string;
  lead: boolean;
  seat: number; // index into seats, or -1 for AM7
  x: number;
  z: number;
  rotY: number;
  mode: Mode;
  clip: HqClip;
  clipTime: number;
  prevClip: HqClip;
  prevClipTime: number;
  blend: number;
  sitTimer: number;
  holdUntil: number;
  /** Target the agent walks to (its seat or the head). */
  tx: number;
  tz: number;
  trot: number;
  /** Where it looks (world); weight 0 = animation only. */
  lookX: number;
  lookY: number;
  lookZ: number;
  lookWeight: number;
};

export type CouncilView = {
  active: boolean;
  gathered: number;
  expected: number;
  allSeated: boolean;
};

const clipName = (clip: HqClip) => HQ_CLIPS[clip];
const clipDuration = (clip: HqClip) => HQ_CLIP_INFO[clipName(clip)].duration;
const clipLoops = (clip: HqClip) => HQ_CLIP_INFO[clipName(clip)].loop;
const clipBlend = (clip: HqClip) => HQ_CLIP_INFO[clipName(clip)].blend;

export class CouncilSimulation {
  readonly frame: HqAgentFrame;
  private readonly agents: Agent[];
  private readonly index = new Map<string, number>();
  private readonly seats: CouncilSeat[];
  private time = 0;
  private active = false;
  private startedAt = 0;
  private speaker = -1; // speaking-order index (0-based) or -1
  private am7Speaking = false;

  constructor(chiefIds: readonly string[]) {
    this.seats = councilSeats();
    const ids = ["am7", ...chiefIds.slice(0, this.seats.length)];
    const count = ids.length;
    this.agents = ids.map((id, i) => {
      const lead = i === 0;
      const seat = lead ? -1 : i - 1;
      // Start at the head (AM7) or clustered by the door (chiefs waiting).
      const start = lead
        ? { x: COUNCIL_HEAD.x, z: COUNCIL_HEAD.z, rotY: COUNCIL_HEAD.rotY }
        : doorSpot(seat);
      const agent: Agent = {
        id,
        lead,
        seat,
        x: start.x,
        z: start.z,
        rotY: start.rotY,
        mode: lead ? "stand" : "idle",
        clip: lead ? HqClip.Idle : HqClip.Idle,
        clipTime: 0,
        prevClip: HqClip.Idle,
        prevClipTime: 0,
        blend: 1,
        sitTimer: 0,
        holdUntil: 0,
        tx: start.x,
        tz: start.z,
        trot: start.rotY,
        lookX: 0,
        lookY: 1.5,
        lookZ: 0,
        lookWeight: 0,
      };
      this.index.set(id, i);
      return agent;
    });
    this.frame = {
      count,
      ids,
      x: new Float32Array(count),
      y: new Float32Array(count),
      z: new Float32Array(count),
      facing: new Float32Array(count),
      clip: new Uint8Array(count),
      clipTime: new Float32Array(count),
      prevClip: new Uint8Array(count),
      prevClipTime: new Float32Array(count),
      blend: new Float32Array(count),
      lookX: new Float32Array(count),
      lookY: new Float32Array(count),
      lookZ: new Float32Array(count),
      lookWeight: new Float32Array(count),
      status: new Uint8Array(count),
      lead: new Uint8Array(count),
      place: new Uint8Array(count),
    };
    for (let i = 0; i < count; i += 1) {
      this.frame.lead[i] = this.agents[i].lead ? 1 : 0;
      this.frame.status[i] = HQ_STATUS_CODE.working;
    }
    this.writeFrame();
  }

  indexOf(id: string): number {
    return this.index.get(id) ?? -1;
  }

  get council(): CouncilView {
    let gathered = 0;
    const expected = this.seats.length;
    for (const a of this.agents) if (!a.lead && a.mode === "seated") gathered += 1;
    return { active: this.active, gathered, expected, allSeated: gathered >= expected };
  }

  /** Calls the council: the chiefs leave the door and take their seats. */
  start(): void {
    this.active = true;
    this.startedAt = this.time;
    let stagger = 0;
    for (const a of this.agents) {
      if (a.lead) {
        a.tx = COUNCIL_HEAD.x;
        a.tz = COUNCIL_HEAD.z;
        a.trot = COUNCIL_HEAD.rotY;
        if (a.mode === "idle") a.mode = "walk";
        continue;
      }
      const seat = this.seats[a.seat];
      a.tx = seat.x;
      a.tz = seat.z;
      a.trot = seat.rotY;
      a.holdUntil = this.time + stagger;
      a.mode = a.mode === "seated" ? "seated" : "walk";
      stagger += 0.18; // the hall rises in a staggered wave, not as one
    }
  }

  /** Ends the council: everyone stays seated, listening (increment 2 may rise/leave). */
  stop(): void {
    this.active = false;
    this.speaker = -1;
    this.am7Speaking = false;
  }

  /** The chief now reporting (0-based speaking-order index), or -1 for none. */
  setSpeaker(index: number): void {
    this.speaker = index;
  }

  /** AM7 is speaking (his reply / closing): presides with a talking pose. */
  setAm7Speaking(on: boolean): void {
    this.am7Speaking = on;
  }

  private setClip(a: Agent, clip: HqClip): void {
    if (a.clip === clip) return;
    a.prevClip = a.clip;
    a.prevClipTime = a.clipTime;
    a.blend = 0;
    a.clip = clip;
    a.clipTime = 0;
  }

  update(dt: number): void {
    const step = Math.min(Math.max(dt, 0), 0.1);
    this.time += step;
    const gatherTimedOut = this.active && this.time - this.startedAt > GATHER_CAP;
    for (let i = 0; i < this.agents.length; i += 1) {
      const a = this.agents[i];
      if (a.lead) this.updateLead(a, step);
      else this.updateChief(a, step, gatherTimedOut);
      this.advanceClip(a, step);
    }
    this.writeFrame();
  }

  private updateLead(a: Agent, step: number): void {
    // Walk to the head, then preside: Talk while replying, else Idle, looking
    // at the chief who is speaking.
    if (a.mode === "walk") {
      if (this.stepToward(a, step)) {
        a.mode = "stand";
        a.rotY = a.trot;
      }
    }
    if (a.mode === "stand") {
      this.setClip(a, this.am7Speaking ? HqClip.Talk : HqClip.StandListen);
      a.rotY = approach(a.rotY, a.trot, step * 6);
    } else {
      this.setClip(a, a.mode === "walk" ? walkGait(a) : HqClip.Idle);
    }
    this.lookAtSpeaker(a);
  }

  private updateChief(a: Agent, step: number, timedOut: boolean): void {
    switch (a.mode) {
      case "idle":
        this.setClip(a, HqClip.Idle);
        break;
      case "walk": {
        if (this.time < a.holdUntil) {
          this.setClip(a, HqClip.Idle);
          break;
        }
        this.setClip(a, walkGait(a));
        if (this.stepToward(a, step)) {
          a.x = a.tx;
          a.z = a.tz;
          a.rotY = a.trot;
          a.mode = "sit";
          a.sitTimer = 0;
          this.setClip(a, HqClip.SitDown);
        }
        break;
      }
      case "sit":
        a.sitTimer += step;
        if (a.sitTimer >= clipDuration(HqClip.SitDown) - 0.05) a.mode = "seated";
        break;
      case "seated": {
        const seat = this.seats[a.seat];
        const speaking = this.speaker >= 0 && this.speaker === a.seat;
        if (speaking) this.setClip(a, seat.turn > 0 ? HqClip.SitTurnL : HqClip.SitTurnR);
        else this.setClip(a, HqClip.SitIdle);
        break;
      }
      default:
        break;
    }
    // A chief that never arrives is let go at the cap, so the gather can finish.
    if (timedOut && (a.mode === "walk" || a.mode === "idle")) {
      a.x = a.tx;
      a.z = a.tz;
      a.rotY = a.trot;
      a.mode = "seated";
      this.setClip(a, HqClip.SitIdle);
    }
    this.lookAtHead(a);
  }

  /** Moves the agent toward (tx, tz); returns true on arrival. */
  private stepToward(a: Agent, step: number): boolean {
    const dx = a.tx - a.x;
    const dz = a.tz - a.z;
    const dist = Math.hypot(dx, dz);
    if (dist < ARRIVE) return true;
    const speed = dist > SETTLE ? RUN_SPEED : WALK_SPEED;
    const move = Math.min(dist, speed * step);
    a.x += (dx / dist) * move;
    a.z += (dz / dist) * move;
    a.rotY = approach(a.rotY, Math.atan2(dx, dz), step * 8);
    return false;
  }

  private lookAtSpeaker(a: Agent): void {
    if (this.speaker < 0) {
      a.lookWeight = 0;
      return;
    }
    const seat = this.seats[this.speaker];
    a.lookX = seat.x;
    a.lookY = 1.2;
    a.lookZ = seat.z;
    a.lookWeight = 0.5;
  }

  private lookAtHead(a: Agent): void {
    if (a.mode !== "seated") {
      a.lookWeight = 0;
      return;
    }
    // Seated chiefs look toward AM7 at the head.
    a.lookX = COUNCIL_HEAD.x;
    a.lookY = 1.4;
    a.lookZ = COUNCIL_HEAD.z;
    a.lookWeight = this.speaker >= 0 && this.speaker === a.seat ? 0.6 : 0.35;
  }

  private advanceClip(a: Agent, step: number): void {
    a.clipTime += step;
    const dur = clipDuration(a.clip);
    if (clipLoops(a.clip)) {
      if (a.clipTime >= dur) a.clipTime %= dur;
    } else if (a.clipTime > dur) {
      a.clipTime = dur;
    }
    if (a.blend < 1) {
      const fade = clipBlend(a.clip) || 0.3;
      a.blend = Math.min(1, a.blend + step / fade);
      a.prevClipTime += step;
    }
  }

  private writeFrame(): void {
    const f = this.frame;
    for (let i = 0; i < this.agents.length; i += 1) {
      const a = this.agents[i];
      f.x[i] = a.x;
      f.y[i] = 0;
      f.z[i] = a.z;
      f.facing[i] = a.rotY;
      f.clip[i] = a.clip;
      f.clipTime[i] = a.clipTime;
      f.prevClip[i] = a.prevClip;
      f.prevClipTime[i] = a.prevClipTime;
      f.blend[i] = a.blend;
      f.lookX[i] = a.lookX;
      f.lookY[i] = a.lookY;
      f.lookZ[i] = a.lookZ;
      f.lookWeight[i] = a.lookWeight;
      f.place[i] = a.lead ? HQ_PLACE.podium : HQ_PLACE.briefing;
    }
  }
}

/** Where a waiting chief stands by the door before the council is called. */
function doorSpot(seat: number): { x: number; z: number; rotY: number } {
  const col = seat % 6;
  const rowBack = Math.floor(seat / 6);
  const x = COUNCIL_DOOR.x + rowBack * 1.0;
  const z = (col - 2.5) * 0.9;
  return { x, z, rotY: -Math.PI / 2 }; // facing −X, toward the table
}

function walkGait(a: Agent): HqClip {
  const dist = Math.hypot(a.tx - a.x, a.tz - a.z);
  return dist > SETTLE ? HqClip.Run : HqClip.Walk;
}

/** Eases `current` toward `target` angle by at most `maxStep` (shortest way). */
function approach(current: number, target: number, maxStep: number): number {
  let delta = target - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  if (Math.abs(delta) <= maxStep) return target;
  return current + Math.sign(delta) * maxStep;
}
