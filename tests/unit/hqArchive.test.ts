import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { HQ_ARCHIVE_CART, HQ_CLIP_INFO, HQ_CLIPS, HQ_PUSH_GRIP, HqClip } from "@/features/hq/core/config";
import { generateHqLayout } from "@/features/hq/core/layout";
import { HQ_PLACE_ARCHIVE, HqSimulation } from "@/features/hq/core/sim";
import { HQ_PLACE } from "@/features/hq/core/types";
import type {
  HqAgentInput,
  HqAgentStatus,
  HqArchiveEvent,
  HqArchiveLane,
  HqArchiveView,
  HqLayout,
} from "@/features/hq/core/types";
import { isLoopingClipName, resolveClipSources } from "@/features/hq/render/crowd/clipTable";

const DT = 0.1;
const REACH = HQ_ARCHIVE_CART.reach;
const AM7: HqAgentInput = { id: "am7", name: "AM7", status: "working" };

function team(count: number, status: (i: number) => HqAgentStatus): HqAgentInput[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `agent-${String(i).padStart(4, "0")}`,
    name: `Agent ${i}`,
    status: status(i),
  }));
}

type Logged = HqArchiveEvent & { t: number };

/** A seeded sim with AM7 and a team, its archive events logged with the sim time. */
function setup(capacity: 100 | 300 | 1000, count: number, status: (i: number) => HqAgentStatus, seed: number) {
  const layout = generateHqLayout(capacity);
  const sim = new HqSimulation(layout, { seed });
  const events: Logged[] = [];
  const clock = { t: 0 };
  sim.onArchiveEvent = (e) => events.push({ ...e, t: clock.t });
  sim.setAgents([AM7, ...team(count, status)]);
  const step = (seconds: number, each?: () => boolean | void) => {
    const n = Math.round(seconds / DT);
    for (let k = 0; k < n; k++) {
      sim.update(DT);
      clock.t += DT;
      if (each && each() === true) return true;
    }
    return false;
  };
  return { layout, sim, events, clock, step };
}

function copyView(v: Readonly<HqArchiveView>) {
  return { x: v.x, z: v.z, rotY: v.rotY, phase: v.phase, level: v.level, pusherId: v.pusherId };
}

/** Nearest sample of a lane to the pusher root that puts the cart at (x, z, rotY). */
function nearestSample(lane: HqArchiveLane, x: number, z: number, rotY: number): { i: number; d: number } {
  const rx = x - Math.sin(rotY) * REACH;
  const rz = z - Math.cos(rotY) * REACH;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < lane.x.length; i++) {
    const d = Math.hypot(lane.x[i] - rx, lane.z[i] - rz);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return { i: best, d: bestD };
}

function inCart(v: { x: number; z: number; rotY: number }, px: number, pz: number): boolean {
  const dx = px - v.x;
  const dz = pz - v.z;
  const c = Math.cos(v.rotY);
  const s = Math.sin(v.rotY);
  // World to the cart's frame (local +Z = its nose).
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.abs(lx) <= HQ_ARCHIVE_CART.width / 2 && lz >= -HQ_ARCHIVE_CART.tail && lz <= HQ_ARCHIVE_CART.nose;
}

function atParkedPose(layout: HqLayout, v: Readonly<HqArchiveView>): boolean {
  const c = layout.archive.cart;
  return Math.hypot(v.x - c.x, v.z - c.z) < 0.01 && Math.abs(v.rotY - c.rotY) < 1e-6;
}

