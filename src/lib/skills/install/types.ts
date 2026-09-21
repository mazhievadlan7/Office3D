import type {
  RegistrySkillPackage,
  SkillRegistryId,
} from "@/lib/skills/registry/types";

/**
 * Installing a fetched skill into a runtime.
 *
 * Runtimes disagree about where skills live and how an agent gets to see them:
 * OpenClaw scans directories it already knows about, while the Hermes adapter
 * has no scanner and injects skill text into the system prompt it builds. The
 * registry layer stays ignorant of all that — it produces a package, and an
 * installer puts it where its runtime expects it.
 */
export type SkillRuntimeId = "openclaw" | "hermes";

/** What was installed, and where it came from. */
export type InstalledSkillRecord = {
  /** Directory name under the runtime's skills root. */
  skillName: string;
  directory: string;
  /**
   * Null for a skill placed in the directory by hand rather than installed
   * from a registry. Its provenance is genuinely unknown and guessing one
   * would be worse than reporting none.
   */
  registry: SkillRegistryId | null;
  slug: string | null;
  version: string | null;
  /** ISO timestamp of the install, or null when it was not installed by us. */
  installedAt: string | null;
};

export interface SkillInstaller {
  readonly runtime: SkillRuntimeId;
  readonly label: string;
  /** Directory this installer owns. Everything it writes stays inside it. */
  readonly root: string;
  install(pkg: RegistrySkillPackage): InstalledSkillRecord;
  /** Returns false when there was nothing to remove. */
  remove(skillName: string): boolean;
  list(): InstalledSkillRecord[];
}

/**
 * Provenance is written beside the skill so the marketplace can show where a
 * directory came from, and so an update knows which slug and version it is
 * replacing. Reading it back is best-effort: a hand-made skill directory has
 * no such file and is still a perfectly valid skill.
 */
export const INSTALL_MANIFEST_FILENAME = ".office3d-install.json";

export class SkillInstallError extends Error {
  constructor(
    readonly runtime: SkillRuntimeId,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SkillInstallError";
  }
}
