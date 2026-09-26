import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GatewayConnectScreen } from "@/features/agents/components/GatewayConnectScreen";

const renderScreen = (overrides: Partial<Parameters<typeof GatewayConnectScreen>[0]> = {}) =>
  render(
    createElement(GatewayConnectScreen, {
      gatewayUrl: "ws://localhost:18789",
      token: "",
      selectedAdapterType: "demo",
      activeAdapterType: "demo",
      localGatewayDefaults: null,
      status: "disconnected",
      error: null,
      showApprovalHint: false,
      onGatewayUrlChange: vi.fn(),
      onTokenChange: vi.fn(),
      onAdapterTypeChange: vi.fn(),
      onUseLocalDefaults: vi.fn(),
      onConnect: vi.fn(),
      ...overrides,
    }),
  );

describe("GatewayConnectScreen backends", () => {
  afterEach(() => cleanup());

  it("marks the chosen backend and switches on click", () => {
    const onAdapterTypeChange = vi.fn();
    renderScreen({ selectedAdapterType: "hermes", onAdapterTypeChange });

    const group = screen.getByRole("group", { name: "Выберите бэкенд и подключитесь к адресу его шлюза." });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Бэкенд Hermes" })).toHaveAttribute("aria-pressed", "true");
    const demo = screen.getByRole("button", { name: "Демо-бэкенд" });
    expect(demo).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(demo);
    expect(onAdapterTypeChange).toHaveBeenCalledWith("demo");
  });

  it("says no local gateway was found and connects on request", () => {
    const onConnect = vi.fn();
    renderScreen({ onConnect });

    expect(screen.getByText("Локальный шлюз не найден.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Подключиться" }));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("does not connect without an address", () => {
    renderScreen({ gatewayUrl: " " });
    expect(screen.getByRole("button", { name: "Подключиться" })).toBeDisabled();
  });
});
