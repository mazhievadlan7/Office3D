import { describe, expect, it } from "vitest";

import {
  GUEST_SPACING,
  buildDeskNeighbourhood,
  helpVisitLimit,
  peerVisitLimit,
} from "@/features/hq/core/beats";
import { HQ_CLIP_INFO, HQ_CLIPS, HQ_SHOULDER, HqClip } from "@/features/hq/core/config";
import { HQ_PROP_FOOTPRINT, generateHqLayout, seatToWorld } from "@/features/hq/core/layout";
import { HqSimulation } from "@/features/hq/core/sim";
import { HQ_PLACE } from "@/features/hq/core/types";
import type { HqAgentInput, HqAgentStatus, HqLayout } from "@/features/hq/core/types";
import { isSeatedClip, isTypingClip } from "@/features/hq/render/crowd/clipTable";

const HEAD_SEATED = 1.22;

/** Seated at the desk in one of its acts (typing, reading, leaning back, ...), not getting up or down. */
const AT_WORK = (clip: number) => isSeatedClip(clip) && clip !== HqClip.SitDown;
/** Standing still: idle, talking, listening, or at someone's shoulder. */
const STANDING_CLIPS: number[] = [HqClip.Idle, HqClip.Talk, HqClip.StandListen, HqClip.StandLookOver];
const TABLE_LOOK_Y = 0.45;

function team(count: number, status: (i: number) => HqAgentStatus): HqAgentInput[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `agent-${String(i).padStart(4, "0")}`,
    name: `Agent ${i}`,
    status: status(i),
  }));
}

/** Lounge seat index each agent's root is on (within 2 cm), or -1. */
function seatOf(layout: HqLayout, x: number, z: number): number {
  const seats = layout.loungeSeats;
  for (let k = 0; k < seats.length; k++) {
    if (Math.abs(seats[k].x - x) < 0.02 && Math.abs(seats[k].z - z) < 0.02) return k;
  }
  return -1;
}

