// What each agent can do and what it remembers, through Hermes' own settings:
//
//   - toolsets: which of Hermes' tool groups an agent has on the API-server
//     platform (the one the office talks to), from `platform_toolsets.api_server`
//     in the profile's config.yaml. Hermes builds each run's tools from that
//     list, so a change applies from the agent's next run;
//   - memory: Hermes' built-in memory — MEMORY.md (the agent's notes) and
//     USER.md (what it knows about the person), entries separated by "\n§\n",
//     each file with a character budget. A session reads memory once, at its
//     start, so an edit reaches new sessions;
//   - MCP servers the person adds: stored and connected by Hermes (its
//     housekeeping picks up changes within about a minute). The office's own
//     server entries are managed by the office and cannot be changed here.
//
// None of this is open to agents: only the person, through the office.

const crypto = require("node:crypto");

const DEFAULT_PROFILE = "default";
const MAIN_AGENT_ID = "main";
const ENTRY_DELIMITER = "\n§\n";
const MEMORY_FILES = { memory: "MEMORY.md", user: "USER.md" };
const DEFAULT_LIMITS = { memory: 2200, user: 1375 };
const MAX_ENTRIES = 200;
// Toolsets the office never offers: speech-to-text is switched in its own
// config section, the context engine is supplied at run time.
const HIDDEN_TOOLSETS = new Set(["stt", "context_engine"]);
// The main agent lays out the board with Hermes' kanban tools.
const MAIN_REQUIRED_TOOLSETS = new Set(["kanban"]);
const RESERVED_MCP = new Set(["office3d", "office3d_team"]);
const TOOLSET_RE = /^[a-z0-9_-]{1,64}$/;
const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const MCP_ACTION_RE = /^mcp-install-[a-z0-9-]{1,48}-[0-9a-f]{8}$/;

const str = (value) => (typeof value === "string" ? value.trim() : "");
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const hashOf = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const parseEntries = (raw) => raw.split(ENTRY_DELIMITER).map((entry) => entry.trim()).filter(Boolean);

/**
 * @param {object} deps
 * @param {any} deps.client
 * @param {(agentId: string) => Promise<string>} deps.profileFor   validates the agent, returns its profile
 * @param {(opts?: {fresh?: boolean}) => Promise<Array<{name: string, path?: string}>>} deps.listProfiles
 * @param {() => boolean} deps.hasDashboard
 * @param {typeof import("./client").HermesApiError} deps.HermesApiError
 * @param {new (code: string, message: string) => Error} deps.AdapterError
 * @param {(message: string) => void} [deps.log]
 */
