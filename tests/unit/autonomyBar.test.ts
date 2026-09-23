import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HermesControlProvider, type HermesControl } from "@/features/hermes/HermesControlContext";
import { AutonomyBar, type AutonomyStatus } from "@/features/hermes/components/AutonomyBar";

const baseStatus = (patch: Partial<AutonomyStatus> = {}, settings: Partial<AutonomyStatus["settings"]> = {}): AutonomyStatus => ({
  settings: {
    mode: "scheduled",
    intervalMinutes: 120,
    activeFrom: null,
    activeTo: null,
    dailyBudgetUsd: 5,
    pauseBoardOnBudget: true,
    paused: false,
    timeZone: "Europe/Moscow",
    ...settings,
  },
  spentTodayUsd: 1.25,
  spendError: null,
  budgetExceeded: false,
  boardPaused: false,
  withinActiveHours: true,
  lastReviewAt: null,
  lastReviewReason: null,
  nextReviewAt: null,
  reviewRunning: false,
  ...patch,
});

const setup = (initial: AutonomyStatus) => {
  let current = initial;
  const call = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === "org.autonomy.pause") current = baseStatus({}, { ...current.settings, paused: Boolean(params.paused) });
    if (method === "org.autonomy.set") current = baseStatus({}, { ...current.settings, ...(params.settings as object) });
    return current;
  });
  const control: HermesControl = { available: true, call: call as HermesControl["call"], onEvent: () => () => {} };
  render(createElement(HermesControlProvider, { value: control }, createElement(AutonomyBar)));
  return { call };
};

describe("AutonomyBar", () => {
  afterEach(() => cleanup());

  it("shows_mode_and_spending_and_pauses", async () => {
    const { call } = setup(baseStatus());
    expect(await screen.findByText("по расписанию, каждые 120 мин")).toBeTruthy();
    expect(screen.getByText("Сегодня потрачено $1.25 из $5.00")).toBeTruthy();
    fireEvent.click(screen.getByText("Пауза"));
    await waitFor(() => expect(screen.getByText("На паузе: обзоры и доска остановлены")).toBeTruthy());
    expect(call).toHaveBeenCalledWith("org.autonomy.pause", { paused: true });
    expect(screen.getByText("Продолжить")).toBeTruthy();
  });

  it("warns_when_the_budget_is_spent", async () => {
    setup(baseStatus({ budgetExceeded: true, boardPaused: true, spentTodayUsd: 5.5 }));
    expect(await screen.findByText("Бюджет исчерпан — доска на паузе до завтра")).toBeTruthy();
  });

  it("saves_settings_without_touching_the_pause", async () => {
    const { call } = setup(baseStatus({}, { mode: "off" }));
    fireEvent.click(await screen.findByText("Настроить"));
    fireEvent.change(screen.getByLabelText("Режим"), { target: { value: "continuous" } });
    fireEvent.change(screen.getByLabelText("Дневной бюджет, $ (0 — без лимита)"), { target: { value: "3" } });
    fireEvent.click(screen.getByText("Сохранить"));
    await waitFor(() => expect(screen.getByText("Настройки автономии сохранены.")).toBeTruthy());
    const [, params] = call.mock.calls.find(([method]) => method === "org.autonomy.set")!;
    expect(params).toMatchObject({ settings: { mode: "continuous", dailyBudgetUsd: 3 } });
    expect((params as { settings: Record<string, unknown> }).settings).not.toHaveProperty("paused");
    expect(screen.getByText("непрерывно")).toBeTruthy();
  });
});
