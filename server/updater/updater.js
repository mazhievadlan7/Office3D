// Hermes updates: the job that moves the Hermes container to a new image and
// back again when the new one does not come up healthy.
//
// This runs in its own container (office3d-updater), the only one with the
// Docker socket; the office never touches Docker. It drives the same compose
// project the person started, so a later `docker compose up` keeps the new
// version: the chosen tag is written to the project's .env (HERMES_IMAGE_TAG).
//
// An update, step by step:
//   1. pull     the new image while Hermes keeps running;
//   2. stop     hermes-gate and hermes (agents pause);
//   3. backup   the Hermes data volume to a tarball (state.db, profiles,
//               memory, kanban) — a new Hermes may migrate it on start;
//   4. switch   HERMES_IMAGE_TAG in .env and `compose up -d` both services;
//   5. check    Hermes' API and the dashboard gate answer, several times in
//               a row, within a deadline.
// When the check fails: stop, restore the data from the backup, switch the
// tag back, start, and check again. The last few backups are kept.
//
// Commands and HTTP go through injected functions, so the whole sequence is
// testable without Docker.

const fs = require("node:fs");
const path = require("node:path");

const TAG_RE = /^v(\d{4})\.(\d{1,2})\.(\d{1,2})(?:\.(\d{1,3}))?$/;
const KEEP_BACKUPS = 3;

/** The numbers of a release tag (vYYYY.M.D[.N]), or null for anything else. */
const parseTag = (tag) => {
  const match = TAG_RE.exec(String(tag ?? ""));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 0)] : null;
};

