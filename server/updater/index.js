// office3d-updater: the small internal service that updates Hermes.
//
// The only container with the Docker socket. It listens on the compose
// network (never published) and answers only requests that carry its token:
//   GET  /health            liveness, no token
//   GET  /status[?refresh]  current version, newer releases, last job
//   POST /update {tag}      start an update (see updater.js)
//   GET  /backups           daily backups: schedule, last run, the list
//   POST /backups           take a backup now
//   POST /backups/<id>/restore  restore one (streams progress); accepted only
//                           from inside this container: scripts/office3d-backup.sh
//
// Configuration (environment):
//   OFFICE3D_UPDATER_TOKEN  shared with office3d, at least 32 characters
//   UPDATER_HOST/PORT       default 0.0.0.0:3020
//   COMPOSE_PROJECT         compose project; read from this container's own
//                           labels when unset
//   PROJECT_DIR             docker-compose.yml and .env, mounted (/project)
//   HERMES_IMAGE_REPO       default nousresearch/hermes-agent
//   HERMES_DATA_DIR         the hermes-data volume, mounted (/hermes-data)
//   BACKUP_DIR              default /backups
//   HEALTH_URLS             comma-separated; default Hermes API and the gate
//   UPDATER_TAGS            comma-separated release tags to offer instead of
//                           asking Docker Hub (a private registry, or tests)
//   OFFICE_STATE_DIR        the office's state volume, mounted (/office-state)
//   BACKUP_TIME             daily backup time HH:MM (default 03:30; empty: off)
//   BACKUP_TIMEZONE         its time zone (default: UTC)
//   BACKUP_KEEP             daily backups to keep (default 7)

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createUpdater, parseTag } = require("./updater");
const { createBackups } = require("./backups");

const env = process.env;
const log = (message) => console.info(`[updater] ${message}`);

