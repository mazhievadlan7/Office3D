import {
  buildSkillMissingDetails,
  canRemoveSkill,
  deriveSkillReadinessState,
  groupSkillsBySource,
  hasInstallableMissingBinary,
  type SkillReadinessState,
} from "@/lib/skills/presentation";
import { getPackagedSkillBySkillKey } from "@/lib/skills/catalog";
import type { SkillStatusEntry } from "@/lib/skills/types";
import { t } from "@/lib/i18n";

export type SkillMarketplaceCollectionId =
  | "office3d"
  | "featured"
  | "installed"
  | "setup-required"
  | "built-in"
  | "workspace"
  | "extra"
  | "other";

export type SkillMarketplaceMetadata = {
  category: string;
  tagline: string;
  trustLabel: string;
  capabilities: string[];
  featured?: boolean;
  editorBadge?: string;
  rating?: number;
  installs?: number;
  poweredByName?: string;
  poweredByUrl?: string;
  hideStats?: boolean;
};

export type SkillMarketplaceEntry = {
  skill: SkillStatusEntry;
  readiness: SkillReadinessState;
  metadata: SkillMarketplaceMetadata;
  installable: boolean;
  removable: boolean;
  missingDetails: string[];
};

const SKILL_MARKETPLACE_OVERRIDES: Record<
  string,
  Partial<SkillMarketplaceMetadata>
> = {
  github: {
    category: t("skillMeta.catEngineering"),
    tagline: t("skillMeta.githubTagline"),
    capabilities: [
      t("skillMeta.capPrSupport"),
      t("skillMeta.capIssueContext"),
      t("skillMeta.capRepoOps"),
    ],
    featured: true,
    editorBadge: t("skillMeta.badgePopular"),
  },
  figma: {
    category: t("skillMeta.catDesign"),
    tagline: t("skillMeta.figmaTagline"),
    capabilities: [t("skillMeta.capDesignContext"), t("skillMeta.capAssetLookup"), t("skillMeta.capSpecHandoff")],
    featured: true,
    editorBadge: t("skillMeta.badgeEditorPick"),
  },
  slack: {
    category: t("skillMeta.catCommunication"),
    tagline: t("skillMeta.slackTagline"),
    capabilities: [
      t("skillMeta.capChannelUpdates"),
      t("skillMeta.capMessageDrafting"),
      t("skillMeta.capNotificationRouting"),
    ],
    featured: true,
  },
  linear: {
    category: t("skillMeta.catPlanning"),
    tagline:
      t("skillMeta.linearTagline"),
    capabilities: [t("skillMeta.capIssueLookup"), t("skillMeta.capStatusUpdates"), t("skillMeta.capPlanningWorkflows")],
    featured: true,
  },
  "todo-board": {
    category: t("skillMeta.catProductivity"),
    tagline:
      t("skillMeta.todoTagline"),
    capabilities: [
      t("skillMeta.capTaskCapture"),
      t("skillMeta.capBlockedTracking"),
      t("skillMeta.capSharedState"),
    ],
    featured: true,
    editorBadge: t("skillMeta.badgeOfficeTest"),
    hideStats: true,
  },
  "task-manager": {
    category: t("skillMeta.catProductivity"),
    tagline:
      t("skillMeta.taskManagerTagline"),
    capabilities: [
      t("skillMeta.capAutoCapture"),
      t("skillMeta.capLifecycle"),
      t("skillMeta.capSharedKanban"),
    ],
    featured: true,
    editorBadge: t("skillMeta.badgeKanbanCore"),
    hideStats: true,
  },
  soundclaw: {
    category: t("skillMeta.catAudio"),
    tagline:
      t("skillMeta.spotifyTagline"),
    capabilities: [t("skillMeta.capSpotifySearch"), t("skillMeta.capPlayback"), t("skillMeta.capLinkSharing")],
    featured: true,
    editorBadge: t("skillMeta.badgeOfficeDemo"),
    hideStats: true,
  },
};