describe("Push clip", () => {
  it("is clip 8, loops at 1.05 m/s, and falls back to Walk, then Idle", () => {
    expect(HqClip.Push).toBe(8);
    expect(HQ_CLIPS[HqClip.Push]).toBe("Push");
    expect(HQ_CLIP_INFO.Push.loop).toBe(true);
    expect(HQ_CLIP_INFO.Push.duration).toBeCloseTo(32 / 30, 6);
    expect(HQ_CLIP_INFO.Push.speed).toBeCloseTo(1.05, 6);
    expect(isLoopingClipName("Armature|Push")).toBe(true);
    const withPush = resolveClipSources(["Idle", "Walk", "Push"]);
    expect(withPush[HqClip.Push]).toBe(2);
    expect(resolveClipSources(["Idle", "Walk"])[HqClip.Push]).toBe(1);
    expect(resolveClipSources(["Walk", "Idle"])[HqClip.Push]).toBe(0);
    expect(resolveClipSources(["Talk", "Idle"])[HqClip.Push]).toBe(1);
  });

  it("grips where push.py puts the hands", () => {
    const src = readFileSync(resolve(__dirname, "../../blender/hacker/anims/push.py"), "utf8");
    const grip = /GRIP_X,\s*GRIP_Y,\s*GRIP_Z\s*=\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)/.exec(src);
    const offset = /CART_OFFSET\s*=\s*([-\d.]+)/.exec(src);
    expect(grip).not.toBeNull();
    expect(offset).not.toBeNull();
    expect(Number(grip![1])).toBeCloseTo(HQ_PUSH_GRIP.halfSpan, 6);
    // -Y is forward in Blender.
    expect(-Number(grip![2])).toBeCloseTo(HQ_PUSH_GRIP.reach, 6);
    expect(Number(grip![3])).toBeCloseTo(HQ_PUSH_GRIP.height, 6);
    expect(Number(offset![1])).toBeCloseTo(HQ_ARCHIVE_CART.reach, 6);
  });
});

describe("Archive cart: a full run", () => {
  const { layout, sim, events, clock, step } = setup(300, 150, (i) => (i % 2 === 0 ? "idle" : "working"), 9);
  sim.setArchiveFill(0.9);
  step(60);
  const levelBefore = sim.archive.level;
  const startedAt = clock.t;
  const who = sim.startArchiveRun("run-1", 5_000_000);
  const hauler = who ? sim.indexOf(who.agentId) : -1;
  let maxCartError = 0;
  let movingFrames = 0;
  let movingWithoutPush = 0;
  let levelDuringRun = Infinity;
  let walkersInCart = 0;
  let runFrames = 0;
  let placeArchiveFrames = 0;
  let prev = copyView(sim.archive);
  const parkedAt = { t: -1 };
  step(400, () => {
    const v = sim.archive;
    const f = sim.frame;
    runFrames++;
    const moved = Math.hypot(v.x - prev.x, v.z - prev.z) > 1e-5 || Math.abs(v.rotY - prev.rotY) > 1e-6;
    if (moved && hauler >= 0) {
      movingFrames++;
      if (f.clip[hauler] !== HqClip.Push) movingWithoutPush++;
      const cx = f.x[hauler] + Math.sin(f.facing[hauler]) * REACH;
      const cz = f.z[hauler] + Math.cos(f.facing[hauler]) * REACH;
      maxCartError = Math.max(maxCartError, Math.hypot(cx - v.x, cz - v.z));
    }
    if (hauler >= 0 && f.place[hauler] === HQ_PLACE_ARCHIVE) placeArchiveFrames++;
    if (!events.some((e) => e.type === "handover")) levelDuringRun = Math.min(levelDuringRun, v.level);
    if (v.phase !== "parked") {
      for (let i = 0; i < f.count; i++) {
        if (i !== hauler && inCart(v, f.x[i], f.z[i])) {
          walkersInCart++;
          break;
        }
      }
    }
    prev = copyView(v);
    if (parkedAt.t < 0 && events.some((e) => e.type === "parked")) parkedAt.t = clock.t;
    return parkedAt.t >= 0;
  });
  const parkedView = copyView(sim.archive);
  // Then back to work: in his chair.
  let seatedAt = -1;
  const desk = who ? layout.desks[sim.getAssignments()[who.agentId]] : null;
  step(240, () => {
    const f = sim.frame;
    if (desk && Math.hypot(f.x[hauler] - desk.x, f.z[hauler] - desk.z) < 0.02 && f.clip[hauler] === HqClip.SitIdle) {
      seatedAt = clock.t;
      return true;
    }
  });

  it("sends an idle hacker, never AM7", () => {
    expect(who).not.toBeNull();
    expect(who!.agentId).not.toBe("am7");
    expect(levelBefore).toBe(4);
  });

  it("plays Push while the cart moves, the cart riding 1.02 m ahead of the root", () => {
    expect(movingFrames).toBeGreaterThan(150);
    expect(movingWithoutPush).toBe(0);
    expect(maxCartError).toBeLessThan(0.01);
    expect(placeArchiveFrames).toBeGreaterThan(movingFrames);
  });

  it("reports taken, handover (with the bytes), parked, in that order, within 180 s", () => {
    const types = events.map((e) => e.type);
    expect(types).toEqual(["taken", "handover", "parked"]);
    for (const e of events) {
      expect(e.runId).toBe("run-1");
      expect(e.agentId).toBe(who!.agentId);
      expect(e.freedBytes).toBe(5_000_000);
    }
    expect(parkedAt.t - startedAt).toBeLessThan(180);
    expect(levelDuringRun).toBeGreaterThanOrEqual(1);
  });

  it("parks it back in the bay exactly, and the hauler goes back to his chair", () => {
    expect(parkedView.phase).toBe("parked");
    expect(Math.hypot(parkedView.x - layout.archive.cart.x, parkedView.z - layout.archive.cart.z)).toBeLessThan(0.01);
    expect(parkedView.rotY).toBe(layout.archive.cart.rotY);
    expect(parkedView.pusherId).toBeNull();
    expect(parkedView.level).toBe(0);
    expect(seatedAt).toBeGreaterThan(0);
  });

  it("keeps walkers out of the cart", () => {
    expect(runFrames).toBeGreaterThan(300);
    expect(walkersInCart / runFrames).toBeLessThan(0.02);
  });
});

