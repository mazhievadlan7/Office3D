import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HermesControl, HermesControlEvent } from "@/features/hermes/HermesControlContext";
import { SystemHealthSection } from "@/features/hermes/components/SystemHealthSection";

describe("SystemHealthSection", () => {
  afterEach(() => cleanup());

  it("shows_the_checks_follows_changes_and_sends_a_test_alert", async () => {
    let listener: ((event: HermesControlEvent) => void) | null = null;
    const call = vi.fn(async (method: string) => {
      if (method === "system.health") {
        return {
          checkedAt: "2026-09-24T10:00:00Z",
          ok: true,
          checks: [{ id: "hermes", label: "Hermes", status: "ok", detail: "версия 0.21.4", since: null }],
          channels: ["ntfy"],
          heartbeat: false,
          configProblems: [],
        };
      }
      return { sent: ["ntfy"], failed: [], channels: ["ntfy"] };
    });
    const control: HermesControl = {
      available: true,
      call: call as HermesControl["call"],
      onEvent: (handler) => {
        listener = handler;
        return () => {};
      },
    };
    render(createElement(SystemHealthSection, { control }));
    expect(await screen.findByText("версия 0.21.4")).toBeTruthy();
    expect(screen.getByText(/Оповещения приходят: ntfy/)).toBeTruthy();
    expect(screen.getByText(/Внешний сторож не настроен/)).toBeTruthy();

    act(() =>
      listener!({
        event: "system.health",
        payload: { checkedAt: "x", ok: false, checks: [{ id: "hermes", label: "Hermes", status: "problem", detail: "connection refused", since: "x" }], channels: ["ntfy"], heartbeat: true, configProblems: [] },
      }),
    );
    expect(screen.getByText("проблема")).toBeTruthy();
    expect(screen.getByText("connection refused")).toBeTruthy();

    fireEvent.click(screen.getByText("Отправить тестовое оповещение"));
    await waitFor(() => expect(call).toHaveBeenCalledWith("system.testAlert"));
    expect(await screen.findByText("Тестовое оповещение отправлено: ntfy.")).toBeTruthy();
  });
});
