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

type Draft = {
  kind: "http" | "stdio";
  name: string;
  url: string;
  token: string;
  command: string;
  args: string;
  env: string;
  everyone: boolean;
};

const EMPTY_DRAFT: Draft = { kind: "http", name: "", url: "", token: "", command: "", args: "", env: "", everyone: false };

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
    return () => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
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

  const add = () =>
    run(async () => {
      if (!draft) return null;
      const params: Record<string, unknown> = { agentId: draft.everyone ? "all" : agentId, name: draft.name.trim() };
      if (draft.kind === "http") {
        params.url = draft.url.trim();
        if (draft.token.trim()) {
          params.auth = "header";
          params.bearerToken = draft.token.trim();
        }
      } else {
        params.command = draft.command.trim();
        params.args = lines(draft.args);
        params.env = parseEnv(draft.env);
      }
      const result = await control.call<{ added: string[]; failed: Array<{ profile: string; error: string }> }>("hermes.mcp.add", params);
      setDraft(null);
      await load();
      return result.failed.length
        ? t("hermesMcp.addedPartly", { failed: result.failed.map((entry) => `${entry.profile}: ${entry.error}`).join("; ") })
        : t("hermesMcp.added");
    });

  const test = (name: string) =>
    run(async () => {
      setTests((current) => ({ ...current, [name]: t("hermesMcp.testing") }));
      const result = await control.call<{ ok: boolean; error: string | null; tools: Array<{ name: string }> }>("hermes.mcp.test", { agentId, name });
      setTests((current) => ({
        ...current,
        [name]: result.ok ? t("hermesMcp.testOk", { count: result.tools.length }) : t("hermesMcp.testFailed", { error: result.error ?? "" }),
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

  const install = () =>
    run(async () => {
      if (!choice) return null;
      const result = await control.call<{ background: boolean; action: string | null }>("hermes.mcp.install", {
        agentId,
        name: choice.entry.name,
        env: choice.env,
        confirm: choice.confirmed,
      });
      setChoice(null);
      setCatalog(null);
      if (result.background && result.action) {
        follow(result.action);
        return t("hermesMcp.installing");
      }
      await load();
      return t("hermesMcp.installed");
    });

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
            <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
              {tests[server.name] ? <span className="mr-auto text-muted-foreground">{tests[server.name]}</span> : null}
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
              <input
                className={`${field} w-full`}
                type="password"
                autoComplete="off"
                placeholder={t("hermesMcp.token")}
                aria-label={t("hermesMcp.token")}
                value={draft.token}
                onChange={(event) => setDraft({ ...draft, token: event.target.value })}
              />
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
            <button type="button" className="ui-btn-primary px-2 py-1 text-[11px] font-semibold" disabled={busy || !draft.name.trim()} onClick={() => void add()}>
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
              ) : entry.authType === "oauth" ? (
                <span className="shrink-0 text-muted-foreground">{t("hermesMcp.oauthInHermes")}</span>
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
              onClick={() => void install()}
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
