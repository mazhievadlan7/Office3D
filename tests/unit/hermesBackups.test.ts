// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { createBackups, clockIn } = await import("../../server/updater/backups.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

describe("daily backups", () => {
  let dir: string;
  let dataDir: string;
  let officeDir: string;
  let backupDir: string;
  let calls: string[];
  let backupCode: number;
  let importFails: boolean;
  let clock: number;
  let busy: boolean;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "office3d-backups-"));
    dataDir = path.join(dir, "hermes-data");
    officeDir = path.join(dir, "office-state");
    backupDir = path.join(dir, "backups");
    fs.mkdirSync(path.join(dataDir, "profiles", "writer"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "state.db"), "current hermes state");
    fs.mkdirSync(path.join(officeDir, "office3d"), { recursive: true });
    fs.writeFileSync(path.join(officeDir, "office3d", "settings.json"), '{"mission":"current"}');
    calls = [];
    backupCode = 0;
    importFails = false;
    clock = Date.parse("2026-09-24T03:30:10Z");
    busy = false;
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Docker commands are simulated on the mounted directories; tar is real.
  const exec = async (cmd: string, args: string[]) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "tar") {
      try {
        execFileSync("tar", args);
        return { code: 0, stdout: "", stderr: "" };
      } catch (err) {
        return { code: 1, stdout: "", stderr: String(err) };
      }
    }
    const line = args.join(" ");
    if (line.includes(" hermes backup -o ")) {
      const out = args[args.indexOf("-o") + 1].replace("/opt/data", dataDir);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      // The "archive": what the state holds now.
      fs.writeFileSync(out, fs.readFileSync(path.join(dataDir, "state.db")));
      return { code: backupCode, stdout: backupCode ? "Archive kept, but 1 file(s) could not be added" : "Backup complete", stderr: "" };
    }
    if (line.includes(" import --force ")) {
      if (importFails) return { code: 1, stdout: "", stderr: "corrupt archive" };
      const zip = args[args.length - 1].replace("/opt/data", dataDir);
      fs.writeFileSync(path.join(dataDir, "state.db"), fs.readFileSync(zip));
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const make = (overrides: Loose = {}) =>
    createBackups({
      exec,
      isBusy: () => busy,
      currentTag: async () => "v2026.9.21",
      now: () => clock,
      config: { project: "o3d", projectDir: "/project", dataDir, officeStateDir: officeDir, backupDir, keep: 2, time: "03:30", timeZone: "UTC", ...overrides },
    });

  it("backs_up_hermes_and_the_office_readable_by_the_owner_only", async () => {
    const backups = make();
    const manifest = await backups.run();
    expect(manifest).toMatchObject({ id: "2026-09-24-033010", complete: true, hermesTag: "v2026.9.21" });
    const folder = path.join(backupDir, "daily", manifest.id);
    for (const file of ["hermes.zip", "office3d-state.tar.gz", "manifest.json"]) {
      expect(fs.statSync(path.join(folder, file)).mode & 0o777).toBe(0o600);
    }
    expect(fs.statSync(folder).mode & 0o777).toBe(0o700);
    // Hermes' own archive left nothing behind in the Hermes home.
    expect(fs.readdirSync(path.join(dataDir, "backups", "office3d"))).toEqual([]);
    expect(calls[0]).toContain("compose -p o3d --project-directory /project exec -T -u hermes hermes hermes backup -o");
    const listed = execFileSync("tar", ["-tzf", path.join(folder, "office3d-state.tar.gz")]).toString();
    expect(listed).toContain("office3d/settings.json");
    expect(backups.status()).toMatchObject({ last: { status: "ok" }, backups: [{ id: manifest.id, complete: true }] });
  });

  it("keeps_the_newest_complete_ones_and_marks_an_incomplete_archive", async () => {
    const backups = make();
    for (let i = 0; i < 3; i++) {
      clock += 60_000;
      await backups.run();
    }
    expect(backups.list().map((entry: Loose) => entry.id)).toEqual(["2026-09-24-033310", "2026-09-24-033210"]);

    backupCode = 1;
    clock += 60_000;
    const partial = await backups.run();
    expect(partial.complete).toBe(false);
    // An incomplete archive never pushes a complete one out.
    expect(backups.list().filter((entry: Loose) => entry.complete)).toHaveLength(2);
    expect(backups.status().last.status).toBe("incomplete");
    expect(backups.status().lastSuccess.id).toBe("2026-09-24-033310");
  });

  it("waits_for_an_update_and_runs_once_a_day_at_its_time", async () => {
    busy = true;
    await expect(make().run()).rejects.toMatchObject({ status: 409 });
    busy = false;

    const backups = make();
    await backups.run({ label: "seed" });
    clock = Date.parse("2026-09-25T03:30:05Z");
    const before = calls.length;
    // The scheduler fires on its own timer; drive one tick through start().
    const originalSetInterval = global.setInterval;
    let tick: (() => void) | null = null;
    global.setInterval = ((fn: () => void) => {
      tick = fn;
      return { unref() {} } as Loose;
    }) as Loose;
    try {
      backups.start();
    } finally {
      global.setInterval = originalSetInterval;
    }
    tick!();
    await new Promise((resolve) => setTimeout(resolve, 50));
    tick!();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Once for the day, not once per tick.
    expect(calls.slice(before).filter((line) => line.includes(" hermes backup "))).toHaveLength(1);
    expect(clockIn(new Date(clock), "Europe/Moscow")).toMatchObject({ day: "2026-09-25", time: "06:30" });
  });

  it("restores_a_backup_and_keeps_the_state_it_replaced", async () => {
    const backups = make();
    const saved = await backups.run();
    // Later: new data and a new agent.
    fs.writeFileSync(path.join(dataDir, "state.db"), "later hermes state");
    fs.mkdirSync(path.join(dataDir, "profiles", "hired-later"), { recursive: true });
    fs.writeFileSync(path.join(officeDir, "office3d", "settings.json"), '{"mission":"later"}');
    clock += 60_000;

    const steps: string[] = [];
    const result = await backups.restore(saved.id, { onStep: (step: string) => steps.push(step) });
    expect(fs.readFileSync(path.join(dataDir, "state.db"), "utf8")).toBe("current hermes state");
    expect(fs.existsSync(path.join(dataDir, "profiles", "hired-later"))).toBe(false);
    expect(fs.readFileSync(path.join(officeDir, "office3d", "settings.json"), "utf8")).toBe('{"mission":"current"}');
    expect(result.safety).toMatch(/-pre-restore$/);
    expect(steps[0]).toBe("safety backup of the current state");
    expect(calls.some((line) => line.includes("compose -p o3d --project-directory /project stop office3d hermes-gate hermes"))).toBe(true);
    expect(calls.at(-1)).toContain("up -d hermes hermes-gate office3d");
    // Nothing of the set-aside state is left behind.
    expect(fs.readdirSync(officeDir)).toEqual(["office3d"]);
  });

  it("puts_everything_back_when_the_restore_fails_and_refuses_a_damaged_backup", async () => {
    const backups = make();
    const saved = await backups.run();
    fs.writeFileSync(path.join(dataDir, "state.db"), "later hermes state");
    fs.writeFileSync(path.join(officeDir, "office3d", "settings.json"), '{"mission":"later"}');
    clock += 60_000;

    importFails = true;
    await expect(backups.restore(saved.id)).rejects.toThrow(/hermes import failed/);
    expect(fs.readFileSync(path.join(dataDir, "state.db"), "utf8")).toBe("later hermes state");
    expect(fs.readFileSync(path.join(officeDir, "office3d", "settings.json"), "utf8")).toBe('{"mission":"later"}');
    expect(calls.at(-1)).toContain("up -d hermes hermes-gate office3d");

    fs.appendFileSync(path.join(backupDir, "daily", saved.id, "hermes.zip"), "tampered");
    importFails = false;
    const before = calls.length;
    await expect(backups.restore(saved.id)).rejects.toThrow(/checksum/);
    // Refused before anything was stopped.
    expect(calls.slice(before).some((line) => line.includes(" stop "))).toBe(false);
    await expect(backups.restore("../../etc")).rejects.toThrow(/Unknown backup/);
  });
});
