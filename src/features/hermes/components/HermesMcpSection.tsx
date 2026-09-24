"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { useHermesControl } from "@/features/hermes/HermesControlContext";

type McpServer = {
  name: string;
  transport: string;
  url: string | null;
  command: string | null;
  args: string[];
  auth: string;
  enabled: boolean;
  source: string;
  plugin: string | null;
  managed: boolean;
};

type CatalogEntry = {
  name: string;
  description: string;
  transport: string;
  authType: string;
  requiredEnv: Array<{ name: string; prompt: string; required: boolean }>;
  command: string | null;
  args: string[];
  url: string | null;
  installUrl: string | null;
  bootstrap: string[];
  needsInstall: boolean;
  installed: boolean;
};

type OAuthClient = { clientId: string; clientSecret: string; scope: string };

type Draft = {
  kind: "http" | "stdio";
  auth: "none" | "token" | "oauth";
  name: string;
  url: string;
  token: string;
  oauthClient: OAuthClient | null;
  command: string;
  args: string;
  env: string;
  everyone: boolean;
};

const EMPTY_CLIENT: OAuthClient = { clientId: "", clientSecret: "", scope: "" };
const EMPTY_DRAFT: Draft = {
  kind: "http",
  auth: "none",
  name: "",
  url: "",
  token: "",
  oauthClient: null,
  command: "",
  args: "",
  env: "",
  everyone: false,
};

type LoginResult = {
  flowId: string;
  status: "starting" | "authorization_required" | "approved" | "error";
  error: string | null;
  tools: Array<{ name: string }>;
  authorizationUrl?: string | null;
};

/** Where one server's sign-in stands, as the section shows it. */
type Login =
  | { phase: "starting" }
  | { phase: "waiting"; flowId: string; url: string; popupBlocked: boolean }
  | { phase: "done"; text: string }
  | { phase: "failed"; text: string };

const LOGIN_POLL_MS = 2000;
// Hermes gives a sign-in 15 minutes.
const LOGIN_GIVE_UP_MS = 15 * 60_000;

const clientParams = (client: OAuthClient | null) =>
  client && client.clientId.trim()
    ? { clientId: client.clientId.trim(), clientSecret: client.clientSecret.trim(), scope: client.scope.trim() }
    : undefined;

/**
 * A blank tab, opened while the click still counts as the person's (browsers
 * block tabs opened later); the sign-in page is loaded into it once Hermes
 * has its address. It cannot reach back into the office.
 */
const openBlankTab = (): Window | null => {
  const tab = window.open("", "_blank");
  if (!tab) return null;
  try {
    tab.opener = null;
    tab.document.title = t("hermesMcp.loginWindowTitle");
    tab.document.body.textContent = t("hermesMcp.loginWindowTitle");
  } catch {}
  return tab;
};

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const parseEnv = (text: string): Record<string, string> =>
  Object.fromEntries(
    lines(text).map((line) => {
      const at = line.indexOf("=");
      return at < 0 ? [line, ""] : [line.slice(0, at).trim(), line.slice(at + 1)];
    }),
  );

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * MCP servers in the agent's Hermes profile: the person's own, added here or
 * from Hermes' catalog, and the office's own connection (shown, not editable).
 * Hermes connects a change within about a minute.
 */
