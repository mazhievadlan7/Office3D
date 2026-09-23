// @vitest-environment node
//
// The Hermes updater against a real Docker daemon, with stand-in images
// instead of Hermes (tests/fixtures/updater). Opt in:
//   OFFICE3D_DOCKER_ITEST=1 npx vitest run tests/unit/hermesUpdaterDocker.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.OFFICE3D_DOCKER_ITEST === "1";
const { createUpdater } = await import("../../server/updater/updater.js");
const { exec } = await import("../../server/updater/index.js");

const FIXTURE = path.resolve(__dirname, "../fixtures/updater");
const REPO = "office3d-itest/hermes";
const PROJECT = "office3d-updater-itest";

describe.skipIf(!enabled)("hermes updater on docker", () => {
  let dir: string;
  let backups: string;

  const docker = async (...args: string[]) => {
    const result = await exec("docker", args, { timeoutMs: 300_000 });
    if (result.code !== 0) throw new Error(`docker ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
  };
  const updater = () =>
    createUpdater({
      exec,
      listTags: async () => ["v2026.1.1", "v2026.1.2", "v2026.1.3"],
      probe: async (url: string) => {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) }).catch(() => null);
        return Boolean(response?.ok);
      },
      config: {
        project: PROJECT,
        projectDir: dir,
        imageRepo: REPO,
        defaultTag: "v2026.1.1",
        dataDir: path.join(dir, "data"),
        backupDir: backups,
        healthUrls: ["http://127.0.0.1:18642/health", "http://127.0.0.1:19120/gate/health"],
        healthDeadlineMs: 25_000,
        healthIntervalMs: 1_000,
        healthStreak: 2,
      },
    });
  const waitJob = async (u: ReturnType<typeof updater>) => {
    for (let i = 0; i < 240; i += 1) {
      const { job } = await u.status();
      if (job && !["running"].includes(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("the update did not finish");
  };

  beforeAll(async () => {
    const builds: Array<[string, string]> = [
      ["v2026.1.1", "good"],
      ["v2026.1.2", "bad"],
      ["v2026.1.3", "good"],
    ];
    for (const [tag, version] of builds) {
      await docker("build", "-q", "-t", `${REPO}:${tag}`, "--build-arg", `VERSION=${version}`, "--build-arg", `TAG=${tag}`, FIXTURE);
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "office3d-updater-itest-"));
    backups = path.join(dir, "backups");
    fs.copyFileSync(path.join(FIXTURE, "docker-compose.yml"), path.join(dir, "docker-compose.yml"));
    fs.mkdirSync(path.join(dir, "data"));
    fs.writeFileSync(path.join(dir, "data", "keep.txt"), "данные агентов");
    fs.writeFileSync(path.join(dir, ".env"), "# the office's settings\nSTUDIO_ACCESS_TOKEN=x\n");
    await docker("compose", "-p", PROJECT, "--project-directory", dir, "up", "-d");
  }, 600_000);

  afterAll(async () => {
    if (!dir) return;
    await exec("docker", ["compose", "-p", PROJECT, "--project-directory", dir, "down", "-v"], { timeoutMs: 120_000 });
    fs.rmSync(dir, { recursive: true, force: true });
  }, 180_000);

  it("rolls_back_a_version_that_never_becomes_healthy_and_restores_its_data", async () => {
    const u = updater();
    await u.start("v2026.1.2");
    const job = await waitJob(u);
    expect(job.status).toBe("rolled_back");
    expect(job.steps.map((s: { name: string }) => s.name)).toEqual(["pull", "stop", "backup", "start", "check", "rollback", "check-rollback"]);
    // The broken version wrote its "migration"; the backup put the old data back.
    expect(fs.readFileSync(path.join(dir, "data", "schema"), "utf8").trim()).toBe("v2026.1.1");
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toContain("HERMES_IMAGE_TAG=v2026.1.1");
    expect(fs.readFileSync(path.join(dir, "data", "keep.txt"), "utf8")).toBe("данные агентов");
    const image = await docker("compose", "-p", PROJECT, "--project-directory", dir, "images", "--format", "json");
    expect(image).toContain("v2026.1.1");
  }, 300_000);

  it("moves_to_a_healthy_version_and_keeps_it_in_the_env_file", async () => {
    const u = updater();
    const before = await u.status({ refresh: true });
    expect(before.newer).toEqual(["v2026.1.3", "v2026.1.2"]);
    await u.start("v2026.1.3");
    const job = await waitJob(u);
    expect(job.status).toBe("done");
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toContain("HERMES_IMAGE_TAG=v2026.1.3");
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toContain("STUDIO_ACCESS_TOKEN=x");
    expect(fs.readFileSync(path.join(dir, "data", "schema"), "utf8").trim()).toBe("v2026.1.3");
    expect(fs.readdirSync(backups).filter((name) => name.endsWith(".tgz")).length).toBeGreaterThan(0);
    expect((await u.status()).current).toBe("v2026.1.3");
  }, 300_000);

  it("refuses_unknown_versions_and_a_second_update_at_once", async () => {
    const u = updater();
    await expect(u.start("v2099.1.1")).rejects.toMatchObject({ status: 400 });
    await expect(u.start("latest")).rejects.toMatchObject({ status: 400 });
  });
});
