import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CallFeedPanel } from "@/features/office/components/panels/CallFeedPanel";
import type { CallFeed } from "@/features/office/hooks/useOfficeCallFeed";
import type { CallRecord, CallStatus } from "@/lib/telephony/types";

const AGENTS = [
  { agentId: "agent-1", name: "Nova", role: "Chases invoices" },
  { agentId: "agent-2", name: "Atlas", role: "Books meetings" },
];

const call = (overrides: Partial<CallRecord> = {}): CallRecord => ({
  sid: "conv_1",
  direction: "outbound",
  status: "in-progress" as CallStatus,
  to: "+447700900123",
  from: null,
  agentId: "agent-1",
  startedAt: "2026-09-22T10:00:00.000Z",
  endedAt: null,
  errorMessage: null,
  transcript: [],
  providerTurnCount: 0,
  pendingSay: null,
  ...overrides,
});

const feed = (overrides: Partial<CallFeed> = {}): CallFeed => ({
  ready: true,
  voiceAgent: { provider: "elevenlabs", configured: true, missing: [] },
  calls: [],
  syncErrors: {},
  loading: false,
  error: null,
  dialing: false,
  dialError: null,
  refresh: vi.fn().mockResolvedValue(undefined),
  placeCall: vi.fn().mockResolvedValue(null),
  ...overrides,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CallFeedPanel", () => {
  it("dials_the_typed_number_as_the_chosen_agent", async () => {
    const placeCall = vi.fn().mockResolvedValue(call());
    render(createElement(CallFeedPanel, { feed: feed({ placeCall }), agents: AGENTS }));

    fireEvent.change(screen.getByPlaceholderText("+441234567890"), {
      target: { value: " +447700900123 " },
    });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "agent-2" } });
    fireEvent.click(screen.getByRole("button", { name: /call/i }));

    await waitFor(() => {
      // One number serves the whole office, so which agent is speaking has to
      // travel with the call.
      // The name and role travel with the call: the server builds the
      // agent's phone prompt from them, so the agent says what it actually
      // does instead of a generic greeting.
      expect(placeCall).toHaveBeenCalledWith({
        toNumber: "+447700900123",
        agentId: "agent-2",
        agentName: "Atlas",
        agentRole: "Books meetings",
      });
    });
  });

  it("will_not_dial_before_the_deployment_is_configured", () => {
    const placeCall = vi.fn();
    render(
      createElement(CallFeedPanel, {
        feed: feed({
          ready: false,
          placeCall,
          voiceAgent: {
            provider: "elevenlabs",
            configured: false,
            missing: ["ELEVENLABS_AGENT_ID"],
          },
        }),
        agents: AGENTS,
      }),
    );

    // Naming the variable beats a bare "not configured": it says where to look.
    expect(screen.getByText("ELEVENLABS_AGENT_ID")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /call/i }));
    expect(placeCall).not.toHaveBeenCalled();
  });

  it("shows_the_conversation_as_it_arrives", () => {
    render(
      createElement(CallFeedPanel, {
        feed: feed({
          calls: [
            call({
              transcript: [
                {
                  id: "t1",
                  speaker: "agent",
                  text: "Good morning, calling about the invoice.",
                  at: "2026-09-22T10:00:05.000Z",
                  confidence: null,
                },
                {
                  id: "t2",
                  speaker: "callee",
                  text: "Go ahead.",
                  at: "2026-09-22T10:00:09.000Z",
                  confidence: 0.94,
                },
              ],
            }),
          ],
        }),
        agents: AGENTS,
      }),
    );

    expect(screen.getByText("Good morning, calling about the invoice.")).toBeTruthy();
    expect(screen.getByText("Go ahead.")).toBeTruthy();
    expect(screen.getAllByText("On the line").length).toBeGreaterThan(0);
  });

  it("says_when_a_call_stopped_updating_rather_than_showing_it_as_live", () => {
    render(
      createElement(CallFeedPanel, {
        feed: feed({
          calls: [call()],
          syncErrors: { conv_1: "ElevenLabs: Not found" },
        }),
        agents: AGENTS,
      }),
    );

    // A transcript that has silently stopped moving looks identical to a quiet
    // call; the operator has to be told the difference.
    expect(screen.getByText(/Not updating: ElevenLabs: Not found/)).toBeTruthy();
  });

  it("reports_why_a_failed_call_failed", () => {
    render(
      createElement(CallFeedPanel, {
        feed: feed({
          calls: [
            call({
              status: "failed",
              endedAt: "2026-09-22T10:00:20.000Z",
              errorMessage: "The number was unreachable.",
            }),
          ],
        }),
        agents: AGENTS,
      }),
    );

    expect(screen.getByText("The number was unreachable.")).toBeTruthy();
    expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
  });

  it("survives_an_office_with_no_agents_yet", () => {
    render(createElement(CallFeedPanel, { feed: feed(), agents: [] }));
    expect(screen.getByText("No agents available")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /call/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
