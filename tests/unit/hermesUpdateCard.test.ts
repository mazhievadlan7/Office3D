import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HermesControlProvider, type HermesControl, type HermesControlEvent } from "@/features/hermes/HermesControlContext";
import { HermesUpdateCard, type HermesUpdateView } from "@/features/hermes/components/HermesUpdateCard";

const offer: HermesUpdateView = { available: true, reachable: true, current: "v2026.9.14", latest: "v2026.9.21", offer: true, job: null, running: false };

const setup = (initial: HermesUpdateView) => {
  const listeners = new Set<(event: HermesControlEvent) => void>();
  const call = vi.fn(async (method: string) => {
    if (method === "hermes.update.start") {
      return { ...offer, offer: false, running: true, job: { id: "upd_1", from: "v2026.9.14", to: "v2026.9.21", status: "running", step: "backup", error: null } };
    }
    if (method === "hermes.update.later") return { ...offer, offer: false };
    return initial;
  });
  const control: HermesControl = {
    available: true,
    call: call as HermesControl["call"],
    onEvent: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
  render(createElement(HermesControlProvider, { value: control }, createElement(HermesUpdateCard)));
  const emit = (payload: HermesUpdateView) => act(() => listeners.forEach((listener) => listener({ event: "hermes.update", payload })));
  return { call, emit };
};

describe("HermesUpdateCard", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("offers_the_update_and_shows_its_steps", async () => {
    const { call } = setup(offer);
    expect(await screen.findByText("Доступна новая версия Hermes v2026.9.21 (у вас v2026.9.14).")).toBeTruthy();
    fireEvent.click(screen.getByText("Обновить"));
    expect(await screen.findByText("Резервная копия данных агентов")).toBeTruthy();
    expect(call).toHaveBeenCalledWith("hermes.update.start", { tag: "v2026.9.21" });
  });

  it("hides_on_later", async () => {
    const { call } = setup(offer);
    fireEvent.click(await screen.findByText("Позже"));
    await act(async () => {});
    expect(call).toHaveBeenCalledWith("hermes.update.later", { tag: "v2026.9.21" });
    expect(screen.queryByTestId("hermes-update")).toBeNull();
  });

  it("reports_a_rollback_until_acknowledged", async () => {
    const { emit } = setup({ available: true, reachable: true, current: "v2026.9.14", latest: "v2026.9.14", offer: false, running: false, job: null });
    expect(screen.queryByTestId("hermes-update")).toBeNull();
    emit({
      available: true,
      reachable: true,
      current: "v2026.9.14",
      latest: "v2026.9.21",
      offer: false,
      running: false,
      job: { id: "upd_2", from: "v2026.9.14", to: "v2026.9.21", status: "rolled_back", step: "check-rollback", error: "Новая версия не прошла проверку." },
    });
    expect(await screen.findByText(/не заработала — возвращена v2026.9.14/)).toBeTruthy();
    fireEvent.click(screen.getByText("Понятно"));
    expect(screen.queryByTestId("hermes-update")).toBeNull();
  });

  it("stays_hidden_without_an_updater", async () => {
    setup({ available: false });
    await act(async () => {});
    expect(screen.queryByTestId("hermes-update")).toBeNull();
  });
});
