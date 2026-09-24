import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A small stand-in for a Hermes installation: the API server (with the
 * /p/<profile>/ multiplex prefix and per-profile keys) and the dashboard's
 * profile API. It follows the contracts in Hermes' own sources
 * (gateway/platforms/api_server*.py, hermes_cli/web_routers/profiles.py) as
 * closely as the adapter needs, so the adapter is tested against the same
 * shapes it meets in production.
 */

export type FakeRunScript =
  | { kind: "reply"; deltas: string[]; tools?: Array<{ tool: string; preview: string; result: string }> }
  | { kind: "approval"; command: string; afterApproval: string }
  | { kind: "wait-for-stop" }
  | { kind: "fail"; error: string };

type RunState = {
  id: string;
  profile: string;
  sessionId: string;
  input: string;
  instructions?: string;
  stopRequested?: boolean;
  status: string;
  events: Record<string, unknown>[];
  listeners: Set<(event: Record<string, unknown> | null) => void>;
  onApproval?: (choice: string) => void;
  onStop?: () => void;
  output?: string;
};

export const DEFAULT_KEY = "default-profile-key-0123456789";
export const DASHBOARD_TOKEN = "dashboard-session-token-0123456789";

export const createFakeHermes = async () => {
  type McpEntry = { url?: string; headers?: Record<string, string>; enabled?: boolean } & Record<string, unknown>;
  const profiles = new Map<
    string,
    { name: string; description: string; env: Record<string, string>; soul: string; mcp: Record<string, McpEntry> }
  >();
  profiles.set("default", { name: "default", description: "", env: { API_SERVER_KEY: DEFAULT_KEY }, soul: "", mcp: {} });
  const sessions = new Map<
    string,
    { id: string; profile: string; title?: string; messages: Array<{ role: string; content: string; timestamp: number }> }
  >();
  const runs = new Map<string, RunState>();
  const jobs = new Map<string, Record<string, unknown>>();
  const envCatalog: Record<string, { category: string; provider: string; provider_label: string; is_password: boolean }> = {
    OPENROUTER_API_KEY: { category: "provider", provider: "openrouter", provider_label: "OpenRouter", is_password: true },
    TAVILY_API_KEY: { category: "tool", provider: "", provider_label: "", is_password: true },
    API_SERVER_KEY: { category: "messaging", provider: "", provider_label: "", is_password: true },
  };
  const kanbanTasks = new Map<string, Record<string, unknown>>();
  let kanbanCounter = 0;
  const modelChoices = new Map<string, { provider: string; model: string }>();
  const memoryResets: string[] = [];
  const toolsets = new Map<string, Set<string>>([["default", new Set(["web", "terminal", "memory"])]]);
  const configPuts: Array<{ profile: string; config: unknown }> = [];
  const kanbanConfig: Record<string, unknown> = { auto_decompose: true, dispatch_profiles: null };
  // Skills per profile, and the hub: the verdict its scan gives each identifier.
  const skills = new Map<string, Array<{ name: string; description: string; enabled: boolean; provenance: string }>>();
  const hubPolicy: Record<string, "allow" | "ask" | "block"> = {
    "official/research/arxiv": "allow",
    "community/shady-tool": "block",
    "community/new-tool": "ask",
  };
  const installs: Array<{ profile: string; identifier: string }> = [];
  // Hermes' accounting: session rows per profile, as its state.db keeps them.
  const usageRows = new Map<string, Array<Record<string, unknown>>>();
  // Files the dashboard's /api/fs routes read and write (memory lives there).
  const files = new Map<string, string>();
  // Own model addresses per profile, as Hermes keeps them under providers:.
  const endpoints = new Map<string, Array<{ id: string; name: string; base_url: string; model: string; api_key?: string; current: boolean }>>();
  const homeOf = (name: string) => (name === "default" ? "/fake/hermes" : `/fake/hermes/profiles/${name}`);
  const memoryConfig = { memory_enabled: true, user_profile_enabled: true, memory_char_limit: 120, user_char_limit: 60, provider: "" };
  type OAuthFlow = { flow_id: string; profile: string; server_name: string; status: string; authorization_url: string | null; error: string | null; state: string; redirect_uri: string; tools: Array<{ name: string; description: string }> };
  const oauthFlows = new Map<string, OAuthFlow>();
  const oauthTokens = new Set<string>();
  const catalog = [
    { name: "linear", description: "Linear", transport: "http", auth_type: "none", required_env: [], command: null, args: [], url: "https://mcp.linear.app/mcp", install_url: null, bootstrap: [], needs_install: false },
    { name: "sqlite", description: "SQLite", transport: "stdio", auth_type: "none", required_env: [{ name: "SQLITE_PATH", prompt: "Путь к базе", required: true }], command: "uvx", args: ["mcp-server-sqlite"], url: null, install_url: null, bootstrap: [], needs_install: false },
    { name: "notion", description: "Notion", transport: "http", auth_type: "oauth", required_env: [], command: null, args: [], url: "https://mcp.notion.com/mcp", install_url: null, bootstrap: [], needs_install: false },
  ];
  const requests: Array<{ method: string; path: string; body: unknown; headers: http.IncomingHttpHeaders }> = [];
  let nextScript: FakeRunScript = { kind: "reply", deltas: ["Готово."] };
  // One-off scripts for the next runs, in order, before nextScript applies.
  const queuedScripts: FakeRunScript[] = [];
  let runCounter = 0;

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: http.IncomingMessage) =>
    new Promise<unknown>((resolve) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });

  const push = (run: RunState, event: Record<string, unknown>) => {
    const full = { run_id: run.id, timestamp: Date.now() / 1000, ...event };
    run.events.push(full);
    for (const listener of run.listeners) listener(full);
    if (String(event.event).startsWith("run.") && event.event !== "run.started") {
      for (const listener of run.listeners) listener(null);
    }
  };

  const finish = (run: RunState, text: string) => {
    run.status = "completed";
    run.output = text;
    const session = sessions.get(run.sessionId);
    session?.messages.push({ role: "user", content: run.input, timestamp: Date.now() / 1000 });
    session?.messages.push({ role: "assistant", content: text, timestamp: Date.now() / 1000 });
    push(run, { event: "run.completed", output: text, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
  };

  const play = (run: RunState, script: FakeRunScript) => {
    setTimeout(() => {
      if (script.kind === "reply") {
        for (const tool of script.tools ?? []) {
          push(run, { event: "tool.started", tool: tool.tool, preview: tool.preview });
          push(run, { event: "tool.completed", tool: tool.tool, duration: 0.1, error: false, preview: tool.result });
        }
        for (const delta of script.deltas) push(run, { event: "message.delta", delta });
        finish(run, script.deltas.join(""));
      } else if (script.kind === "approval") {
        run.status = "waiting_for_approval";
        push(run, {
          event: "approval.request",
          command: script.command,
          description: "опасная команда",
          request_id: "req-1",
          choices: ["once", "session", "always", "deny"],
        });
        run.onApproval = (choice) => {
          push(run, { event: "approval.responded", choice, request_id: "req-1" });
          if (choice === "deny") finish(run, "Отказано.");
          else finish(run, script.afterApproval);
        };
      } else if (script.kind === "wait-for-stop") {
        push(run, { event: "message.delta", delta: "Работаю" });
        run.onStop = () => {
          run.status = "cancelled";
          push(run, { event: "run.cancelled" });
        };
        // Like Hermes: a stop that came before the run got going still stops it.
        if (run.stopRequested) run.onStop();
      } else {
        run.status = "failed";
        push(run, { event: "run.failed", error: script.error });
      }
    }, 20);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    let path = url.pathname;
    const body = req.method === "GET" ? undefined : await readBody(req);
    requests.push({ method: req.method ?? "GET", path: url.pathname + url.search, body, headers: req.headers });

    // --- dashboard -------------------------------------------------------
    if (req.headers["x-hermes-session-token"] !== undefined) {
      if (req.headers["x-hermes-session-token"] !== DASHBOARD_TOKEN) return json(res, 401, { detail: "Unauthorized" });
      if (path === "/api/profiles" && req.method === "GET") {
        return json(res, 200, {
          profiles: [...profiles.values()].map((p) => ({ name: p.name, path: homeOf(p.name), is_default: p.name === "default", description: p.description, model: "test-model", provider: "custom" })),
        });
      }
      if (path === "/api/profiles" && req.method === "POST") {
        const b = body as { name: string; description?: string; clone_from?: string };
        if (profiles.has(b.name)) return json(res, 400, { detail: `A profile named '${b.name}' already exists.` });
        // Like Hermes: a clone starts with the source's config (MCP servers
        // included) and .env.
        const source = b.clone_from ? profiles.get(b.clone_from) : undefined;
        profiles.set(b.name, {
          name: b.name,
          description: b.description ?? "",
          env: source ? { ...source.env } : {},
          soul: "",
          mcp: source ? structuredClone(source.mcp) : {},
        });
        return json(res, 200, { ok: true, name: b.name });
      }
      const profileRoute = path.match(/^\/api\/profiles\/([^/]+)(\/soul|\/description|\/model)?$/);
      if (profileRoute) {
        const profile = profiles.get(decodeURIComponent(profileRoute[1]));
        if (!profile) return json(res, 404, { detail: "Profile not found" });
        if (!profileRoute[2] && req.method === "DELETE") {
          profiles.delete(profile.name);
          return json(res, 200, { ok: true });
        }
        if (profileRoute[2] === "/soul" && req.method === "GET") return json(res, 200, { content: profile.soul, exists: Boolean(profile.soul) });
        if (profileRoute[2] === "/soul" && req.method === "PUT") {
          profile.soul = (body as { content: string }).content;
          return json(res, 200, { ok: true });
        }
        if (profileRoute[2] === "/description") {
          profile.description = (body as { description: string }).description;
          return json(res, 200, { ok: true });
        }
      }
      if (path === "/api/skills" && req.method === "GET") {
        const profile = url.searchParams.get("profile") ?? "default";
        return json(res, 200, skills.get(profile) ?? [{ name: "search", description: "Поиск", enabled: true, provenance: "bundled" }]);
      }
      if (path === "/api/skills/toggle" && req.method === "PUT") {
        const b = body as { name: string; enabled: boolean; profile: string };
        const list = skills.get(b.profile) ?? [{ name: "search", description: "Поиск", enabled: true, provenance: "bundled" }];
        skills.set(b.profile, list.map((skill) => (skill.name === b.name ? { ...skill, enabled: b.enabled } : skill)));
        return json(res, 200, { ok: true, name: b.name, enabled: b.enabled });
      }
      if (path === "/api/skills/hub/official") {
        return json(res, 200, { skills: [{ identifier: "official/research/arxiv", name: "arxiv", description: "Статьи arXiv", category: "research", installed: false }] });
      }
      if (path === "/api/skills/hub/search") {
        return json(res, 200, { results: [{ identifier: "community/new-tool", name: "new-tool", trust_level: "community" }], source_counts: {}, timed_out: [], installed: {} });
      }
      if (path === "/api/skills/hub/scan") {
        const identifier = url.searchParams.get("identifier") ?? "";
        const policy = hubPolicy[identifier];
        if (!policy) return json(res, 404, { detail: `Skill not found: ${identifier}` });
        return json(res, 200, { trust_level: "community", verdict: policy === "allow" ? "safe" : "caution", summary: "проверено", policy, policy_reason: policy === "block" ? "опасный код" : null, findings: [] });
      }
      if (path === "/api/skills/hub/install" && req.method === "POST") {
        const b = body as { identifier: string; profile: string };
        installs.push({ profile: b.profile, identifier: b.identifier });
        return json(res, 200, { ok: true, pid: 4242, name: `skills-install-${b.identifier.replace(/[^a-z0-9]+/g, "-")}-deadbeef` });
      }
      const actionRoute = path.match(/^\/api\/actions\/([^/]+)\/status$/);
      if (actionRoute) {
        return json(res, 200, { name: actionRoute[1], running: false, exit_code: 0, pid: 4242, lines: ["Installed arxiv"] });
      }
      if (path === "/api/sessions" && req.method === "GET") {
        const rows = [...(usageRows.get(url.searchParams.get("profile") ?? "default") ?? [])].sort(
          (a, b) => Number(b.started_at) - Number(a.started_at)
        );
        const limit = Number(url.searchParams.get("limit") ?? 20);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        return json(res, 200, { sessions: rows.slice(offset, offset + limit), total: rows.length, limit, offset });
      }
      if (path === "/api/analytics/usage") {
        const profile = url.searchParams.get("profile") ?? "default";
        const cutoff = Date.now() / 1000 - Number(url.searchParams.get("days") ?? 30) * 86400;
        const byDay = new Map<string, Record<string, number>>();
        for (const row of usageRows.get(profile) ?? []) {
          if (Number(row.started_at) <= cutoff) continue;
          const day = new Date(Number(row.started_at) * 1000).toISOString().slice(0, 10);
          const entry = byDay.get(day) ?? { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, estimated_cost: 0, actual_cost: 0 };
          entry.input_tokens += Number(row.input_tokens ?? 0);
          entry.output_tokens += Number(row.output_tokens ?? 0);
          entry.cache_read_tokens += Number(row.cache_read_tokens ?? 0);
          entry.estimated_cost += Number(row.estimated_cost_usd ?? 0);
          entry.actual_cost += Number(row.actual_cost_usd ?? 0);
          byDay.set(day, entry);
        }
        const daily = [...byDay.entries()].sort().map(([day, entry]) => ({ day, ...entry }));
        return json(res, 200, { daily, by_model: [], totals: {}, period_days: Number(url.searchParams.get("days")) });
      }
      if (path === "/api/config" && req.method === "GET") {
        const name = url.searchParams.get("profile") ?? "default";
        const saved = toolsets.get(name);
        return json(res, 200, {
          kanban: { ...kanbanConfig },
          memory: { ...memoryConfig },
          mcp_servers: structuredClone(profiles.get(name)?.mcp ?? {}),
          ...(saved ? { platform_toolsets: { api_server: [...saved] } } : {}),
        });
      }
      if (path === "/api/providers/custom-endpoints/validate" && req.method === "POST") {
        const b = body as { base_url: string };
        if (b.base_url.includes("unreachable")) return json(res, 200, { ok: false, reachable: false, message: `Could not reach ${b.base_url}/models.`, models: [] });
        return json(res, 200, { ok: true, reachable: true, message: "", models: ["llama3.1:8b", "qwen2.5:14b"] });
      }
      const endpointRoute = path.match(/^\/api\/providers\/custom-endpoints(?:\/([^/]+))?(\/activate)?$/);
      if (endpointRoute) {
        const profile = url.searchParams.get("profile") ?? "default";
        const list = endpoints.get(profile) ?? [];
        endpoints.set(profile, list);
        const rows = () => ({ endpoints: list.map((e) => ({ id: e.id, name: e.name, base_url: e.base_url, model: e.model, models: [e.model], has_api_key: Boolean(e.api_key), is_current: e.current })) });
        if (!endpointRoute[1] && req.method === "GET") return json(res, 200, rows());
        if (!endpointRoute[1] && req.method === "POST") {
          const b = body as { id?: string; name: string; base_url: string; model: string; api_key?: string; make_default?: boolean };
          const id = b.id || b.name;
          const existing = list.find((e) => e.id === id);
          if (b.make_default) list.forEach((e) => (e.current = false));
          if (existing) Object.assign(existing, { name: b.name, base_url: b.base_url, model: b.model, api_key: b.api_key, current: Boolean(b.make_default) || existing.current });
          else list.push({ id, name: b.name, base_url: b.base_url, model: b.model, api_key: b.api_key, current: Boolean(b.make_default) });
          return json(res, 200, { ok: true, id, ...rows() });
        }
        const target = list.find((e) => e.id === decodeURIComponent(endpointRoute[1] ?? ""));
        if (!target) return json(res, 404, { detail: "custom endpoint not found" });
        if (endpointRoute[2] && req.method === "POST") {
          list.forEach((e) => (e.current = e === target));
          return json(res, 200, { ok: true, provider: target.id, model: target.model });
        }
        if (req.method === "DELETE") {
          list.splice(list.indexOf(target), 1);
          return json(res, 200, { ok: true, ...rows() });
        }
      }
      if (path === "/api/fs/read-text") {
        const target = url.searchParams.get("path") ?? "";
        if (!files.has(target)) return json(res, 404, { detail: "File not found" });
        return json(res, 200, { text: files.get(target), truncated: false, binary: false, path: target });
      }
      if (path === "/api/fs/write-text" && req.method === "POST") {
        const b = body as { path: string; content: string };
        files.set(b.path, b.content);
        return json(res, 200, { ok: true, path: b.path });
      }
      if (path === "/api/mcp/servers" && req.method === "POST") {
        const target = profiles.get(url.searchParams.get("profile") ?? "default");
        const b = body as { name: string; url?: string; command?: string; args?: string[]; env?: Record<string, string>; auth?: string; bearer_token?: string };
        if (!target) return json(res, 404, { detail: "Profile not found" });
        if (target.mcp[b.name]) return json(res, 409, { detail: `Server '${b.name}' already exists` });
        if (b.bearer_token) target.env[`MCP_${b.name.toUpperCase()}_TOKEN`] = b.bearer_token;
        target.mcp[b.name] = {
          ...(b.url ? { url: b.url } : { command: b.command, args: b.args ?? [], env: b.env ?? {} }),
          ...(b.auth === "oauth" ? { auth: "oauth" } : {}),
          ...(b.bearer_token ? { headers: { Authorization: `Bearer \${MCP_${b.name.toUpperCase()}_TOKEN}` } } : {}),
        };
        return json(res, 200, { name: b.name });
      }
      if (path === "/api/mcp/catalog") {
        const target = profiles.get(url.searchParams.get("profile") ?? "default");
        return json(res, 200, { entries: catalog.map((entry) => ({ ...entry, installed: Boolean(target?.mcp[entry.name]), enabled: Boolean(target?.mcp[entry.name]) })) });
      }
      if (path === "/api/mcp/catalog/install" && req.method === "POST") {
        const target = profiles.get(url.searchParams.get("profile") ?? "default");
        const b = body as { name: string; env: Record<string, string> };
        const entry = catalog.find((candidate) => candidate.name === b.name);
        if (!target || !entry) return json(res, 404, { detail: "No catalog entry" });
        Object.assign(target.env, b.env);
        target.mcp[b.name] = entry.url ? { url: entry.url, ...(entry.auth_type === "oauth" ? { auth: "oauth" } : {}) } : { command: entry.command ?? "", args: entry.args };
        return json(res, 200, { ok: true, name: b.name, background: false });
      }
      const mcpSubRoute = path.match(/^\/api\/mcp\/servers\/([^/]+)\/(enabled|test)$/);
      if (mcpSubRoute) {
        const target = profiles.get(url.searchParams.get("profile") ?? "default");
        const name = decodeURIComponent(mcpSubRoute[1]);
        const entry = target?.mcp[name];
        if (!entry) return json(res, 404, { detail: `Server '${name}' not found` });
        if (mcpSubRoute[2] === "enabled") {
          entry.enabled = (body as { enabled: boolean }).enabled;
          return json(res, 200, { ok: true, name, enabled: entry.enabled });
        }
        if (String(entry.url ?? "").includes("unreachable")) return json(res, 200, { ok: false, error: "Connection refused", tools: [] });
        if (entry.auth === "oauth" && !oauthTokens.has(`${url.searchParams.get("profile") ?? "default"}/${name}`)) {
          // What Hermes v2026.9.21 answers for an agent that has not signed in.
          return json(res, 200, { ok: false, error: `MCP OAuth for '${name}': non-interactive environment and no cached tokens found. Run \`hermes mcp login ${name}\` interactively first to complete initial authorization.`, tools: [] });
        }
        return json(res, 200, { ok: true, tools: [{ name: "search", description: "Поиск" }] });
      }
      if (path === "/api/config" && req.method === "PUT") {
        const name = url.searchParams.get("profile") ?? "default";
        const config = (body as { config: { platform_toolsets?: { api_server?: string[] }; mcp_servers?: Record<string, McpEntry> } }).config;
        configPuts.push({ profile: name, config });
        if (config.platform_toolsets?.api_server) toolsets.set(name, new Set(config.platform_toolsets.api_server));
        const kanbanPatch = (config as { kanban?: Record<string, unknown> }).kanban;
        if (kanbanPatch && name === "default") Object.assign(kanbanConfig, kanbanPatch);
        const target = profiles.get(name);
        for (const [server, entry] of Object.entries(config.mcp_servers ?? {})) {
          if (target) target.mcp[server] = { ...(target.mcp[server] ?? {}), ...entry };
        }
        return json(res, 200, { ok: true });
      }
      if (path === "/api/mcp/servers" && req.method === "GET") {
        const target = profiles.get(url.searchParams.get("profile") ?? "default");
        return json(res, 200, {
          servers: Object.entries(target?.mcp ?? {}).map(([name, entry]) => ({
            name,
            transport: entry.command ? "stdio" : "http",
            url: entry.url,
            command: entry.command ?? null,
            args: entry.args ?? [],
            env: Object.fromEntries(Object.keys((entry.env as Record<string, string>) ?? {}).map((key) => [key, "***"])),
            auth: entry.auth ?? (entry.headers?.Authorization ? "header" : null),
            enabled: entry.enabled !== false,
            source: "config",
          })),
        });
      }
      const authRoute = path.match(/^\/api\/mcp\/servers\/([^/]+)\/auth$/);
      if (authRoute && req.method === "POST") {
        const profile = url.searchParams.get("profile") ?? "default";
        const name = decodeURIComponent(authRoute[1]);
        const entry = profiles.get(profile)?.mcp[name];
        if (!entry) return json(res, 404, { detail: `Server '${name}' not found` });
        if (!entry.url) return json(res, 400, { detail: "stdio servers authenticate via env keys, not OAuth" });
        if (entry.headers && entry.auth !== "oauth") return json(res, 400, { detail: "This server uses header/API-key auth, not OAuth" });
        const live = [...oauthFlows.values()].filter((flow) => flow.status === "authorization_required");
        if (live.some((flow) => flow.server_name === name && flow.profile === profile)) {
          return json(res, 409, { detail: `MCP OAuth for '${name}' is already in progress` });
        }
        const redirect = String((entry.oauth as { redirect_uri?: string } | undefined)?.redirect_uri ?? `http://127.0.0.1:9119/api/mcp/oauth/callback/${name}`);
        const state = `st-${oauthFlows.size + 1}-${name}`;
        const flow: OAuthFlow = {
          flow_id: `flow-${String(oauthFlows.size + 1).padStart(20, "0")}`,
          profile,
          server_name: name,
          status: String(entry.url).includes("noregister") ? "error" : "authorization_required",
          authorization_url: `https://auth.example.com/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirect)}`,
          error: String(entry.url).includes("noregister") ? "The server responded, but no OAuth token was obtained — this provider may require a manually-registered OAuth client." : null,
          state,
          redirect_uri: redirect,
          tools: [],
        };
        if (flow.status === "error") flow.authorization_url = null;
        oauthFlows.set(flow.flow_id, flow);
        const { flow_id, server_name, status, authorization_url, error } = flow;
        return json(res, 200, { flow_id, server_name, status, authorization_url, error });
      }
      const flowRoute = path.match(/^\/api\/mcp\/oauth\/flows\/([^/]+)$/);
      if (flowRoute) {
        const flow = oauthFlows.get(decodeURIComponent(flowRoute[1]));
        if (!flow) return json(res, 404, { detail: "OAuth flow not found or expired" });
        if (req.method === "DELETE") {
          if (flow.status === "authorization_required") Object.assign(flow, { status: "error", error: "Cancelled by user" });
          return json(res, 200, { ok: true, status: flow.status });
        }
        const { flow_id, server_name, status, authorization_url, error, tools } = flow;
        return json(res, 200, { flow_id, server_name, status, authorization_url, error, tools });
      }
      const callbackRoute = path.match(/^\/api\/mcp\/oauth\/callback\/(.+)$/);
      if (callbackRoute) {
        const name = decodeURIComponent(callbackRoute[1]);
        const state = url.searchParams.get("state");
        const flow = [...oauthFlows.values()].find((candidate) => candidate.server_name === name && candidate.status === "authorization_required" && candidate.state === state);
        const html = (status: number, text: string) => {
          res.writeHead(status, { "Content-Type": "text/html" });
          res.end(text);
        };
        if (!flow) return html(404, "<h1>OAuth flow expired</h1>");
        const error = url.searchParams.get("error");
        if (error) {
          Object.assign(flow, { status: "error", error: `OAuth authorization failed: ${error}` });
          return html(400, "<h1>Authorization failed</h1>");
        }
        oauthTokens.add(`${flow.profile}/${name}`);
        Object.assign(flow, { status: "approved", tools: [{ name: "search", description: "Поиск" }] });
        return html(200, "<h1>Authorization received</h1>");
      }
      const mcpServerRoute = path.match(/^\/api\/mcp\/servers\/([^/]+)$/);
      if (mcpServerRoute && req.method === "DELETE") {
        const target = profiles.get(url.searchParams.get("profile") ?? "default");
        const name = decodeURIComponent(mcpServerRoute[1]);
        if (!target?.mcp[name]) return json(res, 404, { detail: `Server '${name}' not found` });
        delete target.mcp[name];
        return json(res, 200, { ok: true });
      }
      if (path === "/api/plugins/kanban/board") {
        const includeArchived = url.searchParams.get("include_archived") === "true";
        const columns = new Map<string, Record<string, unknown>[]>();
        for (const task of kanbanTasks.values()) {
          if (task.status === "archived" && !includeArchived) continue;
          const list = columns.get(String(task.status)) ?? [];
          list.push(task);
          columns.set(String(task.status), list);
        }
        return json(res, 200, { columns: [...columns].map(([name, tasks]) => ({ name, tasks })) });
      }
      if (path === "/api/plugins/kanban/tasks" && req.method === "POST") {
        const b = body as { title: string; body?: string; assignee?: string; triage?: boolean };
        const id = `t_${++kanbanCounter}`;
        const task = {
          id, title: b.title, body: b.body ?? null, assignee: b.assignee ?? null,
          status: b.triage ? "triage" : b.assignee ? "ready" : "todo", priority: 0,
          created_by: "dashboard", created_at: 1_790_000_000 + kanbanCounter,
        };
        kanbanTasks.set(id, task);
        return json(res, 200, { task });
      }
      const kanbanTask = path.match(/^\/api\/plugins\/kanban\/tasks\/([^/]+)(\/comments)?$/);
      if (kanbanTask) {
        const task = kanbanTasks.get(decodeURIComponent(kanbanTask[1]));
        if (!task) return json(res, 404, { detail: "task not found" });
        if (kanbanTask[2]) {
          task.comments = [...((task.comments as unknown[] | undefined) ?? []), body];
          return json(res, 200, { ok: true });
        }
        if (req.method === "GET") return json(res, 200, { task });
        if (req.method === "DELETE") {
          kanbanTasks.delete(String(task.id));
          return json(res, 200, { deleted: true });
        }
        const b = body as Record<string, unknown>;
        if (b.assignee !== undefined) task.assignee = b.assignee || null;
        if (b.status !== undefined) task.status = b.status;
        if (b.title !== undefined) task.title = b.title;
        if (b.body !== undefined) task.body = b.body;
        return json(res, 200, { task });
      }
      if (path === "/api/env" && req.method === "GET") {
        const target = profiles.get("default")!;
        return json(
          res,
          200,
          Object.fromEntries(
            Object.entries(envCatalog).map(([key, row]) => [
              key,
              { ...row, is_set: Boolean(target.env[key]), redacted_value: target.env[key] ? "…" + target.env[key].slice(-2) : null, channel_managed: false },
            ])
          )
        );
      }
      if (path === "/api/env" && req.method === "DELETE") {
        const name = url.searchParams.get("profile") ?? "default";
        delete profiles.get(name)?.env[(body as { key: string }).key];
        return json(res, 200, { ok: true });
      }
      if (path === "/api/providers/validate") {
        const b = body as { value: string };
        return json(res, 200, b.value === "bad-key" ? { ok: false, reachable: true, message: "That API key was rejected." } : { ok: true, reachable: true, message: "" });
      }
      if (path === "/api/providers/oauth") {
        return json(res, 200, { providers: [{ id: "nous", name: "Nous Portal", flow: "device_code", status: { logged_in: false } }] });
      }
      if (path === "/api/providers/oauth/nous/start") {
        return json(res, 200, { session_id: "s1", flow: "device_code", user_code: "ABCD-1234", verification_url: "https://portal.example/device", expires_in: 900, poll_interval: 3 });
      }
      if (path === "/api/providers/oauth/nous/poll/s1") return json(res, 200, { session_id: "s1", status: "approved", account_email: "boss@example.com" });
      if (path === "/api/model/info") return json(res, 200, { model: "test-model", provider: "custom" });
      if (path === "/api/memory/reset") {
        memoryResets.push(`${url.searchParams.get("profile")}:${(body as { target: string }).target}`);
        return json(res, 200, { ok: true, deleted: ["MEMORY.md"] });
      }
      const modelRoute = path.match(/^\/api\/profiles\/([^/]+)\/model$/);
      if (modelRoute && req.method === "PUT") {
        modelChoices.set(decodeURIComponent(modelRoute[1]), body as { provider: string; model: string });
        return json(res, 200, { ok: true });
      }
      if (path === "/api/env" && req.method === "PUT") {
        const name = url.searchParams.get("profile") ?? "default";
        const profile = profiles.get(name);
        if (!profile) return json(res, 404, { detail: "Profile not found" });
        const b = body as { key: string; value: string };
        profile.env[b.key] = b.value;
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { detail: "Not Found" });
    }

    // --- API server ------------------------------------------------------------
    let profileName = "default";
    const prefix = path.match(/^\/p\/([^/]+)(\/.*)$/);
    if (prefix) {
      profileName = decodeURIComponent(prefix[1]);
      path = prefix[2];
    }
    const profile = profiles.get(profileName);
    if (!profile || (profileName !== "default" && !profile.env.API_SERVER_KEY)) return json(res, 404, { error: "Not Found" });
    if (req.headers.authorization !== `Bearer ${profile.env.API_SERVER_KEY}`) {
      return json(res, 401, { error: { message: "Invalid API key", code: "invalid_api_key" } });
    }
    if (path === "/health") return json(res, 200, { status: "ok" });
    if (path === "/v1/capabilities") return json(res, 200, { version: "fake" });
    if (path === "/v1/toolsets") {
      const enabled = toolsets.get(profileName) ?? new Set();
      return json(res, 200, {
        data: ["web", "terminal", "memory", "kanban", "browser", "stt", "discord_admin"].map((name) => ({
          name,
          label: name,
          description: `Набор ${name}`,
          // Like Hermes, a toolset restricted to another platform never turns on here.
          enabled: enabled.has(name) && name !== "discord_admin",
          configured: name !== "browser",
          tools: [`${name}_tool`],
        })),
      });
    }
    if (path === "/api/model/options") {
      return json(res, 200, {
        providers: [
          { slug: "custom", name: "Custom endpoint", authenticated: true, is_current: true, models: ["test-model"], auth_type: "api_key", key_env: "" },
          { slug: "openrouter", name: "OpenRouter", authenticated: false, models: [], auth_type: "api_key", key_env: "OPENROUTER_API_KEY", warning: "paste OPENROUTER_API_KEY" },
        ],
      });
    }
    if (path === "/v1/skills") return json(res, 200, { data: [{ name: "search", description: "Поиск", enabled: true }] });

    if (path === "/api/sessions" && req.method === "POST") {
      const b = body as { id: string; title?: string };
      if (sessions.has(b.id)) return json(res, 409, { error: { message: "Session already exists", code: "session_exists" } });
      // Like Hermes: a title is unique within a profile.
      const taken = [...sessions.values()].find((s) => s.profile === profileName && b.title && s.title === b.title);
      if (taken) return json(res, 400, { error: { message: `Title already in use by session ${taken.id}`, code: "invalid_title" } });
      sessions.set(b.id, { id: b.id, profile: profileName, title: b.title, messages: [] });
      return json(res, 201, { object: "hermes.session", session: { id: b.id } });
    }
    const messagesRoute = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (messagesRoute) {
      const session = sessions.get(decodeURIComponent(messagesRoute[1]));
      if (!session) return json(res, 404, { error: { message: "Session not found", code: "session_not_found" } });
      return json(res, 200, { object: "list", data: session.messages });
    }
    const sessionRoute = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionRoute && req.method === "PATCH") return json(res, 200, { object: "hermes.session", session: {} });

    if (path === "/v1/runs" && req.method === "POST") {
      const b = body as { input: string; session_id: string; instructions?: string };
      const id = `run_${++runCounter}`;
      const run: RunState = {
        id, profile: profileName, sessionId: b.session_id, input: b.input, instructions: b.instructions,
        status: "running", events: [], listeners: new Set(),
      };
      runs.set(id, run);
      play(run, queuedScripts.shift() ?? nextScript);
      return json(res, 202, { run_id: id, status: "started" });
    }
    const runRoute = path.match(/^\/v1\/runs\/([^/]+)(\/events|\/stop|\/approval)?$/);
    if (runRoute) {
      const run = runs.get(runRoute[1]);
      if (!run || run.profile !== profileName) return json(res, 404, { error: { message: "Run not found" } });
      if (!runRoute[2]) return json(res, 200, { run_id: run.id, status: run.status, output: run.output });
      if (runRoute[2] === "/stop") {
        run.stopRequested = true;
        run.onStop?.();
        return json(res, 200, { status: "stopping" });
      }
      if (runRoute[2] === "/approval") {
        if (!run.onApproval) return json(res, 409, { error: { message: "no pending approval", code: "approval_not_pending" } });
        run.onApproval((body as { choice: string }).choice);
        return json(res, 200, { resolved: 1 });
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const write = (event: Record<string, unknown> | null) => {
        if (event === null) {
          res.end();
          return;
        }
        res.write(`event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      res.write(": keepalive\n\n");
      for (const event of run.events) write(event);
      if (["completed", "failed", "cancelled"].includes(run.status)) {
        res.end();
        return;
      }
      run.listeners.add(write);
      req.on("close", () => run.listeners.delete(write));
      return;
    }

    if (path === "/api/jobs" && req.method === "GET") {
      return json(res, 200, { jobs: [...jobs.values()].filter((job) => job.profile === profileName) });
    }
    if (path === "/api/jobs" && req.method === "POST") {
      const b = body as { name: string; schedule: string; prompt: string; paused?: boolean };
      const id = `job${jobs.size + 1}`;
      const schedule = b.schedule.startsWith("every ")
        ? { kind: "interval", minutes: Number(b.schedule.slice(6, -1)) }
        : { kind: "cron", expr: b.schedule };
      const job = { id, profile: profileName, name: b.name, prompt: b.prompt, schedule, enabled: !b.paused, state: b.paused ? "paused" : "scheduled", created_at: new Date().toISOString() };
      jobs.set(id, job);
      return json(res, 200, { job });
    }
    const jobRoute = path.match(/^\/api\/jobs\/([^/]+)(\/pause|\/resume|\/run)?$/);
    if (jobRoute) {
      const job = jobs.get(jobRoute[1]);
      if (!job) return json(res, 404, { error: "Job not found" });
      if (req.method === "DELETE") {
        jobs.delete(jobRoute[1]);
        return json(res, 200, { ok: true });
      }
      if (jobRoute[2] === "/pause") job.enabled = false;
      if (jobRoute[2] === "/resume") job.enabled = true;
      return json(res, 200, { job });
    }
    return json(res, 404, { error: "Not Found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    profiles,
    sessions,
    runs,
    jobs,
    requests,
    modelChoices,
    memoryResets,
    kanbanTasks,
    toolsets,
    configPuts,
    oauthFlows,
    oauthTokens,
    kanbanConfig,
    skills,
    installs,
    usageRows,
    files,
    endpoints,
    memoryConfig,
    homeOf,
    setNextRun(script: FakeRunScript) {
      nextScript = script;
    },
    queueRuns(...scripts: FakeRunScript[]) {
      queuedScripts.push(...scripts);
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
};