function angleDiff(a: number, b: number): number {
  const d = (((a - b) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2);
  return Math.abs(d - Math.PI);
}

describe("HqSimulation lounge breaks", () => {
  const layout = generateHqLayout(300);
  const seats = layout.loungeSeats;

  // One long idle run, observed frame by frame, shared by the checks below.
  const sim = new HqSimulation(layout, { seed: 7 });
  sim.setAgents(team(160, () => "idle"));
  const DT = 0.1;
  const STEPS = 6000; // ten simulated minutes
  const sat = new Set<string>();
  const sitDownFrom: Array<{ seat: number; x: number; z: number; facing: number }> = [];
  const standUpTo: Array<{ seat: number; x: number; z: number }> = [];
  let doubleBooked = 0;
  let lookSamples = 0;
  let lookMatches = 0;
  let neighbourLooks = 0;
  let maxSeatedAtOnce = 0;
  {
    const n = sim.frame.count;
    const prevSeat = new Int32Array(n).fill(-1);
    const prevX = new Float32Array(n);
    const prevZ = new Float32Array(n);
    const prevFacing = new Float32Array(n);
    const occupant = new Int32Array(seats.length);
    for (let step = 0; step < STEPS; step++) {
      sim.update(DT);
      const f = sim.frame;
      occupant.fill(-1);
      let seatedNow = 0;
      for (let i = 0; i < f.count; i++) {
        const k = seatOf(layout, f.x[i], f.z[i]);
        if (k >= 0) {
          if (occupant[k] >= 0) doubleBooked++;
          occupant[k] = i;
          seatedNow++;
          if (prevSeat[i] < 0) {
            sitDownFrom.push({ seat: k, x: prevX[i], z: prevZ[i], facing: prevFacing[i] });
            expect(f.clip[i]).toBe(HqClip.SitDown);
          }
          if (f.clip[i] === HqClip.SitIdle) sat.add(f.ids[i]);
        } else if (prevSeat[i] >= 0) {
          standUpTo.push({ seat: prevSeat[i], x: f.x[i], z: f.z[i] });
        }
        prevSeat[i] = k;
        prevX[i] = f.x[i];
        prevZ[i] = f.z[i];
        prevFacing[i] = f.facing[i];
      }
      maxSeatedAtOnce = Math.max(maxSeatedAtOnce, seatedNow);
      // Head targets of settled sitters: the nearest settled sitter in the group, else the table.
      if (step % 5 !== 0) continue;
      for (let k = 0; k < seats.length; k++) {
        const i = occupant[k];
        if (i < 0 || f.clip[i] !== HqClip.SitIdle || f.blend[i] < 1) continue;
        let best = -1;
        let bestD = Infinity;
        for (let j = 0; j < seats.length; j++) {
          const o = occupant[j];
          if (j === k || o < 0 || seats[j].group !== seats[k].group || f.clip[o] !== HqClip.SitIdle) continue;
          const d = Math.hypot(seats[j].x - seats[k].x, seats[j].z - seats[k].z);
          if (d < bestD) {
            bestD = d;
            best = j;
          }
        }
        const group = layout.loungeGroups[seats[k].group];
        const tx = best >= 0 ? seats[best].x + Math.sin(seats[best].rotY) * 0.1 : group.tableX;
        const tz = best >= 0 ? seats[best].z + Math.cos(seats[best].rotY) * 0.1 : group.tableZ;
        const ty = best >= 0 ? HEAD_SEATED : TABLE_LOOK_Y;
        lookSamples++;
        if (Math.hypot(f.lookX[i] - tx, f.lookZ[i] - tz) < 0.2 && Math.abs(f.lookY[i] - ty) < 0.1) {
          lookMatches++;
          if (best >= 0) neighbourLooks++;
        }
      }
    }
  }

  it("sits idle agents on lounge seats, never two on one seat", () => {
    expect(seats.length).toBeGreaterThanOrEqual(16);
    expect(sat.size).toBeGreaterThanOrEqual(10);
    expect(maxSeatedAtOnce).toBeGreaterThanOrEqual(4);
    expect(maxSeatedAtOnce).toBeLessThanOrEqual(seats.length);
    expect(doubleBooked).toBe(0);
  });

  it("sits down from the seat's approach point, already facing the seat's way", () => {
    expect(sitDownFrom.length).toBeGreaterThanOrEqual(10);
    for (const s of sitDownFrom) {
      const seat = seats[s.seat];
      expect(Math.hypot(s.x - seat.approach.x, s.z - seat.approach.z)).toBeLessThan(0.05);
      expect(angleDiff(s.facing, seat.rotY)).toBeLessThan(0.1);
    }
  });

  it("stands up back onto the approach point and leaves", () => {
    expect(standUpTo.length).toBeGreaterThanOrEqual(5);
    for (const s of standUpTo) {
      const seat = seats[s.seat];
      expect(Math.hypot(s.x - seat.approach.x, s.z - seat.approach.z)).toBeLessThan(0.05);
    }
  });

  it("looks at the nearest other sitter in the group, or at the coffee table", () => {
    expect(lookSamples).toBeGreaterThan(200);
    expect(neighbourLooks).toBeGreaterThan(20);
    expect(lookMatches / lookSamples).toBeGreaterThan(0.85);
  });

  it("walks everyone back to their desks when work starts", () => {
    sim.setAgents(team(160, () => "working"));
    for (let step = 0; step < 1800; step++) sim.update(DT);
    const f = sim.frame;
    for (let i = 0; i < f.count; i++) {
      expect(seatOf(layout, f.x[i], f.z[i]), f.ids[i]).toBe(-1);
      expect(AT_WORK(f.clip[i]), `${f.ids[i]} ${HQ_CLIPS[f.clip[i]]}`).toBe(true);
    }
    // And the seats are free again: a new idle spell fills them.
    sim.setAgents(team(160, () => "idle"));
    let seatedLater = 0;
    for (let step = 0; step < 3000 && seatedLater === 0; step++) {
      sim.update(DT);
      for (let i = 0; i < f.count; i++) if (seatOf(layout, f.x[i], f.z[i]) >= 0) seatedLater++;
    }
    expect(seatedLater).toBeGreaterThan(0);
  });

  it("falls back to standing in the lounge when a seating group is full", () => {
    const busy = new HqSimulation(layout, { seed: 11 });
    busy.setAgents(team(300, () => "idle"));
    // Per seating group: the most sat at once, and the most standing in its
    // lounge (past the coffee bar) while the group was full.
    const groups = layout.loungeGroups.map((g, gi) => ({
      room: layout.lounges.find((r) => g.tableX > r.x0 && g.tableX < r.x1 && g.tableZ > r.z0 && g.tableZ < r.z1)!,
      seats: new Set(seats.map((s, k) => (s.group === gi ? k : -1)).filter((k) => k >= 0)),
      seatedMax: 0,
      standingFull: 0,
    }));
    // Twenty simulated minutes.
    for (let step = 0; step < 12000; step++) {
      busy.update(DT);
      if (step % 10 !== 0) continue;
      const f = busy.frame;
      const seatedIn = new Int32Array(groups.length);
      const standingIn = new Map<HqLayout["lounge"], number>();
      for (let i = 0; i < f.count; i++) {
        const k = seatOf(layout, f.x[i], f.z[i]);
        if (k >= 0) {
          seatedIn[seats[k].group]++;
          continue;
        }
        if (f.clip[i] === HqClip.Walk) continue;
        for (const room of layout.lounges) {
          if (f.x[i] > room.x0 && f.x[i] < room.x1 && f.z[i] > room.z0 + 4.5 && f.z[i] < room.z1) {
            standingIn.set(room, (standingIn.get(room) ?? 0) + 1);
          }
        }
      }
      groups.forEach((g, gi) => {
        g.seatedMax = Math.max(g.seatedMax, seatedIn[gi]);
        // "Every seat taken", give or take one being left or walked to.
        if (seatedIn[gi] >= g.seats.size - 1) g.standingFull = Math.max(g.standingFull, standingIn.get(g.room) ?? 0);
      });
    }
    const full = groups.filter((g) => g.seatedMax >= g.seats.size - 1);
    expect(full.length).toBeGreaterThan(0);
    expect(Math.max(...full.map((g) => g.standingFull))).toBeGreaterThan(0);
  });
});

describe("HqSimulation standing places", () => {
  // A crowded hall: more agents than desks, most of them idle, so the social
  // spots fill up and deskless agents spill into the overflow rings.
  const layout = generateHqLayout(300);
  const sim = new HqSimulation(layout, { seed: 9 });
  // 120 more agents than desks, whatever the hall size.
  sim.setAgents(team(layout.desks.length + 120, (i) => (i % 4 === 0 ? "working" : "idle")));
  const lounge = layout.lounge;
  const inLounge = (x: number, z: number) => x > lounge.x0 && x < lounge.x1 && z > lounge.z0 && z < lounge.z1;
  const standing = (clip: number) => STANDING_CLIPS.includes(clip);
  const approaches = layout.loungeSeats.map((s) => s.approach);
  const atApproach = (x: number, z: number) => approaches.some((a) => Math.abs(a.x - x) < 0.05 && Math.abs(a.z - z) < 0.05);
  const bumps: string[] = [];
  const settled: Array<{ x: number; z: number }> = [];
  {
    const f = sim.frame;
    const lastX = new Float32Array(f.count);
    const lastZ = new Float32Array(f.count);
    const still = new Int32Array(f.count);
    for (let step = 0; step < 6000; step++) {
      sim.update(0.1);
      for (let i = 0; i < f.count; i++) {
        if (Math.abs(f.x[i] - lastX[i]) < 1e-4 && Math.abs(f.z[i] - lastZ[i]) < 1e-4) still[i]++;
        else still[i] = 0;
        lastX[i] = f.x[i];
        lastZ[i] = f.z[i];
        // Settled on a standing place: still for 3 s, not a sitter about to sit.
        if (still[i] === 30 && standing(f.clip[i]) && !atApproach(f.x[i], f.z[i])) settled.push({ x: f.x[i], z: f.z[i] });
        // Walkers in the lounge never walk through someone standing there.
        if (f.clip[i] !== HqClip.Walk || !inLounge(f.x[i], f.z[i])) continue;
        for (let j = 0; j < f.count; j++) {
          if (j === i || !standing(f.clip[j]) || !inLounge(f.x[j], f.z[j])) continue;
          if (Math.hypot(f.x[i] - f.x[j], f.z[i] - f.z[j]) < 0.45) bumps.push(`${f.ids[i]} into ${f.ids[j]}`);
        }
      }
    }
  }

  it("keeps the lounge's standing groups off its walkways", () => {
    // Before the standing spots moved off the corridors this was in the thousands.
    expect(bumps.length).toBeLessThan(25);
  });

  it("never stands anyone in the furniture or on the glass", () => {
    expect(settled.length).toBeGreaterThan(100);
    const props = layout.props.filter((p) => HQ_PROP_FOOTPRINT[p.kind][0] > 0);
    for (const p of settled) {
      const tag = `standing at ${p.x.toFixed(2)},${p.z.toFixed(2)}`;
      expect(p.x > layout.bounds.x0 + 0.3 && p.x < layout.bounds.x1 - 0.3, tag).toBe(true);
      for (const prop of props) {
        const [w, d] = HQ_PROP_FOOTPRINT[prop.kind];
        const c = Math.cos(prop.rotY);
        const s = Math.sin(prop.rotY);
        const dx = p.x - prop.x;
        const dz = p.z - prop.z;
        const ex = Math.max(0, Math.abs(dx * c - dz * s) - w / 2);
        const ez = Math.max(0, Math.abs(dx * s + dz * c) - d / 2);
        expect(Math.hypot(ex, ez), `${tag} vs ${prop.kind} at ${prop.x},${prop.z}`).toBeGreaterThan(0.3);
      }
      for (const w of layout.partitions) {
        expect(segmentDistance(p, w.ax, w.az, w.bx, w.bz), `${tag} vs glass`).toBeGreaterThan(0.3);
      }
    }
  });
});

function segmentDistance(p: { x: number; z: number }, ax: number, az: number, bx: number, bz: number): number {
  const ux = bx - ax;
  const uz = bz - az;
  const len2 = ux * ux + uz * uz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - ax) * ux + (p.z - az) * uz) / len2)) : 0;
  return Math.hypot(p.x - ax - ux * t, p.z - az - uz * t);
}