describe("Archive cart: picking the hauler", () => {
  const run = () => {
    const { sim, events, step } = setup(100, 90, (i) => (i % 9 === 0 ? "error" : i % 2 === 0 ? "idle" : "working"), 4);
    step(120);
    const picks: string[] = [];
    const bad: string[] = [];
    for (let r = 0; r < 6; r++) {
      const who = sim.startArchiveRun(`run-${r}`, 1_000_000);
      if (!who) {
        step(10);
        continue;
      }
      const i = sim.indexOf(who.agentId);
      // At the pick: idle, not on the range, not in error.
      if (sim.frame.status[i] !== 1 || sim.frame.place[i] === HQ_PLACE.cyberrange) bad.push(who.agentId);
      picks.push(who.agentId);
      step(400, () => events.some((e) => e.type === "parked" && e.runId === `run-${r}`));
      step(25);
    }
    return { picks, bad, events };
  };
  const a = run();
  const b = run();

  it("never picks AM7, an agent in error or on the range", () => {
    expect(a.picks.length).toBeGreaterThanOrEqual(5);
    expect(a.picks).not.toContain("am7");
    expect(a.bad).toEqual([]);
  });

  it("does not send any of the last three pushers again", () => {
    for (let k = 1; k < a.picks.length; k++) {
      expect(a.picks.slice(Math.max(0, k - 3), k)).not.toContain(a.picks[k]);
    }
  });

  it("picks the same agents for the same seed", () => {
    expect(b.picks).toEqual(a.picks);
  });

  it("waits while AM7 is the only idle agent", () => {
    const { sim, events, step } = setup(100, 40, () => "working", 5);
    sim.setAgents([{ ...AM7, status: "idle" }, ...team(40, () => "working")]);
    step(20);
    expect(sim.startArchiveRun("lonely", 10)).toBeNull();
    step(60);
    expect(events).toEqual([]);
    expect(sim.archive.pusherId).toBeNull();
    expect(sim.archive.phase).toBe("parked");
  });

  it("ignores a run id it has seen, and folds a clean-up into the load under way", () => {
    const { sim, events, step } = setup(100, 60, (i) => (i % 2 === 0 ? "idle" : "working"), 6);
    step(60);
    expect(sim.startArchiveRun("same", 100)).not.toBeNull();
    expect(sim.startArchiveRun("same", 100)).toBeNull();
    expect(sim.startArchiveRun("extra", 50)).toBeNull();
    step(400, () => events.some((e) => e.type === "parked"));
    expect(events.map((e) => e.type)).toEqual(["taken", "handover", "parked"]);
    expect(events[1].freedBytes).toBe(150);
  });
});

