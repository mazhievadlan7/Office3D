import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsPanel, type SettingsPanelProps } from "@/features/office/components/panels/SettingsPanel";
import { hqOptionClass } from "@/features/agents/components/hqFormClasses";

const baseProps = (overrides: Partial<SettingsPanelProps> = {}): SettingsPanelProps => ({
  gatewayStatus: "disconnected",
  gatewayUrl: "ws://localhost:18789",
  gatewayToken: "",
  selectedAdapterType: "demo",
  activeAdapterType: "demo",
  officeTitle: "",
  officeTitleLoaded: true,
  onOfficeTitleChange: vi.fn(),
  remoteOfficeEnabled: false,
  remoteOfficeSourceKind: "presence_endpoint",
  remoteOfficeLabel: "",
  remoteOfficePresenceUrl: "",
  remoteOfficeGatewayUrl: "",
  remoteOfficeTokenConfigured: false,
  onRemoteOfficeEnabledChange: vi.fn(),
  onRemoteOfficeSourceKindChange: vi.fn(),
  onRemoteOfficeLabelChange: vi.fn(),
  onRemoteOfficePresenceUrlChange: vi.fn(),
  onRemoteOfficeGatewayUrlChange: vi.fn(),
  onRemoteOfficeTokenChange: vi.fn(),
  voiceRepliesEnabled: false,
  voiceRepliesVoiceId: null,
  voiceRepliesSpeed: 1,
  voiceRepliesLoaded: true,
  onVoiceRepliesToggle: vi.fn(),
  onVoiceRepliesVoiceChange: vi.fn(),
  onVoiceRepliesSpeedChange: vi.fn(),
  onVoiceRepliesPreview: vi.fn(),
  ...overrides,
});

describe("SettingsPanel controls", () => {
  afterEach(() => cleanup());

  it("switches report their state and flip it on click", () => {
    const onVoiceRepliesToggle = vi.fn();
    const onRemoteOfficeEnabledChange = vi.fn();
    render(
      createElement(SettingsPanel, baseProps({ voiceRepliesEnabled: true, onVoiceRepliesToggle, onRemoteOfficeEnabledChange })),
    );

    const voice = screen.getByRole("switch", { name: "Голосовые ответы" });
    expect(voice).toHaveAttribute("aria-checked", "true");
    fireEvent.click(voice);
    expect(onVoiceRepliesToggle).toHaveBeenCalledWith(false);

    const remote = screen.getByRole("switch", { name: "Удалённый офис" });
    expect(remote).toHaveAttribute("aria-checked", "false");
    fireEvent.click(remote);
    expect(onRemoteOfficeEnabledChange).toHaveBeenCalledWith(true);
  });

  it("voice replies switch waits for the saved settings", () => {
    render(createElement(SettingsPanel, baseProps({ voiceRepliesLoaded: false })));
    expect(screen.getByRole("switch", { name: "Голосовые ответы" })).toBeDisabled();
  });

  it("marks the chosen backend and reports a new choice", () => {
    const onGatewayAdapterTypeChange = vi.fn();
    render(createElement(SettingsPanel, baseProps({ selectedAdapterType: "hermes", onGatewayAdapterTypeChange })));

    expect(screen.getByRole("button", { name: "Hermes" })).toHaveAttribute("aria-pressed", "true");
    const openclaw = screen.getByRole("button", { name: "OpenClaw" });
    expect(openclaw).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(openclaw);
    expect(onGatewayAdapterTypeChange).toHaveBeenCalledWith("openclaw");
  });

  it("connect waits for an address; disconnect for a connection", () => {
    const { rerender } = render(createElement(SettingsPanel, baseProps({ gatewayUrl: "  " })));
    expect(screen.getByRole("button", { name: "Подключиться" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Отключить шлюз" })).toBeDisabled();

    rerender(createElement(SettingsPanel, baseProps({ gatewayStatus: "connected" })));
    expect(screen.getByRole("button", { name: "Подключиться" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Отключить шлюз" })).toBeEnabled();
  });
});

describe("hqOptionClass", () => {
  it("lights only the chosen option", () => {
    expect(hqOptionClass(true)).toContain("bg-primary/20");
    expect(hqOptionClass(false)).not.toContain("bg-primary/20");
    expect(hqOptionClass(false)).toContain("hover:border-ring/50");
  });
});
