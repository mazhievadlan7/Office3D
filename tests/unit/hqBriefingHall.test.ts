import { describe, expect, it } from "vitest";

import { HqClip } from "@/features/hq/core/config";
import { generateHqLayout } from "@/features/hq/core/layout";
import { HqSimulation } from "@/features/hq/core/sim";
import { HQ_PLACE } from "@/features/hq/core/types";
import type { HqAgentInput, HqAgentStatus } from "@/features/hq/core/types";

function team(count: number, status: (i: number) => HqAgentStatus): HqAgentInput[] {
  return Array.from({ length: count }, (_, i) => ({ id: `agent-${String(i).padStart(4, "0")}`, name: `Agent ${i}`, status: status(i) }));
}

const DT = 0.1;

/** The sim's agents, for the tests that have to hold one back (private in the sim). */
type SimAgent = { id: string; lead: boolean; seat: number; holdUntil: number; mode: number };
const agentsOf = (sim: HqSimulation) => (sim as unknown as { agents: SimAgent[] }).agents;

describe("HqSimulation briefing: AM7 waits for the floor", () => {
  it("does not begin until everyone with a desk stands at it, waiting at the microphone meanwhile", () => {
    const layout = generateHqLayout(300);
    const sim = new HqSimulation(layout, { seed: 5 });
    // Some idle (out on breaks when the call comes), two in error (never waited for).
    sim.setAgents([
      { id: "am7", name: "AM7", status: "working" },
      ...team(120, (i) => (i < 2 ? "error" : i % 3 === 0 ? "idle" : "working")),
    ]);
    for (let step = 0; step < 1500; step++) sim.update(DT);
    sim.startBriefing(600);
    // The host says he speaks (the old default): he still waits for the floor.
    sim.setBriefingSpeaking(true);
    const li = sim.frame.ids.indexOf("am7");
    let atPodium = -1;
    let ready = -1;
    let talkedBeforeReady = 0;
    let presentedBeforeReady = 0;
    let waitingFrames = 0;
    for (let step = 0; step < 900 && ready < 0; step++) {
      sim.update(DT);
      const b = sim.briefing;
      if (atPodium < 0 && b.leadAtPodium) atPodium = step;
      if (b.hallReady) {
        ready = step;
        break;
      }
      const clip = sim.frame.clip[li];
      if (b.leadAtPodium) {
        waitingFrames++;
        if (clip === HqClip.Talk) talkedBeforeReady++;
        if (clip === HqClip.Present) presentedBeforeReady++;
      }
      expect(b.gathered).toBeLessThanOrEqual(b.expected);
    }
    expect(atPodium).toBeGreaterThanOrEqual(0);
    expect(ready).toBeGreaterThanOrEqual(atPodium);
    // Ready because the floor gathered, well before the cap.
    expect(ready * DT).toBeLessThan(45);
    const b = sim.briefing;
    expect(b.expected).toBe(118); // the two in error are not waited for
    expect(b.gathered).toBe(b.expected);
    // Everyone expected really stands at their desk.
    const f = sim.frame;
    let standing = 0;
    for (let i = 0; i < f.count; i++) if (i !== li && f.place[i] === HQ_PLACE.briefing) standing++;
    expect(standing).toBeGreaterThanOrEqual(118);
    // Waiting at the microphone: no talking, no presenting, before the hall is ready.
    expect(waitingFrames).toBeGreaterThan(0);
    expect(talkedBeforeReady).toBe(0);
    expect(presentedBeforeReady).toBe(0);
    // Once ready (and speaking), he talks.
    for (let step = 0; step < 20; step++) sim.update(DT);
    expect([HqClip.Talk, HqClip.Present]).toContain(sim.frame.clip[li]);
    // A new briefing starts the wait over.
    sim.endBriefing();
    for (let step = 0; step < 200 && sim.briefing.active; step++) sim.update(DT);
    sim.startBriefing(600);
    sim.update(DT);
    expect(sim.briefing.hallReady).toBe(false);
  });

  it("never deadlocks on someone who does not come: ready at the cap", () => {
    const layout = generateHqLayout(300);
    const sim = new HqSimulation(layout, { seed: 9 });
    sim.setAgents([{ id: "am7", name: "AM7", status: "working" }, ...team(60, () => "working")]);
    for (let step = 0; step < 600; step++) sim.update(DT);
    sim.startBriefing(600);
    // One hacker never reacts (stuck in his chair).
    const stuck = agentsOf(sim).find((a) => !a.lead && a.seat >= 0)!;
    stuck.holdUntil = 1e9;
    let ready = -1;
    for (let step = 0; step < 900 && ready < 0; step++) {
      sim.update(DT);
      if (sim.briefing.hallReady) ready = step;
    }
    const b = sim.briefing;
    expect(ready).toBeGreaterThan(0);
    // Not before the cap (45 s from the call), and not much after it.
    expect(ready * DT).toBeGreaterThanOrEqual(44.9);
    expect(ready * DT).toBeLessThan(46);
    expect(b.leadAtPodium).toBe(true);
    expect(b.gathered).toBe(b.expected - 1);
  });

  it("shows the wall on cue once he may begin, and only then", () => {
    const layout = generateHqLayout(300);
    const sim = new HqSimulation(layout, { seed: 11 });
    sim.setAgents([{ id: "am7", name: "AM7", status: "working" }, ...team(40, () => "working")]);
    for (let step = 0; step < 300; step++) sim.update(DT);
    sim.startBriefing(600);
    sim.setBriefingSpeaking(false);
    const li = sim.frame.ids.indexOf("am7");
    // Asked to point while the floor is still gathering: nothing yet.
    for (let step = 0; step < 900 && !sim.briefing.leadAtPodium; step++) sim.update(DT);
    if (!sim.briefing.hallReady) {
      sim.pointAtWall();
      for (let step = 0; step < 5; step++) sim.update(DT);
      if (!sim.briefing.hallReady) expect(sim.frame.clip[li]).not.toBe(HqClip.Present);
    }
    for (let step = 0; step < 900 && !sim.briefing.hallReady; step++) sim.update(DT);
    expect(sim.briefing.hallReady).toBe(true);
    // Let a stale request run out, then he speaks: facing the rows, talking.
    for (let step = 0; step < 80; step++) sim.update(DT);
    sim.setBriefingSpeaking(true);
    for (let step = 0; step < 80; step++) sim.update(DT);
    expect(sim.frame.clip[li]).toBe(HqClip.Talk);
    // On cue from here on: Present on the call, back to talking after it, no fixed rhythm.
    sim.pointAtWall();
    let presented = 0;
    for (let step = 0; step < 20; step++) {
      sim.update(DT);
      if (sim.frame.clip[li] === HqClip.Present) presented++;
    }
    expect(presented).toBeGreaterThan(10);
    for (let step = 0; step < 60; step++) sim.update(DT);
    let presentedLater = 0;
    for (let step = 0; step < 200; step++) {
      sim.update(DT);
      if (sim.frame.clip[li] === HqClip.Present) presentedLater++;
    }
    expect(presentedLater).toBe(0);
    expect(sim.frame.clip[li]).toBe(HqClip.Talk);
  });
});
