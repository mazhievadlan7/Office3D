import { describe, expect, it } from "vitest";

import { helpVisitLimit, peerVisitLimit } from "@/features/hq/core/beats";
import { HQ_SHOULDER, HQ_SHOULDER_LEFT, HqClip } from "@/features/hq/core/config";
import { generateHqLayout, seatToWorld } from "@/features/hq/core/layout";
import { HqSimulation } from "@/features/hq/core/sim";
import type { HqAgentInput, HqAgentStatus } from "@/features/hq/core/types";

// A hacker in error works the problem at their own desk; now and then a free
// colleague comes over to help (sim.ts errorActs / startHelp).

const DT = 0.1;
const layout = generateHqLayout(300);

/** The sim's agents, for what the frame does not show (private in the sim). */
type SimAgent = {
  id: string;
  index: number;
  seat: number;
  status: number;
  mode: number;
  place: number;
  placeSeat: number;
  helpTarget: SimAgent | null;
  helpSeat: number;
  errHelper: SimAgent | null;
};
const agentsOf = (sim: HqSimulation) => (sim as unknown as { agents: SimAgent[] }).agents;
const M_SEATED = 2;
const M_STAND = 4;
const D_SEAT = 1;
const D_ERROR = 2;
const D_BRIEF = 6;
const D_HELP = 10;

function team(count: number, status: (i: number) => HqAgentStatus): HqAgentInput[] {
  return Array.from({ length: count }, (_, i) => ({ id: `agent-${String(i).padStart(4, "0")}`, name: `Agent ${i}`, status: status(i) }));
}

/** 200 hackers: every 6th in error, about half the rest free (helpers to be had). */
const STATUS = (i: number): HqAgentStatus => (i % 6 === 0 ? "error" : i % 2 === 0 ? "idle" : "working");

const place = (desk: number, local: { x: number; z: number }) => {
  const d = layout.desks[desk];
  return seatToWorld(d.x, d.z, d.rotY, local.x, local.z);
};

const SEATED_ERROR_CLIPS: number[] = [HqClip.SitType2, HqClip.SitRead, HqClip.SitLeanBack];

