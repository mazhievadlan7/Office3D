import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FilesystemSkillInstaller,
  INSTALL_MANIFEST_FILENAME,
  readSkillNameFromManifest,
  resolveHermesSkillsRoot,
  resolveOpenClawSkillsRoot,
  sanitizeSkillDirectoryName,
} from "@/lib/skills/install";
import type { RegistrySkillPackage } from "@/lib/skills/registry/types";

let root: string;

const makePackage = (
  overrides: Partial<RegistrySkillPackage> = {},
): RegistrySkillPackage => ({
  summary: {
    registry: "clawhub",
    slug: "openclaw/pdf-tools",
    name: "PDF Tools",
    description: "Read and write PDFs.",
    version: "1.2.0",
    homepageUrl: null,
    downloads: null,
    stars: null,
    updatedAt: null,
  },
  files: [
    { path: "SKILL.md", contents: "---\nname: pdf-tools\n---\n# PDF Tools" },
    { path: "scripts/run.sh", contents: "echo hi" },
  ],
  ...overrides,
});

const installer = () => new FilesystemSkillInstaller("openclaw", "OpenClaw", root);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "office3d-skills-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("sanitizeSkillDirectoryName", () => {
  it("reduces_a_name_to_a_safe_directory_name", () => {
    expect(sanitizeSkillDirectoryName("PDF Tools")).toBe("pdf-tools");
    expect(sanitizeSkillDirectoryName("  Weird///Name!!  ")).toBe("weird-name");
    expect(sanitizeSkillDirectoryName("...dotted...")).toBe("dotted");
  });

  it("refuses_a_name_that_reduces_to_nothing", () => {
    // "../" and friends must not survive as a usable directory name.
    expect(() => sanitizeSkillDirectoryName("../..")).toThrow();
    expect(() => sanitizeSkillDirectoryName("!!!")).toThrow();
  });
});

describe("readSkillNameFromManifest", () => {
  it("reads_the_name_from_frontmatter", () => {
    expect(readSkillNameFromManifest("---\nname: pdf-tools\ndesc: x\n---\n# Body")).toBe(
      "pdf-tools",
    );
    expect(readSkillNameFromManifest('---\nname: "quoted"\n---\n')).toBe("quoted");
    expect(readSkillNameFromManifest("# No frontmatter")).toBeNull();
  });
});

describe("FilesystemSkillInstaller.install", () => {
  it("writes_the_skill_and_records_where_it_came_from", () => {
    const record = installer().install(makePackage());

    expect(record).toMatchObject({
      skillName: "pdf-tools",
      registry: "clawhub",
      slug: "openclaw/pdf-tools",
      version: "1.2.0",
    });
    expect(fs.readFileSync(path.join(root, "pdf-tools", "SKILL.md"), "utf8")).toContain(
      "# PDF Tools",
    );
    expect(fs.readFileSync(path.join(root, "pdf-tools", "scripts", "run.sh"), "utf8")).toBe(
      "echo hi",
    );

    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "pdf-tools", INSTALL_MANIFEST_FILENAME), "utf8"),
    );
    expect(manifest.slug).toBe("openclaw/pdf-tools");
  });

  it("falls_back_to_the_slug_when_the_manifest_has_no_name", () => {
    const record = installer().install(
      makePackage({ files: [{ path: "SKILL.md", contents: "# No name here" }] }),
    );
    expect(record.skillName).toBe("pdf-tools");
  });

  it("replaces_a_previous_install_without_leaving_removed_files", () => {
    const install = installer();
    install.install(makePackage());
    expect(fs.existsSync(path.join(root, "pdf-tools", "scripts", "run.sh"))).toBe(true);

    install.install(
      makePackage({
        files: [{ path: "SKILL.md", contents: "---\nname: pdf-tools\n---\n# v2" }],
      }),
    );

    expect(fs.readFileSync(path.join(root, "pdf-tools", "SKILL.md"), "utf8")).toContain("# v2");
    // The old file is gone rather than lingering from the previous version.
    expect(fs.existsSync(path.join(root, "pdf-tools", "scripts", "run.sh"))).toBe(false);
  });

  it("leaves_no_staging_directory_behind", () => {
    installer().install(makePackage());
    expect(fs.readdirSync(root)).toEqual(["pdf-tools"]);
  });

  it("refuses_a_package_whose_paths_escape_the_root", () => {
    expect(() =>
      installer().install(
        makePackage({
          files: [
            { path: "SKILL.md", contents: "---\nname: evil\n---\n" },
            { path: "../../escaped.sh", contents: "pwned" },
          ],
        }),
      ),
    ).toThrow(/не может выходить за пределы каталога/);

    expect(fs.existsSync(path.join(path.dirname(root), "escaped.sh"))).toBe(false);
  });

  it("refuses_a_package_with_no_manifest", () => {
    expect(() =>
      installer().install(makePackage({ files: [{ path: "README.md", contents: "hi" }] })),
    ).toThrow(/SKILL\.md/);
  });
});