const createCapabilityHandlers = ({ client, profileFor, listProfiles, hasDashboard, HermesApiError, AdapterError, log = () => {} }) => {
  const invalid = (message) => new AdapterError("INVALID_REQUEST", message);
  const requireDashboard = () => {
    if (!hasDashboard()) throw new AdapterError("UNAVAILABLE", "Эти настройки доступны при подключённой панели Hermes.");
  };
  const profileOfRequest = async (p) => {
    requireDashboard();
    return profileFor(str(p?.agentId) || MAIN_AGENT_ID);
  };

  // One change at a time per profile and kind: each is read-modify-write.
  const locks = new Map();
  const withLock = (key, task) => {
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    const tail = next.catch(() => {});
    locks.set(key, tail);
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return next;
  };

  // --- toolsets -------------------------------------------------------------

  const readToolsets = async (profile) => {
    const result = await client.toolsets(profile);
    const rows = Array.isArray(result?.data) ? result.data.filter(isRecord) : [];
    return rows
      .filter((row) => TOOLSET_RE.test(str(row.name)) && !HIDDEN_TOOLSETS.has(str(row.name)))
      .map((row) => ({
        name: str(row.name),
        label: str(row.label) || str(row.name),
        description: str(row.description),
        enabled: row.enabled === true,
        // False when the toolset needs a key or a service Hermes cannot find.
        configured: row.configured !== false,
        tools: Array.isArray(row.tools) ? row.tools.slice(0, 60).map((tool) => String(tool)) : [],
        locked: profile === DEFAULT_PROFILE && MAIN_REQUIRED_TOOLSETS.has(str(row.name)),
      }));
  };

  // --- memory ---------------------------------------------------------------

  const memoryPaths = async (profile) => {
    const profiles = await listProfiles({ fresh: true });
    const home = str(profiles.find((entry) => entry.name === profile)?.path);
    if (!home || !home.startsWith("/")) throw new AdapterError("UNAVAILABLE", "Hermes не сообщил, где лежит профиль агента.");
    const dir = `${home.replace(/\/+$/, "")}/memories`;
    return { memory: `${dir}/${MEMORY_FILES.memory}`, user: `${dir}/${MEMORY_FILES.user}` };
  };

  const readRaw = async (path) => {
    try {
      const result = await client.dashboard("/api/fs/read-text", { query: { path } });
      if (result?.truncated || result?.binary) throw new AdapterError("CONFLICT", "Файл памяти слишком велик или повреждён; разберите его в Hermes.");
      return typeof result?.text === "string" ? result.text.replace(/^﻿/, "") : "";
    } catch (err) {
      if (err instanceof HermesApiError && err.status === 404) return "";
      throw err;
    }
  };

  const memorySettings = async (profile) => {
    const config = await client.dashboard("/api/config", { query: { profile } });
    const memory = isRecord(config?.memory) ? config.memory : {};
    const limit = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);
    return {
      provider: str(memory.provider) || null,
      limits: { memory: limit(memory.memory_char_limit, DEFAULT_LIMITS.memory), user: limit(memory.user_char_limit, DEFAULT_LIMITS.user) },
      enabled: { memory: memory.memory_enabled !== false, user: memory.user_profile_enabled !== false },
    };
  };

  const describeMemory = async (profile) => {
    const [paths, settings] = await Promise.all([memoryPaths(profile), memorySettings(profile)]);
    const targets = {};
    for (const target of Object.keys(MEMORY_FILES)) {
      const raw = await readRaw(paths[target]);
      const entries = parseEntries(raw);
      targets[target] = {
        entries,
        chars: entries.join(ENTRY_DELIMITER).length,
        limit: settings.limits[target],
        enabled: settings.enabled[target],
        version: hashOf(raw),
      };
    }
    return { provider: settings.provider, targets };
  };

  // --- MCP servers ----------------------------------------------------------

  const summarizeServer = (row) => ({
    name: str(row.name),
    transport: str(row.transport) || "unknown",
    url: str(row.url) || null,
    command: str(row.command) || null,
    args: Array.isArray(row.args) ? row.args.map((arg) => String(arg)) : [],
    // Hermes returns env values redacted.
    env: isRecord(row.env) ? row.env : {},
    auth: str(row.auth) || "none",
    enabled: row.enabled !== false,
    source: str(row.source) || "config",
    plugin: str(row.plugin) || null,
    managed: RESERVED_MCP.has(str(row.name)),
  });

  const assertChangeable = (name) => {
    if (!MCP_NAME_RE.test(name)) throw invalid("Имя MCP-сервера: латиница, цифры, «-» и «_», до 64 символов.");
    if (RESERVED_MCP.has(name)) throw new AdapterError("FORBIDDEN", "Этот сервер — доступ агента к офису; им управляет Office3D.");
  };

  const targetProfiles = async (p) => {
    if (str(p?.agentId) !== "all") return [await profileOfRequest(p)];
    requireDashboard();
    return (await listProfiles({ fresh: true })).map((entry) => entry.name);
  };

  /** The body Hermes' POST /api/mcp/servers takes, validated. */
  const serverBody = (p) => {
    const name = str(p.name);
    assertChangeable(name);
    const url = str(p.url);
    const command = str(p.command);
    if (Boolean(url) === Boolean(command)) throw invalid("Укажите либо адрес (HTTP), либо команду запуска (stdio).");
    const auth = str(p.auth) || "none";
    if (auth === "oauth") {
      throw new AdapterError("UNSUPPORTED", "Серверы со входом через OAuth подключаются в панели Hermes: вход открывается в браузере на её стороне.");
    }
    if (!["none", "header"].includes(auth)) throw invalid("Неизвестный способ входа.");
    const body = { name };
    if (url) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw invalid("Неверный адрес сервера.");
      }
      if (!["http:", "https:"].includes(parsed.protocol)) throw invalid("Адрес сервера должен начинаться с http:// или https://.");
      body.url = url;
      body.auth = auth;
      if (auth === "header") {
        const token = str(p.bearerToken);
        if (!token || token.length > 4096) throw invalid("Нужен токен доступа.");
        body.bearer_token = token;
      }
    } else {
      if (auth !== "none") throw invalid("Серверам с командой запуска токен передаётся через переменные окружения.");
      if (command.length > 500) throw invalid("Слишком длинная команда.");
      body.command = command;
      const args = Array.isArray(p.args) ? p.args : [];
      if (args.length > 50 || args.some((arg) => typeof arg !== "string" || arg.length > 1000)) throw invalid("Неверные аргументы команды.");
      body.args = args;
      const env = isRecord(p.env) ? p.env : {};
      const entries = Object.entries(env);
      if (entries.length > 50 || entries.some(([key, value]) => !ENV_NAME_RE.test(key) || typeof value !== "string" || value.length > 4096)) {
        throw invalid("Переменные окружения: имена ЗАГЛАВНЫМИ_БУКВАМИ, значения — строки.");
      }
      body.env = env;
    }
    return body;
  };

  const handlers = {
    /** The agent's toolsets on the platform the office talks to. */
    async "hermes.toolsets.list"(p) {
      const profile = await profileOfRequest(p);
      return { toolsets: await readToolsets(profile) };
    },

    async "hermes.toolsets.set"(p) {
      const profile = await profileOfRequest(p);
      const name = str(p.name);
      if (!TOOLSET_RE.test(name) || typeof p.enabled !== "boolean") throw invalid("Нужны набор инструментов и включён ли он.");
      return withLock(`toolsets:${profile}`, async () => {
        const rows = await readToolsets(profile);
        const row = rows.find((entry) => entry.name === name);
        if (!row) throw new AdapterError("NOT_FOUND", "Такого набора инструментов у Hermes нет.");
        if (row.locked && !p.enabled) throw new AdapterError("FORBIDDEN", "Главному агенту нужна доска задач Hermes: без неё он не раздаёт работу.");
        if (row.enabled === p.enabled) return { toolsets: rows };
        // The saved list is what Hermes reports enabled, changed by this one
        // toolset. Entries that are not toolsets (MCP server names, custom
        // toolsets) stay as they were: an MCP name there is an allowlist.
        const config = await client.dashboard("/api/config", { query: { profile } });
        const saved = config?.platform_toolsets?.api_server;
        const known = new Set(rows.map((entry) => entry.name).concat([...HIDDEN_TOOLSETS]));
        const passthrough = (Array.isArray(saved) ? saved.map(String) : []).filter((entry) => !known.has(entry) && !entry.startsWith("hermes-"));
        const enabled = rows.filter((entry) => entry.enabled && entry.name !== name).map((entry) => entry.name);
        if (p.enabled) enabled.push(name);
        await client.dashboard("/api/config", {
          method: "PUT",
          query: { profile },
          body: { config: { platform_toolsets: { api_server: [...enabled, ...passthrough] } } },
        });
        const after = await readToolsets(profile);
        if (after.find((entry) => entry.name === name)?.enabled !== p.enabled) {
          throw new AdapterError("CONFLICT", "Hermes не применил изменение: этот набор недоступен агентам, работающим через API.");
        }
        log(`Toolset ${name} ${p.enabled ? "enabled" : "disabled"} for ${profile}.`);
        return { toolsets: after };
      });
    },

    /** The agent's memory: its notes and what it knows about the person. */
    async "hermes.memory.get"(p) {
      const profile = await profileOfRequest(p);
      return describeMemory(profile);
    },

    /**
     * Replaces one memory file with the given entries. `version` is what the
     * person edited; if the agent wrote to its memory since, nothing is
     * overwritten and the office shows the new memory instead.
     */
    async "hermes.memory.set"(p) {
      const profile = await profileOfRequest(p);
      const target = str(p.target);
      if (!Object.hasOwn(MEMORY_FILES, target)) throw invalid("Неизвестная память.");
      if (!Array.isArray(p.entries) || p.entries.length > MAX_ENTRIES || p.entries.some((entry) => typeof entry !== "string")) {
        throw invalid("Память — это список записей.");
      }
      const entries = p.entries.map((entry) => entry.replace(/\r\n?/g, "\n").trim()).filter(Boolean);
      if (entries.some((entry) => entry.includes(ENTRY_DELIMITER))) throw invalid("Запись не может содержать строку из одного «§».");
      return withLock(`memory:${profile}`, async () => {
        const [paths, settings] = await Promise.all([memoryPaths(profile), memorySettings(profile)]);
        const content = entries.join(ENTRY_DELIMITER);
        if (content.length > settings.limits[target]) {
          throw invalid(`Слишком много текста: ${content.length} из ${settings.limits[target]} символов.`);
        }
        const current = await readRaw(paths[target]);
        if (hashOf(current) !== str(p.version)) {
          throw new AdapterError("CONFLICT", "Пока вы правили, агент изменил свою память. Загрузите её заново и повторите правку.");
        }
        await client.dashboard("/api/fs/write-text", { method: "POST", body: { path: paths[target], content } });
        log(`Memory ${target} of ${profile} edited by the person (${entries.length} entries).`);
        return describeMemory(profile);
      });
    },

    /** MCP servers in the agent's profile, the office's own marked managed. */
    async "hermes.mcp.list"(p) {
      const profile = await profileOfRequest(p);
      const result = await client.dashboard("/api/mcp/servers", { query: { profile } });
      const servers = (Array.isArray(result?.servers) ? result.servers : []).filter(isRecord).map(summarizeServer);
      return { servers };
    },

    /** Adds a server to one agent or to the whole team (`agentId: "all"`). */
    async "hermes.mcp.add"(p) {
      const body = serverBody(p);
      const profiles = await targetProfiles(p);
      const added = [];
      const failed = [];
      for (const profile of profiles) {
        await withLock(`mcp:${profile}`, async () => {
          try {
            await client.dashboard("/api/mcp/servers", { method: "POST", query: { profile }, body: { ...body, profile } });
            added.push(profile);
          } catch (err) {
            if (!(err instanceof HermesApiError) || profiles.length === 1) throw err;
            failed.push({ profile, error: err.message });
          }
        });
      }
      log(`MCP server ${body.name} added for ${added.join(", ") || "nobody"}.`);
      return { ok: true, name: body.name, added, failed };
    },

    async "hermes.mcp.remove"(p) {
      const profile = await profileOfRequest(p);
      const name = str(p.name);
      assertChangeable(name);
      await withLock(`mcp:${profile}`, () =>
        client.dashboard(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: "DELETE", query: { profile } })
      );
      log(`MCP server ${name} removed from ${profile}.`);
      return { ok: true };
    },

    async "hermes.mcp.enable"(p) {
      const profile = await profileOfRequest(p);
      const name = str(p.name);
      assertChangeable(name);
      if (typeof p.enabled !== "boolean") throw invalid("Не указано, включить ли сервер.");
      await withLock(`mcp:${profile}`, () =>
        client.dashboard(`/api/mcp/servers/${encodeURIComponent(name)}/enabled`, {
          method: "PUT",
          query: { profile },
          body: { enabled: p.enabled, profile },
        })
      );
      return { ok: true, name, enabled: p.enabled };
    },

    /** Connects to the server as the agent would and lists its tools. */
    async "hermes.mcp.test"(p) {
      const profile = await profileOfRequest(p);
      const name = str(p.name);
      if (!MCP_NAME_RE.test(name)) throw invalid("Неверное имя MCP-сервера.");
      const result = await client.dashboard(`/api/mcp/servers/${encodeURIComponent(name)}/test`, {
        method: "POST",
        query: { profile },
        timeoutMs: 90_000,
      });
      return {
        ok: result?.ok === true,
        error: str(result?.error) || null,
        tools: (Array.isArray(result?.tools) ? result.tools : [])
          .filter(isRecord)
          .slice(0, 200)
          .map((tool) => ({ name: str(tool.name), description: str(tool.description).slice(0, 300) })),
      };
    },

    /** Nous' catalog of vetted MCP servers, marked installed for the agent. */
    async "hermes.mcp.catalog"(p) {
      const profile = await profileOfRequest(p);
      const result = await client.dashboard("/api/mcp/catalog", { query: { profile } });
      const entries = (Array.isArray(result?.entries) ? result.entries : []).filter(isRecord).map((entry) => ({
        name: str(entry.name),
        description: str(entry.description),
        transport: str(entry.transport),
        authType: str(entry.auth_type) || "none",
        requiredEnv: (Array.isArray(entry.required_env) ? entry.required_env : [])
          .filter(isRecord)
          .map((env) => ({ name: str(env.name), prompt: str(env.prompt), required: env.required !== false })),
        command: str(entry.command) || null,
        args: Array.isArray(entry.args) ? entry.args.map((arg) => String(arg)) : [],
        url: str(entry.url) || null,
        installUrl: str(entry.install_url) || null,
        bootstrap: Array.isArray(entry.bootstrap) ? entry.bootstrap.map((step) => String(step)) : [],
        needsInstall: entry.needs_install === true,
        installed: entry.installed === true,
        enabled: entry.enabled === true,
      }));
      return { entries };
    },

    /**
     * Installs a catalog server. One that runs a program on the Hermes
     * machine (a command, or a clone and build) installs only once the person
     * has seen what runs and confirmed.
     */
    async "hermes.mcp.install"(p) {
      const profile = await profileOfRequest(p);
      const name = str(p.name);
      if (!name || RESERVED_MCP.has(name)) throw invalid("Неверное имя сервера.");
      const { entries } = await handlers["hermes.mcp.catalog"](p);
      const entry = entries.find((candidate) => candidate.name === name);
      if (!entry) throw new AdapterError("NOT_FOUND", "В каталоге Hermes нет такого сервера.");
      if (entry.authType === "oauth") {
        throw new AdapterError("UNSUPPORTED", "Серверы со входом через OAuth подключаются в панели Hermes: вход открывается в браузере на её стороне.");
      }
      if ((entry.command || entry.needsInstall) && p.confirm !== true) {
        throw new AdapterError("CONFIRMATION_REQUIRED", "Этот сервер запускает программу на машине Hermes: посмотрите, что именно, и подтвердите.");
      }
      const env = isRecord(p.env) ? p.env : {};
      const declared = new Set(entry.requiredEnv.map((spec) => spec.name));
      for (const [key, value] of Object.entries(env)) {
        if (!declared.has(key) || typeof value !== "string" || value.length > 4096) throw invalid(`Сервер не использует переменную ${key}.`);
      }
      const missing = entry.requiredEnv.filter((spec) => spec.required && !str(env[spec.name])).map((spec) => spec.name);
      if (missing.length) throw invalid(`Нужно заполнить: ${missing.join(", ")}.`);
      const result = await withLock(`mcp:${profile}`, () =>
        client.dashboard("/api/mcp/catalog/install", { method: "POST", query: { profile }, body: { name, env, enable: true, profile } })
      );
      log(`MCP catalog server ${name} installing for ${profile}.`);
      return { ok: true, name, background: result?.background === true, action: str(result?.action) || null };
    },

    /** Progress of a background catalog install. */
    async "hermes.mcp.action"(p) {
      requireDashboard();
      const name = str(p.action);
      if (!MCP_ACTION_RE.test(name)) throw invalid("Неизвестное действие.");
      const result = await client.dashboard(`/api/actions/${encodeURIComponent(name)}/status`, { query: { lines: 20 } });
      return {
        running: Boolean(result?.running),
        exitCode: typeof result?.exit_code === "number" ? result.exit_code : null,
        lines: Array.isArray(result?.lines) ? result.lines.slice(-20).map((line) => String(line).slice(0, 300)) : [],
      };
    },
  };

  return handlers;
};

module.exports = { createCapabilityHandlers, ENTRY_DELIMITER };