describe("HqSimulation: a hacker in error at their own desk", () => {
  // One long run, observed frame by frame, shared by the checks below.
  const sim = new HqSimulation(layout, { seed: 11 });
  const inputs = team(200, STATUS);
  sim.setAgents(inputs);
  const desks = sim.getAssignments();
  const agents = agentsOf(sim);
  const errorIds = inputs.filter((p) => p.status === "error").map((p) => p.id);
  const errorSet = new Set(errorIds);
  let maxFromDesk = 0;
  let seatedFrames = 0;
  let standFrames = 0;
  let otherSettled = 0;
  const clipsSeen = new Set<number>();
  let maxShoulderErr = 0;
  let maxHelperErr = 0;
  let helperBadClip = 0;
  let maxHelpers = 0;
  let maxNeighbourStanding = Infinity;
  const helpStays: number[] = [];
  const helpedIds = new Set<string>();
  const helperIds = new Set<string>();
  {
    const arrived = new Map<string, number>();
    const STEPS = 3600; // six simulated minutes
    for (let step = 0; step < STEPS; step++) {
      sim.update(DT);
      const f = sim.frame;
      let helpers = 0;
      const standers: number[] = [];
      for (const a of agents) {
        const i = a.index;
        if (errorSet.has(a.id)) {
          const d = layout.desks[desks[a.id]];
          maxFromDesk = Math.max(maxFromDesk, Math.hypot(f.x[i] - d.x, f.z[i] - d.z));
          if (a.mode === M_SEATED && a.place === D_SEAT) {
            seatedFrames++;
            clipsSeen.add(f.clip[i]);
            if (f.blend[i] >= 1 && !SEATED_ERROR_CLIPS.includes(f.clip[i])) otherSettled++;
          } else if (a.mode === M_STAND && a.place === D_ERROR) {
            standFrames++;
            clipsSeen.add(f.clip[i]);
            const p = place(desks[a.id], HQ_SHOULDER);
            maxShoulderErr = Math.max(maxShoulderErr, Math.hypot(f.x[i] - p.x, f.z[i] - p.z));
            if (f.blend[i] >= 1 && f.clip[i] !== HqClip.StandLookOver) otherSettled++;
            standers.push(i);
          }
        }
        if (a.helpTarget) {
          helpers++;
          helpedIds.add(a.helpTarget.id);
          helperIds.add(a.id);
          if (a.mode === M_STAND && a.place === D_HELP) {
            const p = place(a.helpSeat, HQ_SHOULDER_LEFT);
            maxHelperErr = Math.max(maxHelperErr, Math.hypot(f.x[i] - p.x, f.z[i] - p.z));
            if (f.blend[i] >= 1 && f.clip[i] !== HqClip.Talk && f.clip[i] !== HqClip.StandListen) helperBadClip++;
            if (!arrived.has(a.id)) arrived.set(a.id, step);
            standers.push(i);
          }
        } else if (arrived.has(a.id)) {
          helpStays.push((step - arrived.get(a.id)!) * DT);
          arrived.delete(a.id);
        }
      }
      maxHelpers = Math.max(maxHelpers, helpers);
      // Standing helpers and hackers in error never crowd each other.
      for (let p = 0; p < standers.length; p++) {
        for (let q = p + 1; q < standers.length; q++) {
          const i = standers[p];
          const j = standers[q];
          maxNeighbourStanding = Math.min(maxNeighbourStanding, Math.hypot(f.x[i] - f.x[j], f.z[i] - f.z[j]));
        }
      }
    }
  }

  it("never leaves their own desk", () => {
    expect(errorIds.length).toBeGreaterThan(20);
    // The chair, the shoulder place, the few steps round the chair's back.
    expect(maxFromDesk).toBeLessThan(1.6);
  });

  it("works the problem mostly seated, now and then up at the shoulder place over their own chair", () => {
    for (const clip of [HqClip.SitType2, HqClip.SitRead, HqClip.SitLeanBack, HqClip.StandLookOver]) {
      expect(clipsSeen.has(clip)).toBe(true);
    }
    expect(clipsSeen.has(HqClip.SitIdle)).toBe(false);
    expect(otherSettled).toBe(0);
    expect(standFrames).toBeGreaterThan(0);
    expect(seatedFrames).toBeGreaterThan(2 * standFrames);
    expect(maxShoulderErr).toBeLessThan(0.02);
  });

  it("brings a free colleague to the left shoulder place now and then, talking or listening, for 15-40 s", () => {
    expect(helpedIds.size).toBeGreaterThan(2);
    // Roughly the share of errors that draw help (30%), not every one.
    expect(helpedIds.size).toBeLessThan(errorIds.length);
    for (const id of helpedIds) expect(errorSet.has(id)).toBe(true);
    for (const id of helperIds) expect(inputs.find((p) => p.id === id)?.status).toBe("idle");
    expect(maxHelperErr).toBeLessThan(0.02);
    expect(helperBadClip).toBe(0);
    expect(helpStays.length).toBeGreaterThan(0);
    for (const t of helpStays) {
      expect(t).toBeGreaterThanOrEqual(15);
      expect(t).toBeLessThanOrEqual(41);
    }
  });

  it("keeps the visit limit and the room between people standing at the desks", () => {
    expect(maxHelpers).toBeLessThanOrEqual(peerVisitLimit(agents.length));
    expect(maxNeighbourStanding).toBeGreaterThan(0.75);
  });

  it("has the helper and the hacker in error count as a conversation for the crew's voices", () => {
    // Find a helper at the place, then cue each side once.
    const fresh = new HqSimulation(layout, { seed: 11 });
    fresh.setAgents(inputs);
    const list = agentsOf(fresh);
    let helper: SimAgent | undefined;
    for (let step = 0; step < 3600 && !helper; step++) {
      fresh.update(DT);
      helper = list.find((a) => a.helpTarget && a.place === D_HELP && a.mode === M_STAND);
    }
    expect(helper).toBeDefined();
    const h = helper!;
    const t = h.helpTarget!;
    expect(fresh.conversing(h.index)).toBe(true);
    expect(fresh.conversing(t.index)).toBe(true);
    expect(fresh.cueTalk(h.id, 3)).toBe(true);
    for (let step = 0; step < 8; step++) fresh.update(DT);
    expect(fresh.frame.clip[h.index]).toBe(HqClip.Talk);
    expect(fresh.cueTalk(t.id, 3)).toBe(true);
    for (let step = 0; step < 8; step++) fresh.update(DT);
    expect(fresh.frame.clip[h.index]).toBe(HqClip.StandListen);
  });
});

