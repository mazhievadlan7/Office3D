import { ClawHubRegistry } from "@/lib/skills/registry/clawhub";
import { GitHubSkillRegistry } from "@/lib/skills/registry/github";
import type {
  RegistrySkillSummary,
  SkillRegistry,
  SkillRegistryId,
  SkillRegistrySearchOptions,
} from "@/lib/skills/registry/types";
import { t } from "@/lib/i18n";

export * from "@/lib/skills/registry/types";
export { ClawHubRegistry, resolveClawHubApiUrl } from "@/lib/skills/registry/clawhub";
export { GitHubSkillRegistry, parseGitHubSlug } from "@/lib/skills/registry/github";

/**
 * The sources a skill can be installed from. Adding one means adding a
 * SkillRegistry here; nothing downstream needs to know which source a skill
 * came from beyond the `registry` field on its summary.
 */
export const createSkillRegistries = (): SkillRegistry[] => [
  new ClawHubRegistry(),
  new GitHubSkillRegistry(),
];

export const findSkillRegistry = (
  registries: SkillRegistry[],
  id: SkillRegistryId,
): SkillRegistry => {
  const found = registries.find((registry) => registry.id === id);
  if (!found) {
    throw new Error(t("libSkills.unknownRegistry", { id }));
  }
  return found;
};

export type SkillRegistrySearchResult = {
  registry: SkillRegistryId;
  results: RegistrySkillSummary[];
  /** Set when this source failed; the others still returned. */
  error: string | null;
};

/**
 * Searches every source. One registry being down or rate limited must not
 * blank the marketplace, so failures are reported per source rather than
 * rejecting the whole search.
 */
export const searchSkillRegistries = async (
  registries: SkillRegistry[],
  query: string,
  options?: SkillRegistrySearchOptions,
): Promise<SkillRegistrySearchResult[]> =>
  Promise.all(
    registries.map(async (registry) => {
      try {
        return {
          registry: registry.id,
          results: await registry.search(query, options),
          error: null,
        };
      } catch (error) {
        return {
          registry: registry.id,
          results: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