const titleCaseWords = (value: string): string =>
  value
    .split(/[\s_-]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");

const buildFallbackCapabilities = (skill: SkillStatusEntry): string[] => {
  const capabilities: string[] = [];
  if (skill.primaryEnv) {
    capabilities.push(t("skillMeta.usesEnv", { env: skill.primaryEnv }));
  }
  if (skill.install.length > 0) {
    capabilities.push(t("skillMeta.guidedInstall"));
  }
  if (skill.always) {
    capabilities.push(t("skillMeta.alwaysAvailable"));
  }
  if (skill.homepage) {
    capabilities.push(t("skillMeta.externalDocs"));
  }
  if (capabilities.length === 0) {
    capabilities.push(t("skillMeta.reusableWorkflow"));
  }
  return capabilities.slice(0, 3);
};

const buildFallbackMetadata = (
  skill: SkillStatusEntry,
): SkillMarketplaceMetadata => {
  const source = skill.source.trim();
  const category =
    skill.bundled || source === "openclaw-bundled"
      ? t("skillMeta.catBuiltIn")
      : source === "openclaw-managed"
        ? t("skillMeta.catInstalled")
        : source === "openclaw-workspace"
          ? t("skillMeta.catWorkspace")
          : source === "openclaw-extra"
            ? t("skillMeta.catCommunity")
            : t("skillMeta.catAutomation");
  const trustLabel =
    skill.bundled || source === "openclaw-bundled"
      ? t("skillMeta.trustVerified")
      : source === "openclaw-managed"
        ? t("skillMeta.trustManaged")
        : source === "openclaw-workspace"
          ? t("skillMeta.catWorkspace")
          : t("skillMeta.catCommunity");
  return {
    category,
    tagline:
      skill.description.trim() ||
      t("skillMeta.capabilityPack", { name: titleCaseWords(skill.name) }),
    trustLabel,
    capabilities: buildFallbackCapabilities(skill),
    featured: skill.bundled || source === "openclaw-managed",
    // No rating or installs: these used to be derived from a hash of the skill
    // name and rendered as though they were real figures. A registry that
    // publishes actual download and star counts can populate them.
  };
};

/**
 * Ratings and install counts are shown only when a source actually supplied
 * them. Nothing does today — they used to be invented from a hash of the skill
 * name and rendered as real figures — so this is false until a registry that
 * publishes them is wired in.
 */
export const hasSkillMarketplaceStats = (
  metadata: SkillMarketplaceMetadata,
): boolean =>
  !metadata.hideStats &&
  (typeof metadata.rating === "number" || typeof metadata.installs === "number");

export const resolveSkillMarketplaceMetadata = (
  skill: SkillStatusEntry,
): SkillMarketplaceMetadata => {
  const normalizedKey = skill.skillKey.trim().toLowerCase();
  const fallback = buildFallbackMetadata(skill);
  const override = SKILL_MARKETPLACE_OVERRIDES[normalizedKey];
  const packagedSkill = getPackagedSkillBySkillKey(skill.skillKey);
  if (!override) {
    return {
      ...fallback,
      poweredByName: packagedSkill?.creatorName,
      poweredByUrl: packagedSkill?.creatorUrl,
      hideStats: Boolean(packagedSkill),
    };
  }
  return {
    ...fallback,
    ...override,
    capabilities: override.capabilities ?? fallback.capabilities,
    poweredByName: packagedSkill?.creatorName,
    poweredByUrl: packagedSkill?.creatorUrl,
    hideStats: override.hideStats ?? Boolean(packagedSkill),
  };
};

export const buildSkillMarketplaceEntry = (
  skill: SkillStatusEntry,
): SkillMarketplaceEntry => {
  const packagedSkill = getPackagedSkillBySkillKey(skill.skillKey);
  const missingDetails = buildSkillMissingDetails(skill);
  if (packagedSkill && !skill.baseDir.trim()) {
    missingDetails.unshift(
      t("libSkills.installPackagedHint"),
    );
  }
  return {
    skill,
    readiness: deriveSkillReadinessState(skill),
    metadata: resolveSkillMarketplaceMetadata(skill),
    installable: hasInstallableMissingBinary(skill),
    removable: canRemoveSkill(skill),
    missingDetails,
  };
};

export const buildSkillMarketplaceCollections = (
  skills: SkillStatusEntry[],
): Array<{
  id: SkillMarketplaceCollectionId;
  label: string;
  entries: SkillMarketplaceEntry[];
}> => {
  const entries = skills.map(buildSkillMarketplaceEntry);
  const sourceGroups = groupSkillsBySource(skills);
  const collections: Array<{
    id: SkillMarketplaceCollectionId;
    label: string;
    entries: SkillMarketplaceEntry[];
  }> = [];

  const featured = entries
    .filter((entry) => entry.metadata.featured)
    .slice(0, 6);
  if (featured.length > 0) {
    collections.push({ id: "featured", label: t("libSkills.collectionFeatured"), entries: featured });
  }

  const office3d = entries.filter((entry) =>
    getPackagedSkillBySkillKey(entry.skill.skillKey),
  );
  if (office3d.length > 0) {
    collections.push({ id: "office3d", label: "Office3D", entries: office3d });
  }

  const installed = entries.filter(
    (entry) => entry.readiness === "ready" || entry.skill.disabled,
  );
  if (installed.length > 0) {
    collections.push({
      id: "installed",
      label: t("skillMeta.catInstalled"),
      entries: installed,
    });
  }

  const setupRequired = entries.filter(
    (entry) => entry.readiness === "needs-setup",
  );
  if (setupRequired.length > 0) {
    collections.push({
      id: "setup-required",
      label: t("skills.filterNeedsSetup"),
      entries: setupRequired,
    });
  }

  for (const group of sourceGroups) {
    const groupEntries = group.skills.map(buildSkillMarketplaceEntry);
    const groupId =
      group.id === "built-in" ||
      group.id === "workspace" ||
      group.id === "extra" ||
      group.id === "other"
        ? group.id
        : "installed";
    collections.push({
      id: groupId,
      label: group.label,
      entries: groupEntries,
    });
  }

  return collections;
};