const compareTags = (a, b) => {
  const left = parseTag(a);
  const right = parseTag(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 4; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
};

/** Release tags newer than `current`, newest first. */
const newerTags = (tags, current) =>
  [...new Set(tags.filter((tag) => parseTag(tag) && (!parseTag(current) || compareTags(tag, current) > 0)))].sort((a, b) =>
    compareTags(b, a),
  );

/** .env text with KEY set to value (added when missing), other lines untouched. */
const setEnvValue = (text, key, value) => {
  const lines = String(text ?? "").split("\n");
  const index = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
  if (index === -1) {
    if (lines.length && lines[lines.length - 1] === "") lines.splice(lines.length - 1, 0, `${key}=${value}`);
    else lines.push(`${key}=${value}`);
  } else {
    lines[index] = `${key}=${value}`;
  }
  return lines.join("\n");
};

const readEnvValue = (text, key) => {
  const line = String(text ?? "")
    .split("\n")
    .find((row) => new RegExp(`^\\s*${key}\\s*=`).test(row));
  return line ? line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") : "";
};

/**
 * @param {object} deps
 * @param {(cmd: string, args: string[], opts?: {timeoutMs?: number}) => Promise<{code: number, stdout: string, stderr: string}>} deps.exec
 * @param {() => Promise<string[]>} deps.listTags            release tags of the Hermes image
 * @param {(url: string) => Promise<boolean>} deps.probe     one health request
 * @param {object} deps.config
 * @param {string} deps.config.project           compose project name
 * @param {string} deps.config.projectDir        where docker-compose.yml and .env are
 * @param {string} deps.config.imageRepo         e.g. nousresearch/hermes-agent
 * @param {string} deps.config.defaultTag        the compose file's default tag
 * @param {string} deps.config.dataDir           the Hermes data volume, mounted
 * @param {string} deps.config.backupDir
 * @param {string[]} deps.config.healthUrls
 * @param {string[]} [deps.config.services]      compose services to restart (hermes first)
 * @param {number} [deps.config.healthDeadlineMs]
 * @param {number} [deps.config.healthIntervalMs]
 * @param {number} [deps.config.healthStreak]    consecutive good checks needed
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {(message: string) => void} [deps.log]
 */
const createUpdater = ({
  exec,
  listTags,
  probe,
  config,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
}) => {
  const services = config.services ?? ["hermes", "hermes-gate"];
  const envFile = path.join(config.projectDir, ".env");
  const stateFile = path.join(config.backupDir, "updater-state.json");
  const healthDeadlineMs = config.healthDeadlineMs ?? 180_000;
  const healthIntervalMs = config.healthIntervalMs ?? 3_000;
  const healthStreak = config.healthStreak ?? 3;

  const readState = () => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
      return { job: null, history: [] };
    }
  };
  let state = readState();
  // A job that was running when the updater stopped did not finish; say so
  // rather than pretend it is still going.
  if (state.job && !["done", "rolled_back", "failed", "rollback_failed"].includes(state.job.status)) {
    state.job = { ...state.job, status: "failed", error: "Сервис обновлений перезапустился во время обновления.", finishedAt: new Date(now()).toISOString() };
  }
  const saveState = () => {
    fs.mkdirSync(config.backupDir, { recursive: true });
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, stateFile);
  };

  const compose = (...args) => ["compose", "-p", config.project, "--project-directory", config.projectDir, ...args];

  const run = async (label, cmd, args, timeoutMs) => {
    log(`${label}: ${cmd} ${args.join(" ")}`);
    const result = await exec(cmd, args, { timeoutMs });
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" ").slice(0, 400);
      throw new Error(`${label}: ${detail || `код ${result.code}`}`);
    }
    return result.stdout;
  };

  /**
   * The version Hermes runs now: the tag in .env, else the running
   * container's image tag, else the compose file's default. "" when none of
   * them is a release tag — then there is nothing to roll back to.
   */
  const currentTag = async () => {
    const env = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
    const fromEnv = readEnvValue(env, "HERMES_IMAGE_TAG");
    if (parseTag(fromEnv)) return fromEnv;
    const images = await exec("docker", compose("images", services[0], "--format", "json"), { timeoutMs: 30_000 }).catch(() => null);
    if (images?.code === 0) {
      try {
        const rows = JSON.parse(images.stdout || "[]");
        const tag = (Array.isArray(rows) ? rows : [rows]).map((row) => row?.Tag).find((value) => parseTag(value));
        if (tag) return tag;
      } catch {
        // Older compose prints one JSON object per line; fall through.
      }
    }
    return parseTag(config.defaultTag) ? config.defaultTag : "";
  };

  const writeTag = (tag) => {
    const env = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
    const tmp = `${envFile}.office3d-updater.tmp`;
    fs.writeFileSync(tmp, setEnvValue(env, "HERMES_IMAGE_TAG", tag), { mode: 0o600 });
    fs.renameSync(tmp, envFile);
  };

  const step = (name) => {
    state.job.step = name;
    state.job.steps.push({ name, at: new Date(now()).toISOString() });
    saveState();
    log(`Update ${state.job.id}: ${name}`);
  };

  /** True once every health URL answered `healthStreak` times in a row. */
  const healthy = async () => {
    const deadline = now() + healthDeadlineMs;
    let streak = 0;
    while (now() < deadline) {
      const results = await Promise.all(config.healthUrls.map((url) => probe(url).catch(() => false)));
      streak = results.every(Boolean) ? streak + 1 : 0;
      if (streak >= healthStreak) return true;
      await sleep(healthIntervalMs);
    }
    return false;
  };

  const backupPath = (tag) => path.join(config.backupDir, `hermes-data-${new Date(now()).toISOString().replace(/[:.]/g, "-")}-${tag}.tgz`);

  const pruneBackups = () => {
    const files = fs
      .readdirSync(config.backupDir)
      .filter((name) => /^hermes-data-.*\.tgz$/.test(name))
      .sort();
    for (const name of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) {
      fs.rmSync(path.join(config.backupDir, name), { force: true });
    }
  };

  const restoreData = async (archive) => {
    // Empty the volume (dotfiles included) and unpack the backup into it.
    await run("очистка данных", "sh", ["-c", `find "${config.dataDir}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +`], 10 * 60_000);
    await run("восстановление данных", "tar", ["-xzf", archive, "-C", config.dataDir], 30 * 60_000);
  };

  const perform = async (from, to) => {
    const job = state.job;
    step("pull");
    const image = `${config.imageRepo}:${to}`;
    const present = await exec("docker", ["image", "inspect", image], { timeoutMs: 30_000 });
    if (present.code !== 0) await run("загрузка образа", "docker", ["pull", image], 60 * 60_000);
    step("stop");
    await run("остановка Hermes", "docker", compose("stop", ...[...services].reverse()), 5 * 60_000);
    step("backup");
    fs.mkdirSync(config.backupDir, { recursive: true });
    const archive = backupPath(from);
    await run("резервная копия", "tar", ["-czf", archive, "-C", config.dataDir, "."], 60 * 60_000);
    job.backup = archive;
    step("start");
    writeTag(to);
    await run("запуск Hermes", "docker", compose("up", "-d", ...services), 10 * 60_000);
    step("check");
    if (await healthy()) {
      pruneBackups();
      return "done";
    }
    // Rollback: the old image, the old data.
    job.error = "Новая версия не прошла проверку.";
    step("rollback");
    await run("остановка Hermes", "docker", compose("stop", ...[...services].reverse()), 5 * 60_000);
    await restoreData(archive);
    writeTag(from);
    await run("запуск прежней версии", "docker", compose("up", "-d", ...services), 10 * 60_000);
    step("check-rollback");
    if (await healthy()) return "rolled_back";
    job.error = "Не удалось вернуть прежнюю версию: Hermes не отвечает. Нужна помощь администратора.";
    return "rollback_failed";
  };

  /** Starts an update to `tag`; returns the job at once. */
  const start = async (tag) => {
    if (state.job && !["done", "rolled_back", "failed", "rollback_failed"].includes(state.job.status)) {
      const error = new Error("Обновление уже идёт.");
      error.status = 409;
      throw error;
    }
    const from = await currentTag();
    if (!from) {
      const error = new Error("Не удалось определить текущую версию Hermes — откатываться было бы некуда.");
      error.status = 409;
      throw error;
    }
    if (!parseTag(tag)) {
      const error = new Error("Неизвестная версия.");
      error.status = 400;
      throw error;
    }
    const available = await listTags();
    if (!available.includes(tag)) {
      const error = new Error(`Версии ${tag} нет в реестре образов.`);
      error.status = 400;
      throw error;
    }
    if (tag === from) {
      const error = new Error("Эта версия уже установлена.");
      error.status = 400;
      throw error;
    }
    state.job = {
      id: `upd_${now().toString(36)}`,
      from,
      to: tag,
      status: "running",
      step: "queued",
      steps: [],
      startedAt: new Date(now()).toISOString(),
      finishedAt: null,
      backup: null,
      error: null,
    };
    saveState();
    const job = state.job;
    (async () => {
      let status;
      try {
        status = await perform(from, tag);
      } catch (err) {
        job.error = err?.message ?? String(err);
        status = "failed";
        // A failure before the switch leaves the old version in place, but it
        // may be stopped: bring it back.
        await exec("docker", compose("up", "-d", ...services), { timeoutMs: 10 * 60_000 }).catch(() => {});
      }
      job.status = status;
      job.finishedAt = new Date(now()).toISOString();
      state.history = [{ ...job, steps: undefined }, ...(state.history ?? [])].slice(0, 20);
      saveState();
      log(`Update ${job.id} ${status}${job.error ? `: ${job.error}` : ""}`);
    })();
    return job;
  };

  let tagsCache = { at: 0, tags: null };
  /** Current version, newer releases and the last job. */
  const status = async ({ refresh = false } = {}) => {
    const current = await currentTag();
    if (refresh || !tagsCache.tags || now() - tagsCache.at > 60 * 60_000) {
      tagsCache = { at: now(), tags: await listTags() };
    }
    const newer = newerTags(tagsCache.tags, current);
    return { current, latest: newer[0] ?? current, newer, job: state.job, history: state.history ?? [], checkedAt: new Date(tagsCache.at).toISOString() };
  };

  const isRunning = () => Boolean(state.job && !["done", "rolled_back", "failed", "rollback_failed"].includes(state.job.status));

  return { start, status, currentTag, isRunning };
};

module.exports = { createUpdater, parseTag, compareTags, newerTags, setEnvValue, readEnvValue };
