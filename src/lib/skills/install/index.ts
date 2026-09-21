import os from "node:os";
import path from "node:path";

import { resolveStateDir, resolveUserPath } from "@/lib/clawdbot/paths";
import { FilesystemSkillInstaller } from "@/lib/skills/install/filesystem";
import type { SkillInstaller, SkillRuntimeId } from "@/lib/skills/install/types";

export * from "@/lib/skills/install/types";
export {
  FilesystemSkillInstaller,
  readSkillNameFromManifest,
  resolveSkillDirectoryName,
  sanitizeSkillDirectoryName,
} from "@/lib/skills/install/filesystem";

/**
 * OpenClaw's managed skills directory — the `openclaw-managed` source it
 * already scans, so a skill installed here is discovered with no further
 * wiring. It follows OPENCLAW_STATE_DIR and the legacy state directories, the
 * same way the rest of the app resolves OpenClaw's state.
 */
export const resolveOpenClawSkillsRoot = (
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string => path.join(resolveStateDir(env, homedir), "skills");

/**
 * Hermes has no skill scanner: the adapter builds a system prompt and is what
 * an agent actually sees. This directory is where installed skills wait for it
 * to read them, kept beside the adapter's other state in ~/.hermes.
 */
export const resolveHermesSkillsRoot = (
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string => {
  const override = env.HERMES_SKILLS_DIR?.trim();
  if (override) return resolveUserPath(override, homedir);
  return path.join(homedir(), ".hermes", "skills");
};

export const createSkillInstaller = (
  runtime: SkillRuntimeId,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): SkillInstaller => {
  switch (runtime) {
    case "openclaw":
      return new FilesystemSkillInstaller(
        "openclaw",
        "OpenClaw",
        resolveOpenClawSkillsRoot(env, homedir),
      );
    case "hermes":
      return new FilesystemSkillInstaller(
        "hermes",
        "Hermes",
        resolveHermesSkillsRoot(env, homedir),
      );
  }
};

/**
 * The runtimes a skill can be installed into. `demo`, `local` and `custom`
 * are absent on purpose: the demo gateway is a fixture, and the other two have
 * no skill storage to install into.
 */
export const SKILL_INSTALL_RUNTIMES: SkillRuntimeId[] = ["openclaw", "hermes"];