describe("HqSimulation determinism and budget", () => {
  it("replays exactly with the same seed", () => {
    const layout = generateHqLayout(100);
    const run = () => {
      const s = new HqSimulation(layout, { seed: 3 });
      s.setAgents(team(80, (i) => (i % 3 === 0 ? "working" : "idle")));
      for (let step = 0; step < 1500; step++) s.update(0.1);
      return [Array.from(s.frame.x), Array.from(s.frame.z), Array.from(s.frame.clip)];
    };
    expect(run()).toEqual(run());
  });

  it("updates 1000 agents well inside a frame", () => {
    const layout = generateHqLayout(1000);
    const sim = new HqSimulation(layout, { seed: 5 });
    sim.setAgents(team(1000, (i) => (i % 5 === 0 ? "idle" : i % 23 === 0 ? "error" : "working")));
    // Flip a third of the team to idle so routes, outings and lounge breaks run.
    for (let step = 0; step < 300; step++) sim.update(1 / 30);
    sim.setAgents(team(1000, (i) => (i % 3 === 0 ? "idle" : i % 23 === 0 ? "error" : "working")));
    for (let step = 0; step < 300; step++) sim.update(1 / 30);
    const frames = 300;
    const t0 = performance.now();
    for (let step = 0; step < frames; step++) sim.update(1 / 60);
    const perFrame = (performance.now() - t0) / frames;
    expect(perFrame).toBeLessThan(4);
  });
});

describe("HqSimulation cyber-range from the workstation", () => {
  const layout = generateHqLayout(300);
  const sim = new HqSimulation(layout, { seed: 11 });
  sim.setAgents(team(120, () => "working"));
  const DT = 0.1;
  const CY = HQ_PLACE.cyberrange;
  const WORKING = 0; // HQ_STATUS_CODE.working
  const everOnRange = new Set<string>();
  let maxConcurrent = 0;
  let nonWorkingOnRange = 0;
  let walkingOnRange = 0;
  {
    for (let step = 0; step < 5000; step++) {
      sim.update(DT); // ~8 simulated minutes
      const f = sim.frame;
      let concurrent = 0;
      for (let i = 0; i < f.count; i++) {
        if (f.place[i] !== CY) continue;
        concurrent++;
        everOnRange.add(f.ids[i]);
        if (f.status[i] !== WORKING) nonWorkingOnRange++;
        // A hacker on the range is seated at their own desk, never walking.
        if (f.clip[i] === HqClip.Walk) walkingOnRange++;
      }
      maxConcurrent = Math.max(maxConcurrent, concurrent);
    }
  }

  it("sends a rotating share of working hackers onto the range from their desks", () => {
    expect(everOnRange.size).toBeGreaterThan(10);
    expect(maxConcurrent).toBeGreaterThan(3);
  });

  it("keeps the range for working, seated hackers only", () => {
    expect(nonWorkingOnRange).toBe(0);
    expect(walkingOnRange).toBe(0);
  });

  it("drops every hacker off the range the moment they stop working", () => {
    sim.setAgents(team(120, () => "idle"));
    sim.update(DT);
    const f = sim.frame;
    let stillOn = 0;
    for (let i = 0; i < f.count; i++) if (f.place[i] === CY) stillOn++;
    expect(stillOn).toBe(0);
  });
});

describe("HqSimulation briefing call to the floor", () => {
  const layout = generateHqLayout(300);
  const sim = new HqSimulation(layout, { seed: 33 });
  // Many idle, so plenty of them are out on breaks when the call comes.
  sim.setAgents([{ id: "am7", name: "AM7", status: "working" }, ...team(150, (i) => (i % 2 === 0 ? "idle" : "working"))]);
  const DT = 0.1;
  for (let step = 0; step < 1800; step++) sim.update(DT);

  it("runs those away from their desks back to them, holds an early end until AM7 has spoken from the tribune", () => {
    sim.startBriefing(600);
    // The screen ends it at once (as if the answer had come and gone).
    sim.endBriefing();
    expect(sim.briefing.active).toBe(true);
    let runners = 0;
    let arrivedAt = -1;
    let endedAt = -1;
    for (let step = 0; step < 1200 && endedAt < 0; step++) {
      sim.update(DT);
      const f = sim.frame;
      for (let i = 0; i < f.count; i++) if (f.clip[i] === HqClip.Run && !f.lead[i]) runners++;
      if (arrivedAt < 0 && sim.briefing.leadAtPodium) arrivedAt = step;
      if (!sim.briefing.active) endedAt = step;
    }
    expect(runners).toBeGreaterThan(0);
    // Straight down from the island: behind the tribune within ~15 s.
    expect(arrivedAt).toBeGreaterThanOrEqual(0);
    expect(arrivedAt * DT).toBeLessThan(15);
    // And it ended only after a full cycle of talking and presenting there.
    expect(endedAt).toBeGreaterThan(arrivedAt);
    expect((endedAt - arrivedAt) * DT).toBeGreaterThan(8.4);
  });
});

