// Daily backups of everything the deployment keeps, and restoring one.
//
// Runs in the updater container, which already has the Docker socket, the
// Hermes data volume and the backup volume. A backup is one directory under
// <backupDir>/daily/<id>/:
//   hermes.zip              `hermes backup`: Hermes' own archive of its home
//                           (profiles, memory, sessions, skills, kanban, .env),
//                           with SQLite copied safely while Hermes runs;
//   office3d-state.tar.gz   the office's state volume (settings, tasks,
//                           organization);
//   manifest.json           when, which Hermes version, sizes and sha256.
// Archives hold secrets (API keys in .env), so they are readable by the owner
// only. The newest `keep` complete backups are kept.
//
// A restore stops the office and Hermes, keeps a copy of the current state
// first, replaces the Hermes data with the archive through `hermes import`,
// puts the office state back, and starts everything again. It is started
// from the server's shell (see scripts/office3d-restore.sh), never over HTTP.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ID_RE = /^\d{4}-\d{2}-\d{2}-\d{6}(?:-[a-z0-9-]{1,32})?$/;
const HERMES_OUT_DIR = "backups/office3d"; // inside the Hermes home; Hermes' backup skips backups/
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const sha256File = (file) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });

/** Year, month, day, hour, minute in a time zone. */
const clockIn = (date, timeZone) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timeZone || undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    id: `${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}${parts.second}`,
  };
};

/**
 * @param {object} deps
 * @param {(cmd: string, args: string[], opts?: {timeoutMs?: number}) => Promise<{code: number, stdout: string, stderr: string}>} deps.exec
 * @param {object} deps.config
 * @param {string} deps.config.project        compose project
 * @param {string} deps.config.projectDir     docker-compose.yml and .env
 * @param {string} deps.config.dataDir        the Hermes data volume, mounted
 * @param {string} deps.config.officeStateDir the office state volume, mounted
 * @param {string} deps.config.backupDir
 * @param {number} deps.config.keep           complete backups to keep
 * @param {string} deps.config.time           daily, HH:MM in timeZone; "" turns the schedule off
 * @param {string} [deps.config.timeZone]
 * @param {() => boolean} deps.isBusy         an update is running
 * @param {() => Promise<string>} deps.currentTag
 * @param {(message: string) => void} [deps.log]
 * @param {() => number} [deps.now]
 */
