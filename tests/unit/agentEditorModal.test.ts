import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentEditorModal } from "@/features/agents/components/AgentEditorModal";
import { createDefaultAgentAvatarProfile } from "@/lib/avatars/profile";
import type { AgentState } from "@/features/agents/state/store";
import type { GatewayClient } from "@/lib/gateway/GatewayClient";
import { HermesControlProvider, type HermesControl } from "@/features/hermes/HermesControlContext";

vi.mock("@/features/agents/components/AgentAvatarPreview3D", () => ({
  AgentAvatarPreview3D: () => createElement("div", { "data-testid": "avatar-preview-3d" }, "preview"),
}));

vi.mock("@/features/agents/components/inspect/AgentBrainPanel", () => ({
  AgentBrainPanel: ({
    selectedAgentId,
    activeSection,
  }: {
    selectedAgentId: string | null;
    activeSection?: string;
  }) =>
    createElement(
      "div",
      { "data-testid": "brain-panel" },
      `brain:${selectedAgentId}:${activeSection ?? "all"}`,
    ),
}));

vi.mock("@/features/hermes/components/HermesAgentCapabilitiesPanel", () => ({
  HermesAgentCapabilitiesPanel: ({ agentId }: { agentId: string }) =>
    createElement("div", { "data-testid": "hermes-capabilities" }, `hermes:${agentId}`),
}));

const buildAgent = (): AgentState =>
  ({
    agentId: "agent-1",
    name: "Agent One",
    avatarProfile: createDefaultAgentAvatarProfile("seed-a"),
    avatarSeed: "seed-a",
    avatarUrl: null,
    status: "idle",
    sessionCreated: false,
    awaitingUserInput: false,
    hasUnseenActivity: false,
    outputLines: [],
    lastResult: null,
    lastDiff: null,
    runId: null,
    runStartedAt: null,
    streamText: null,
    thinkingTrace: null,
    latestOverride: null,
    latestOverrideKind: null,
    lastAssistantMessageAt: null,
    lastActivityAt: null,
    latestPreview: null,
    lastUserMessage: null,
    draft: "",
    queuedMessages: [],
    sessionSettingsSynced: false,
    historyLoadedAt: null,
    historyFetchLimit: null,
    historyFetchedCount: null,
    historyMaybeTruncated: false,
    toolCallingEnabled: true,
    showThinkingTraces: false,
    sessionKey: "session-1",
    model: undefined,
    thinkingLevel: undefined,
  }) as AgentState;

describe("AgentEditorModal", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("saves avatar changes from the avatar section", async () => {
    const agent = buildAgent();
    const onAvatarSave = vi.fn(async () => {});
    const initialBackpack = agent.avatarProfile?.accessories.backpack;

    render(
      createElement(AgentEditorModal, {
        open: true,
        client: {} as GatewayClient,
        agents: [agent],
        agent,
        onClose: () => {},
        onAvatarSave,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Рюкзак" }));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить аватар" }));

    expect(onAvatarSave).toHaveBeenCalledTimes(1);
    expect(onAvatarSave).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        seed: "seed-a",
        accessories: expect.objectContaining({ backpack: !initialBackpack }),
      }),
    );
  });

  it("switches to another file section", () => {
    const agent = buildAgent();

    render(
      createElement(AgentEditorModal, {
        open: true,
        client: {} as GatewayClient,
        agents: [agent],
        agent,
        onClose: () => {},
        onAvatarSave: () => {},
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /Инструменты/i }));

    expect(screen.getByTestId("brain-panel")).toHaveTextContent("brain:agent-1:TOOLS.md");
  });

  it("honors the initial file section", () => {
    const agent = buildAgent();

    render(
      createElement(AgentEditorModal, {
        open: true,
        client: {} as GatewayClient,
        agents: [agent],
        agent,
        initialSection: "MEMORY.md",
        onClose: () => {},
        onAvatarSave: () => {},
      }),
    );

    expect(screen.getByTestId("brain-panel")).toHaveTextContent("brain:agent-1:MEMORY.md");
  });

  it("offers_hermes_capabilities_only_while_connected_to_hermes", () => {
    const agent = buildAgent();
    const modal = createElement(AgentEditorModal, {
      open: true,
      client: {} as GatewayClient,
      agents: [agent],
      agent,
      initialSection: "hermes",
      onClose: () => {},
      onAvatarSave: () => {},
    });
    const control = (available: boolean): HermesControl => ({ available, call: vi.fn() as HermesControl["call"], onEvent: () => () => {} });

    render(createElement(HermesControlProvider, { value: control(true) }, modal));
    expect(screen.getByTestId("hermes-capabilities")).toHaveTextContent("hermes:agent-1");
    cleanup();

    // Another backend: no Hermes section, and a stale choice falls back to the avatar.
    render(createElement(HermesControlProvider, { value: control(false) }, modal));
    expect(screen.queryByRole("button", { name: /Возможности Hermes/ })).toBeNull();
    expect(screen.queryByTestId("hermes-capabilities")).toBeNull();
    expect(screen.getByRole("button", { name: "Сохранить аватар" })).toBeTruthy();
  });
});