const exec = (cmd, args, { timeoutMs = 10 * 60_000 } = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const cap = (text, chunk) => (text.length > 1_000_000 ? text : text + chunk);
    child.stdout.on("data", (chunk) => (stdout = cap(stdout, chunk.toString())));
    child.stderr.on("data", (chunk) => (stderr = cap(stderr, chunk.toString())));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: String(err?.message ?? err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

/** Release tags of the image on Docker Hub (a few pages, newest first). */
const dockerHubTags = (repo) => async () => {
  const tags = [];
  let url = `https://hub.docker.com/v2/repositories/${repo}/tags?page_size=100&ordering=last_updated`;
  for (let page = 0; page < 3 && url; page += 1) {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Docker Hub answered ${response.status}`);
    const body = await response.json();
    for (const row of Array.isArray(body.results) ? body.results : []) {
      if (parseTag(row?.name)) tags.push(row.name);
    }
    url = typeof body.next === "string" ? body.next : null;
  }
  return tags;
};

const probe = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
  return response.ok;
};

const composeDefaultTag = (projectDir) => {
  try {
    const text = fs.readFileSync(path.join(projectDir, "docker-compose.yml"), "utf8");
    return /image:\s*\S+?:\$\{HERMES_IMAGE_TAG:-([^}]+)\}/.exec(text)?.[1] ?? "";
  } catch {
    return "";
  }
};

const detectProject = async () => {
  if (env.COMPOSE_PROJECT?.trim()) return env.COMPOSE_PROJECT.trim();
  const self = env.HOSTNAME?.trim();
  if (!self) return "";
  const result = await exec("docker", ["inspect", self, "--format", '{{ index .Config.Labels "com.docker.compose.project" }}'], {
    timeoutMs: 15_000,
  });
  return result.code === 0 ? result.stdout.trim() : "";
};

const main = async () => {
  const token = String(env.OFFICE3D_UPDATER_TOKEN ?? "").trim();
  if (token.length < 32) throw new Error("OFFICE3D_UPDATER_TOKEN must be at least 32 characters.");
  const projectDir = env.PROJECT_DIR?.trim() || "/project";
  const project = await detectProject();
  if (!project) throw new Error("Cannot tell the compose project: set COMPOSE_PROJECT.");
  const imageRepo = env.HERMES_IMAGE_REPO?.trim() || "nousresearch/hermes-agent";
  const updater = createUpdater({
    exec,
    listTags: env.UPDATER_TAGS?.trim()
      ? async () => env.UPDATER_TAGS.split(",").map((tag) => tag.trim()).filter((tag) => parseTag(tag))
      : dockerHubTags(imageRepo),
    probe,
    log,
    config: {
      project,
      projectDir,
      imageRepo,
      defaultTag: composeDefaultTag(projectDir),
      dataDir: env.HERMES_DATA_DIR?.trim() || "/hermes-data",
      backupDir: env.BACKUP_DIR?.trim() || "/backups",
      healthUrls: (env.HEALTH_URLS?.trim() || "http://hermes:8642/health,http://hermes:9120/gate/health")
        .split(",")
        .map((url) => url.trim())
        .filter(Boolean),
    },
  });

  let updateStarting = false;
  const backups = createBackups({
    exec,
    log,
    // An update being started counts too: it checks versions before it
    // marks itself running.
    isBusy: () => updateStarting || updater.isRunning(),
    currentTag: () => updater.currentTag(),
    config: {
      project,
      projectDir,
      dataDir: env.HERMES_DATA_DIR?.trim() || "/hermes-data",
      officeStateDir: env.OFFICE_STATE_DIR?.trim() || "/office-state",
      backupDir: env.BACKUP_DIR?.trim() || "/backups",
      keep: Math.min(Math.max(Number(env.BACKUP_KEEP) || 7, 1), 365),
      time: env.BACKUP_TIME === undefined ? "03:30" : env.BACKUP_TIME.trim(),
      timeZone: env.BACKUP_TIMEZONE?.trim() || "",
    },
  });
  backups.start();

  const expected = Buffer.from(token);
  const fromInside = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
  const authorized = (req) => {
    const header = String(req.headers.authorization ?? "");
    const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7).trim() : "");
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  };
  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const readJson = (req) =>
    new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 4_096) {
          reject(Object.assign(new Error("too large"), { status: 413 }));
          req.destroy();
        }
      });
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          reject(Object.assign(new Error("bad json"), { status: 400 }));
        }
      });
      req.on("error", reject);
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://updater.internal");
    try {
      if (url.pathname === "/health") return send(res, 200, { ok: true });
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      if (req.method === "GET" && url.pathname === "/status") {
        return send(res, 200, await updater.status({ refresh: url.searchParams.has("refresh") }));
      }
      if (req.method === "GET" && url.pathname === "/backups") return send(res, 200, backups.status());
      if (req.method === "POST" && url.pathname === "/backups") {
        const started = backups.run({ label: "manual" });
        started.catch(() => {});
        // Answer at once; the result shows in GET /backups.
        return send(res, 202, { started: true });
      }
      const restoreRoute = url.pathname.match(/^\/backups\/([^/]+)\/restore$/);
      if (req.method === "POST" && restoreRoute) {
        if (!fromInside(req)) return send(res, 403, { error: "Восстановление запускается только на сервере: scripts/office3d-backup.sh restore <id>." });
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        try {
          const result = await backups.restore(decodeURIComponent(restoreRoute[1]), { onStep: (step) => res.write(`… ${step}\n`) });
          res.end(`OK: restored ${result.restored}; the state before it is backup ${result.safety}.\n`);
        } catch (err) {
          res.end(`FAILED: ${err?.message ?? err}\n`);
        }
        return;
      }
      if (req.method === "POST" && url.pathname === "/update") {
        if (backups.isRunning()) return send(res, 409, { error: "Идёт резервное копирование или восстановление; обновление — после него." });
        const body = await readJson(req);
        updateStarting = true;
        let job;
        try {
          job = await updater.start(String(body?.tag ?? ""));
        } finally {
          updateStarting = false;
        }
        return send(res, 202, { job });
      }
      return send(res, 404, { error: "not found" });
    } catch (err) {
      const status = typeof err?.status === "number" ? err.status : 500;
      if (status >= 500) console.error("[updater] Request failed:", err);
      return send(res, status, { error: status >= 500 ? "Сервис обновлений не смог выполнить запрос." : err.message });
    }
  });
  const port = Number(env.UPDATER_PORT || 3020);
  server.listen(port, env.UPDATER_HOST?.trim() || "0.0.0.0", () => log(`Listening on ${port} for project «${project}».`));
  const shutdown = () => {
    backups.stop();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`[updater] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { exec, dockerHubTags, composeDefaultTag };
