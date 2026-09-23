import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { toStandupMeeting, type HermesMeeting } from "@/features/hermes/useHermesMeetingController";
import { StandupImmersiveScreen } from "@/features/office/screens/StandupImmersiveScreen";

const meeting = (patch: Partial<HermesMeeting> = {}): HermesMeeting => ({
  id: "mtg_1",
  topic: "Меню на осень",
  status: "speaking",
  requestedBy: "person",
  hostAgentId: "main",
  participants: [
    { agentId: "main", name: "Hermes" },
    { agentId: "barista-1", name: "Бариста" },
  ],
  rounds: 1,
  round: 1,
  currentSpeaker: "barista-1",
  currentSessionKey: "agent:barista-1:meeting-mtg_1",
  currentRunId: "run-2",
  transcript: [
    { agentId: "main", name: "Hermes", kind: "opening", round: 1, text: "Обсудим меню.", status: "done" },
    { agentId: "barista-1", name: "Бариста", kind: "turn", round: 1, text: "", status: "speaking" },
  ],
  summary: null,
  startedAt: "2026-09-23T10:00:00.000Z",
  endedAt: null,
  error: null,
  ...patch,
});

describe("live meeting view", () => {
  afterEach(() => cleanup());

  it("maps_a_hermes_meeting_onto_the_meeting_room", () => {
    const view = toStandupMeeting(meeting(), "Предлагаю тыквенный латте", ["main"]);
    expect(view).toMatchObject({
      kind: "live",
      phase: "in_progress",
      topic: "Меню на осень",
      currentSpeakerAgentId: "barista-1",
      participantOrder: ["main", "barista-1"],
      arrivedAgentIds: ["main"],
    });
    expect(view.cards[1]).toMatchObject({ agentName: "Бариста", speech: "Предлагаю тыквенный латте", manualNotes: [] });
    expect(view.cards[0]).toMatchObject({ speech: "Обсудим меню.", manualNotes: ["Обсудим меню."] });

    const gathering = toStandupMeeting(meeting({ status: "gathering", currentSpeaker: null }), "", []);
    expect(gathering.phase).toBe("gathering");
    const done = toStandupMeeting(meeting({ status: "done", summary: "Решили: латте.", currentSpeaker: null }), "", []);
    expect(done.phase).toBe("complete");
    expect(done.cards[0].speech).toBe("Решили: латте.");
  });

  it("shows_the_topic_live_speech_summary_and_a_stop_button", () => {
    const onStop = vi.fn();
    const view = toStandupMeeting(meeting({ summary: null }), "Предлагаю тыквенный латте", ["main", "barista-1"]);
    render(createElement(StandupImmersiveScreen, { meeting: view, onClose: () => {}, onStop }));
    expect(screen.getByText("Тема: Меню на осень")).toBeTruthy();
    expect(screen.getByText("Говорит: Бариста")).toBeTruthy();
    expect(screen.getByText("Предлагаю тыквенный латте")).toBeTruthy();
    expect(screen.queryByText("Последние коммиты")).toBeNull();
    fireEvent.click(screen.getByText("Остановить"));
    expect(onStop).toHaveBeenCalled();
    cleanup();

    const done = toStandupMeeting(meeting({ status: "done", summary: "Решили: латте.", currentSpeaker: null }), "", []);
    render(createElement(StandupImmersiveScreen, { meeting: done, onClose: () => {}, onStop }));
    expect(screen.getByText("Итог ведущего")).toBeTruthy();
    expect(screen.queryByText("Остановить")).toBeNull();
  });
});
