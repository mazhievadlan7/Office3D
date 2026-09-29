import { describe, expect, it } from "vitest";

import { HQ_CLIP_INFO, HqClip } from "@/features/hq/core/config";
import { generateHqLayout } from "@/features/hq/core/layout";
import { HqSimulation } from "@/features/hq/core/sim";
import type { HqAgentInput } from "@/features/hq/core/types";
import { CREW_EXCHANGES } from "@/features/hq/render/audio/crewScript";
import {
  ANSWER_GAP_MAX,
  ANSWER_GAP_MIN,
  CrewTalkPlanner,
  EXCHANGE_GAP_MAX,
  EXCHANGE_GAP_MIN,
  TURN_RADIUS,
  chooseAnswerer,
} from "@/features/hq/render/audio/crewTalk";
import { isSeatedClip } from "@/features/hq/render/crowd/clipTable";

const DT = 1 / 30;
const [H0, H1] = HQ_CLIP_INFO.SitTurnL.hold!;
const [, T1] = HQ_CLIP_INFO.SitTurnL.talkWindow!;

function team(count: number): HqAgentInput[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `agent-${String(i).padStart(4, "0")}`,
    name: `Agent ${i}`,
    status: "idle" as const,
  }));
}

const isTurn = (clip: number) => clip === HqClip.SitTurnL || clip === HqClip.SitTurnR;

/** Runs the sim until `found` returns something (at most `seconds`). */
function until<T>(sim: HqSimulation, seconds: number, found: () => T | null): T | null {
  for (let t = 0; t < seconds; t += DT) {
    sim.update(DT);
    const v = found();
    if (v !== null) return v;
  }
  return null;
}

describe("crew voices lead the talk poses (sim.cueTalk)", () => {
  it("holds_a_seated_pair_speaker_in_the_talk_half_and_the_partner_listening", () => {
    const sim = new HqSimulation(generateHqLayout(300), { seed: 11 });
    sim.setAgents(team(160));
    const f = sim.frame;
    // A seated pair turned to each other, both looping inside the hold.
    const pair = until(sim, 900, () => {
      for (let i = 0; i < f.count; i++) {
        if (!isTurn(f.clip[i]) || !sim.conversing(i) || f.clipTime[i] < H0 + 0.1) continue;
        for (let j = 0; j < f.count; j++) {
          if (j === i || !isTurn(f.clip[j]) || f.clipTime[j] < H0 + 0.1) continue;
          if (Math.hypot(f.x[i] - f.x[j], f.z[i] - f.z[j]) < 2.2) return [i, j] as const;
        }
      }
      return null;
    });
    expect(pair).not.toBeNull();
    const [i, j] = pair!;
    // Cue whoever is listening right now: the clip does not wait for its half.
    const speaker = f.clipTime[i] >= T1 ? i : j;
    const partner = speaker === i ? j : i;
    const id = f.ids[speaker];
    expect(sim.cueTalk(id, 4)).toBe(true);
    let wrong = 0;
    let samples = 0;
    for (let t = 0; t < 3.9; t += DT) {
      sim.update(DT);
      samples++;
      if (!(f.clipTime[speaker] >= H0 && f.clipTime[speaker] < T1)) wrong++;
      // (Frame times are float32: the loop point h1 may read as itself.)
      if (!(f.clipTime[partner] >= T1 && f.clipTime[partner] <= H1 + 1e-3)) wrong++;
    }
    // Longer than a talk half (1.9 s): the hold keeps both where they belong.
    expect(wrong).toBe(0);
    expect(samples).toBeGreaterThan(100);
    // The pair lasts past the phrase: nobody turns away mid-sentence.
    expect(sim.conversing(speaker)).toBe(true);
    expect(sim.conversing(partner)).toBe(true);
  });

  it("gives_the_word_at_a_spot_to_the_cued_speaker_and_waits_for_the_next_cue", () => {
    const sim = new HqSimulation(generateHqLayout(300), { seed: 5 });
    sim.setAgents(team(160));
    const f = sim.frame;
    // A group standing at a spot, with a listener to cue.
    const found = until(sim, 900, () => {
      for (let i = 0; i < f.count; i++) {
        if (isSeatedClip(f.clip[i]) || f.clip[i] === HqClip.Talk || !sim.conversing(i)) continue;
        return i;
      }
      return null;
    });
    expect(found).not.toBeNull();
    const a = found!;
    const group: number[] = [];
    for (let k = 0; k < f.count; k++) {
      if (k !== a && !isSeatedClip(f.clip[k]) && sim.conversing(k) && Math.hypot(f.x[k] - f.x[a], f.z[k] - f.z[a]) < 4) group.push(k);
    }
    expect(sim.cueTalk(f.ids[a], 2)).toBe(true);
    let talking = 0;
    let others = 0;
    let steps = 0;
    for (let t = 0; t < 1.8; t += DT) {
      sim.update(DT);
      steps++;
      if (f.clip[a] === HqClip.Talk) talking++;
      for (const k of group) if (f.clip[k] === HqClip.Talk) others++;
    }
    // Talk starts at once (a stand turn may take a frame or two to leave a gesture).
    expect(talking).toBeGreaterThan(steps - 10);
    expect(others).toBe(0);
    // After the phrase the group listens, waiting for the next voice, rather than picking a speaker.
    for (let t = 0; t < 0.4; t += DT) sim.update(DT);
    let spoke = 0;
    for (let t = 0; t < 2.2; t += DT) {
      sim.update(DT);
      if (f.clip[a] === HqClip.Talk) spoke++;
      for (const k of group) if (f.clip[k] === HqClip.Talk) spoke++;
    }
    expect(spoke).toBe(0);
  });

  it("refuses_agents_who_are_in_no_conversation", () => {
    const sim = new HqSimulation(generateHqLayout(300), { seed: 3 });
    sim.setAgents(team(40));
    for (let t = 0; t < 5; t += DT) sim.update(DT);
    const f = sim.frame;
    let tried = 0;
    for (let i = 0; i < f.count; i++) {
      if (sim.conversing(i)) continue;
      expect(sim.cueTalk(f.ids[i], 2)).toBe(false);
      tried++;
    }
    expect(tried).toBeGreaterThan(0);
    expect(sim.cueTalk("nobody", 2)).toBe(false);
  });
});

