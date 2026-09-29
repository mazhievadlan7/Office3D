"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentState, AgentStatus } from "@/features/agents/state/store";
import type { RunRecord } from "@/features/office/hooks/useRunLog";
import {
  OP_COMPLETE_MS,
  OP_HANDOFF_MS,
  isOperationStale,
  operationReducer,
  type HqOperation,
  type HqOperationEvent,
} from "@/features/hq/core/operation";
import type { HqOperationSnapshot } from "@/features/hq/render/screens/screenPaint";

/**
 * Tracks the «ХОД ЗАДАЧИ» operation for the video wall (design_wall.md), from a
 * briefing onward, and publishes a serialisable snapshot for HqScreenHub.
 *
 * Progress is built only from real events — a briefing beginning, the lead
 * agent's plan and later messages (step marks), each crew agent's run start,
 * finalised reply or error — never from a timer. Time only ever shows as the
 * `T+` clock. The reducer lives in a ref; the snapshot is published at most
 * once a second and only on change (with a growing `rev`), except lifecycle
 * changes, which go out at once. The hook owns the timers: 45 s of «ЗАДАЧА
 * ЗАВЕРШЕНА» after completion, 20 min without an event before it hands off, and
 * the 1.5 s hand-off frame before the panels return.
 *
 * This hook does no I/O and never calls any voice/TTS API.
 */

/**
 * `at` is when the command went out (ms): the operation's start, so a send
 * that marks the first agent running before this hook's effect runs still
 * counts as started after it. Defaults to when the hook first sees the briefing.
 */
type BriefingInput = { id: string; task: string; reply: string; at?: number } | null;

export type UseHqOperationArgs = {
  /** The addressed roster (crew + lead). Pass the same agents the briefing was sent to. */
  agents: AgentState[];
  /** Run lifecycle records (useRunLog): a fallback signal for started/error. */
  runLog: RunRecord[];
  /** The briefing in progress (its id, task and the lead's first reply), or null. */
  briefing: BriefingInput;
  /** The main agent's id (AM7). */
  leadAgentId: string | null;
  /** The HUD toggle: false hides the tracker (shows the panels) without ending it. Default true. */
  show?: boolean;
};

type Phase = "live" | "complete" | "handoff";

/** The latest confirmed assistant message of an agent, or null. */
function latestAssistant(agent: AgentState | undefined): { entryId: string; text: string; at: number } | null {
  const entries = agent?.transcriptEntries;
  if (!Array.isArray(entries)) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.role !== "assistant" || e.kind !== "assistant") continue;
    if (!e.confirmed || !e.text.trim()) continue;
    return { entryId: e.entryId, text: e.text, at: e.timestampMs ?? 0 };
  }
  return null;
}

/** A cheap signature of what the wall shows, so unchanged snapshots are not republished. */
function signature(op: HqOperation, state: string): string {
  const steps = op.steps.map((s) => s.state[0]).join("");
  const last = op.log[op.log.length - 1];
  return [
    state,
    op.task,
    op.goal,
    steps,
    op.activeStep,
    op.overall,
    op.lead,
    op.team.addressed,
    op.team.started,
    op.team.replied,
    op.team.errors,
    op.log.length,
    last ? `${last.at}:${last.kind}:${last.step ?? ""}` : "",
  ].join("|");
}

/** Complete when every step is done, or every addressed crew member has replied and AM7 is free. */
function shouldComplete(op: HqOperation): boolean {
  if (op.state !== "live") return false;
  const stepsDone = op.steps.length > 0 && op.steps.every((s) => s.state === "done");
  const teamDone = op.team.addressed > 0 && op.team.replied >= op.team.addressed && op.lead !== "working";
  return stepsDone || teamDone;
}

