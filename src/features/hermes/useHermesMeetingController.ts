"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HermesControl } from "@/features/hermes/HermesControlContext";
import type {
  StandupMeeting,
  StandupSummaryCard,
} from "@/lib/office/standup/types";

export type HermesMeetingEntry = {
  agentId: string;
  name: string;
  kind: "opening" | "turn" | "summary";
  round: number;
  text: string;
  status: "speaking" | "done" | "failed" | "timeout";
};

export type HermesMeeting = {
  id: string;
  topic: string;
  status:
    | "gathering"
    | "speaking"
    | "summarizing"
    | "done"
    | "stopped"
    | "failed";
  requestedBy: "person" | "main";
  hostAgentId: string;
  participants: Array<{ agentId: string; name: string }>;
  rounds: number;
  round: number;
  currentSpeaker: string | null;
  currentSessionKey: string | null;
  currentRunId: string | null;
  transcript: HermesMeetingEntry[];
  summary: string | null;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
};

const ACTIVE = new Set<HermesMeeting["status"]>([
  "gathering",
  "speaking",
  "summarizing",
]);

const isMeeting = (value: unknown): value is HermesMeeting =>
  Boolean(value) &&
  typeof value === "object" &&
  typeof (value as HermesMeeting).id === "string";

/**
 * A Hermes meeting in the shape the office's 3D meeting room already knows
 * (the standup): who takes part, who is speaking and what they say — live
 * while the speaker's reply streams, then as spoken.
 */
export const toStandupMeeting = (
  meeting: HermesMeeting,
  liveText: string,
  arrivedAgentIds: string[],
): StandupMeeting => {
  const said = (agentId: string) =>
    meeting.transcript
      .filter((entry) => entry.agentId === agentId && entry.text)
      .map((entry) => entry.text);
  const cards: StandupSummaryCard[] = meeting.participants.map(
    (participant) => {
      const own = said(participant.agentId);
      const speaking = meeting.currentSpeaker === participant.agentId;
      const speech =
        (speaking && liveText) ||
        (participant.agentId === meeting.hostAgentId && meeting.summary) ||
        own.at(-1) ||
        "";
      return {
        agentId: participant.agentId,
        agentName: participant.name,
        speech,
        currentTask: meeting.topic,
        blockers: [],
        recentCommits: [],
        activeTickets: [],
        manualNotes: own,
        sourceStates: [],
      };
    },
  );
  const phase =
    meeting.status === "gathering"
      ? "gathering"
      : ACTIVE.has(meeting.status)
        ? "in_progress"
        : "complete";
  return {
    id: meeting.id,
    trigger: "manual",
    phase,
    scheduledFor: null,
    startedAt: meeting.startedAt,
    updatedAt: meeting.endedAt ?? meeting.startedAt,
    completedAt: meeting.endedAt,
    currentSpeakerAgentId: meeting.currentSpeaker,
    speakerStartedAt: null,
    speakerDurationMs: 0,
    participantOrder: meeting.participants.map(
      (participant) => participant.agentId,
    ),
    arrivedAgentIds,
    cards,
    kind: "live",
    topic: meeting.topic,
    summary: meeting.summary,
  };
};

/**
 * Meetings chaired by the Office3D server over Hermes: live replies from
 * each agent, a summary and tasks from the main agent. Same surface as the
 * standup controller where the office room uses it.
 */
export const useHermesMeetingController = (control: HermesControl | null) => {
  const available = Boolean(control?.available);
  const [meeting, setMeeting] = useState<HermesMeeting | null>(null);
  const [liveText, setLiveText] = useState("");
  const [arrived, setArrived] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const meetingRef = useRef<HermesMeeting | null>(null);
  const lastArrivalsRef = useRef("");

  // One place that moves to a new meeting state: the live text belongs to one
  // speaker's run, and arrivals to one meeting.
  const adopt = useCallback((next: HermesMeeting | null) => {
    const previous = meetingRef.current;
    if (
      previous?.currentSessionKey !== next?.currentSessionKey ||
      previous?.currentRunId !== next?.currentRunId
    )
      setLiveText("");
    if (previous?.id !== next?.id) setArrived([]);
    meetingRef.current = next;
    setMeeting(next);
  }, []);

  useEffect(() => {
    // Not on Hermes: nothing to follow (the result below reads as no meeting).
    if (!available || !control) return;
    let cancelled = false;
    control
      .call<{ meeting: HermesMeeting | null }>("org.meeting.get")
      .then((result) => {
        if (!cancelled)
          adopt(
            result.meeting && ACTIVE.has(result.meeting.status)
              ? result.meeting
              : null,
          );
      })
      .catch(() => {});
    const unsubscribe = control.onEvent((frame) => {
      if (frame.event === "org.meeting") {
        const next = (frame.payload as { meeting?: unknown } | undefined)
          ?.meeting;
        if (isMeeting(next)) adopt(next);
        return;
      }
      if (frame.event !== "chat") return;
      const payload = frame.payload as
        | {
            sessionKey?: string;
            state?: string;
            message?: { content?: unknown };
          }
        | undefined;
      if (
        !payload?.sessionKey ||
        payload.sessionKey !== meetingRef.current?.currentSessionKey
      )
        return;
      if (
        (payload.state === "delta" || payload.state === "final") &&
        typeof payload.message?.content === "string"
      ) {
        setLiveText(payload.message.content);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [adopt, available, control]);

  const startMeeting = useCallback(
    async (_trigger?: string, topic?: string) => {
      if (!control) return;
      setError(null);
      try {
        const result = await control.call<{ meeting: HermesMeeting }>(
          "org.meeting.start",
          topic ? { topic } : {},
        );
        // Events may already have moved the meeting on past this answer.
        if (meetingRef.current?.id !== result.meeting.id) adopt(result.meeting);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [adopt, control],
  );

  const reportArrivals = useCallback(
    async (arrivedAgentIds: string[]) => {
      if (!control || !meeting || meeting.status !== "gathering") return;
      const key = `${meeting.id}:${[...arrivedAgentIds].sort().join(",")}`;
      if (key === lastArrivalsRef.current) return;
      lastArrivalsRef.current = key;
      setArrived(arrivedAgentIds);
      await control
        .call("org.meeting.arrivals", { id: meeting.id, arrivedAgentIds })
        .catch(() => {});
    },
    [control, meeting],
  );

  const stopMeeting = useCallback(async () => {
    if (!control || !meeting) return;
    await control.call("org.meeting.stop", { id: meeting.id });
  }, [control, meeting]);

  const standupMeeting = useMemo(
    () =>
      available && meeting
        ? toStandupMeeting(meeting, liveText, arrived)
        : null,
    [available, meeting, liveText, arrived],
  );

  return {
    available,
    meeting: standupMeeting,
    hermesMeeting: available ? meeting : null,
    error,
    openBoardByDefault: true,
    startMeeting,
    reportArrivals,
    stopMeeting,
  };
};

export type HermesMeetingController = ReturnType<
  typeof useHermesMeetingController
>;
