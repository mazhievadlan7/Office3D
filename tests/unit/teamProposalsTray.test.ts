import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HermesControlProvider, type HermesControl, type HermesControlEvent } from "@/features/hermes/HermesControlContext";
import { TeamProposalsTray, mergeProposal, type TeamProposal } from "@/features/hermes/components/TeamProposalsTray";

const proposal = (patch: Partial<TeamProposal> = {}): TeamProposal => ({
  id: "prop_1",
  kind: "hire",
  status: "pending",
  reason: "Некому вести соцсети.",
  createdAt: "2026-09-23T10:00:00.000Z",
  decidedAt: null,
  note: null,
  error: null,
  name: "Маркетолог",
  role: "продвижение",
  instructions: null,
  agentId: null,
  ...patch,
});

const setup = (initial: TeamProposal[], decide: (params: Record<string, unknown>) => TeamProposal) => {
  const listeners = new Set<(event: HermesControlEvent) => void>();
  const call = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === "org.proposals.list") return { proposals: initial };
    if (method === "org.proposals.decide") return { proposal: decide(params) };
    throw new Error(`unexpected ${method}`);
  });
  const control: HermesControl = {
    available: true,
    call: call as HermesControl["call"],
    onEvent: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
  const onTeamChanged = vi.fn();
  render(createElement(HermesControlProvider, { value: control }, createElement(TeamProposalsTray, { onTeamChanged })));
  const emit = (event: HermesControlEvent) => act(() => listeners.forEach((listener) => listener(event)));
  return { call, onTeamChanged, emit };
};

describe("TeamProposalsTray", () => {
  afterEach(() => cleanup());

  it("shows_a_pending_proposal_and_approves_it_with_a_note", async () => {
    const { call, onTeamChanged } = setup([proposal()], (params) =>
      proposal({ status: "done", agentId: "marketolog-1a2b3c", note: String(params.note) }),
    );
    expect(await screen.findByText("Маркетолог")).toBeTruthy();
    expect(screen.getByText("Некому вести соцсети.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Комментарий для главного агента (необязательно)"), { target: { value: "Бери" } });
    fireEvent.click(screen.getByText("Одобрить"));
    await waitFor(() => expect(screen.getByText("«Маркетолог» нанят и уже в команде.")).toBeTruthy());
    expect(call).toHaveBeenCalledWith("org.proposals.decide", { id: "prop_1", approve: true, note: "Бери" });
    expect(onTeamChanged).toHaveBeenCalled();
    expect(screen.queryByText("Одобрить")).toBeNull();
  });

  it("adds_proposals_that_arrive_while_open_and_drops_decided_ones", async () => {
    const { emit } = setup([], () => proposal());
    expect(screen.queryByTestId("team-proposals")).toBeNull();
    emit({ event: "org.proposal", payload: { proposal: proposal({ id: "prop_2", kind: "dismiss", name: "Курьер" }) } });
    expect(await screen.findByText("Главный агент предлагает уволить")).toBeTruthy();
    emit({ event: "org.proposal", payload: { proposal: proposal({ id: "prop_2", kind: "dismiss", status: "rejected" }) } });
    await waitFor(() => expect(screen.queryByTestId("team-proposals")).toBeNull());
  });

  it("keeps_only_open_proposals", () => {
    const open = [proposal({ id: "a" }), proposal({ id: "b" })];
    expect(mergeProposal(open, proposal({ id: "a", status: "executing" })).map((p) => p.id)).toEqual(["b", "a"]);
    expect(mergeProposal(open, proposal({ id: "a", status: "done" })).map((p) => p.id)).toEqual(["b"]);
  });
});
