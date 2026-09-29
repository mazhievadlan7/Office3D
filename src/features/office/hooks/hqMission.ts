import type { AgentState } from "@/features/agents/state/store";
import type { RunRecord } from "@/features/office/hooks/useRunLog";
import { MISSION_MAX_DEFAULT } from "@/features/hq/core/beats";

/**
 * When the HQ's mission mode («боевая задача») ends, as the screen tracks it.
 * A voice command to the whole team starts one (with the briefing); it holds
 * until at least 90% of the runs that command started have finished, or for
 * ten minutes at most. The share of agents working is never used: in the demo
 * it stays around half the floor for good, so the mission would never end.
 */

/** Longest a mission lasts (ms), the same span as the simulation's own limit. */
export const HQ_MISSION_MAX_MS = MISSION_MAX_DEFAULT * 1000;
/** Share of the started runs that must have finished for the mission to end, in percent. */
export const HQ_MISSION_DONE_PERCENT = 90;
/**
 * After the last message went out, how long the run starts are given to
 * arrive (ms) before the share is judged, so one early finisher cannot end it.
 */
export const HQ_MISSION_SETTLE_MS = 5_000;

export type HqMissionTrack = {
  /** The briefing that started it. */
  id: string;
  /** When the command went out to the team (ms since epoch). */
  startedAt: number;
  /** The agents it was sent to; null until the send begins. */
  addressed: readonly string[] | null;
  /** When the last message went out (ms); null while they are still being sent. */
  sentAt: number | null;
};

export type HqMissionRunAgent = Pick<AgentState, "agentId" | "status" | "runStartedAt">;

/**
 * Notes the addressed agents whose run since the command is under way right
 * now into `seen`. The store clears `runStartedAt` the moment a run ends, so
 * without this latch the run-state fallback could never see a run finish.
 * Call it on every change of the agents (not only on the 1 s check).
 */
export function noteHqMissionRuns(
  mission: HqMissionTrack,
  agents: readonly HqMissionRunAgent[],
  seen: Set<string>,
): void {
  const addressed = mission.addressed;
  if (!addressed || addressed.length === 0) return;
  let ids: Set<string> | null = null;
  for (const agent of agents) {
    if (agent.status !== "running" || (agent.runStartedAt ?? 0) < mission.startedAt) continue;
    if (seen.has(agent.agentId)) continue;
    ids ??= new Set(addressed);
    if (ids.has(agent.agentId)) seen.add(agent.agentId);
  }
}

/**
 * The runs the command started and how many have finished: each addressed
 * agent's first user run since the command, from the run log; for an agent the
 * log has no such run for (it is off, or missed the start), the agent's own run
 * state stands in, with `seen` (noteHqMissionRuns) remembering runs that were
 * under way and have since ended.
 */
export function hqMissionRuns(
  mission: HqMissionTrack,
  runLog: readonly RunRecord[],
  agents: readonly HqMissionRunAgent[],
  seen?: ReadonlySet<string>,
): { started: number; finished: number } {
  let started = 0;
  let finished = 0;
  const addressed = mission.addressed ?? [];
  if (addressed.length === 0) return { started, finished };
  // One pass over the log and one over the roster (checked every second on
  // the main thread, with hundreds of agents): each agent's earliest user run
  // since the command (the first of equals kept), and the first roster entry.
  const firstRun = new Map<string, RunRecord>();
  for (const record of runLog) {
    if (record.trigger !== "user" || record.startedAt < mission.startedAt) continue;
    const first = firstRun.get(record.agentId);
    if (!first || record.startedAt < first.startedAt) firstRun.set(record.agentId, record);
  }
  let byId: Map<string, HqMissionRunAgent> | null = null;
  for (const agentId of addressed) {
    const first = firstRun.get(agentId);
    if (first) {
      started += 1;
      if (first.endedAt !== null) finished += 1;
      continue;
    }
    if (!byId) {
      byId = new Map();
      for (const candidate of agents) if (!byId.has(candidate.agentId)) byId.set(candidate.agentId, candidate);
    }
    const agent = byId.get(agentId);
    const current = agent !== undefined && (agent.runStartedAt ?? 0) >= mission.startedAt;
    if (!current && !seen?.has(agentId)) continue;
    started += 1;
    if (agent?.status !== "running") finished += 1;
  }
  return { started, finished };
}

/** Whether the mission is over at `now` (see the module comment). */
export function isHqMissionOver(
  mission: HqMissionTrack,
  runLog: readonly RunRecord[],
  agents: readonly HqMissionRunAgent[],
  now: number,
  seen?: ReadonlySet<string>,
): boolean {
  if (now - mission.startedAt >= HQ_MISSION_MAX_MS) return true;
  if (mission.sentAt === null || mission.addressed === null) return false;
  // Nobody was addressed: nothing to wait for.
  if (mission.addressed.length === 0) return true;
  if (now - mission.sentAt < HQ_MISSION_SETTLE_MS) return false;
  const { started, finished } = hqMissionRuns(mission, runLog, agents, seen);
  if (started === 0) return false;
  // In whole numbers: 0.9 * 30 is not exactly 27 in floating point.
  return finished * 100 >= started * HQ_MISSION_DONE_PERCENT;
}
