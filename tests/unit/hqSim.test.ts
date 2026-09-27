import { describe, expect, it } from "vitest";

import { HqClip } from "@/features/hq/core/config";
import { HQ_PROP_FOOTPRINT, generateHqLayout } from "@/features/hq/core/layout";
import { HqSimulation } from "@/features/hq/core/sim";
import { HQ_PLACE } from "@/features/hq/core/types";
import type { HqAgentInput, HqAgentStatus, HqLayout } from "@/features/hq/core/types";

const HEAD_SEATED = 1.22;
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
      expect(f.clip[i], f.ids[i]).toBe(HqClip.SitType);
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

  it("falls back to standing in the lounge when every seat is taken", () => {
    const busy = new HqSimulation(layout, { seed: 11 });
    busy.setAgents(team(300, () => "idle"));
    let standingInLounge = 0;
    let seatedMax = 0;
    const lounge = layout.lounge;
    for (let step = 0; step < 6000; step++) {
      busy.update(DT);
      if (step % 10 !== 0) continue;
      const f = busy.frame;
      let seated = 0;
      let standing = 0;
      for (let i = 0; i < f.count; i++) {
        if (seatOf(layout, f.x[i], f.z[i]) >= 0) seated++;
        else if (
          f.clip[i] !== HqClip.Walk &&
          f.x[i] > lounge.x0 &&
          f.x[i] < lounge.x1 &&
          f.z[i] > lounge.z0 + 4.5 &&
          f.z[i] < lounge.z1
        ) {
          standing++;
        }
      }
      seatedMax = Math.max(seatedMax, seated);
      // "Every seat taken", give or take the couple being left or walked to.
      if (seated >= seats.length - 2) standingInLounge = Math.max(standingInLounge, standing);
    }
    expect(seatedMax).toBeGreaterThanOrEqual(seats.length - 2);
    expect(standingInLounge).toBeGreaterThan(0);
  });
});

describe("HqSimulation standing places", () => {
  // A crowded hall: more agents than desks, most of them idle, so the social
  // spots fill up and deskless agents spill into the overflow rings.
  const layout = generateHqLayout(300);
  const sim = new HqSimulation(layout, { seed: 9 });
  sim.setAgents(team(420, (i) => (i % 4 === 0 ? "working" : "idle")));
  const lounge = layout.lounge;
  const inLounge = (x: number, z: number) => x > lounge.x0 && x < lounge.x1 && z > lounge.z0 && z < lounge.z1;
  const standing = (clip: number) => clip === HqClip.Idle || clip === HqClip.Talk;
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
