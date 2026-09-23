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
  const profiles = new Map<string, { name: string; description: string; env: Record<string, string>; soul: string }>();
  profiles.set("default", { name: "default", description: "", env: { API_SERVER_KEY: DEFAULT_KEY }, soul: "" });
  const sessions = new Map<string, { id: string; profile: string; messages: Array<{ role: string; content: string; timestamp: number }> }>();
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
  const requests: Array<{ method: string; path: string; body: unknown; headers: http.IncomingHttpHeaders }> = [];
  let nextScript: FakeRunScript = { kind: "reply", deltas: ["Готово."] };
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
          profiles: [...profiles.values()].map((p) => ({ name: p.name, is_default: p.name === "default", description: p.description, model: "test-model", provider: "custom" })),
        });
      }
      if (path === "/api/profiles" && req.method === "POST") {
        const b = body as { name: string; description?: string };
        if (profiles.has(b.name)) return json(res, 400, { detail: `A profile named '${b.name}' already exists.` });
        profiles.set(b.name, { name: b.name, description: b.description ?? "", env: {}, soul: "" });
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
      const b = body as { id: string };
      if (sessions.has(b.id)) return json(res, 409, { error: { message: "Session already exists", code: "session_exists" } });
      sessions.set(b.id, { id: b.id, profile: profileName, messages: [] });
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
      play(run, nextScript);
      return json(res, 202, { run_id: id, status: "started" });
    }
    const runRoute = path.match(/^\/v1\/runs\/([^/]+)(\/events|\/stop|\/approval)?$/);
    if (runRoute) {
      const run = runs.get(runRoute[1]);
      if (!run || run.profile !== profileName) return json(res, 404, { error: { message: "Run not found" } });
      if (!runRoute[2]) return json(res, 200, { run_id: run.id, status: run.status, output: run.output });
      if (runRoute[2] === "/stop") {
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
    setNextRun(script: FakeRunScript) {
      nextScript = script;
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
};
