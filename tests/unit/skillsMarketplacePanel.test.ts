import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SkillsMarketplacePanel } from "@/features/office/components/panels/SkillsMarketplacePanel";
import type { OfficeSkillsMarketplaceController } from "@/features/office/hooks/useOfficeSkillsMarketplace";
import { appendPackagedSkillsToMarketplace, listPackagedSkills } from "@/lib/skills/catalog";

// Only the packaged Office3D skills: they need no gateway to be listed, which
// is exactly what a freshly connected office shows.
const controller = (
  overrides: Partial<OfficeSkillsMarketplaceController> = {},
): OfficeSkillsMarketplaceController =>
  ({
    agents: [{ agentId: "main", name: "AM7" }],
    selectedAgent: { agentId: "main", name: "AM7" },
    selectedAgentId: "main",
    setSelectedAgentId: vi.fn(),
    skillsReport: null,
    marketplaceSkills: appendPackagedSkillsToMarketplace([]),
    packagedSkillsByKey: new Map(listPackagedSkills().map((skill) => [skill.skillKey, skill])),
    skillsAllowlist: undefined,
    loading: false,
    error: null,
    busySkillKey: null,
    message: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    handleSetSkillEnabled: vi.fn().mockResolvedValue(undefined),
    handleInstallSkill: vi.fn().mockResolvedValue(undefined),
    handleInstallPackagedSkill: vi.fn().mockResolvedValue(undefined),
    handleInstallPackagedSkillAndEnable: vi.fn().mockResolvedValue(undefined),
    handleSetSkillGlobalEnabled: vi.fn().mockResolvedValue(undefined),
    handleRemoveSkill: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }) as unknown as OfficeSkillsMarketplaceController;

const renderPanel = (marketplace: OfficeSkillsMarketplaceController) =>
  render(
    createElement(SkillsMarketplacePanel, {
      marketplace,
      onSelectAgent: vi.fn(),
      onOpenAgentSettings: vi.fn(),
    }),
  );

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SkillsMarketplacePanel", () => {
  it("opens_on_the_office3d_tab_and_installs_a_packaged_skill", () => {
    const marketplace = controller();
    renderPanel(marketplace);

    const office3dTab = screen.getByRole("button", { name: /^Office3D/ });
    expect(office3dTab.getAttribute("aria-pressed")).toBe("true");

    const installButtons = screen.getAllByRole("button", { name: /установить навык/i });
    expect(installButtons).toHaveLength(listPackagedSkills().length);
    fireEvent.click(installButtons[0]);
    expect(marketplace.handleInstallPackagedSkill).toHaveBeenCalledWith(
      listPackagedSkills()[0].skillKey,
    );
  });

  it("switches_tabs_and_marks_only_the_active_one_pressed", () => {
    renderPanel(controller());

    fireEvent.click(screen.getByRole("button", { name: /^Все/ }));

    expect(screen.getByRole("button", { name: /^Все/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /^Office3D/ }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    // The "all" tab leads with the featured shelf.
    expect(screen.getByText("Избранная полка")).toBeTruthy();
  });

  it("shows_a_success_message_with_the_find_it_hint", () => {
    renderPanel(
      controller({ message: { kind: "success", text: "Навык todo установлен." } }),
    );

    expect(screen.getByRole("status").textContent).toContain("Навык todo установлен.");
    expect(screen.getByText(/вкладке Office3D ниже/)).toBeTruthy();
  });
});
