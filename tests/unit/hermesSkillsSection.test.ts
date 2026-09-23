import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HermesControlProvider, type HermesControl } from "@/features/hermes/HermesControlContext";
import { HermesSkillsSection } from "@/features/hermes/components/HermesSkillsSection";

const setup = (policy: "allow" | "ask" | "block") => {
  const call = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    switch (method) {
      case "hermes.skills.list":
        return { skills: [{ name: "search", description: "Поиск", category: null, enabled: true, provenance: "bundled" }] };
      case "hermes.skills.toggle":
        return { ok: true };
      case "hermes.skills.catalog":
        return { skills: [{ identifier: "official/research/arxiv", name: "arxiv", description: "Статьи", installed: false }] };
      case "hermes.skills.scan":
        return { identifier: params.identifier, policy, verdict: "x", summary: "итог проверки", policyReason: "опасно", trustLevel: "community", findings: ["сетевой доступ"] };
      case "hermes.skills.install":
        return { ok: true, actions: [{ profile: "default", action: "skills-install-arxiv-1" }] };
      case "hermes.skills.action":
        return { running: false, exitCode: 0, lines: [] };
      default:
        throw new Error(method);
    }
  });
  const control: HermesControl = { available: true, call: call as HermesControl["call"], onEvent: () => () => {} };
  render(createElement(HermesControlProvider, { value: control }, createElement(HermesSkillsSection, { agentId: "main" })));
  return { call };
};

describe("HermesSkillsSection", () => {
  afterEach(() => cleanup());

  it("toggles_a_skill_and_installs_one_after_a_clean_scan", async () => {
    const { call } = setup("allow");
    fireEvent.click(await screen.findByLabelText("Навык search включён"));
    await waitFor(() => expect(call).toHaveBeenCalledWith("hermes.skills.toggle", { agentId: "main", name: "search", enabled: false }));
    fireEvent.click(screen.getByText("Каталог"));
    fireEvent.click(await screen.findByText("Установить"));
    expect(await screen.findByText("Проверка безопасности пройдена.")).toBeTruthy();
    fireEvent.click(screen.getByText("Установить всей команде"));
    fireEvent.click(screen.getAllByText("Установить").at(-1)!);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("hermes.skills.install", { agentId: "all", identifier: "official/research/arxiv", confirmRisk: false }),
    );
    expect(await screen.findByText("Навык установлен.", {}, { timeout: 4000 })).toBeTruthy();
  });

  it("asks_for_confirmation_on_a_risky_skill_and_refuses_a_blocked_one", async () => {
    const risky = setup("ask");
    fireEvent.click(await screen.findByText("Каталог"));
    fireEvent.click(await screen.findByText("Установить"));
    expect(await screen.findByText(/просит внимания/)).toBeTruthy();
    expect(screen.getByText("сетевой доступ")).toBeTruthy();
    fireEvent.click(screen.getByText("Установить, я проверил"));
    await waitFor(() => expect(risky.call).toHaveBeenCalledWith("hermes.skills.install", expect.objectContaining({ confirmRisk: true })));
    cleanup();

    setup("block");
    fireEvent.click(await screen.findByText("Каталог"));
    fireEvent.click(await screen.findByText("Установить"));
    expect(await screen.findByText("Hermes запретил установку: опасно")).toBeTruthy();
    expect(screen.queryByText("Установить, я проверил")).toBeNull();
  });
});
