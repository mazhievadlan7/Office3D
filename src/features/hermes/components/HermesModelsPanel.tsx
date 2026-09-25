"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import type { HermesControl } from "@/features/hermes/HermesControlContext";

type ProviderRow = {
  slug: string;
  name: string;
  authenticated: boolean;
  authType: string | null;
  keyEnv: string | null;
  warning: string | null;
  isCurrent: boolean;
  models: string[];
  featuredModels: string[];
};

type SignInRow = {
  id: string;
  name: string;
  flow: string;
  docsUrl: string | null;
  cliCommand: string | null;
  signedIn: boolean;
  account: string | null;
  disconnectable: boolean;
};

type KeyRow = {
  key: string;
  category: string;
  provider: string | null;
  providerLabel: string | null;
  description: string | null;
  url: string | null;
  isSecret: boolean;
  isSet: boolean;
  preview: string | null;
  advanced: boolean;
};

type ProvidersStatus = {
  current: { provider: string | null; model: string | null } | null;
  providers: ProviderRow[];
  signIns: SignInRow[];
  keys: KeyRow[];
};

type SetKeyResult = { ok: boolean; verified?: boolean; message?: string; failed?: Array<{ profile: string; error: string }> };

// Shown before any search: the keys most offices start with. Every other key
// in Hermes' catalog is one search (or «Показать все») away.
const POPULAR_KEYS = new Set([
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "TAVILY_API_KEY",
  "FIRECRAWL_API_KEY",
  "EXA_API_KEY",
  "BRAVE_SEARCH_API_KEY",
  "BROWSERBASE_API_KEY",
  "ELEVENLABS_API_KEY",
  "GITHUB_TOKEN",
]);

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const CARD = "mt-3 rounded-lg border border-red-500/10 bg-black/20 px-4 py-3";
const LABEL = "mb-1 text-[10px] uppercase tracking-[0.14em] text-red-100/65";
const INPUT =
  "w-full rounded-md border border-red-500/10 bg-black/25 px-3 py-2 text-[11px] text-red-100 outline-none transition-colors placeholder:text-red-100/30 focus:border-red-400/30";
const BUTTON =
  "rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.14em] text-red-100 transition-colors hover:border-red-400/40 hover:bg-red-500/15 disabled:opacity-50";
const DANGER =
  "rounded-md border border-red-500/45 bg-red-600/20 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.14em] text-red-50 transition-colors hover:border-red-400/70 hover:bg-red-600/30 disabled:opacity-50";