describe("Archive cart: a briefing on a stoppable stretch", () => {
  const { layout, sim, events, clock, step } = setup(300, 150, (i) => (i % 2 === 0 ? "idle" : "working"), 21);
  sim.setArchiveFill(0.7);
  step(60);
  const who = sim.startArchiveRun("brief-a", 2_000_000);
  const hauler = who ? sim.indexOf(who.agentId) : -1;
  const out = layout.archive.laneOut;
  // Out of the bay, not yet in the doorway.
  step(300, () => {
    const v = sim.archive;
    if (v.phase !== "push-out") return;
    const { i } = nearestSample(out, v.x, v.z, v.rotY);
    return out.s[i] > 1.5 && out.s[i] < 4.5 && !out.noStop[i];
  });
  const reached = sim.archive.phase === "push-out";
  sim.startBriefing(40);
  const frozen = copyView(sim.archive);
  const pausedAtOnce = events.some((e) => e.type === "paused");
  let moveDuringBriefing = 0;
  let ranToDesk = false;
  let haulerInCart = 0;
  step(60, () => {
    const v = sim.archive;
    if (Math.hypot(v.x - frozen.x, v.z - frozen.z) > 1e-6 || v.rotY !== frozen.rotY) moveDuringBriefing++;
    if (sim.frame.clip[hauler] === HqClip.Run) ranToDesk = true;
    if (inCart(v, sim.frame.x[hauler], sim.frame.z[hauler])) haulerInCart++;
    return !sim.briefing.active;
  });
  const endedAt = clock.t;
  let ranAfter = false;
  let firstMove: number | null = null;
  let resumedAt = -1;
  step(300, () => {
    const v = sim.archive;
    if (sim.frame.clip[hauler] === HqClip.Run) ranAfter = true;
    if (v.phase !== "parked" && inCart(v, sim.frame.x[hauler], sim.frame.z[hauler])) haulerInCart++;
    if (firstMove === null && (Math.hypot(v.x - frozen.x, v.z - frozen.z) > 1e-6 || v.rotY !== frozen.rotY)) {
      firstMove = Math.hypot(v.x - frozen.x, v.z - frozen.z);
    }
    if (resumedAt < 0 && events.some((e) => e.type === "resumed")) resumedAt = clock.t;
    return events.some((e) => e.type === "parked");
  });

  it("leaves the cart exactly where it stands for the whole briefing", () => {
    expect(reached).toBe(true);
    expect(pausedAtOnce).toBe(true);
    expect(frozen.phase).toBe("left");
    expect(moveDuringBriefing).toBe(0);
  });

  it("runs the hauler to his desk like everyone else", () => {
    expect(ranToDesk).toBe(true);
  });

  it("never walks the hauler through the cart, leaving it or coming back to it", () => {
    expect(haulerInCart).toBe(0);
  });

  it("walks him back afterwards (never runs), from exactly where it stood, and he parks it", () => {
    expect(ranAfter).toBe(false);
    expect(firstMove).not.toBeNull();
    expect(firstMove!).toBeLessThan(0.05);
    expect(resumedAt - endedAt).toBeGreaterThan(3);
    const types = events.map((e) => e.type);
    expect(types).toEqual(["taken", "paused", "resumed", "handover", "parked"]);
    expect(events.every((e) => e.agentId === who!.agentId)).toBe(true);
    expect(atParkedPose(layout, sim.archive)).toBe(true);
  });
});

