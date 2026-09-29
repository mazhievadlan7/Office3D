import { describe, expect, it } from "vitest";

import {
  HQ_MISSION_MAX_MS,
  HQ_MISSION_SETTLE_MS,
  hqMissionRuns,
  isHqMissionOver,
  noteHqMissionRuns,
  type HqMissionRunAgent,
  type HqMissionTrack,
} from "@/features/office/hooks/hqMission";
import type { RunRecord } from "@/features/office/hooks/useRunLog";

const T0 = 1_000_000;
const SENT = T0 + 2_000;
const LATER = SENT + HQ_MISSION_SETTLE_MS + 1_000;

const mission = (ids: string[], sentAt: number | null = SENT): HqMissionTrack => ({
  id: "briefing-x",
  startedAt: T0,
  addressed: ids,
  sentAt,
});

const run = (agentId: string, startedAt: number, endedAt: number | null, trigger: RunRecord["trigger"] = "user"): RunRecord => ({
  runId: `${agentId}-${startedAt}`,
  agentId,
  agentName: agentId,
  startedAt,
  endedAt,
  outcome: endedAt === null ? null : "ok",
  trigger,
});

const idle = (agentId: string): HqMissionRunAgent => ({ agentId, status: "idle", runStartedAt: null });

const ids = (n: number) => Array.from({ length: n }, (_, i) => `a${i}`);

describe("HQ mission end", () => {
  it("holds while the messages are still going out", () => {
    const m = mission(["a0"], null);
    expect(isHqMissionOver(m, [run("a0", T0 + 10, T0 + 20)], [idle("a0")], LATER)).toBe(false);
  });

  it("holds for the settle time after the last message, even if every run is done", () => {
    const m = mission(["a0", "a1"]);
    const runs = [run("a0", T0 + 10, T0 + 20)];
    expect(isHqMissionOver(m, runs, [], SENT + 1_000)).toBe(false);
  });

  it("holds while no run has started", () => {
    expect(isHqMissionOver(mission(ids(3)), [], ids(3).map(idle), LATER)).toBe(false);
  });

  it("ends once 90% of the started runs have finished", () => {
    const team = ids(10);
    const runs = team.map((id, i) => run(id, T0 + 100 + i, i < 8 ? T0 + 5_000 : null));
    expect(isHqMissionOver(mission(team), runs, [], LATER)).toBe(false);
    runs[8] = run("a8", T0 + 108, T0 + 6_000);
    expect(isHqMissionOver(mission(team), runs, [], LATER)).toBe(true);
  });

  it("counts in whole numbers (27 of 30 is enough)", () => {
    const team = ids(30);
    const runs = team.map((id, i) => run(id, T0 + 100 + i, i < 27 ? T0 + 5_000 : null));
    expect(hqMissionRuns(mission(team), runs, [])).toEqual({ started: 30, finished: 27 });
    expect(isHqMissionOver(mission(team), runs, [], LATER)).toBe(true);
  });

  it("ignores runs from before the command, other agents and heartbeats", () => {
    const m = mission(["a0", "a1"]);
    const runs = [
      run("a0", T0 - 5_000, T0 - 1_000),
      run("a1", T0 + 50, T0 + 90, "heartbeat"),
      run("zz", T0 + 50, T0 + 90),
      run("a0", T0 + 100, null),
    ];
    expect(hqMissionRuns(m, runs, [])).toEqual({ started: 1, finished: 0 });
  });

  it("uses only each agent's first run after the command", () => {
    const m = mission(["a0"]);
    const runs = [run("a0", T0 + 9_000, null), run("a0", T0 + 100, T0 + 4_000)];
    expect(hqMissionRuns(m, runs, [])).toEqual({ started: 1, finished: 1 });
  });

  it("falls back to the agent's own run state without a run log", () => {
    const m = mission(["a0", "a1"]);
    const agents: HqMissionRunAgent[] = [
      { agentId: "a0", status: "running", runStartedAt: T0 + 100 },
      { agentId: "a1", status: "idle", runStartedAt: T0 + 200 },
    ];
    expect(hqMissionRuns(m, [], agents)).toEqual({ started: 2, finished: 1 });
    expect(isHqMissionOver(m, [], agents, LATER)).toBe(false);
    agents[0] = { ...agents[0], status: "idle" };
    expect(isHqMissionOver(m, [], agents, LATER)).toBe(true);
  });

  it("counts a run that ended even though the store cleared its runStartedAt (seen latch)", () => {
    // The store sets runStartedAt back to null the moment a run ends, so the
    // fallback alone would lose every finished run and hold for ten minutes.
    const m = mission(["a0", "a1"]);
    const seen = new Set<string>();
    const running: HqMissionRunAgent[] = [
      { agentId: "a0", status: "running", runStartedAt: T0 + 100 },
      { agentId: "a1", status: "running", runStartedAt: T0 + 200 },
    ];
    noteHqMissionRuns(m, running, seen);
    const done: HqMissionRunAgent[] = [idle("a0"), idle("a1")];
    expect(isHqMissionOver(m, [], done, LATER)).toBe(false);
    expect(hqMissionRuns(m, [], done, seen)).toEqual({ started: 2, finished: 2 });
    expect(isHqMissionOver(m, [], done, LATER, seen)).toBe(true);
    // A run from before the command, or an agent nobody addressed, is never latched.
    const other = new Set<string>();
    noteHqMissionRuns(m, [{ agentId: "a0", status: "running", runStartedAt: T0 - 1 }, { agentId: "zz", status: "running", runStartedAt: T0 + 5 }], other);
    expect(other.size).toBe(0);
  });

  it("never looks at how many agents are working, and ends at the time limit", () => {
    const team = ids(4);
    const runs = team.map((id) => run(id, T0 + 100, null));
    expect(isHqMissionOver(mission(team), runs, [], T0 + HQ_MISSION_MAX_MS - 1)).toBe(false);
    expect(isHqMissionOver(mission(team), runs, [], T0 + HQ_MISSION_MAX_MS)).toBe(true);
    // A briefing without a send (no addressed list) also ends at the limit.
    const bare: HqMissionTrack = { id: "b", startedAt: T0, addressed: null, sentAt: null };
    expect(isHqMissionOver(bare, [], [], T0 + HQ_MISSION_MAX_MS - 1)).toBe(false);
    expect(isHqMissionOver(bare, [], [], T0 + HQ_MISSION_MAX_MS)).toBe(true);
  });

  it("ends at once when nobody was addressed", () => {
    expect(isHqMissionOver(mission([]), [], [], SENT)).toBe(true);
  });
});