describe("HqSimulation briefing", () => {
  const layout = generateHqLayout(300);
  const sim = new HqSimulation(layout, { seed: 21 });
  // AM7 (the lead, by id) and a team: most working at their desks, some idle out on breaks.
  const people: HqAgentInput[] = [
    { id: "am7", name: "AM7", status: "working" },
    ...team(150, (i) => (i % 4 === 0 ? "idle" : "working")),
  ];
  sim.setAgents(people);
  const DT = 0.1;
  for (let step = 0; step < 1200; step++) sim.update(DT); // two minutes of ordinary work
  // AM7's spot behind the tribune, facing the rows.
  const podium = { x: layout.tribune.standX, z: layout.tribune.standZ };
  const leadIndex = () => sim.frame.ids.indexOf("am7");

  it("keeps the tribune under the floor until a briefing", () => {
    expect(sim.tribuneUp).toBe(false);
  });

  it("brings the lead to the podium and everyone to their own desks, standing and facing the lead", () => {
    sim.startBriefing(600);
    expect(sim.tribuneUp).toBe(true);
    let atPodium = -1;
    for (let step = 0; step < 1800; step++) {
      sim.update(DT);
      if (atPodium < 0 && sim.briefing.leadAtPodium) atPodium = step;
    }
    expect(sim.briefing.active).toBe(true);
    expect(atPodium).toBeGreaterThanOrEqual(0);
    const f = sim.frame;
    const li = leadIndex();
    expect(Math.hypot(f.x[li] - podium.x, f.z[li] - podium.z)).toBeLessThan(0.3);
    expect(f.place[li]).toBe(HQ_PLACE.podium);
    expect([HqClip.Talk, HqClip.Idle, HqClip.Present]).toContain(f.clip[li]);
    // Behind the tribune, facing the rows (the wall at his back) while he talks.
    if (f.clip[li] !== HqClip.Present) expect(angleDiff(f.facing[li], layout.tribune.rotY)).toBeLessThan(0.15);
    let standing = 0;
    for (let i = 0; i < f.count; i++) {
      if (i === li) continue;
      const desk = layout.desks.find((d) => Math.hypot(d.approach.x - f.x[i], d.approach.z - f.z[i]) < 0.05);
      expect(desk, `${f.ids[i]} at ${f.x[i].toFixed(2)},${f.z[i].toFixed(2)}`).toBeDefined();
      // Listening: StandListen or Idle (per agent), never talking.
      expect([HqClip.Idle, HqClip.StandListen]).toContain(f.clip[i]);
      expect(f.place[i]).toBe(HQ_PLACE.briefing);
      // Turned to the lead.
      const toLead = Math.atan2(f.x[li] - f.x[i], f.z[li] - f.z[i]);
      expect(angleDiff(f.facing[i], toLead), f.ids[i]).toBeLessThan(0.15);
      expect(Math.hypot(f.lookX[i] - f.x[li], f.lookZ[i] - f.z[li])).toBeLessThan(0.5);
      standing++;
    }
    expect(standing).toBe(150);
  });

  it("alternates addressing the rows with presenting the wall, the head left to the clip while presenting", () => {
    // Still at the podium from the test above: watch two full cycles.
    const li = leadIndex();
    const seen = new Set<number>();
    let presentingLooks = 0;
    let presentingFrames = 0;
    for (let step = 0; step < 300; step++) {
      sim.update(DT);
      const f = sim.frame;
      seen.add(f.clip[li]);
      if (f.clip[li] === HqClip.Present && f.blend[li] >= 1) {
        presentingFrames++;
        if (f.lookWeight[li] < 0.05) presentingLooks++;
      }
      // The feet stay on the podium throughout.
      expect(Math.hypot(f.x[li] - podium.x, f.z[li] - podium.z)).toBeLessThan(0.3);
    }
    expect(seen.has(HqClip.Present)).toBe(true);
    expect(seen.has(HqClip.Talk)).toBe(true);
    expect(presentingFrames).toBeGreaterThan(20);
    expect(presentingLooks / presentingFrames).toBeGreaterThan(0.9);
  });

  it("sends everyone back to work when it ends, the lead to the island", () => {
    sim.endBriefing();
    expect(sim.briefing.active).toBe(false);
    // The tribune stays up while the lead is still behind it.
    expect(sim.tribuneUp).toBe(true);
    let backOnIsland = false;
    let tribuneDownAt = -1;
    for (let step = 0; step < 1800; step++) {
      sim.update(DT);
      const li = leadIndex();
      const f = sim.frame;
      if (tribuneDownAt < 0 && !sim.tribuneUp) tribuneDownAt = step;
      if (Math.hypot(f.x[li] - layout.leadDesk.x, f.z[li] - layout.leadDesk.z) < 0.05 && f.clip[li] === HqClip.SitType) backOnIsland = true;
    }
    // It sinks once he has walked off, well before he is back in his chair.
    expect(tribuneDownAt).toBeGreaterThan(0);
    expect(tribuneDownAt).toBeLessThan(100);
    // Back in the command chair (later outings of the lead's own are fine).
    expect(backOnIsland).toBe(true);
    const f = sim.frame;
    let typing = 0;
    let atWork = 0;
    for (let i = 0; i < f.count; i++) {
      expect(f.place[i] === HQ_PLACE.briefing || f.place[i] === HQ_PLACE.podium).toBe(false);
      if (isTypingClip(f.clip[i])) typing++;
      if (AT_WORK(f.clip[i])) atWork++;
    }
    // Back at their desks; still on duty (the mission outlasts the briefing), so mostly typing.
    expect(atWork).toBeGreaterThan(130);
    expect(typing).toBeGreaterThan(70);
  });

  it("ends by itself when its time is up", () => {
    sim.startBriefing(5);
    for (let step = 0; step < 60; step++) sim.update(DT);
    expect(sim.briefing.active).toBe(false);
  });
});

