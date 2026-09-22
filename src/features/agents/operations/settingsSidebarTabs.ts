import type { SettingsRouteTab } from "@/features/agents/operations/settingsRouteWorkflow";
import { t } from "@/lib/i18n";

export type SettingsSidebarEntry = {
  id: SettingsRouteTab;
  label: string;
};

const BASE_SETTINGS_SIDEBAR_ENTRIES: readonly SettingsSidebarEntry[] = [
  { id: "personality", label: t("opsSettings.tabBehavior") },
  { id: "capabilities", label: t("opsSettings.tabCapabilities") },
  { id: "skills", label: t("opsSettings.tabSkills") },
  { id: "system", label: t("opsSettings.tabSystem") },
  { id: "automations", label: t("opsSettings.tabAutomations") },
  { id: "advanced", label: t("opsSettings.tabAdvanced") },
];

export const resolveSettingsSidebarEntries = (runtimeSupportsCron: boolean) =>
  BASE_SETTINGS_SIDEBAR_ENTRIES.filter(
    (entry) => runtimeSupportsCron || entry.id !== "automations"
  );