describe("crew talk rhythm (planner)", () => {
  const q = { line: CREW_EXCHANGES[2].ask, exchange: 2, role: "ask" as const };
  const a = { line: CREW_EXCHANGES[2].answer, exchange: 2, role: "answer" as const };

  it("lets_the_answer_come_a_quarter_second_after_the_question_and_the_next_exchange_a_breath_later", () => {
    const planner = new CrewTalkPlanner(() => 0.5);
    planner.spoke("a", q, 0, 0, 10, 12);
    expect(planner.waitFor("b", 1, 0, 12)).toBeCloseTo(ANSWER_GAP_MIN, 5);
    expect(planner.waitFor("b", 1, 0, 12 + ANSWER_GAP_MIN)).toBe(0);
    const gap = planner.answerGap();
    expect(gap).toBeGreaterThanOrEqual(ANSWER_GAP_MIN);
    expect(gap).toBeLessThanOrEqual(ANSWER_GAP_MAX);
    const breath = planner.spoke("b", a, 1, 0, 12 + gap, 14);
    const wait = planner.waitFor("a", 0, 0, 14);
    expect(wait).toBeCloseTo(breath, 5);
    expect(wait).toBeGreaterThanOrEqual(EXCHANGE_GAP_MIN);
    expect(wait).toBeLessThanOrEqual(EXCHANGE_GAP_MAX);
    // A scheduled answer holds the floor before it is heard, too.
    expect(planner.waitFor("c", 0.5, 0, 12.1)).toBeGreaterThan(0);
  });

  it("drops_an_answer_that_never_played_and_reopens_the_question", () => {
    const planner = new CrewTalkPlanner(() => 0.5);
    planner.spoke("a", q, 0, 0, 10, 12);
    planner.spoke("b", a, 1, 0, 12.4, 14);
    expect(planner.openQuestion("c", 0, 0, 12.2)).toBe(-1);
    planner.stopped("b", 12.2);
    expect(planner.openQuestion("c", 0, 0, 12.2)).toBe(2);
    expect(planner.log.some((e) => e.speaker === "b")).toBe(false);
    expect(planner.waitFor("c", 0, 0, 12.3)).toBe(0);
  });

  it("chooses_the_nearest_free_answerer_with_the_answer_decoded", () => {
    const far = { x: TURN_RADIUS + 1, z: 0, busyUntil: 0, ready: true };
    const busy = { x: 0.5, z: 0, busyUntil: 13, ready: true };
    const cold = { x: 0.6, z: 0, busyUntil: 0, ready: false };
    const near = { x: 1.5, z: 0, busyUntil: 11, ready: true };
    const nearer = { x: 1, z: 0, busyUntil: 0, ready: true };
    expect(chooseAnswerer([far, busy, cold, near, nearer], 0, 0, 12)).toBe(4);
    expect(chooseAnswerer([far, busy, cold, near], 0, 0, 12)).toBe(3);
    expect(chooseAnswerer([far, busy, cold], 0, 0, 12)).toBe(-1);
  });
});