describe("FilesystemSkillInstaller.remove", () => {
  it("removes_an_installed_skill", () => {
    const install = installer();
    install.install(makePackage());
    expect(install.remove("pdf-tools")).toBe(true);
    expect(fs.existsSync(path.join(root, "pdf-tools"))).toBe(false);
  });

  it("reports_nothing_removed_for_an_unknown_skill", () => {
    expect(installer().remove("missing")).toBe(false);
  });

  it("refuses_a_directory_that_is_not_a_skill", () => {
    // Guards against this becoming a general-purpose delete for any path that
    // happens to sit under the skills root.
    fs.mkdirSync(path.join(root, "not-a-skill"));
    fs.writeFileSync(path.join(root, "not-a-skill", "important.txt"), "keep me");

    expect(() => installer().remove("not-a-skill")).toThrow(/нет SKILL\.md; удаление отменено/);
    expect(fs.existsSync(path.join(root, "not-a-skill", "important.txt"))).toBe(true);
  });

  it("refuses_a_name_that_would_escape_the_root", () => {
    expect(() => installer().remove("../..")).toThrow();
  });
});

describe("FilesystemSkillInstaller.list", () => {
  it("returns_nothing_when_the_root_does_not_exist", () => {
    const missing = new FilesystemSkillInstaller(
      "hermes",
      "Hermes",
      path.join(root, "nope"),
    );
    expect(missing.list()).toEqual([]);
  });

  it("lists_installed_skills_with_their_provenance", () => {
    const install = installer();
    install.install(makePackage());
    expect(install.list()).toEqual([
      expect.objectContaining({
        skillName: "pdf-tools",
        registry: "clawhub",
        slug: "openclaw/pdf-tools",
        version: "1.2.0",
      }),
    ]);
  });

  it("reports_a_hand_placed_skill_with_no_invented_origin", () => {
    // A skill copied in by hand is genuinely installed but has no provenance;
    // reporting a made-up registry would be worse than reporting none.
    fs.mkdirSync(path.join(root, "manual"));
    fs.writeFileSync(path.join(root, "manual", "SKILL.md"), "---\nname: manual\n---\n");

    expect(installer().list()).toEqual([
      expect.objectContaining({
        skillName: "manual",
        registry: null,
        slug: null,
        version: null,
        installedAt: null,
      }),
    ]);
  });

  it("ignores_directories_that_are_not_skills", () => {
    fs.mkdirSync(path.join(root, "junk"));
    fs.writeFileSync(path.join(root, "loose.txt"), "x");
    expect(installer().list()).toEqual([]);
  });

  it("survives_an_unreadable_provenance_file", () => {
    const install = installer();
    install.install(makePackage());
    fs.writeFileSync(
      path.join(root, "pdf-tools", INSTALL_MANIFEST_FILENAME),
      "{ not json",
      "utf8",
    );
    expect(install.list()).toEqual([
      expect.objectContaining({ skillName: "pdf-tools", registry: null }),
    ]);
  });
});

describe("runtime skill roots", () => {
  it("points_openclaw_at_its_managed_skills_directory", () => {
    const resolved = resolveOpenClawSkillsRoot(
      { OPENCLAW_STATE_DIR: "/tmp/state" } as unknown as NodeJS.ProcessEnv,
      () => "/home/test",
    );
    expect(resolved).toBe(path.join("/tmp/state", "skills"));
  });

  it("points_hermes_at_its_own_directory_and_honours_an_override", () => {
    expect(
      resolveHermesSkillsRoot({} as unknown as NodeJS.ProcessEnv, () => "/home/test"),
    ).toBe(path.join("/home/test", ".hermes", "skills"));

    expect(
      resolveHermesSkillsRoot(
        { HERMES_SKILLS_DIR: "~/custom-skills" } as unknown as NodeJS.ProcessEnv,
        () => "/home/test",
      ),
    ).toBe(path.join("/home/test", "custom-skills"));
  });
});