// --- Living workstations ----------------------------------------------------------

const STANDING = (clip: number) => STANDING_CLIPS.includes(clip);

/** Desk index per 0.1 m cell of its shoulder place, to find guests fast. */
function shoulderIndex(layout: HqLayout) {
  const cells = new Map<number, number[]>();
  const key = (cx: number, cz: number) => cx * 100003 + cz;
  const places = layout.desks.map((d, i) => {
    const p = seatToWorld(d.x, d.z, d.rotY, HQ_SHOULDER.x, HQ_SHOULDER.z);
    const k = key(Math.round(p.x * 10), Math.round(p.z * 10));
    const list = cells.get(k);
    if (list) list.push(i);
    else cells.set(k, [i]);
    return p;
  });
  /** The desk whose shoulder place (x, z) is on (within 5 cm), or -1. */
  return (x: number, z: number): number => {
    const cx = Math.round(x * 10);
    const cz = Math.round(z * 10);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const i of cells.get(key(cx + dx, cz + dz)) ?? []) {
          if (Math.hypot(places[i].x - x, places[i].z - z) < 0.05) return i;
        }
      }
    }
    return -1;
  };
}

/** Nearest social spot within 4 m of (x, z), or -1. */
function spotNear(layout: HqLayout, x: number, z: number): number {
  let best = -1;
  let bestD = 4;
  layout.socialSpots.forEach((s, i) => {
    const d = Math.hypot(s.x - x, s.z - z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

describe("HqSimulation living workstations: nobody in lockstep", () => {
  const layout = generateHqLayout(300);
  const sim = new HqSimulation(layout, { seed: 41 });
  sim.setAgents([{ id: "am7", name: "AM7", status: "working" }, ...team(150, () => "working")]);
  const DT = 0.05;
  for (let step = 0; step < 60 / DT; step++) sim.update(DT);
  const f = sim.frame;
  const n = f.count;
  const li = f.ids.indexOf("am7");
  const atWorkAtStart = Array.from(f.clip).filter((c, i) => i !== li && AT_WORK(c)).length;
  const typingAtStart = Array.from(f.clip).filter((c, i) => i !== li && isTypingClip(c)).length;

  // The call: when each hacker starts to get up.
  sim.startBriefing(600);
  const missionWithBriefing = sim.mission.active;
  const rise = new Float64Array(n).fill(-1);
  for (let k = 1; k <= 60; k++) {
    sim.update(DT);
    for (let i = 0; i < n; i++) if (i !== li && rise[i] < 0 && f.clip[i] === HqClip.SitDown) rise[i] = k * DT;
  }
  // The floor gathers; AM7 has his full say behind the tribune; the screen ends it.
  for (let k = 0; k < 90 / DT && !sim.briefing.leadAtPodium; k++) sim.update(DT);
  for (let k = 0; k < 16 / DT; k++) sim.update(DT);
  sim.endBriefing();
  const endedAtOnce = !sim.briefing.active;
  const missionAfterBriefing = sim.mission.active;
  // ...and when each one sits back down.
  const sit = new Float64Array(n).fill(-1);
  for (let k = 1; k <= 60; k++) {
    sim.update(DT);
    for (let i = 0; i < n; i++) if (i !== li && sit[i] < 0 && f.clip[i] === HqClip.SitDown) sit[i] = k * DT;
  }
  for (let k = 0; k < 30 / DT; k++) sim.update(DT);
  // Everyone typing again, the hall just sat down together: phase and tempo per agent.
  const phase: number[] = [];
  const rate: number[] = [];
  {
    const t0 = Float32Array.from(f.clipTime);
    const c0 = Uint8Array.from(f.clip);
    sim.update(DT);
    for (let i = 0; i < n; i++) {
      if (i === li || !isTypingClip(c0[i]) || f.clip[i] !== c0[i] || f.blend[i] < 1) continue;
      const dur = HQ_CLIP_INFO[HQ_CLIPS[c0[i]]].duration;
      phase.push(f.clipTime[i] / dur);
      rate.push((((f.clipTime[i] - t0[i]) % dur) + dur) % dur / DT);
    }
  }

  it("gets the floor up one by one, 0.15-1.4 s after the call", () => {
    // Everyone was at their desk, most typing (the rest reading, thinking, talking to a neighbour).
    expect(atWorkAtStart).toBe(150);
    expect(typingAtStart).toBeGreaterThan(90);
    const times = Array.from(rise).filter((_, i) => i !== li);
    expect(times.every((t) => t > 0)).toBe(true);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(0.15 - 1e-6);
    expect(Math.max(...times)).toBeLessThanOrEqual(1.4 + 2 * DT);
    expect(Math.max(...times) - Math.min(...times)).toBeGreaterThan(0.9);
    // Never more than a fifth of the hall in the same 50 ms.
    const perFrame = new Map<number, number>();
    for (const t of times) perFrame.set(Math.round(t / DT), (perFrame.get(Math.round(t / DT)) ?? 0) + 1);
    expect(Math.max(...perFrame.values())).toBeLessThan(30);
  });

  it("sits them back down one by one when it ends", () => {
    expect(endedAtOnce).toBe(true);
    const times = Array.from(sit).filter((_, i) => i !== li);
    expect(times.every((t) => t > 0)).toBe(true);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(0.15 - 1e-6);
    expect(Math.max(...times)).toBeLessThanOrEqual(1.4 + 4 * DT);
    expect(Math.max(...times) - Math.min(...times)).toBeGreaterThan(0.9);
  });

  it("types out of step: every loop starts at its own frame and plays at its own tempo", () => {
    expect(phase.length).toBeGreaterThan(100);
    // A 1/32-of-a-loop histogram of where in their typing loop everyone is.
    const buckets = new Set(phase.map((t) => Math.floor(t * 32)));
    expect(buckets.size).toBeGreaterThanOrEqual(26);
    const rounded = new Set(rate.map((r) => Math.round(r * 100)));
    expect(rounded.size).toBeGreaterThan(8);
    expect(Math.max(...rate) - Math.min(...rate)).toBeGreaterThan(0.05);
    // A mission (every briefing starts one) types a touch faster: 1.08-1.18.
    expect(Math.min(...rate)).toBeGreaterThan(1.07);
    expect(Math.max(...rate)).toBeLessThan(1.19);
  });

  it("starts a mission with the briefing that outlasts it until endMission", () => {
    expect(missionWithBriefing).toBe(true);
    expect(missionAfterBriefing).toBe(true);
    expect(sim.mission.active).toBe(true);
    expect(sim.mission.elapsed).toBeGreaterThan(40);
    expect(sim.mission.remaining).toBeGreaterThan(0);
    sim.endMission();
    expect(sim.mission.active).toBe(false);
    expect(sim.mission.elapsed).toBe(0);
    // Out of the mission, typing is back at each agent's own 0.92-1.08.
    sim.update(DT);
    const t0 = Float32Array.from(f.clipTime);
    const c0 = Uint8Array.from(f.clip);
    sim.update(DT);
    for (let i = 0; i < n; i++) {
      if (i === li || !isTypingClip(f.clip[i]) || f.clip[i] !== c0[i] || f.blend[i] < 1) continue;
      const dur = HQ_CLIP_INFO[HQ_CLIPS[f.clip[i]]].duration;
      const r = ((((f.clipTime[i] - t0[i]) % dur) + dur) % dur) / DT;
      expect(r).toBeGreaterThan(0.91);
      expect(r).toBeLessThan(1.09);
    }
  });
});

describe("HqSimulation living workstations: spots, shoulders and desks", () => {
  const layout = generateHqLayout(300);
  const sim = new HqSimulation(layout, { seed: 43 });
  const people: HqAgentInput[] = [
    { id: "am7", name: "AM7", status: "working" },
    ...team(300, (i) => (i % 2 === 0 ? "idle" : "working")),
  ];
  sim.setAgents(people);
  const nb = buildDeskNeighbourhood(layout.desks, layout.arena);
  const shoulderOf = shoulderIndex(layout);
  const deskOf = new Map(Object.entries(sim.getAssignments()));
  const f = sim.frame;
  const n = f.count;
  const li = f.ids.indexOf("am7");
  const agentAt = new Int32Array(layout.desks.length).fill(-1);
  for (let i = 0; i < n; i++) {
    const d = deskOf.get(f.ids[i]);
    if (d !== undefined) agentAt[d] = i;
  }
  const DT = 0.1;
  let spotTalkFrames = 0;
  let twoSpeakers = 0;
  const speakers = new Set<string>();
  let maxGuests = 0;
  let crowdedRow = 0;
  let hostNotAtWork = 0;
  let leadAtShoulder = 0;
  const visits = new Set<string>();
  const wasGuest = new Int32Array(n).fill(-1);
  // Hackers at their own desk: when their seated act last changed, and what they did.
  const lastSwitch = new Float64Array(n).fill(-1);
  const lastLoop = new Int32Array(n).fill(-1);
  let shortestBeat = Infinity;
  const idleActs = new Map<number, Set<string>>();
  const workActs = new Map<number, Set<string>>();
  const seen = (m: Map<number, Set<string>>, clip: number, id: string) => {
    let set = m.get(clip);
    if (!set) m.set(clip, (set = new Set()));
    set.add(id);
  };
  let pairFrames = 0;
  let lonelyTurns = 0;
  let pairsInStep = 0;
  let hostsShowing = 0;
  {
    const talkAt = new Int32Array(layout.socialSpots.length);
    for (let step = 0; step < 9000; step++) {
      sim.update(DT);
      const t = (step + 1) * DT;
      talkAt.fill(0);
      const guestDesks: number[] = [];
      let guests = 0;
      for (let i = 0; i < n; i++) {
        const clip = f.clip[i];
        if (clip === HqClip.Talk && i !== li) {
          const s = spotNear(layout, f.x[i], f.z[i]);
          if (s >= 0) {
            talkAt[s]++;
            spotTalkFrames++;
            speakers.add(f.ids[i]);
          }
        }
        const g = STANDING(clip) ? shoulderOf(f.x[i], f.z[i]) : -1;
        if (g >= 0) {
          guestDesks.push(g);
          const host = agentAt[g];
          // The host is at work at the screen (showing it once the guest is there).
          if (host < 0 || !(AT_WORK(f.clip[host]) || f.clip[host] === HqClip.SitDown)) hostNotAtWork++;
          if (host >= 0 && f.clip[host] === HqClip.SitShowScreen && clip === HqClip.StandLookOver) hostsShowing++;
          if (i === li) leadAtShoulder++;
          else {
            guests++;
            if (wasGuest[i] !== g) visits.add(`${f.ids[i]}@${g}@${Math.floor(t / 60)}`);
          }
        }
        wasGuest[i] = g;
        // Beats at their own desks (a stretch is a one-shot gesture inside a beat).
        const d = deskOf.get(f.ids[i]);
        const atDesk = d !== undefined && Math.hypot(layout.desks[d].x - f.x[i], layout.desks[d].z - f.z[i]) < 0.02;
        if (i !== li && atDesk && AT_WORK(clip)) {
          seen(f.status[i] === 1 ? idleActs : workActs, clip, f.ids[i]);
          if (clip === HqClip.SitStretch || clip === HqClip.SitShowScreen) continue;
          if (lastLoop[i] >= 0 && lastLoop[i] !== clip) {
            if (lastSwitch[i] >= 0) shortestBeat = Math.min(shortestBeat, t - lastSwitch[i]);
            lastSwitch[i] = t;
          }
          lastLoop[i] = clip;
          // A seated pair: turned toward each other; one talks while the other listens.
          const [h0, h1] = HQ_CLIP_INFO.SitTurnL.hold!;
          if (clip === HqClip.SitTurnL && d !== undefined && f.blend[i] >= 1 && f.clipTime[i] > h0 + 0.1 && f.clipTime[i] < h1 - 0.1) {
            let partner = -1;
            for (let j = 0; j < n; j++) {
              if (f.clip[j] !== HqClip.SitTurnR) continue;
              const e = deskOf.get(f.ids[j]);
              if (e === undefined || Math.hypot(layout.desks[e].x - f.x[j], layout.desks[e].z - f.z[j]) > 0.02) continue;
              // j sits on i's left (+X of i's workstation frame), the desk beside it.
              const dx = layout.desks[e].x - layout.desks[d].x;
              const dz = layout.desks[e].z - layout.desks[d].z;
              const r = layout.desks[d].rotY;
              const lx = dx * Math.cos(r) - dz * Math.sin(r);
              const lz = dx * Math.sin(r) + dz * Math.cos(r);
              if (lx > 1.2 && lx < 2.1 && Math.abs(lz) < 0.4) partner = j;
            }
            if (partner < 0) lonelyTurns++;
            else {
              pairFrames++;
              const j = partner;
              const [t0, t1] = HQ_CLIP_INFO.SitTurnL.talkWindow!;
              const talkI = f.clipTime[i] >= t0 && f.clipTime[i] < t1;
              const talkJ = f.clipTime[j] >= t0 && f.clipTime[j] < t1;
              // Away from the turn boundaries (the one who starts may be a frame ahead).
              const clear = (x: number) => Math.min(Math.abs(x - h0), Math.abs(x - t1), Math.abs(x - h1)) > 0.15;
              const holding = f.clipTime[j] > h0 && f.clipTime[j] < h1 && clear(f.clipTime[i]) && clear(f.clipTime[j]);
              if (holding && talkI === talkJ) pairsInStep++;
            }
          }
        } else {
          lastLoop[i] = -1;
          lastSwitch[i] = -1;
        }
      }
      for (let s = 0; s < talkAt.length; s++) if (talkAt[s] > 1) twoSpeakers++;
      maxGuests = Math.max(maxGuests, guests);
      for (let a = 0; a < guestDesks.length; a++) {
        for (let b = a + 1; b < guestDesks.length; b++) {
          const da = guestDesks[a];
          const db = guestDesks[b];
          if (nb.row[da] === nb.row[db] && Math.abs(nb.pos[da] - nb.pos[db]) <= GUEST_SPACING) crowdedRow++;
        }
      }
    }
  }

  it("lets one person talk at a time at every spot, and passes the word round", () => {    expect(spotTalkFrames).toBeGreaterThan(300);
    expect(twoSpeakers).toBe(0);
    expect(speakers.size).toBeGreaterThan(10);
  });

  it("sends free hackers to look over a working neighbour's shoulder, within the limits", () => {
    expect(visits.size).toBeGreaterThanOrEqual(8);
    expect(maxGuests).toBeLessThanOrEqual(peerVisitLimit(n));
    expect(crowdedRow).toBe(0);
    expect(hostNotAtWork).toBe(0);
  });

  it("brings AM7 to the shoulder place of those he visits", () => {
    expect(leadAtShoulder).toBeGreaterThan(50);
  });

  it("varies what everyone does at their desk, never switching faster than the minimum beat", () => {
    const count = (m: Map<number, Set<string>>, clip: number) => m.get(clip)?.size ?? 0;
    // Free: sitting back, reading, thinking, talking, stretching.
    expect(count(idleActs, HqClip.SitIdle)).toBeGreaterThan(20);
    expect(count(idleActs, HqClip.SitRead)).toBeGreaterThan(10);
    expect(count(idleActs, HqClip.SitLeanBack)).toBeGreaterThan(5);
    expect(count(idleActs, HqClip.SitTurnL) + count(idleActs, HqClip.SitTurnR)).toBeGreaterThan(5);
    // Working: both typing variants, reading, a word with the neighbour, showing the screen to a guest.
    expect(count(workActs, HqClip.SitType)).toBeGreaterThan(20);
    expect(count(workActs, HqClip.SitType2)).toBeGreaterThan(20);
    expect(count(workActs, HqClip.SitRead)).toBeGreaterThan(20);
    expect(count(workActs, HqClip.SitTurnL) + count(workActs, HqClip.SitTurnR)).toBeGreaterThan(5);
    expect(count(workActs, HqClip.SitShowScreen)).toBeGreaterThan(3);
    // A free hacker never types outside a mission.
    expect(count(idleActs, HqClip.SitType) + count(idleActs, HqClip.SitType2)).toBe(0);
    expect(shortestBeat).toBeGreaterThanOrEqual(6 - DT - 1e-6);
  });

  it("turns seated neighbours to each other, one talking while the other listens", () => {
    expect(pairFrames).toBeGreaterThan(100);
    // Turned to the left: the neighbour on that side is turned back (SitTurnR)...
    expect(lonelyTurns).toBeLessThan(0.02 * pairFrames);
    // ...and half a loop apart: never both talking or both listening.
    expect(pairsInStep).toBe(0);
  });

  it("has the host show the screen while the guest looks over the shoulder", () => {
    expect(hostsShowing).toBeGreaterThan(50);
  });
});

/** What a free hacker at their desk may do on duty: read, type, a short word with the neighbour. */
const DUTY_CLIPS: number[] = [
  HqClip.SitRead,
  HqClip.SitType,
  HqClip.SitType2,
  HqClip.SitTurnL,
  HqClip.SitTurnR,
  HqClip.SitDown,
];

describe("HqSimulation mission mode", () => {
  const layout = generateHqLayout(300);
  const sim = new HqSimulation(layout, { seed: 47 });
  sim.setAgents([{ id: "am7", name: "AM7", status: "working" }, ...team(150, (i) => (i % 2 === 0 ? "idle" : "working"))]);
  const deskOf = new Map(Object.entries(sim.getAssignments()));
  const f = sim.frame;
  const n = f.count;
  const li = f.ids.indexOf("am7");
  const DT = 0.1;
  const atOwnDesk = (i: number) => {
    const d = deskOf.get(f.ids[i]);
    return d !== undefined && Math.hypot(layout.desks[d].x - f.x[i], layout.desks[d].z - f.z[i]) < 0.05;
  };
  const shoulderOf = shoulderIndex(layout);
  // Walking pace over 2 s windows (walking all the way through), per agent.
  const lastX = new Float32Array(n);
  const lastZ = new Float32Array(n);
  const walkedSince = new Uint8Array(n);
  const paces = (who: (i: number) => boolean, out: number[], step: number) => {
    for (let i = 0; i < n; i++) {
      if (f.clip[i] !== HqClip.Walk) walkedSince[i] = 0;
      if (step % 20 !== 0) continue;
      if (walkedSince[i] && who(i)) out.push(Math.hypot(f.x[i] - lastX[i], f.z[i] - lastZ[i]) / (20 * DT));
      lastX[i] = f.x[i];
      lastZ[i] = f.z[i];
      walkedSince[i] = f.clip[i] === HqClip.Walk ? 1 : 0;
    }
  };
  const median = (v: number[]) => v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const ordinaryPace: number[] = [];
  for (let step = 0; step < 2400; step++) {
    sim.update(DT); // four minutes of an ordinary day
    paces((i) => i !== li, ordinaryPace, step);
  }
  const awayBefore: number[] = [];
  for (let i = 0; i < n; i++) if (i !== li && !atOwnDesk(i)) awayBefore.push(i);
  const wasAway = new Uint8Array(n);
  for (const i of awayBefore) wasAway[i] = 1;

  sim.startMission(400);
  const activeAtStart = sim.mission.active;
  // Ninety seconds to get everyone who was away back (the hall is ~100 m across)...
  const backAt = new Float64Array(n).fill(-1);
  const returnPace: number[] = [];
  walkedSince.fill(0);
  for (let step = 0; step < 900; step++) {
    sim.update(DT);
    for (const i of awayBefore) if (backAt[i] < 0 && atOwnDesk(i)) backAt[i] = (step + 1) * DT;
    paces((i) => wasAway[i] === 1 && backAt[i] < 0, returnPace, step);
  }
  const returns = awayBefore.map((i) => backAt[i]);
  // ...then two minutes on duty.
  let maxAway = 0;
  let atSpots = 0;
  let onRange = 0;
  let idleOffDuty = 0;
  let helpers = 0;
  let maxHelpers = 0;
  for (let step = 0; step < 1200; step++) {
    sim.update(DT);
    let away = 0;
    let helping = 0;
    for (let i = 0; i < n; i++) {
      if (f.place[i] === HQ_PLACE.cyberrange) onRange++;
      if (i === li) continue;
      if (!atOwnDesk(i)) {
        away++;
        if (STANDING(f.clip[i]) && spotNear(layout, f.x[i], f.z[i]) >= 0) atSpots++;
        if (STANDING(f.clip[i]) && shoulderOf(f.x[i], f.z[i]) >= 0) helping++;
      } else if (f.status[i] === 1 && !DUTY_CLIPS.includes(f.clip[i])) {
        idleOffDuty++;
      }
    }
    if (helping > 0) helpers++;
    maxHelpers = Math.max(maxHelpers, helping);
    maxAway = Math.max(maxAway, away);
  }

  // After the mission: who leaves their desk, and when.
  sim.endMission();
  const activeAfterEnd = sim.mission.active;
  const departures: number[] = [];
  {
    const seatedBefore = new Uint8Array(n);
    for (let i = 0; i < n; i++) seatedBefore[i] = atOwnDesk(i) ? 1 : 0;
    for (let step = 0; step < 3000; step++) {
      sim.update(DT);
      for (let i = 0; i < n; i++) {
        if (i === li) continue;
        const seated = atOwnDesk(i) ? 1 : 0;
        if (seatedBefore[i] && !seated) departures.push((step + 1) * DT);
        seatedBefore[i] = seated;
      }
    }
  }

  it("calls whoever is away back to their desk, each after their own short delay", () => {
    expect(awayBefore.length).toBeGreaterThan(5);
    expect(activeAtStart).toBe(true);
    expect(returns.every((t) => t > 0)).toBe(true);
    expect(Math.min(...returns)).toBeGreaterThan(0.5);
    expect(Math.max(...returns)).toBeLessThan(90);
  });

  it("brings them back at a brisk walk, not a run", () => {
    expect(ordinaryPace.length).toBeGreaterThan(100);
    expect(returnPace.length).toBeGreaterThan(50);
    const ratio = median(returnPace) / median(ordinaryPace);
    expect(ratio).toBeGreaterThan(1.08);
    expect(ratio).toBeLessThan(1.25);
  });

  it("keeps the floor on duty: no breaks, no cyber-range, at most a colleague's short help", () => {
    expect(atSpots).toBe(0);
    expect(onRange).toBe(0);
    expect(idleOffDuty).toBe(0);
    expect(maxHelpers).toBeLessThanOrEqual(helpVisitLimit(n));
    // The helper's walk there and back is the only one away from a desk.
    expect(maxAway).toBeLessThanOrEqual(helpVisitLimit(n) + 2);
    expect(helpers).toBeGreaterThan(0);
  });

  it("relaxes each hacker at their own moment afterwards: no rush for the door", () => {    expect(activeAfterEnd).toBe(false);
    expect(departures.length).toBeGreaterThan(15);
    // Everyone stays on duty a few seconds more; breaks only from 45 s on.
    expect(departures[0]).toBeGreaterThanOrEqual(3);
    expect(departures.filter((t) => t < 45).length).toBeLessThanOrEqual(2 * peerVisitLimit(n));
    // Never more than the departure limiter lets through (a burst of 2, then 1.5 a second).
    for (let k = 0; k < departures.length; k++) {
      let within = 0;
      for (let j = k; j < departures.length && departures[j] < departures[k] + 2; j++) within++;
      expect(within).toBeLessThanOrEqual(5);
    }
    expect(departures[departures.length - 1] - departures[0]).toBeGreaterThan(90);
  });

  it("ends by itself after its longest time", () => {
    const small = new HqSimulation(generateHqLayout(100), { seed: 5 });
    small.setAgents(team(20, (i) => (i % 2 === 0 ? "idle" : "working")));
    small.startMission(5);
    for (let step = 0; step < 40; step++) small.update(DT);
    expect(small.mission.active).toBe(true);
    expect(small.mission.remaining).toBeLessThan(1.1);
    for (let step = 0; step < 20; step++) small.update(DT);
    expect(small.mission.active).toBe(false);
    // Asking again while active only moves the end later.
    small.startMission(30);
    small.startMission(5);
    expect(small.mission.remaining).toBeGreaterThan(29);
  });
});