export function useHqOperation({ agents, runLog, briefing, leadAgentId, show = true }: UseHqOperationArgs): HqOperationSnapshot | null {
  const [snapshot, setSnapshot] = useState<HqOperationSnapshot | null>(null);

  const opRef = useRef<HqOperation | null>(null);
  const revRef = useRef(0);
  const phaseRef = useRef<Phase>("live");
  const beginIdRef = useRef<string | null>(null);
  const dismissedRef = useRef(false);
  const completeAtRef = useRef(0);
  const handoffAtRef = useRef(0);

  const planDoneRef = useRef(false);
  const leadSeenRef = useRef<Set<string>>(new Set());
  const leadStatusRef = useRef<AgentStatus | null>(null);
  const crewStartedRef = useRef<Set<string>>(new Set());
  const crewRepliedRef = useRef<Set<string>>(new Set());
  const crewErroredRef = useRef<Set<string>>(new Set());
  /**
   * Each crew agent's status as last seen (seeded at begin): "running" and
   * "error" count only as a change, never as a state an agent was already in
   * before the command (a stale error or an earlier task's run).
   */
  const crewStatusRef = useRef<Map<string, AgentStatus>>(new Map());

  const publishedSigRef = useRef<string | null>(null);
  const lastStateRef = useRef<string | null>(null);
  const lastPublishAtRef = useRef(0);
  const showRef = useRef(show);

  // The HUD toggle, kept in a ref for the interval; publish at once when it flips.
  useEffect(() => {
    showRef.current = show;
  }, [show]);

  const dispatch = useCallback((event: HqOperationEvent) => {
    opRef.current = operationReducer(opRef.current, event);
  }, []);

  const publish = useCallback(() => {
    const op = opRef.current;
    if (!op || dismissedRef.current || !showRef.current) {
      if (publishedSigRef.current !== null) {
        publishedSigRef.current = null;
        lastStateRef.current = null;
        setSnapshot(null);
      }
      return;
    }
    const state: HqOperation["state"] = phaseRef.current === "complete" ? "complete" : phaseRef.current === "handoff" ? "handoff" : op.state;
    const sig = signature(op, state);
    const stateChanged = lastStateRef.current !== state;
    if (sig === publishedSigRef.current && !stateChanged) return;
    const now = Date.now();
    // Throttle content churn to 1 Hz; lifecycle (state) changes go out at once.
    if (!stateChanged && publishedSigRef.current !== null && now - lastPublishAtRef.current < 1000) return;
    publishedSigRef.current = sig;
    lastStateRef.current = state;
    lastPublishAtRef.current = now;
    revRef.current += 1;
    setSnapshot({ ...op, state, rev: revRef.current });
  }, []);

  // Agent-driven events: begin, the lead's plan and messages, and the crew's
  // starts, replies and errors — each fired once per real transition.
  useEffect(() => {
    const now = Date.now();
    const lead = leadAgentId ? agents.find((a) => a.agentId === leadAgentId) : undefined;
    const leadName = lead?.name || "AM7";

    if (briefing && briefing.id !== beginIdRef.current) {
      beginIdRef.current = briefing.id;
      dismissedRef.current = false;
      phaseRef.current = "live";
      completeAtRef.current = 0;
      handoffAtRef.current = 0;
      planDoneRef.current = false;
      leadSeenRef.current = new Set();
      leadStatusRef.current = lead?.status ?? null;
      crewStartedRef.current = new Set();
      crewRepliedRef.current = new Set();
      crewErroredRef.current = new Set();
      const crewStatus = new Map<string, AgentStatus>();
      for (const a of agents) if (a.agentId !== leadAgentId) crewStatus.set(a.agentId, a.status);
      crewStatusRef.current = crewStatus;
      // Everything the lead has said so far is pre-briefing: don't replay it.
      const seed = latestAssistant(lead);
      if (seed) leadSeenRef.current.add(seed.entryId);
      const crew = crewStatus.size;
      const at = typeof briefing.at === "number" && Number.isFinite(briefing.at) && briefing.at <= now ? briefing.at : now;
      dispatch({ type: "begin", id: briefing.id, task: briefing.task, goal: "", crew, lead: leadName, at });
    }

    const op = opRef.current;
    if (op && beginIdRef.current === briefing?.id && !dismissedRef.current) {
      const startedAt = op.startedAt;

      // The lead's plan (first message after the briefing), then any later
      // messages: step marks and lead activity come from these.
      const leadLatest = latestAssistant(lead);
      if (leadLatest && !leadSeenRef.current.has(leadLatest.entryId) && leadLatest.at >= startedAt - 1000) {
        leadSeenRef.current.add(leadLatest.entryId);
        if (!planDoneRef.current) {
          planDoneRef.current = true;
          dispatch({ type: "plan", text: leadLatest.text, who: leadName, at: now });
        } else {
          dispatch({ type: "leadMessage", text: leadLatest.text, who: leadName, at: now });
        }
      } else if (!planDoneRef.current && briefing?.reply) {
        // The reply may reach us before its transcript entry does.
        planDoneRef.current = true;
        if (leadLatest) leadSeenRef.current.add(leadLatest.entryId);
        dispatch({ type: "plan", text: briefing.reply, who: leadName, at: now });
      }

      // The lead's status → AM7 works / waits / errored.
      const leadStatus = lead?.status ?? null;
      if (leadStatus && leadStatus !== leadStatusRef.current) {
        leadStatusRef.current = leadStatus;
        if (leadStatus === "running") dispatch({ type: "agentStarted", who: leadName, isLead: true, at: now });
        else if (leadStatus === "error") dispatch({ type: "agentError", who: leadName, isLead: true, at: now });
        else dispatch({ type: "agentReplied", who: leadName, isLead: true, at: now });
      }

      // The crew's reactions, each distinct agent once. This runs on every
      // roster update (streaming included), so it stays linear: the run log's
      // errors are collected once, and an agent already counted for a signal
      // is not looked at again for it (no transcript scan, no log scan).
      const started = crewStartedRef.current;
      const replied = crewRepliedRef.current;
      const erroredIds = crewErroredRef.current;
      const statusSeen = crewStatusRef.current;
      let logErrors: Set<string> | null = null;
      for (const agent of agents) {
        if (agent.agentId === leadAgentId) continue;
        const id = agent.agentId;
        const who = agent.name || id;
        const prev = statusSeen.get(id);
        statusSeen.set(id, agent.status);
        const becameRunning = agent.status === "running" && prev !== "running";
        if (!started.has(id) && ((agent.runStartedAt ?? 0) >= startedAt || becameRunning)) {
          started.add(id);
          dispatch({ type: "agentStarted", who, at: now });
        }
        if (!replied.has(id)) {
          const reply = latestAssistant(agent);
          if (reply && reply.at >= startedAt) {
            replied.add(id);
            dispatch({ type: "agentReplied", who, at: now });
          }
        }
        if (erroredIds.has(id)) continue;
        let errored = agent.status === "error" && prev !== "error";
        if (!errored) {
          if (!logErrors) {
            logErrors = new Set();
            for (const r of runLog) if (r.outcome === "error" && r.startedAt >= startedAt) logErrors.add(r.agentId);
          }
          errored = logErrors.has(id);
        }
        if (errored) {
          crewErroredRef.current.add(id);
          dispatch({ type: "agentError", who, at: now });
        }
      }
    }
    // The reducer ref is now current; the interval below publishes the snapshot
    // (so no setState runs synchronously inside this effect).
  }, [agents, runLog, briefing, leadAgentId, dispatch]);

  // Lifecycle timers, independent of any event: completion hold, staleness and
  // the hand-off frame. Also flushes throttled content changes.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const op = opRef.current;
      if (op && !dismissedRef.current) {
        const now = Date.now();
        if (phaseRef.current === "live") {
          if (shouldComplete(op)) {
            dispatch({ type: "complete", at: now });
            phaseRef.current = "complete";
            completeAtRef.current = now;
          } else if (isOperationStale(op, now)) {
            phaseRef.current = "handoff";
            handoffAtRef.current = now;
          }
        } else if (phaseRef.current === "complete" && now - completeAtRef.current >= OP_COMPLETE_MS) {
          phaseRef.current = "handoff";
          handoffAtRef.current = now;
        } else if (phaseRef.current === "handoff" && now - handoffAtRef.current >= OP_HANDOFF_MS) {
          dismissedRef.current = true;
        }
      }
      publish();
    }, 500);
    return () => window.clearInterval(timer);
  }, [dispatch, publish]);

  return snapshot;
}
