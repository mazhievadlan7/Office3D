import fs from "node:fs";
import path from "node:path";

import { isPathInside } from "@/lib/skills/fs-guards";
import {
  INSTALL_MANIFEST_FILENAME,
  SkillInstallError,
  type InstalledSkillRecord,
  type SkillInstaller,
  type SkillRuntimeId,
} from "@/lib/skills/install/types";
import {
  SKILL_MANIFEST_FILENAME,
  assertValidSkillPackageFiles,
  type RegistrySkillPackage,
} from "@/lib/skills/registry/types";
import { t } from "@/lib/i18n";

/**
 * Writes a fetched skill into a directory on disk. Both supported runtimes
 * read skills from directories, so they share this implementation and differ
 * only in which root they point it at.
 */

/** Directory names come from registry metadata, so they are constrained hard. */
const MAX_SKILL_NAME_LENGTH = 64;

export const sanitizeSkillDirectoryName = (candidate: string): string => {
  const cleaned = candidate
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "")
    .slice(0, MAX_SKILL_NAME_LENGTH);
  if (!cleaned) {
    throw new Error(t("libSkills.cannotDeriveDirName", { candidate }));
  }
  return cleaned;
};

/** Reads `name:` from SKILL.md frontmatter, which names the skill to an agent. */
export const readSkillNameFromManifest = (contents: string): string | null => {
  const frontmatter = contents.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const body = frontmatter ? frontmatter[1] : contents;
  const match = body.match(/^name:\s*(.+)$/m);
  if (!match) return null;
  const value = match[1].trim().replace(/^["']|["']$/g, "");
  return value || null;
};

export const resolveSkillDirectoryName = (pkg: RegistrySkillPackage): string => {
  const manifest = pkg.files.find((file) => file.path === SKILL_MANIFEST_FILENAME);
  const fromManifest = manifest ? readSkillNameFromManifest(manifest.contents) : null;
  // The manifest name is what the agent sees, so it wins; the slug's last
  // segment is the fallback when a skill does not declare one.
  const candidate = fromManifest ?? pkg.summary.slug.split("/").filter(Boolean).pop() ?? "";
  return sanitizeSkillDirectoryName(candidate);
};

/** A skill directory we did not install: present, but with no known origin. */
const unknownProvenance = (
  skillName: string,
  directory: string,
): InstalledSkillRecord => ({
  skillName,
  directory,
  registry: null,
  slug: null,
  version: null,
  installedAt: null,
});

export class FilesystemSkillInstaller implements SkillInstaller {
  constructor(
    readonly runtime: SkillRuntimeId,
    readonly label: string,
    readonly root: string,
  ) {}

  private assertInsideRoot(target: string): void {
    if (!isPathInside(this.root, target)) {
      throw new SkillInstallError(
        this.runtime,
        t("libSkills.refuseOutsideRoot", { target, root: this.root }),
      );
    }
  }

  install(pkg: RegistrySkillPackage): InstalledSkillRecord {
    let files: RegistrySkillPackage["files"];
    let skillName: string;
    try {
      // Revalidated here rather than trusted from the registry: an installer is
      // the last place that can refuse a traversing path before it is written.
      files = assertValidSkillPackageFiles(pkg.files);
      skillName = resolveSkillDirectoryName(pkg);
    } catch (error) {
      throw new SkillInstallError(
        this.runtime,
        error instanceof Error ? error.message : String(error),
        error,
      );
    }

    const directory = path.join(this.root, skillName);
    this.assertInsideRoot(directory);

    // Staged in a sibling directory and swapped in at the end, so a failure
    // part way through cannot leave a half-written skill that a runtime would
    // happily load.
    const staging = `${directory}.office3d-staging`;
    this.assertInsideRoot(staging);

    const installedAt = new Date().toISOString();
    const record: InstalledSkillRecord = {
      skillName,
      directory,
      registry: pkg.summary.registry,
      slug: pkg.summary.slug,
      version: pkg.summary.version,
      installedAt,
    };

    try {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });

      for (const file of files) {
        const target = path.join(staging, file.path);
        this.assertInsideRoot(target);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.contents, "utf8");
      }

      fs.writeFileSync(
        path.join(staging, INSTALL_MANIFEST_FILENAME),
        `${JSON.stringify(record, null, 2)}\n`,
        "utf8",
      );

      fs.rmSync(directory, { recursive: true, force: true });
      fs.renameSync(staging, directory);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new SkillInstallError(
        this.runtime,
        t("libSkills.installIntoDirFailed", { slug: pkg.summary.slug, directory, message: error instanceof Error ? error.message : String(error) }),
        error,
      );
    }

    return record;
  }

  remove(skillName: string): boolean {
    let sanitized: string;
    try {
      sanitized = sanitizeSkillDirectoryName(skillName);
    } catch (error) {
      throw new SkillInstallError(
        this.runtime,
        error instanceof Error ? error.message : String(error),
        error,
      );
    }

    const directory = path.join(this.root, sanitized);
    this.assertInsideRoot(directory);
    if (directory === path.resolve(this.root)) {
      throw new SkillInstallError(this.runtime, t("libSkills.refuseRemoveSkillsRoot"));
    }
    if (!fs.existsSync(directory)) return false;
    // Only directories that look like skills are removable, so a stray path
    // cannot turn this into a general-purpose delete.
    if (!fs.existsSync(path.join(directory, SKILL_MANIFEST_FILENAME))) {
      throw new SkillInstallError(
        this.runtime,
        t("libSkills.noManifestRefuseRemove", { directory, manifest: SKILL_MANIFEST_FILENAME }),
      );
    }
    fs.rmSync(directory, { recursive: true, force: true });
    return true;
  }

  list(): InstalledSkillRecord[] {
    if (!fs.existsSync(this.root)) return [];
    const entries = fs.readdirSync(this.root, { withFileTypes: true });
    const records: InstalledSkillRecord[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(this.root, entry.name);
      if (!fs.existsSync(path.join(directory, SKILL_MANIFEST_FILENAME))) continue;

      const manifestPath = path.join(directory, INSTALL_MANIFEST_FILENAME);
      if (!fs.existsSync(manifestPath)) {
        // A skill placed here by hand has no provenance. It is still installed,
        // so report it rather than hiding it.
        records.push(unknownProvenance(entry.name, directory));
        continue;
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as InstalledSkillRecord;
        records.push({ ...parsed, skillName: entry.name, directory });
      } catch {
        records.push(unknownProvenance(entry.name, directory));
      }
    }

    return records.sort((a, b) => a.skillName.localeCompare(b.skillName));
  }
}
