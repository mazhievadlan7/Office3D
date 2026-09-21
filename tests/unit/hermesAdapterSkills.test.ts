import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The adapter resolves its skills directory once at module load, so each test
 * points HERMES_SKILLS_DIR at a fresh fixture and re-imports it.
 */
let skillsDir: string;

const loadAdapter = async () => {
  vi.resetModules();
  process.env.HERMES_SKILLS_DIR = skillsDir;
  return import("../../server/hermes-gateway-adapter.js");
};

type SkillStatusPayload = {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: Array<{ skillKey: string; name: string; description: string }>;
};

/** Calls skills.status and narrows the handler's ok/error union to the payload. */
const skillStatus = async (): Promise<SkillStatusPayload> => {
  const { handleMethod } = await loadAdapter();
  const response = await handleMethod("skills.status", {}, "1", () => {});
  if (!("payload" in response)) {
    throw new Error(`Expected an ok response, got ${JSON.stringify(response)}`);
  }
  return response.payload as SkillStatusPayload;
};

const writeSkill = (name: string, contents: string) => {
  const dir = path.join(skillsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), contents, "utf8");
};

beforeEach(() => {
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-skills-"));
});

afterEach(() => {
  fs.rmSync(skillsDir, { recursive: true, force: true });
  delete process.env.HERMES_SKILLS_DIR;
  vi.resetModules();
});

describe("hermes adapter skills.status", () => {
  it("reports_installed_skills_instead_of_an_empty_list", async () => {
    writeSkill(
      "pdf-tools",
      "---\nname: PDF Tools\ndescription: Read and write PDFs.\n---\n# How to use",
    );
    const payload = await skillStatus();

    expect(payload.managedSkillsDir).toBe(skillsDir);
    expect(payload.skills).toEqual([
      expect.objectContaining({
        skillKey: "pdf-tools",
        name: "PDF Tools",
        description: "Read and write PDFs.",
        source: "hermes-managed",
        eligible: true,
        bundled: false,
      }),
    ]);
  });

  it("returns_an_empty_list_when_nothing_is_installed", async () => {
    expect((await skillStatus()).skills).toEqual([]);
  });

  it("survives_a_missing_skills_directory", async () => {
    fs.rmSync(skillsDir, { recursive: true, force: true });
    expect((await skillStatus()).skills).toEqual([]);
  });

  it("skips_a_directory_without_a_manifest_and_keeps_the_rest", async () => {
    fs.mkdirSync(path.join(skillsDir, "not-a-skill"), { recursive: true });
    writeSkill("good", "---\nname: Good\n---\n# ok");

    const payload = await skillStatus();

    expect(payload.skills.map((skill) => skill.skillKey)).toEqual(["good"]);
  });

  it("falls_back_to_the_directory_name_when_frontmatter_has_no_name", async () => {
    writeSkill("bare", "# No frontmatter at all");
    const payload = await skillStatus();
    expect(payload.skills[0]).toMatchObject({ skillKey: "bare", name: "bare" });
  });
});