describe("Archive cart: a briefing in the doorway", () => {
  const { layout, sim, events, step } = setup(300, 150, (i) => (i % 2 === 0 ? "idle" : "working"), 33);
  step(60);
  const who = sim.startArchiveRun("brief-b", 3_000_000);
  const out = layout.archive.laneOut;
  const back = layout.archive.laneBack;
  step(300, () => {
    const v = sim.archive;
    if (v.phase !== "push-out") return;
    const { i } = nearestSample(out, v.x, v.z, v.rotY);
    return out.noStop[i] === 1 && out.s[i] > 6;
  });
  const reached = sim.archive.phase === "push-out";
  sim.startBriefing(60);
  const pausedAtOnce = events.some((e) => e.type === "paused");
  let leftPoses = 0;
  let leftOnNoStop = 0;
  step(70, () => {
    const v = sim.archive;
    if (v.phase === "left") {
      leftPoses++;
      const { i, d } = nearestSample(back, v.x, v.z, v.rotY);
      if (d > 0.01 || back.noStop[i]) leftOnNoStop++;
    }
    return !sim.briefing.active;
  });
  const typesAtEnd = events.map((e) => e.type);
  step(300, () => events.some((e) => e.type === "parked"));

  it("pushes on until the cart is clear, then leaves it inside the hall", () => {
    expect(reached).toBe(true);
    expect(pausedAtOnce).toBe(false);
    expect(typesAtEnd).toEqual(["taken", "handover", "paused"]);
    expect(leftPoses).toBeGreaterThan(100);
    expect(leftOnNoStop).toBe(0);
  });

  it("finishes the run after the briefing", () => {
    expect(events.map((e) => e.type)).toEqual(["taken", "handover", "paused", "resumed", "parked"]);
    expect(events.every((e) => e.agentId === who!.agentId)).toBe(true);
    expect(atParkedPose(layout, sim.archive)).toBe(true);
  });
});

describe("Archive cart: the hauler leaves mid-run", () => {
  const people = [AM7, ...team(150, (i) => (i % 2 === 0 ? "idle" : "working"))];
  const { layout, sim, events, step } = setup(300, 150, (i) => (i % 2 === 0 ? "idle" : "working"), 44);
  step(60);
  const who = sim.startArchiveRun("gone", 1_234);
  step(300, () => {
    const v = sim.archive;
    return v.phase === "push-out" && Math.hypot(v.x - layout.archive.cart.x, v.z - layout.archive.cart.z) > 3;
  });
  const reached = sim.archive.phase === "push-out";
  sim.setAgents(people.filter((p) => p.id !== who?.agentId));
  sim.update(DT);
  const at = copyView(sim.archive);
  let movedBeforeTakeover = 0;
  step(400, () => {
    const v = sim.archive;
    const taken = events.some((e) => e.type === "reassigned");
    if (!taken && (Math.hypot(v.x - at.x, v.z - at.z) > 1e-6 || v.rotY !== at.rotY)) movedBeforeTakeover++;
    return events.some((e) => e.type === "parked");
  });
  const takeover = events.find((e) => e.type === "reassigned");
  const parked = events.find((e) => e.type === "parked");

  it("leaves the cart standing until someone else takes over", () => {
    expect(reached).toBe(true);
    expect(at.phase).toBe("left");
    expect(at.pusherId).toBeNull();
    expect(movedBeforeTakeover).toBe(0);
  });

  it("hands it to another hacker (not AM7), who parks it", () => {
    expect(takeover).toBeDefined();
    expect(takeover!.agentId).not.toBe(who!.agentId);
    expect(takeover!.agentId).not.toBe("am7");
    expect(takeover!.previousName).toBe(who!.name);
    expect(takeover!.t - events[0].t).toBeGreaterThan(6);
    expect(parked?.agentId).toBe(takeover!.agentId);
    expect(atParkedPose(layout, sim.archive)).toBe(true);
  });
});