export function HermesMcpSection({ agentId }: { agentId: string }) {
  const control = useHermesControl();
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [choice, setChoice] = useState<{ entry: CatalogEntry; env: Record<string, string>; confirmed: boolean } | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<string | null>(null);
  const [logins, setLogins] = useState<Record<string, Login>>({});
  const [clientFor, setClientFor] = useState<{ name: string; client: OAuthClient } | null>(null);
  const loginTimers = useRef(new Map<string, number>());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const pollRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!control) return;
    try {
      setServers((await control.call<{ servers: McpServer[] }>("hermes.mcp.list", { agentId })).servers);
    } catch (error) {
      setMessage({ kind: "error", text: describe(error) });
    }
  }, [agentId, control]);

  useEffect(() => {
    void load();
    const timers = loginTimers.current;
    return () => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, [load]);

  if (!control) return null;

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setMessage(null);
    try {
      const done = await action();
      if (done) setMessage({ kind: "ok", text: done });
    } catch (error) {
      setMessage({ kind: "error", text: describe(error) });
    } finally {
      setBusy(false);
    }
  };

  const setLogin = (name: string, login: Login | null) =>
    setLogins((current) => {
      const next = { ...current };
      if (login) next[name] = login;
      else delete next[name];
      return next;
    });

  const stopFollowing = (name: string) => {
    const timer = loginTimers.current.get(name);
    if (timer) window.clearTimeout(timer);
    loginTimers.current.delete(name);
  };

  const followLogin = (name: string, flowId: string, startedAt: number) => {
    stopFollowing(name);
    const tick = async () => {
      loginTimers.current.delete(name);
      if (Date.now() - startedAt > LOGIN_GIVE_UP_MS) {
        setLogin(name, { phase: "failed", text: t("hermesMcp.loginTimeout") });
        return;
      }
      try {
        const state = await control.call<LoginResult>("hermes.mcp.loginStatus", { flowId });
        if (state.status === "approved") {
          setLogin(name, { phase: "done", text: t("hermesMcp.loginDone", { count: state.tools.length }) });
          setTests((current) => {
            const next = { ...current };
            delete next[name];
            return next;
          });
          void load();
          return;
        }
        if (state.status === "error") {
          setLogin(name, { phase: "failed", text: state.error ?? "" });
          return;
        }
      } catch (error) {
        setLogin(name, { phase: "failed", text: describe(error) });
        return;
      }
      loginTimers.current.set(name, window.setTimeout(() => void tick(), LOGIN_POLL_MS));
    };
    loginTimers.current.set(name, window.setTimeout(() => void tick(), LOGIN_POLL_MS));
  };

  /** Signs the agent in to `name`; `tab` was opened by the click that asked. */
  const beginLogin = async (name: string, tab: Window | null, client?: OAuthClient | null) => {
    stopFollowing(name);
    setLogin(name, { phase: "starting" });
    try {
      const result = await control.call<LoginResult>("hermes.mcp.login", {
        agentId,
        name,
        origin: window.location.origin,
        client: clientParams(client ?? null),
      });
      if (result.status === "approved") {
        tab?.close();
        setLogin(name, { phase: "done", text: t("hermesMcp.loginDone", { count: result.tools.length }) });
        void load();
        return;
      }
      if (result.status === "error" || !result.authorizationUrl) {
        tab?.close();
        setLogin(name, { phase: "failed", text: result.error ?? "" });
        return;
      }
      const opened = Boolean(tab && !tab.closed);
      if (opened) tab!.location.href = result.authorizationUrl;
      setLogin(name, { phase: "waiting", flowId: result.flowId, url: result.authorizationUrl, popupBlocked: !opened });
      followLogin(name, result.flowId, Date.now());
    } catch (error) {
      tab?.close();
      setLogin(name, { phase: "failed", text: describe(error) });
    }
  };

  const login = (name: string, client?: OAuthClient | null) => {
    const tab = openBlankTab();
    setClientFor(null);
    void beginLogin(name, tab, client);
  };

  const cancelLogin = (name: string) => {
    const current = logins[name];
    stopFollowing(name);
    setLogin(name, null);
    if (current?.phase === "waiting") {
      void control.call("hermes.mcp.loginCancel", { flowId: current.flowId }).catch(() => {});
    }
  };

  const add = () => {
    if (!draft) return;
    // A tab for the sign-in, opened now: after the server is saved it would be blocked.
    const tab = draft.kind === "http" && draft.auth === "oauth" ? openBlankTab() : null;
    const oauthClient = draft.oauthClient;
    void run(async () => {
      const params: Record<string, unknown> = { agentId: draft.everyone ? "all" : agentId, name: draft.name.trim() };
      if (draft.kind === "http") {
        params.url = draft.url.trim();
        if (draft.auth === "token") {
          params.auth = "header";
          params.bearerToken = draft.token.trim();
        } else if (draft.auth === "oauth") {
          params.auth = "oauth";
        }
      } else {
        params.command = draft.command.trim();
        params.args = lines(draft.args);
        params.env = parseEnv(draft.env);
      }
      let result: { added: string[]; failed: Array<{ profile: string; error: string }>; needsLogin?: boolean };
      try {
        result = await control.call("hermes.mcp.add", params);
      } catch (error) {
        tab?.close();
        throw error;
      }
      setDraft(null);
      await load();
      if (result.needsLogin) void beginLogin(String(params.name), tab, oauthClient);
      else tab?.close();
      if (result.failed.length) {
        return t("hermesMcp.addedPartly", { failed: result.failed.map((entry) => `${entry.profile}: ${entry.error}`).join("; ") });
      }
      return result.needsLogin && draft.everyone ? t("hermesMcp.addedEveryoneOauth") : t("hermesMcp.added");
    });
  };

  const test = (name: string) =>
    run(async () => {
      setTests((current) => ({ ...current, [name]: t("hermesMcp.testing") }));
      const result = await control.call<{ ok: boolean; error: string | null; needsLogin?: boolean; tools: Array<{ name: string }> }>("hermes.mcp.test", { agentId, name });
      setTests((current) => ({
        ...current,
        [name]: result.ok
          ? t("hermesMcp.testOk", { count: result.tools.length })
          : result.needsLogin
            ? (result.error ?? "")
            : t("hermesMcp.testFailed", { error: result.error ?? "" }),
      }));
      return null;
    });

  const setEnabled = (server: McpServer) =>
    run(async () => {
      await control.call("hermes.mcp.enable", { agentId, name: server.name, enabled: !server.enabled });
      await load();
      return null;
    });

  const remove = (name: string) =>
    run(async () => {
      await control.call("hermes.mcp.remove", { agentId, name });
      setRemoving(null);
      await load();
      return t("hermesMcp.removed");
    });

  const openCatalog = () =>
    run(async () => {
      setCatalog((await control.call<{ entries: CatalogEntry[] }>("hermes.mcp.catalog", { agentId })).entries);
      return null;
    });

  const follow = (action: string) => {
    const tick = async () => {
      try {
        const state = await control.call<{ running: boolean; exitCode: number | null; lines: string[] }>("hermes.mcp.action", { action });
        if (state.running) {
          pollRef.current = window.setTimeout(() => void tick(), 2000);
          return;
        }
        setMessage(
          state.exitCode === 0
            ? { kind: "ok", text: t("hermesMcp.installed") }
            : { kind: "error", text: t("hermesMcp.installFailed", { detail: state.lines.at(-1) ?? "" }) },
        );
        void load();
      } catch (error) {
        setMessage({ kind: "error", text: describe(error) });
      }
    };
    pollRef.current = window.setTimeout(() => void tick(), 1500);
  };

  const install = () => {
    if (!choice) return;
    const tab = choice.entry.authType === "oauth" && !choice.entry.needsInstall ? openBlankTab() : null;
    void run(async () => {
      let result: { background: boolean; action: string | null; needsLogin?: boolean };
      try {
        result = await control.call("hermes.mcp.install", {
          agentId,
          name: choice.entry.name,
          env: choice.env,
          confirm: choice.confirmed,
        });
      } catch (error) {
        tab?.close();
        throw error;
      }
      setChoice(null);
      setCatalog(null);
      if (result.background && result.action) {
        tab?.close();
        follow(result.action);
        return t("hermesMcp.installing");
      }
      await load();
      if (result.needsLogin) void beginLogin(choice.entry.name, tab, null);
      else tab?.close();
      return t("hermesMcp.installed");
    });
  };

  const runsProgram = (entry: CatalogEntry) => Boolean(entry.command) || entry.needsInstall;
  const field = "min-w-0 ui-input rounded px-2 py-1 text-[11px]";

  return (
    <section className="mt-4 rounded-lg border border-border/50 bg-muted/20 px-4 py-3" data-testid="hermes-mcp">
      <div className="text-[11px] font-medium text-foreground">{t("hermesMcp.title")}</div>
      <div className="mt-1 text-[10px] text-muted-foreground">{t("hermesMcp.lead")}</div>

      <div className="mt-3 space-y-2">
        {servers === null ? <div className="text-[11px] text-muted-foreground">{t("hermesMcp.loading")}</div> : null}
        {servers?.length === 0 ? <div className="text-[11px] text-muted-foreground">{t("hermesMcp.none")}</div> : null}
        {servers?.map((server) => (
          <div key={server.name} className="rounded bg-muted/40 px-2 py-1.5 text-[11px]">
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0">
                <span className="text-foreground">{server.name}</span>
                {server.managed ? <span className="ml-2 text-cyan-700 dark:text-cyan-300">{t("hermesMcp.managed")}</span> : null}
                <span className="block truncate text-muted-foreground">
                  {server.url ?? [server.command, ...server.args].filter(Boolean).join(" ")}
                  {server.auth === "header" ? ` · ${t("hermesMcp.withToken")}` : ""}
                  {server.auth === "oauth" ? ` · ${t("hermesMcp.withOauth")}` : ""}
                </span>
              </span>
              {server.managed || server.source === "plugin" ? null : (
                <input
                  type="checkbox"
                  aria-label={t("hermesMcp.toggle", { name: server.name })}
                  checked={server.enabled}
                  disabled={busy}
                  onChange={() => void setEnabled(server)}
                />
              )}
            </div>
            {logins[server.name] ? <LoginState login={logins[server.name]} /> : null}
            {clientFor?.name === server.name ? (
              <OAuthClientFields
                client={clientFor.client}
                redirectUrl={`${window.location.origin}/oauth/mcp/${encodeURIComponent(server.name)}`}
                onChange={(client) => setClientFor({ name: server.name, client })}
                field={field}
              />
            ) : null}
            <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
              {tests[server.name] ? <span className="mr-auto text-muted-foreground">{tests[server.name]}</span> : null}
              {server.auth === "oauth" && !server.managed && server.source !== "plugin" ? (
                logins[server.name]?.phase === "waiting" || logins[server.name]?.phase === "starting" ? (
                  <button type="button" className="ui-btn-secondary px-2 py-0.5 text-[10px]" onClick={() => cancelLogin(server.name)}>
                    {t("hermesMcp.loginCancel")}
                  </button>
                ) : (
                  <>
                    {clientFor?.name === server.name ? null : (
                      <button
                        type="button"
                        className="ui-btn-secondary px-2 py-0.5 text-[10px]"
                        disabled={busy}
                        onClick={() => setClientFor({ name: server.name, client: { ...EMPTY_CLIENT } })}
                      >
                        {t("hermesMcp.clientToggle")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="ui-btn-primary px-2 py-0.5 text-[10px] font-semibold"
                      disabled={busy || (clientFor?.name === server.name && !clientFor.client.clientId.trim())}
                      onClick={() => login(server.name, clientFor?.name === server.name ? clientFor.client : null)}
                    >
                      {t("hermesMcp.login")}
                    </button>
                  </>
                )
              ) : null}
              <button type="button" className="ui-btn-secondary px-2 py-0.5 text-[10px]" disabled={busy} onClick={() => void test(server.name)}>
                {t("hermesMcp.test")}
              </button>
              {server.managed || server.source === "plugin" ? null : removing === server.name ? (
                <>
                  <button type="button" className="ui-btn-secondary px-2 py-0.5 text-[10px]" onClick={() => setRemoving(null)}>
                    {t("hermesMcp.cancel")}
                  </button>
                  <button type="button" className="ui-btn-primary px-2 py-0.5 text-[10px] font-semibold" disabled={busy} onClick={() => void remove(server.name)}>
                    {t("hermesMcp.confirmRemove")}
                  </button>
                </>
              ) : (
                <button type="button" className="ui-btn-secondary px-2 py-0.5 text-[10px]" disabled={busy} onClick={() => setRemoving(server.name)}>
                  {t("hermesMcp.remove")}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {draft ? (
        <div className="mt-3 space-y-2 rounded border border-border/50 px-3 py-2 text-[11px]" data-testid="hermes-mcp-form">
          <div className="flex gap-3 text-foreground">
            {(["http", "stdio"] as const).map((kind) => (
              <label key={kind} className="flex items-center gap-1">
                <input type="radio" checked={draft.kind === kind} onChange={() => setDraft({ ...draft, kind })} />
                {kind === "http" ? t("hermesMcp.kindHttp") : t("hermesMcp.kindStdio")}
              </label>
            ))}
          </div>
          <input className={`${field} w-full`} placeholder={t("hermesMcp.name")} aria-label={t("hermesMcp.name")} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          {draft.kind === "http" ? (
            <>
              <input className={`${field} w-full`} placeholder="https://…/mcp" aria-label={t("hermesMcp.url")} value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} />
              <div className="flex flex-wrap gap-3 text-foreground" role="radiogroup">
                {(["none", "token", "oauth"] as const).map((auth) => (
                  <label key={auth} className="flex items-center gap-1">
                    <input type="radio" checked={draft.auth === auth} onChange={() => setDraft({ ...draft, auth })} />
                    {t(auth === "none" ? "hermesMcp.authNone" : auth === "token" ? "hermesMcp.authToken" : "hermesMcp.authOauth")}
                  </label>
                ))}
              </div>
              {draft.auth === "token" ? (
                <input
                  className={`${field} w-full`}
                  type="password"
                  autoComplete="off"
                  placeholder={t("hermesMcp.token")}
                  aria-label={t("hermesMcp.token")}
                  value={draft.token}
                  onChange={(event) => setDraft({ ...draft, token: event.target.value })}
                />
              ) : null}
              {draft.auth === "oauth" ? (
                <>
                  <div className="text-[10px] text-muted-foreground">{t("hermesMcp.oauthHint")}</div>
                  <label className="flex items-center gap-2 text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={draft.oauthClient !== null}
                      onChange={(event) => setDraft({ ...draft, oauthClient: event.target.checked ? { ...EMPTY_CLIENT } : null })}
                    />
                    {t("hermesMcp.clientToggle")}
                  </label>
                  {draft.oauthClient ? (
                    <OAuthClientFields
                      client={draft.oauthClient}
                      redirectUrl={`${window.location.origin}/oauth/mcp/${encodeURIComponent(draft.name.trim() || "…")}`}
                      onChange={(oauthClient) => setDraft({ ...draft, oauthClient })}
                      field={field}
                    />
                  ) : null}
                </>
              ) : null}
            </>
          ) : (
            <>
              <div className="text-[10px] text-amber-700 dark:text-amber-300">{t("hermesMcp.stdioWarning")}</div>
              <input className={`${field} w-full`} placeholder="npx" aria-label={t("hermesMcp.command")} value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} />
              <textarea className={`${field} w-full`} placeholder={t("hermesMcp.args")} aria-label={t("hermesMcp.args")} value={draft.args} onChange={(event) => setDraft({ ...draft, args: event.target.value })} />
              <textarea
                className={`${field} w-full`}
                spellCheck={false}
                placeholder={t("hermesMcp.env")}
                aria-label={t("hermesMcp.env")}
                value={draft.env}
                onChange={(event) => setDraft({ ...draft, env: event.target.value })}
              />
            </>
          )}
          <label className="flex items-center gap-2 text-muted-foreground">
            <input type="checkbox" checked={draft.everyone} onChange={(event) => setDraft({ ...draft, everyone: event.target.checked })} />
            {t("hermesMcp.forEveryone")}
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" className="ui-btn-secondary px-2 py-1 text-[11px]" onClick={() => setDraft(null)}>
              {t("hermesMcp.cancel")}
            </button>
            <button
              type="button"
              className="ui-btn-primary px-2 py-1 text-[11px] font-semibold"
              disabled={
                busy ||
                !draft.name.trim() ||
                (draft.kind === "http" && draft.auth === "token" && !draft.token.trim()) ||
                (draft.kind === "http" && draft.auth === "oauth" && draft.oauthClient !== null && !draft.oauthClient.clientId.trim())
              }
              onClick={add}
            >
              {t("hermesMcp.addServer")}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="ui-btn-secondary px-2 py-1 text-[11px]" disabled={busy} onClick={() => void openCatalog()}>
            {t("hermesMcp.catalog")}
          </button>
          <button type="button" className="ui-btn-secondary px-2 py-1 text-[11px]" disabled={busy} onClick={() => setDraft({ ...EMPTY_DRAFT })}>
            {t("hermesMcp.addOwn")}
          </button>
        </div>
      )}

      {catalog && !choice ? (
        <div className="mt-2 max-h-56 space-y-1 overflow-auto">
          {catalog.length === 0 ? <div className="text-[11px] text-muted-foreground">{t("hermesMcp.catalogEmpty")}</div> : null}
          {catalog.map((entry) => (
            <div key={entry.name} className="flex items-start justify-between gap-3 text-[11px]">
              <span className="min-w-0">
                <span className="text-foreground">{entry.name}</span>
                {entry.description ? <span className="block truncate text-muted-foreground">{entry.description}</span> : null}
              </span>
              {entry.installed ? (
                <span className="shrink-0 ui-text-success">{t("hermesMcp.alreadyInstalled")}</span>
              ) : (
                <button
                  type="button"
                  className="ui-btn-secondary shrink-0 px-2 py-0.5 text-[10px]"
                  disabled={busy}
                  onClick={() => setChoice({ entry, env: {}, confirmed: false })}
                >
                  {t("hermesMcp.install")}
                </button>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {choice ? (
        <div className="mt-3 space-y-2 rounded border border-border/50 px-3 py-2 text-[11px]" data-testid="hermes-mcp-install">
          <div className="text-foreground">{choice.entry.name}</div>
          {choice.entry.requiredEnv.map((spec) => (
            <input
              key={spec.name}
              className={`${field} w-full`}
              type="password"
              autoComplete="off"
              placeholder={`${spec.name}${spec.prompt ? ` — ${spec.prompt}` : ""}`}
              aria-label={spec.name}
              value={choice.env[spec.name] ?? ""}
              onChange={(event) => setChoice({ ...choice, env: { ...choice.env, [spec.name]: event.target.value } })}
            />
          ))}
          {choice.entry.authType === "oauth" ? <div className="text-[10px] text-muted-foreground">{t("hermesMcp.oauthHint")}</div> : null}
          {runsProgram(choice.entry) ? (
            <div className="rounded border border-amber-400/40 px-2 py-1.5">
              <div className="text-amber-700 dark:text-amber-200">{t("hermesMcp.runsProgram")}</div>
              <code className="mt-1 block whitespace-pre-wrap break-all text-[10px] text-foreground">
                {[choice.entry.command, ...choice.entry.args].filter(Boolean).join(" ")}
                {choice.entry.installUrl ? `\n${t("hermesMcp.clones", { url: choice.entry.installUrl })}` : ""}
                {choice.entry.bootstrap.length ? `\n${choice.entry.bootstrap.join("\n")}` : ""}
              </code>
              <label className="mt-1 flex items-center gap-2 text-foreground">
                <input type="checkbox" checked={choice.confirmed} onChange={(event) => setChoice({ ...choice, confirmed: event.target.checked })} />
                {t("hermesMcp.confirmRuns")}
              </label>
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <button type="button" className="ui-btn-secondary px-2 py-1 text-[11px]" onClick={() => setChoice(null)}>
              {t("hermesMcp.cancel")}
            </button>
            <button
              type="button"
              className="ui-btn-primary px-2 py-1 text-[11px] font-semibold"
              disabled={busy || (runsProgram(choice.entry) && !choice.confirmed)}
              onClick={install}
            >
              {t("hermesMcp.install")}
            </button>
          </div>
        </div>
      ) : null}

      {message ? (
        <div className={`mt-2 text-[11px] ${message.kind === "error" ? "ui-text-danger" : "text-muted-foreground"}`}>{message.text}</div>
      ) : null}
    </section>
  );
}

function LoginState({ login }: { login: Login }) {
  if (login.phase === "starting") return <div className="mt-1 text-muted-foreground">{t("hermesMcp.loginStarting")}</div>;
  if (login.phase === "done") return <div className="mt-1 ui-text-success">{login.text}</div>;
  if (login.phase === "failed") return <div className="mt-1 ui-text-danger">{login.text}</div>;
  return (
    <div className="mt-1 text-muted-foreground" data-testid="hermes-mcp-login-waiting">
      {login.popupBlocked ? t("hermesMcp.loginPopupBlocked") : t("hermesMcp.loginWaiting")}{" "}
      <a className="underline" href={login.url} target="_blank" rel="noopener noreferrer">
        {t("hermesMcp.loginOpen")}
      </a>
    </div>
  );
}

function OAuthClientFields({
  client,
  redirectUrl,
  onChange,
  field,
}: {
  client: OAuthClient;
  redirectUrl: string;
  onChange: (client: OAuthClient) => void;
  field: string;
}) {
  return (
    <div className="mt-1 space-y-1">
      <div className="text-[10px] text-muted-foreground">{t("hermesMcp.clientHint", { url: redirectUrl })}</div>
      <input
        className={`${field} w-full`}
        autoComplete="off"
        placeholder={t("hermesMcp.clientId")}
        aria-label={t("hermesMcp.clientId")}
        value={client.clientId}
        onChange={(event) => onChange({ ...client, clientId: event.target.value })}
      />
      <input
        className={`${field} w-full`}
        type="password"
        autoComplete="off"
        placeholder={t("hermesMcp.clientSecret")}
        aria-label={t("hermesMcp.clientSecret")}
        value={client.clientSecret}
        onChange={(event) => onChange({ ...client, clientSecret: event.target.value })}
      />
      <input
        className={`${field} w-full`}
        autoComplete="off"
        placeholder={t("hermesMcp.clientScope")}
        aria-label={t("hermesMcp.clientScope")}
        value={client.scope}
        onChange={(event) => onChange({ ...client, scope: event.target.value })}
      />
    </div>
  );
}
