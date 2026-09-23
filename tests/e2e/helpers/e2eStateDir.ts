import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A fresh, empty OpenClaw/Studio state directory for one Playwright run.
 *
 * The dev server under test writes its settings and the shared task board into
 * this directory. Pointing it at a directory in the repository made every run
 * start from what the previous one left — kanban cards piled up until
 * `getByText("Create marketing website")` matched four of them — and dirtied
 * the working tree. The config is loaded again in every worker process, so the
 * path is created once and handed down through the environment.
 */
export const e2eStateDir = (): string => {
  const existing = process.env.OFFICE3D_E2E_STATE_DIR?.trim();
  if (existing) return existing;
  const dir = mkdtempSync(path.join(os.tmpdir(), "office3d-e2e-"));
  process.env.OFFICE3D_E2E_STATE_DIR = dir;
  return dir;
};
