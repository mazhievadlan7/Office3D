// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { createUpdater, parseTag, compareTags, newerTags, setEnvValue, readEnvValue } = await import(
  "../../server/updater/updater.js"
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

describe("hermes updater", () => {
  let dir: string;
  let calls: string[];
  let failOn: RegExp | null;
  let healthyAfter: string | null;
  let tag: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "office3d-updater-"));
    fs.mkdirSync(path.join(dir, "data"));
    fs.writeFileSync(path.join(dir, ".env"), "STUDIO_ACCESS_TOKEN=secret\nHERMES_IMAGE_TAG=v2026.9.14\n");
    calls = [];
    failOn = null;
    healthyAfter = "v2026.9.21";
    tag = "v2026.9.14";
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const make = (overrides: Loose = {}) =>
    createUpdater({
      exec: async (cmd: string, args: string[]) => {
        const line = `${cmd} ${args.join(" ")}`;
        calls.push(line);
        if (failOn?.test(line)) return { code: 1, stdout: "", stderr: "boom" };
        if (line.includes(" up -d ")) tag = readEnvValue(fs.readFileSync(path.join(dir, ".env"), "utf8"), "HERMES_IMAGE_TAG");
        if (cmd === "tar" && args[0] === "-czf") fs.writeFileSync(args[1], "backup");
        return { code: 0, stdout: "", stderr: "" };
      },
      listTags: async () => ["v2026.9.21", "v2026.9.14", "v2026.9.11"],
      probe: async () => healthyAfter === null || tag !== "v2026.9.21" || healthyAfter === "v2026.9.21",
      sleep: async () => {},
      config: {
        project: "office3d",
        projectDir: dir,
        imageRepo: "nousresearch/hermes-agent",
        defaultTag: "v2026.9.21",
        dataDir: path.join(dir, "data"),
        backupDir: path.join(dir, "backups"),
        healthUrls: ["http://hermes:8642/health"],
        healthDeadlineMs: 50,
        healthIntervalMs: 1,
        healthStreak: 2,
      },
      ...overrides,
    });

  const finish = async (u: Loose) => {
    for (let i = 0; i < 200; i += 1) {
      const { job } = await u.status();
      if (job?.status !== "running") return job;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("job did not finish");
  };

  it("reads_release_tags_and_orders_them", () => {
    expect(parseTag("v2026.8.16.2")).toEqual([2026, 8, 16, 2]);
    expect(parseTag("latest")).toBeNull();
    expect(compareTags("v2026.8.16.2", "v2026.8.16")).toBeGreaterThan(0);
    expect(compareTags("v2026.10.1", "v2026.9.30")).toBeGreaterThan(0);
    expect(newerTags(["main", "v2026.9.21", "v2026.9.7", "v2026.9.14", "v2026.9.21"], "v2026.9.7")).toEqual([
      "v2026.9.21",
      "v2026.9.14",
    ]);
  });

  it("edits_one_line_of_the_env_file", () => {
    expect(setEnvValue("A=1\nHERMES_IMAGE_TAG=v1\nB=2\n", "HERMES_IMAGE_TAG", "v2")).toBe("A=1\nHERMES_IMAGE_TAG=v2\nB=2\n");
    expect(setEnvValue("A=1\n", "HERMES_IMAGE_TAG", "v2")).toBe("A=1\nHERMES_IMAGE_TAG=v2\n");
    expect(readEnvValue('X=1\nHERMES_IMAGE_TAG="v3"\n', "HERMES_IMAGE_TAG")).toBe("v3");
  });

  it("updates_with_a_backup_and_keeps_the_new_tag", async () => {
    const u = make();
    expect((await u.status()).newer).toEqual(["v2026.9.21"]);
    await u.start("v2026.9.21");
    const job = await finish(u);
    expect(job.status).toBe("done");
    expect(job.steps.map((s: { name: string }) => s.name)).toEqual(["pull", "stop", "backup", "start", "check"]);
    const env = fs.readFileSync(path.join(dir, ".env"), "utf8");
    expect(env).toContain("HERMES_IMAGE_TAG=v2026.9.21");
    expect(env).toContain("STUDIO_ACCESS_TOKEN=secret");
    expect(calls.some((c) => c.startsWith("tar -czf"))).toBe(true);
    expect(calls.find((c) => c.includes(" stop "))).toContain("stop hermes-gate hermes");
  });

  it("rolls_back_tag_and_data_when_the_new_version_is_unhealthy", async () => {
    healthyAfter = "never";
    const u = make();
    await u.start("v2026.9.21");
    const job = await finish(u);
    expect(job.status).toBe("rolled_back");
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toContain("HERMES_IMAGE_TAG=v2026.9.14");
    expect(calls.some((c) => c.startsWith("tar -xzf"))).toBe(true);
  });

  it("restarts_the_old_version_when_a_step_fails_before_the_switch", async () => {
    failOn = /^tar -czf/;
    const u = make();
    await u.start("v2026.9.21");
    const job = await finish(u);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("резервная копия");
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toContain("HERMES_IMAGE_TAG=v2026.9.14");
    expect(calls.at(-1)).toContain("up -d hermes hermes-gate");
  });

  it("refuses_unknown_versions_the_current_one_and_a_second_job", async () => {
    const u = make();
    await expect(u.start("v2099.1.1")).rejects.toMatchObject({ status: 400 });
    await expect(u.start("latest")).rejects.toMatchObject({ status: 400 });
    await expect(u.start("v2026.9.14")).rejects.toMatchObject({ status: 400 });
    healthyAfter = null;
    await u.start("v2026.9.21");
    await expect(u.start("v2026.9.11")).rejects.toMatchObject({ status: 409 });
    await finish(u);
  });

  it("will_not_start_without_a_known_current_version", async () => {
    fs.writeFileSync(path.join(dir, ".env"), "X=1\n");
    const u = make({
      config: { project: "o", projectDir: dir, imageRepo: "r", defaultTag: "", dataDir: dir, backupDir: dir, healthUrls: [] },
    });
    await expect(u.start("v2026.9.21")).rejects.toMatchObject({ status: 409 });
  });

  it("marks_a_job_interrupted_by_a_restart_as_failed", async () => {
    fs.mkdirSync(path.join(dir, "backups"));
    fs.writeFileSync(
      path.join(dir, "backups", "updater-state.json"),
      JSON.stringify({ job: { id: "upd_x", status: "running", step: "backup", steps: [] }, history: [] }),
    );
    const u = make();
    expect((await u.status()).job).toMatchObject({ id: "upd_x", status: "failed" });
  });
});