describe("Archive cart: the hauler leaves during the handover", () => {
  const people = [AM7, ...team(150, (i) => (i % 2 === 0 ? "idle" : "working"))];
  const { layout, sim, events, step } = setup(300, 150, (i) => (i % 2 === 0 ? "idle" : "working"), 45);
  sim.setArchiveFill(0.9);
  step(60);
  const who = sim.startArchiveRun("hand-gone", 2_048);
  step(400, () => sim.archive.phase === "handover" && sim.archive.unload > 0.2);
  const reached = sim.archive.phase === "handover";
  const unloadAtDrop = sim.archive.unload;
  sim.setAgents(people.filter((p) => p.id !== who?.agentId));
  let unloadWentBack = false;
  let lastUnload = unloadAtDrop;
  let leftWithLoad = 0;
  step(6, () => {
    const v = sim.archive;
    if (v.phase === "handover") {
      if (v.unload < lastUnload - 1e-9) unloadWentBack = true;
      lastUnload = v.unload;
    } else if (v.level > 0) leftWithLoad++;
  });
  const afterDrop = copyView(sim.archive);
  step(400, () => events.some((e) => e.type === "parked"));

  it("lets the load roll on into the chute, then leaves the cart at the start of the way back", () => {
    expect(reached).toBe(true);
    expect(unloadWentBack).toBe(false);
    expect(leftWithLoad).toBe(0);
    const handover = events.find((e) => e.type === "handover");
    expect(handover).toMatchObject({ agentId: who!.agentId, freedBytes: 2_048 });
    expect(afterDrop.phase).toBe("left");
    expect(afterDrop.level).toBe(0);
    const back = layout.archive.laneBack;
    expect(nearestSample(back, afterDrop.x, afterDrop.z, afterDrop.rotY)).toMatchObject({ i: 0 });
  });

  it("is taken back by someone else, who parks it", () => {
    const types = events.map((e) => e.type);
    expect(types).toEqual(["taken", "handover", "reassigned", "parked"]);
    expect(events[3].agentId).toBe(events[2].agentId);
    expect(atParkedPose(layout, sim.archive)).toBe(true);
  });
});

describe("Archive cart: nobody idle to take a left cart over", () => {
  it("hands it to a working hacker after a minute, never AM7", () => {
    const busy = (i: number): HqAgentStatus => (i < 60 ? "idle" : "working");
    const { layout, sim, events, clock, step } = setup(100, 90, busy, 46);
    step(60);
    const who = sim.startArchiveRun("all-busy", 1);
    step(300, () => {
      const v = sim.archive;
      return v.phase === "push-out" && Math.hypot(v.x - layout.archive.cart.x, v.z - layout.archive.cart.z) > 3;
    });
    expect(sim.archive.phase).toBe("push-out");
    // The hauler goes, and everyone else gets busy.
    sim.setAgents([AM7, ...team(90, () => "working").filter((p) => p.id !== who!.agentId)]);
    const droppedAt = clock.t;
    step(400, () => events.some((e) => e.type === "parked"));
    const takeover = events.find((e) => e.type === "reassigned");
    expect(takeover).toBeDefined();
    expect(takeover!.agentId).not.toBe("am7");
    expect(takeover!.agentId).not.toBe(who!.agentId);
    expect(takeover!.t - droppedAt).toBeGreaterThanOrEqual(60 - 0.2);
    expect(events.at(-1)?.type).toBe("parked");
    expect(atParkedPose(layout, sim.archive)).toBe(true);
  });
});