const createBackups = ({ exec, config, isBusy, currentTag, log = () => {}, now = () => Date.now() }) => {
  const dailyDir = path.join(config.backupDir, "daily");
  const statePath = path.join(dailyDir, "state.json");
  const compose = (...args) => ["compose", "-p", config.project, "--project-directory", config.projectDir, ...args];

  const readState = () => {
    try {
      return JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch {
      return {};
    }
  };
  let state = readState();
  const saveState = () => {
    fs.mkdirSync(dailyDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(`${statePath}.tmp`, statePath);
  };

  /** Complete backups, newest first. */
  const list = () => {
    let names = [];
    try {
      names = fs.readdirSync(dailyDir).filter((name) => ID_RE.test(name));
    } catch {
      return [];
    }
    return names
      .map((name) => {
        try {
          const manifest = JSON.parse(fs.readFileSync(path.join(dailyDir, name, "manifest.json"), "utf8"));
          return manifest?.id === name ? manifest : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  };

  const prune = () => {
    const keep = Math.max(1, config.keep);
    const complete = list().filter((entry) => entry.complete);
    const keepIds = new Set(complete.slice(0, keep).map((entry) => entry.id));
    const newestKept = complete[Math.min(keep, complete.length) - 1]?.createdAt ?? "";
    let names = [];
    try {
      names = fs.readdirSync(dailyDir).filter((name) => ID_RE.test(name));
    } catch {
      return;
    }
    for (const name of names) {
      if (keepIds.has(name)) continue;
      const manifestPath = path.join(dailyDir, name, "manifest.json");
      let createdAt = "";
      try {
        createdAt = JSON.parse(fs.readFileSync(manifestPath, "utf8")).createdAt ?? "";
      } catch {
        // A directory without a manifest is a backup that never finished.
      }
      // Older than every kept backup (or unfinished): gone. A newer
      // incomplete one stays until complete ones overtake it.
      if (!createdAt || createdAt < newestKept) {
        fs.rmSync(path.join(dailyDir, name), { recursive: true, force: true });
        log(`Backup ${name} pruned.`);
      }
    }
  };

  let running = null;
  let restoring = false;

  const perform = async (id, label) => {
    const dir = path.join(dailyDir, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const errors = [];

    // Hermes, through its own backup (safe SQLite copies, no downtime).
    const hermesName = `hermes-${id}.zip`;
    const inHermes = `/opt/data/${HERMES_OUT_DIR}/${hermesName}`;
    const result = await exec(
      "docker",
      compose("exec", "-T", "-u", "hermes", "hermes", "hermes", "backup", "-o", inHermes, "--keep", "0"),
      { timeoutMs: 60 * 60_000 },
    );
    const produced = path.join(config.dataDir, HERMES_OUT_DIR, hermesName);
    if (!fs.existsSync(produced)) {
      throw new Error(`hermes backup failed (${result.code}): ${(result.stderr || result.stdout).trim().slice(-400)}`);
    }
    // Exit 1 with an archive: written, but some files could not be added.
    if (result.code !== 0) errors.push(`hermes backup incomplete: ${result.stdout.trim().split("\n").slice(-6).join(" ").slice(0, 400)}`);
    const hermesZip = path.join(dir, "hermes.zip");
    fs.copyFileSync(produced, hermesZip);
    fs.rmSync(produced, { force: true });
    fs.chmodSync(hermesZip, 0o600);

    // The office's state volume.
    const officeTar = path.join(dir, "office3d-state.tar.gz");
    const tar = await exec("tar", ["-czf", officeTar, "-C", config.officeStateDir, "."], { timeoutMs: 30 * 60_000 });
    if (tar.code !== 0) throw new Error(`office state archive failed: ${tar.stderr.trim().slice(-300)}`);
    fs.chmodSync(officeTar, 0o600);

    const files = {};
    for (const file of ["hermes.zip", "office3d-state.tar.gz"]) {
      const full = path.join(dir, file);
      files[file] = { size: fs.statSync(full).size, sha256: await sha256File(full) };
    }
    const manifest = {
      id,
      label: label || null,
      createdAt: new Date(now()).toISOString(),
      hermesTag: await currentTag().catch(() => null),
      complete: errors.length === 0,
      errors,
      files,
    };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return manifest;
  };

  /** Takes a backup now. Resolves to its manifest; one at a time. */
  const run = ({ label = "" } = {}) => {
    if (running) return running;
    if (isBusy()) return Promise.reject(Object.assign(new Error("Идёт обновление Hermes: копия будет сделана после него."), { status: 409 }));
    const id = `${clockIn(new Date(now()), config.timeZone).id}${label ? `-${label}` : ""}`;
    running = (async () => {
      const startedAt = new Date(now()).toISOString();
      try {
        const manifest = await perform(id, label);
        state.last = { id, status: manifest.complete ? "ok" : "incomplete", startedAt, finishedAt: manifest.createdAt, errors: manifest.errors };
        if (manifest.complete) state.lastSuccess = { id, at: manifest.createdAt };
        log(`Backup ${id} ${manifest.complete ? "complete" : "incomplete"}.`);
        prune();
        return manifest;
      } catch (err) {
        state.last = { id, status: "failed", startedAt, finishedAt: new Date(now()).toISOString(), errors: [err?.message ?? String(err)] };
        log(`Backup ${id} failed: ${err?.message ?? err}`);
        throw err;
      } finally {
        saveState();
        running = null;
      }
    })();
    return running;
  };

  const status = () => ({
    schedule: TIME_RE.test(config.time) ? { time: config.time, timeZone: config.timeZone || "UTC", keep: config.keep } : null,
    running: Boolean(running),
    last: state.last ?? null,
    lastSuccess: state.lastSuccess ?? null,
    backups: list().map(({ id, label, createdAt, hermesTag, complete, files }) => ({
      id,
      label,
      createdAt,
      hermesTag,
      complete,
      size: Object.values(files ?? {}).reduce((sum, file) => sum + (file?.size ?? 0), 0),
    })),
  });

  // The schedule: once a day at the set time, and at start when the last
  // good backup is more than a day old (the server was off at that time).
  let timer = null;
  const tick = async () => {
    if (!TIME_RE.test(config.time) || running || isBusy()) return;
    const clock = clockIn(new Date(now()), config.timeZone);
    const lastAt = state.lastSuccess?.at ? Date.parse(state.lastSuccess.at) : 0;
    const due = clock.time === config.time && state.lastScheduledDay !== clock.day;
    const overdue = now() - lastAt > 26 * 60 * 60_000 && now() - Date.parse(state.last?.finishedAt ?? 0) > 60 * 60_000;
    if (!due && !overdue) return;
    if (due) {
      state.lastScheduledDay = clock.day;
      saveState();
    }
    await run().catch(() => {});
  };
  const start = () => {
    if (!TIME_RE.test(config.time)) {
      log("Daily backups are off (BACKUP_TIME is empty).");
      return;
    }
    log(`Daily backups at ${config.time} ${config.timeZone || "UTC"}, keeping ${config.keep}.`);
    timer = setInterval(() => void tick(), 60_000);
    timer.unref?.();
    // First look a few minutes after start, once Hermes is up.
    setTimeout(() => void tick(), 5 * 60_000).unref?.();
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  /**
   * Restores backup `id`: the current state is backed up first (label
   * "pre-restore"), then the office and Hermes are stopped, the Hermes home
   * and the office state are replaced by the backup's, and everything is
   * started again. A failure puts the previous state back before starting.
   * @param {string} id
   * @param {{onStep?: (step: string) => void}} [opts]
   */
  /** @type {{current: (step: string) => void}} */
  const onStepRef = { current: () => {} };
  const restore = async (id, { onStep = /** @type {(step: string) => void} */ (() => {}) } = {}) => {
    if (!ID_RE.test(String(id))) throw new Error("Unknown backup id.");
    if (isBusy() || running || restoring) throw new Error("An update, a backup or a restore is running; try again when it has finished.");
    restoring = true;
    onStepRef.current = onStep;
    try {
      const dir = path.join(dailyDir, id);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
      for (const [file, info] of Object.entries(manifest.files ?? {})) {
        const actual = await sha256File(path.join(dir, file));
        if (actual !== info.sha256) throw new Error(`${file} does not match its checksum: the backup is damaged.`);
      }
      return await restoreChecked(id, dir);
    } finally {
      restoring = false;
      onStepRef.current = () => {};
    }
  };

  const restoreChecked = async (id, dir) => {
    onStepRef.current("safety backup of the current state");
    const safety = await run({ label: "pre-restore" });

    onStepRef.current("stopping the office and Hermes");
    const services = ["office3d", "hermes-gate", "hermes"];
    const stopped = await exec("docker", compose("stop", ...services), { timeoutMs: 5 * 60_000 });
    if (stopped.code !== 0) throw new Error(`stop failed: ${stopped.stderr.trim().slice(-300)}`);

    // The current data is moved aside within its own volume (a rename, not a
    // copy) and moved back if anything below fails.
    const hermesAside = path.join(config.dataDir, HERMES_OUT_DIR, `previous-${id}`);
    const officeAside = path.join(config.officeStateDir, `.previous-${id}`);
    const moveAside = (root, aside, skip) => {
      fs.rmSync(aside, { recursive: true, force: true });
      fs.mkdirSync(aside, { recursive: true, mode: 0o700 });
      for (const name of fs.readdirSync(root)) {
        if (skip.has(name)) continue;
        fs.renameSync(path.join(root, name), path.join(aside, name));
      }
    };
    const moveBack = (root, aside, skip) => {
      if (!fs.existsSync(aside)) return;
      for (const name of fs.readdirSync(root)) {
        if (skip.has(name)) continue;
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
      }
      for (const name of fs.readdirSync(aside)) fs.renameSync(path.join(aside, name), path.join(root, name));
      fs.rmSync(aside, { recursive: true, force: true });
    };
    const hermesSkip = new Set(["backups"]);
    const officeSkip = new Set([path.basename(officeAside)]);

    let failure = null;
    try {
      onStepRef.current("replacing the Hermes data");
      moveAside(config.dataDir, hermesAside, hermesSkip);
      const staged = path.join(config.dataDir, HERMES_OUT_DIR, `restore-${id}.zip`);
      fs.copyFileSync(path.join(dir, "hermes.zip"), staged);
      const imported = await exec(
        "docker",
        compose("run", "--rm", "--no-deps", "-T", "-u", "hermes", "--entrypoint", "hermes", "hermes", "import", "--force", `/opt/data/${HERMES_OUT_DIR}/restore-${id}.zip`),
        { timeoutMs: 60 * 60_000 },
      );
      fs.rmSync(staged, { force: true });
      if (imported.code !== 0) throw new Error(`hermes import failed: ${(imported.stderr || imported.stdout).trim().slice(-400)}`);

      onStepRef.current("replacing the office state");
      moveAside(config.officeStateDir, officeAside, officeSkip);
      const untar = await exec("tar", ["-xzf", path.join(dir, "office3d-state.tar.gz"), "-C", config.officeStateDir], { timeoutMs: 30 * 60_000 });
      if (untar.code !== 0) throw new Error(`office state restore failed: ${untar.stderr.trim().slice(-300)}`);
      fs.rmSync(hermesAside, { recursive: true, force: true });
      fs.rmSync(officeAside, { recursive: true, force: true });
    } catch (err) {
      failure = err;
      onStepRef.current("putting the previous state back");
      moveBack(config.dataDir, hermesAside, hermesSkip);
      moveBack(config.officeStateDir, officeAside, officeSkip);
    } finally {
      onStepRef.current("starting everything");
      await exec("docker", compose("up", "-d", "hermes", "hermes-gate", "office3d"), { timeoutMs: 10 * 60_000 });
    }
    if (failure) throw failure;
    log(`Restored backup ${id} (the state before it is backup ${safety.id}).`);
    return { restored: id, safety: safety.id };
  };

  return { run, status, list, start, stop, restore, prune, isRunning: () => Boolean(running) || restoring };
};

module.exports = { createBackups, clockIn, ID_RE };
