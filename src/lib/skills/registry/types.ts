
import { t } from "@/lib/i18n";
/**
 * Remote skill sources.
 *
 * Skills are AgentSkills-compatible directories: a `SKILL.md` with frontmatter
 * plus supporting files. Until now Office3D could only surface skills that were
 * already on disk — every runtime discovered them by scanning directories, and
 * `skills.install` installed a skill's *dependencies* rather than the skill
 * itself. This layer is the missing half: fetching a skill from somewhere.
 *
 * It is deliberately split from installation. A registry knows how to search
 * and download; a runtime installer knows where that runtime expects skills to
 * live. Adding a source means one more SkillRegistry, and adding a runtime
 * means one more installer, without the two knowing about each other.
 */

export type SkillRegistryId = "clawhub" | "github";

/** A skill as listed by a registry, before any files are downloaded. */
export type RegistrySkillSummary = {
  registry: SkillRegistryId;
  /** Identifier within the registry, e.g. `openclaw/pdf-tools`. */
  slug: string;
  name: string;
  description: string;
  /** Latest version, when the registry tracks versions. */
  version: string | null;
  homepageUrl: string | null;
  /**
   * Real popularity figures when the registry publishes them. The marketplace
   * renders these only when present — it previously invented them.
   */
  downloads: number | null;
  stars: number | null;
  updatedAt: string | null;
};

/** One file inside a fetched skill directory. */
export type RegistrySkillFile = {
  /** Path relative to the skill directory root. Validated, never absolute. */
  path: string;
  contents: string;
};

export type RegistrySkillPackage = {
  summary: RegistrySkillSummary;
  /** Always contains SKILL.md; enforced when the package is assembled. */
  files: RegistrySkillFile[];
};

export type SkillRegistrySearchOptions = {
  limit?: number;
  signal?: AbortSignal;
};

export interface SkillRegistry {
  readonly id: SkillRegistryId;
  readonly label: string;
  search(
    query: string,
    options?: SkillRegistrySearchOptions,
  ): Promise<RegistrySkillSummary[]>;
  fetchPackage(
    slug: string,
    version?: string | null,
    options?: { signal?: AbortSignal },
  ): Promise<RegistrySkillPackage>;
}

export class SkillRegistryError extends Error {
  constructor(
    readonly registry: SkillRegistryId,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SkillRegistryError";
  }
}

/** A downloaded skill is written to disk, so its total size is capped. */
export const MAX_SKILL_PACKAGE_BYTES = 2 * 1024 * 1024;
export const MAX_SKILL_FILE_COUNT = 100;

const UNSAFE_SEGMENTS = new Set([".", ".."]);

/**
 * Registry content is untrusted: these paths are joined onto a skills
 * directory, so a `../` or an absolute path would write outside it. Rejecting
 * is the only safe response — a sanitised path would silently relocate a file
 * the skill expects to find.
 */
export const assertSafeSkillFilePath = (path: string): string => {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error(t("libSkills.filePathEmpty"));
  }
  if (trimmed.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    throw new Error(t("libSkills.filePathNotRelative", { path }));
  }
  if (trimmed.includes("\\")) {
    throw new Error(t("libSkills.filePathBackslashes", { path }));
  }
  if (trimmed.includes("\0")) {
    throw new Error(t("libSkills.filePathNullByte", { path }));
  }
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment === "") {
      throw new Error(t("libSkills.filePathEmptySegment", { path }));
    }
    if (UNSAFE_SEGMENTS.has(segment)) {
      throw new Error(t("libSkills.filePathTraversal", { path }));
    }
  }
  return trimmed;
};

export const SKILL_MANIFEST_FILENAME = "SKILL.md";

/**
 * Validates the files of a fetched package: safe paths, a manifest, and sizes
 * within the caps above.
 */
export const assertValidSkillPackageFiles = (
  files: RegistrySkillFile[],
): RegistrySkillFile[] => {
  if (files.length === 0) {
    throw new Error(t("libSkills.packageEmpty"));
  }
  if (files.length > MAX_SKILL_FILE_COUNT) {
    throw new Error(
      t("libSkills.packageTooManyFiles", { count: files.length, max: MAX_SKILL_FILE_COUNT }),
    );
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  const validated = files.map((file) => {
    const path = assertSafeSkillFilePath(file.path);
    if (seen.has(path)) {
      throw new Error(t("libSkills.packageDuplicatePath", { path }));
    }
    seen.add(path);
    totalBytes += Buffer.byteLength(file.contents, "utf8");
    return { path, contents: file.contents };
  });

  if (totalBytes > MAX_SKILL_PACKAGE_BYTES) {
    throw new Error(
      t("libSkills.packageTooLarge", { bytes: totalBytes, max: MAX_SKILL_PACKAGE_BYTES }),
    );
  }
  if (!seen.has(SKILL_MANIFEST_FILENAME)) {
    throw new Error(t("libSkills.packageNoManifest", { manifest: SKILL_MANIFEST_FILENAME }));
  }
  return validated;
};