function MainModelSection({
  status,
  control,
  onChanged,
}: {
  status: ProvidersStatus;
  control: HermesControl;
  onChanged: () => void;
}) {
  const usable = useMemo(
    () => status.providers.filter((provider) => provider.authenticated && provider.models.length > 0),
    [status.providers],
  );
  const [provider, setProvider] = useState(status.current?.provider ?? usable[0]?.slug ?? "");
  const models = usable.find((row) => row.slug === provider)?.models ?? [];
  const [model, setModel] = useState(status.current?.model ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await control.call("hermes.agents.setModel", { agentId: "main", provider, model });
      setMessage(t("hermesModels.mainModelSaved"));
      onChanged();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={CARD}>
      <div className="text-[11px] font-medium text-white">{t("hermesModels.mainModelTitle")}</div>
      <div className="mt-1 text-[10px] text-white/75">{t("hermesModels.mainModelLead")}</div>
      {status.current?.model ? (
        <div className="mt-2 font-mono text-[10px] text-red-200/80">
          {t("hermesModels.currentModel", { provider: status.current.provider ?? "?", model: status.current.model })}
        </div>
      ) : null}
      {usable.length === 0 ? (
        <div className="mt-2 text-[10px] text-red-200/80">{t("hermesModels.noUsableProviders")}</div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div>
            <div className={LABEL}>{t("hermesModels.provider")}</div>
            <select
              aria-label={t("hermesModels.provider")}
              className={INPUT}
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value);
                setModel("");
              }}
            >
              {usable.map((row) => (
                <option key={row.slug} value={row.slug}>
                  {row.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className={LABEL}>{t("hermesModels.model")}</div>
            <select aria-label={t("hermesModels.model")} className={INPUT} value={model} onChange={(event) => setModel(event.target.value)}>
              <option value="">{t("hermesModels.chooseModel")}</option>
              {models.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button type="button" className={BUTTON} disabled={busy || !provider || !model} onClick={() => void save()}>
          {t("settings.save")}
        </button>
        {message ? <span className="text-[10px] text-white/70">{message}</span> : null}
      </div>
    </div>
  );
}

type DeviceSession = { provider: string; sessionId: string; verificationUrl: string | null; userCode: string | null; interval: number };

function SignInSection({ status, control, onChanged }: { status: ProvidersStatus; control: HermesControl; onChanged: () => void }) {
  const [session, setSession] = useState<DeviceSession | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    pollTimer.current = null;
  }, []);
  useEffect(() => stopPolling, [stopPolling]);

  const poll = useCallback(
    (current: DeviceSession) => {
      pollTimer.current = window.setTimeout(async () => {
        try {
          const result = await control.call<{ status: string; error: string | null; account: string | null }>("hermes.signin.poll", {
            provider: current.provider,
            sessionId: current.sessionId,
          });
          if (result.status === "pending") {
            poll(current);
            return;
          }
          setSession(null);
          setMessage(
            result.status === "approved"
              ? t("hermesModels.signInDone", { account: result.account ?? "" })
              : result.error || t("hermesModels.signInFailed", { status: result.status }),
          );
          onChanged();
        } catch (error) {
          setSession(null);
          setMessage(errorText(error));
        }
      }, current.interval * 1000);
    },
    [control, onChanged],
  );

  const start = async (provider: string) => {
    setBusy(provider);
    setMessage(null);
    try {
      const started = await control.call<Omit<DeviceSession, "provider">>("hermes.signin.start", { provider });
      const next = { ...started, provider };
      setSession(next);
      poll(next);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    stopPolling();
    if (session) await control.call("hermes.signin.cancel", { sessionId: session.sessionId }).catch(() => {});
    setSession(null);
  };

  const disconnect = async (provider: string) => {
    setBusy(provider);
    try {
      await control.call("hermes.signin.disconnect", { provider });
      onChanged();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(null);
    }
  };

  const rows = status.signIns.filter((row) => row.flow === "device_code" || row.signedIn);
  if (rows.length === 0) return null;

  return (
    <div className={CARD}>
      <div className="text-[11px] font-medium text-white">{t("hermesModels.signInTitle")}</div>
      <div className="mt-1 text-[10px] text-white/75">{t("hermesModels.signInLead")}</div>
      <div className="mt-3 space-y-2">
        {rows.map((row) => (
          <div key={row.id} className="flex items-center justify-between gap-3 rounded-md border border-red-500/10 bg-black/15 px-3 py-2">
            <div className="min-w-0">
              <div className="text-[11px] text-white">{row.name}</div>
              <div className="text-[10px] text-white/55">
                {row.signedIn ? t("hermesModels.signedIn", { account: row.account ?? "" }) : t("hermesModels.notSignedIn")}
              </div>
            </div>
            {row.signedIn ? (
              row.disconnectable ? (
                <button type="button" className={DANGER} disabled={busy === row.id} onClick={() => void disconnect(row.id)}>
                  {t("hermesModels.signOut")}
                </button>
              ) : null
            ) : row.flow === "device_code" ? (
              <button type="button" className={BUTTON} disabled={Boolean(session) || busy === row.id} onClick={() => void start(row.id)}>
                {t("hermesModels.signIn")}
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {session ? (
        <div className="mt-3 rounded-md border border-red-500/25 bg-red-950/20 px-3 py-3">
          <div className="text-[10px] text-white/80">{t("hermesModels.deviceCodeLead")}</div>
          {session.verificationUrl ? (
            <a href={session.verificationUrl} target="_blank" rel="noopener noreferrer" className="mt-2 block break-all text-[11px] text-red-200 underline">
              {session.verificationUrl}
            </a>
          ) : null}
          {session.userCode ? <div className="mt-2 font-mono text-[18px] tracking-[0.3em] text-white">{session.userCode}</div> : null}
          <div className="mt-2 flex items-center gap-2">
            <span className="text-[10px] text-white/55">{t("hermesModels.waitingForApproval")}</span>
            <button type="button" className={DANGER} onClick={() => void cancel()}>
              {t("hermesModels.cancel")}
            </button>
          </div>
        </div>
      ) : null}
      {message ? <div className="mt-2 text-[10px] text-white/70">{message}</div> : null}
    </div>
  );
}

function KeyEditor({ row, control, onChanged }: { row: KeyRow; control: HermesControl; onChanged: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await control.call<SetKeyResult>("hermes.providers.setKey", { key: row.key, value });
      if (!result.ok) {
        setMessage(result.message || t("hermesModels.keyRejected"));
        return;
      }
      setValue("");
      setMessage(result.message || (result.verified ? t("hermesModels.keySavedVerified") : t("hermesModels.keySaved")));
      onChanged();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await control.call("hermes.providers.deleteKey", { key: row.key });
      onChanged();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-red-500/10 bg-black/15 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-red-100">{row.key}</span>
        <span className={`text-[10px] ${row.isSet ? "text-red-200/80" : "text-white/40"}`}>
          {row.isSet ? t("hermesModels.keySet", { preview: row.preview ?? "" }) : t("hermesModels.keyNotSet")}
        </span>
      </div>
      {row.description ? <div className="mt-1 text-[10px] text-white/55">{row.description}</div> : null}
      <div className="mt-2 flex items-center gap-2">
        <input
          type={row.isSecret ? "password" : "text"}
          aria-label={row.key}
          value={value}
          autoComplete="off"
          onChange={(event) => setValue(event.target.value)}
          placeholder={row.isSet ? t("hermesModels.keyReplace") : t("hermesModels.keyEnter")}
          className={`${INPUT} min-w-0 flex-1`}
        />
        <button type="button" className={BUTTON} disabled={busy || !value.trim()} onClick={() => void save()}>
          {t("settings.save")}
        </button>
        {row.isSet ? (
          <button type="button" className={DANGER} disabled={busy} onClick={() => void remove()}>
            {t("settings.clear")}
          </button>
        ) : null}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        {message ? <span className="text-[10px] text-white/70">{message}</span> : <span />}
        {row.url ? (
          <a href={row.url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-red-200/70 underline">
            {t("hermesModels.whereToGetKey")}
          </a>
        ) : null}
      </div>
    </div>
  );
}

function KeysSection({
  title,
  lead,
  rows,
  control,
  onChanged,
  initiallyOpen,
}: {
  title: string;
  lead: string;
  rows: KeyRow[];
  control: HermesControl;
  onChanged: () => void;
  initiallyOpen: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const needle = query.trim().toLowerCase();
  const visible = rows.filter((row) => {
    if (needle) {
      return [row.key, row.providerLabel ?? "", row.description ?? ""].some((text) => text.toLowerCase().includes(needle));
    }
    return showAll || row.isSet || POPULAR_KEYS.has(row.key);
  });
  const configured = rows.filter((row) => row.isSet).length;

  return (
    <div className={CARD}>
      <button type="button" className="flex w-full items-start justify-between gap-3 text-left" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <div>
          <div className="text-[11px] font-medium text-white">{title}</div>
          <div className="mt-1 text-[10px] text-white/75">{lead}</div>
        </div>
        <span className="font-mono text-[10px] text-red-200/70">{t("hermesModels.configuredCount", { count: configured, total: rows.length })}</span>
      </button>
      {open ? (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="search"
              aria-label={t("hermesModels.search")}
              placeholder={t("hermesModels.search")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className={`${INPUT} min-w-0 flex-1`}
            />
            <label className="flex items-center gap-1 text-[10px] text-white/60">
              <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />
              {t("hermesModels.showAll")}
            </label>
          </div>
          {visible.map((row) => (
            <div key={row.key}>
              {row.providerLabel ? <div className="mb-1 text-[10px] text-red-100/60">{row.providerLabel}</div> : null}
              <KeyEditor row={row} control={control} onChanged={onChanged} />
            </div>
          ))}
          {visible.length === 0 ? <div className="text-[10px] text-white/50">{t("hermesModels.nothingFound")}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Models and providers of the Hermes install behind the office: the main
 * agent's model (the one new hires copy), device-code sign-ins such as Nous
 * Portal, and provider and tool keys — all from Hermes' own catalog. A key is
 * written to every agent at once.
 */
export function HermesModelsPanel({ control }: { control: HermesControl }) {
  const [status, setStatus] = useState<ProvidersStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await control.call<ProvidersStatus>("hermes.providers.status"));
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  }, [control]);

  useEffect(() => {
    void load();
  }, [load]);

  const providerKeys = useMemo(() => status?.keys.filter((row) => row.category === "provider") ?? [], [status]);
  const toolKeys = useMemo(() => status?.keys.filter((row) => row.category !== "provider") ?? [], [status]);

  return (
    <div>
      <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-red-500/10 bg-black/20 px-4 py-3">
        <div>
          <div className="text-[11px] font-medium text-white">{t("hermesModels.title")}</div>
          <div className="mt-1 text-[10px] text-white/75">{t("hermesModels.lead")}</div>
        </div>
        <button type="button" className={BUTTON} disabled={loading} onClick={() => void load()}>
          {loading ? t("settings.loading") : t("hermesModels.refresh")}
        </button>
      </div>
      {error ? <div className="mt-2 text-[10px] text-red-200/90">{error}</div> : null}
      {status ? (
        <>
          <MainModelSection key={`${status.current?.provider}/${status.current?.model}`} status={status} control={control} onChanged={() => void load()} />
          <SignInSection status={status} control={control} onChanged={() => void load()} />
          <KeysSection
            title={t("hermesModels.providerKeysTitle")}
            lead={t("hermesModels.providerKeysLead")}
            rows={providerKeys}
            control={control}
            onChanged={() => void load()}
            initiallyOpen={false}
          />
          <KeysSection
            title={t("hermesModels.toolKeysTitle")}
            lead={t("hermesModels.toolKeysLead")}
            rows={toolKeys}
            control={control}
            onChanged={() => void load()}
            initiallyOpen={false}
          />
        </>
      ) : null}
    </div>
  );
}
