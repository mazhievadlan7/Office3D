import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveUserPath } from "@/lib/clawdbot/paths";
import { isPathInside, resolveComparablePath } from "@/lib/skills/fs-guards";
import type { RemovableSkillSource, SkillRemoveRequest, SkillRemoveResult } from "@/lib/skills/types";
import { t } from "@/lib/i18n";

const normalizeRequiredPath = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(t("libSkills.fieldRequired", { field }));
  }
  return resolveUserPath(trimmed, os.homedir);
};

const resolveAllowedRoot = (params: {
  source: RemovableSkillSource;
  workspaceDir: string;
  managedSkillsDir: string;
}): string => {
  if (params.source === "openclaw-managed") {
    return params.managedSkillsDir;
  }
  return path.join(params.workspaceDir, "skills");
};

export const removeSkillLocally = (params: SkillRemoveRequest): SkillRemoveResult => {
  const skillKey = params.skillKey.trim();
  if (!skillKey) {
    throw new Error(t("libSkills.fieldRequired", { field: "skillKey" }));
  }

  const source = params.source;
  const baseDir = normalizeRequiredPath(params.baseDir, "baseDir");
  const workspaceDir = normalizeRequiredPath(params.workspaceDir, "workspaceDir");
  const managedSkillsDir = normalizeRequiredPath(params.managedSkillsDir, "managedSkillsDir");

  const allowedRoot = resolveAllowedRoot({
    source,
    workspaceDir,
    managedSkillsDir,
  });

  if (!isPathInside(allowedRoot, baseDir)) {
    throw new Error(t("libSkills.removeOutsideRoot", { path: baseDir }));
  }
  if (resolveComparablePath(allowedRoot) === resolveComparablePath(baseDir)) {
    throw new Error(t("libSkills.removeSkillsRoot", { path: baseDir }));
  }

  const exists = fs.existsSync(baseDir);
  if (exists) {
    const stats = fs.statSync(baseDir);
    if (!stats.isDirectory()) {
      throw new Error(t("libSkills.notADirectory", { path: baseDir }));
    }
    const skillDocPath = path.join(baseDir, "SKILL.md");
    if (!fs.existsSync(skillDocPath) || !fs.statSync(skillDocPath).isFile()) {
      throw new Error(t("libSkills.removeNonSkillDir", { path: baseDir }));
    }
    fs.rmSync(baseDir, { recursive: true, force: false });
  }

  return {
    removed: exists,
    removedPath: baseDir,
    source,
  };
};
