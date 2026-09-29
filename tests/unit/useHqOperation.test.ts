import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentState } from "@/features/agents/state/store";
import { useHqOperation, type UseHqOperationArgs } from "@/features/office/hooks/useHqOperation";

const T0 = Date.UTC(2026, 8, 29, 12, 0, 0);

// The hook reads only these fields of an agent.
const agent = (agentId: string, status: AgentState["status"], runStartedAt: number | null = null): AgentState =>
  ({ agentId, name: agentId, status, runStartedAt, transcriptEntries: [] }) as unknown as AgentState;

describe("useHqOperation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const briefing = { id: "briefing-1", task: "Проверить стенд", reply: "", at: T0 - 50 };

  it("does not count a crew error or run that was already there before the command", () => {
    const initial: UseHqOperationArgs = {
      agents: [agent("am7", "idle"), agent("stale-error", "error"), agent("busy", "running", T0 - 60_000), agent("fresh", "idle")],
      runLog: [],
      briefing,
      leadAgentId: "am7",
    };
    const { result, rerender } = renderHook((args: UseHqOperationArgs) => useHqOperation(args), { initialProps: initial });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current?.team).toEqual({ addressed: 3, started: 0, replied: 0, errors: 0 });

    // Real transitions after the command do count: a new error, a run start.
    rerender({
      ...initial,
      agents: [agent("am7", "running", T0 + 10), agent("stale-error", "running", T0 + 20), agent("busy", "running", T0 - 60_000), agent("fresh", "error")],
    });
    act(() => {
      vi.advanceTimersByTime(1_100);
    });
    expect(result.current?.team.started).toBe(1);
    expect(result.current?.team.errors).toBe(1);
  });

  it("counts the first agent as started when the send marked it running before the hook saw the briefing", () => {
    // chatSendOperation sets status "running" and runStartedAt at the send,
    // which can happen before this hook's effect runs: the command time (at) is the start.
    const { result } = renderHook(() =>
      useHqOperation({
        agents: [agent("am7", "idle"), agent("first", "running", T0 - 10)],
        runLog: [],
        briefing,
        leadAgentId: "am7",
      }),
    );
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current?.team.started).toBe(1);
    expect(result.current?.startedAt).toBe(briefing.at);
  });
});