describe("HqSimulation: an error clears", () => {
  it("sends the helper back and sits the hacker down to work, every clip change a crossfade", () => {
    const sim = new HqSimulation(layout, { seed: 11 });
    const inputs = team(200, STATUS);
    sim.setAgents(inputs);
    const list = agentsOf(sim);
    let helper: SimAgent | undefined;
    // A hacker in error up at the shoulder place with a helper beside them, or at least a helper there.
    for (let step = 0; step < 6000; step++) {
      sim.update(DT);
      helper = list.find((a) => a.helpTarget && a.place === D_HELP && a.mode === M_STAND && a.helpTarget.place === D_ERROR);
      if (helper) break;
    }
    if (!helper) helper = list.find((a) => a.helpTarget && a.place === D_HELP && a.mode === M_STAND);
    expect(helper).toBeDefined();
    const h = helper!;
    const t = h.helpTarget!;
    const watch = [h.index, t.index];
    sim.setAgents(inputs.map((p) => (p.id === t.id ? { ...p, status: "working" as const } : p)));
    expect(h.helpTarget).toBeNull();
    expect(t.errHelper).toBeNull();
    const last = watch.map((i) => sim.frame.clip[i]);
    const lastPrev = watch.map((i) => sim.frame.prevClip[i]);
    const lastBlend = watch.map((i) => sim.frame.blend[i]);
    let pops = 0;
    for (let step = 0; step < 300; step++) {
      sim.update(DT);
      const f = sim.frame;
      watch.forEach((i, k) => {
        if (f.clip[i] !== last[k]) {
          // A new clip always fades in from the one before it: its weight
          // never jumps (it may already have been fading out: a swap back).
          const before = lastPrev[k] === f.clip[i] ? 1 - lastBlend[k] : 0;
          if (f.prevClip[i] !== last[k] || f.blend[i] - before > 0.5) pops++;
        }
        last[k] = f.clip[i];
        lastPrev[k] = f.prevClip[i];
        lastBlend[k] = f.blend[i];
      });
    }
    expect(pops).toBe(0);
    const f = sim.frame;
    expect(t.mode).toBe(M_SEATED);
    expect(t.place).toBe(D_SEAT);
    expect([HqClip.SitType, HqClip.SitType2]).toContain(f.clip[t.index]);
    expect(h.place).toBe(D_SEAT);
    expect(h.placeSeat).toBe(h.seat);
  });
});

describe("HqSimulation: errors, briefings and missions", () => {
  it("stands everyone in error at their own desk for a briefing, with no help under way, and leaves them out of the count", () => {
    const sim = new HqSimulation(layout, { seed: 11 });
    const inputs = [{ id: "am7", name: "AM7", status: "working" as const }, ...team(200, STATUS)];
    sim.setAgents(inputs);
    const list = agentsOf(sim);
    for (let step = 0; step < 900; step++) sim.update(DT);
    sim.startBriefing(600);
    for (let step = 0; step < 400; step++) {
      sim.update(DT);
      expect(list.some((a) => a.helpTarget || a.errHelper)).toBe(false);
    }
    const errors = list.filter((a) => a.status === 2);
    for (const a of errors) expect(a.place).toBe(D_BRIEF);
    const b = sim.briefing;
    expect(b.expected).toBe(list.length - 1 - errors.length);
  });

  it("allows help during a mission only within the mission's help limit", () => {
    const sim = new HqSimulation(layout, { seed: 12 });
    const inputs = team(200, STATUS);
    sim.startMission(600);
    sim.setAgents(inputs);
    const list = agentsOf(sim);
    let max = 0;
    let any = 0;
    for (let step = 0; step < 3600; step++) {
      sim.update(DT);
      let n = 0;
      for (const a of list) if (a.helpTarget) n++;
      max = Math.max(max, n);
      any += n;
    }
    expect(any).toBeGreaterThan(0);
    expect(max).toBeLessThanOrEqual(helpVisitLimit(list.length));
  });

  it("replays exactly with the same seed", () => {
    const run = () => {
      const s = new HqSimulation(layout, { seed: 4 });
      s.setAgents(team(160, STATUS));
      for (let step = 0; step < 1800; step++) s.update(DT);
      return [Array.from(s.frame.x), Array.from(s.frame.z), Array.from(s.frame.clip)];
    };
    expect(run()).toEqual(run());
  });
});