describe("Archive cart: pending runs", () => {
  it("starts a run asked for during a briefing only 10 s after it", () => {
    const { sim, events, clock, step } = setup(300, 120, (i) => (i % 2 === 0 ? "idle" : "working"), 55);
    step(60);
    sim.startBriefing(30);
    expect(sim.startArchiveRun("during", 77)).toBeNull();
    let endedAt = -1;
    step(60, () => {
      if (endedAt < 0 && !sim.briefing.active) endedAt = clock.t;
      return events.length > 0;
    });
    expect(endedAt).toBeGreaterThan(0);
    expect(events[0]?.type).toBe("taken");
    expect(events[0].t).toBeGreaterThanOrEqual(endedAt + 10 - 1e-6);
    expect(events[0].t).toBeLessThan(endedAt + 10.5);
  });

  it("applies a run nobody is free for within 600 s without a trip", () => {
    const { sim, events, clock, step } = setup(100, 40, () => "working", 56);
    sim.setArchiveFill(0.5);
    step(10);
    const askedAt = clock.t;
    expect(sim.startArchiveRun("nobody", 4096)).toBeNull();
    step(700, () => events.length > 0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "auto", runId: "nobody", agentId: null, freedBytes: 4096 });
    expect(events[0].t - askedAt).toBeGreaterThanOrEqual(600 - 0.2);
    expect(events[0].t - askedAt).toBeLessThan(601);
    expect(sim.archive.level).toBe(0);
  });

  it("applies every run at once while runs are off", () => {
    const { sim, events, step } = setup(100, 40, (i) => (i % 2 === 0 ? "idle" : "working"), 57);
    sim.setArchiveFill(0.95);
    sim.setArchiveRunsEnabled(false);
    step(30);
    expect(sim.archive.level).toBe(4);
    expect(sim.startArchiveRun("off", 9)).toBeNull();
    expect(events.map((e) => e.type)).toEqual(["auto"]);
    expect(sim.archive.level).toBe(0);
  });
});

describe("Archive cart: load tiers", () => {
  it("shows the fill at once after a reload, with no events, through one reused view", () => {
    const { sim, events, step } = setup(100, 30, () => "working", 60);
    sim.setArchiveFill(0.9);
    const view = sim.archive;
    expect(view.level).toBe(4);
    expect(view.phase).toBe("parked");
    step(5);
    expect(sim.archive).toBe(view);
    expect(sim.archive.level).toBe(4);
    expect(events).toEqual([]);
  });

  it("rises a tier per 1.5 s and drops only after 60 s below the lower threshold", () => {
    const { sim, step } = setup(100, 30, () => "working", 61);
    sim.setArchiveFill(0);
    step(1);
    sim.setArchiveFill(0.9);
    const levels: number[] = [];
    step(6, () => {
      levels.push(sim.archive.level);
    });
    expect(levels[0]).toBe(1);
    expect(levels.indexOf(2)).toBeGreaterThanOrEqual(14);
    expect(levels.indexOf(4)).toBeGreaterThanOrEqual(44);
    expect(levels[levels.length - 1]).toBe(4);
    // Inside the hysteresis band: stays.
    sim.setArchiveFill(0.85);
    step(90);
    expect(sim.archive.level).toBe(4);
    // Below it: only after 60 s.
    sim.setArchiveFill(0.5);
    step(55);
    expect(sim.archive.level).toBe(4);
    step(10);
    expect(sim.archive.level).toBe(2);
  });
});

describe("Archive cart: budget", () => {
  it("updates 1000 agents with a run under way well inside a frame", () => {
    const { sim, step } = setup(1000, 999, (i) => (i % 3 === 0 ? "idle" : i % 23 === 0 ? "error" : "working"), 5);
    sim.setArchiveFill(0.9);
    step(30);
    expect(sim.startArchiveRun("big", 1)).not.toBeNull();
    for (let k = 0; k < 120; k++) sim.update(1 / 30);
    const frames = 300;
    const t0 = performance.now();
    for (let k = 0; k < frames; k++) sim.update(1 / 60);
    const perFrame = (performance.now() - t0) / frames;
    expect(sim.archive.pusherId).not.toBeNull();
    expect(perFrame).toBeLessThan(4);
  });
});
