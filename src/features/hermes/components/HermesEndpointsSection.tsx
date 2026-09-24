"use client";

import { useCallback, useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { useHermesControl } from "@/features/hermes/HermesControlContext";

type Endpoint = { id: string; name: string; baseUrl: string; model: string; models: string[]; hasApiKey: boolean; isCurrent: boolean };
type Draft = { name: string; baseUrl: string; apiKey: string; models: string[]; model: string; everyone: boolean; checked: boolean };

const EMPTY: Draft = { name: "", baseUrl: "", apiKey: "", models: [], model: "", everyone: false, checked: false };
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The agent's own models by address: any OpenAI-compatible server — Ollama,
 * vLLM, LM Studio, llama.cpp — on this server or elsewhere. Hermes checks the
 * address from its side of the network and keeps the key in its .env.
 */
export function HermesEndpointsSection({ agentId }: { agentId: string }) {
  const control = useHermesControl();
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!control) return;
    try {
      setEndpoints((await control.call<{ endpoints: Endpoint[] }>("hermes.endpoints.list", { agentId })).endpoints);
    } catch (error) {
      setMessage({ kind: "error", text: describe(error) });
    }
  }, [agentId, control]);

  useEffect(() => {
    void load();
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

  const check = () =>
    run(async () => {
      if (!draft) return null;
      const result = await control.call<{ ok: boolean; reachable: boolean; message: string; models: string[] }>("hermes.endpoints.validate", {
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey.trim(),
      });
      if (!result.ok) throw new Error(result.message || t("hermesEndpoints.unreachable"));
      if (!result.models.length) throw new Error(t("hermesEndpoints.noModels"));
      setDraft({ ...draft, models: result.models, model: result.models.includes(draft.model) ? draft.model : result.models[0], checked: true });
      return t("hermesEndpoints.found", { count: result.models.length });
    });

  const save = () =>
    run(async () => {
      if (!draft) return null;
      const result = await control.call<{ ok: boolean; failed: Array<{ profile: string; error: string }> }>("hermes.endpoints.save", {
        agentId: draft.everyone ? "all" : agentId,
        name: draft.name.trim(),
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey.trim(),
        model: draft.model,
        useNow: true,
      });
      setDraft(null);
      await load();
      return result.failed.length
        ? t("hermesEndpoints.savedPartly", { failed: result.failed.map((f) => `${f.profile}: ${f.error}`).join("; ") })
        : t("hermesEndpoints.saved");
    });

  const activate = (endpoint: Endpoint) =>
    run(async () => {
      await control.call("hermes.endpoints.activate", { agentId, id: endpoint.id });
      await load();
      return t("hermesEndpoints.activated", { name: endpoint.name });
    });

  const remove = (endpoint: Endpoint) =>
    run(async () => {
      await control.call("hermes.endpoints.delete", { agentId, id: endpoint.id });
      await load();
      return t("hermesEndpoints.removed");
    });

  const field = "ui-input w-full rounded px-2 py-1 text-[11px]";

  return (
    <section className="mt-4 rounded-lg border border-border/50 bg-muted/20 px-4 py-3" data-testid="hermes-endpoints">
      <div className="text-[11px] font-medium text-foreground">{t("hermesEndpoints.title")}</div>
      <div className="mt-1 text-[10px] text-muted-foreground">{t("hermesEndpoints.lead")}</div>

      <div className="mt-3 space-y-1.5">
        {endpoints?.map((endpoint) => (
          <div key={endpoint.id} className="flex items-start justify-between gap-2 rounded bg-muted/40 px-2 py-1.5 text-[11px]">
            <span className="min-w-0">
              <span className="text-foreground">{endpoint.name}</span>
              {endpoint.isCurrent ? <span className="ml-2 ui-text-success">{t("hermesEndpoints.current")}</span> : null}
              <span className="block truncate text-muted-foreground">
                {endpoint.baseUrl} · {endpoint.model}
                {endpoint.hasApiKey ? ` · ${t("hermesEndpoints.withKey")}` : ""}
              </span>
            </span>
            <span className="flex shrink-0 gap-1">
              {endpoint.isCurrent ? null : (
                <button type="button" className="ui-btn-secondary px-2 py-0.5 text-[10px]" disabled={busy} onClick={() => void activate(endpoint)}>
                  {t("hermesEndpoints.use")}
                </button>
              )}
              <button type="button" className="ui-btn-secondary px-2 py-0.5 text-[10px]" disabled={busy} onClick={() => void remove(endpoint)}>
                {t("hermesEndpoints.remove")}
              </button>
            </span>
          </div>
        ))}
      </div>

      {draft ? (
        <div className="mt-3 space-y-2 text-[11px]" data-testid="hermes-endpoint-form">
          <input className={field} placeholder={t("hermesEndpoints.name")} aria-label={t("hermesEndpoints.name")} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input
            className={field}
            placeholder="http://host.docker.internal:11434/v1"
            aria-label={t("hermesEndpoints.address")}
            value={draft.baseUrl}
            onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value, checked: false, models: [] })}
          />
          <div className="text-[10px] text-muted-foreground">{t("hermesEndpoints.addressHint")}</div>
          <input
            className={field}
            type="password"
            autoComplete="off"
            placeholder={t("hermesEndpoints.key")}
            aria-label={t("hermesEndpoints.key")}
            value={draft.apiKey}
            onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
          />
          {draft.checked ? (
            <select className={`${field} h-8`} aria-label={t("hermesEndpoints.model")} value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })}>
              {draft.models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          ) : null}
          <label className="flex items-center gap-2 text-muted-foreground">
            <input type="checkbox" checked={draft.everyone} onChange={(e) => setDraft({ ...draft, everyone: e.target.checked })} />
            {t("hermesEndpoints.forEveryone")}
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" className="ui-btn-secondary px-2 py-1 text-[11px]" onClick={() => setDraft(null)}>
              {t("hermesEndpoints.cancel")}
            </button>
            <button type="button" className="ui-btn-secondary px-2 py-1 text-[11px]" disabled={busy || !draft.baseUrl.trim()} onClick={() => void check()}>
              {t("hermesEndpoints.check")}
            </button>
            <button type="button" className="ui-btn-primary px-2 py-1 text-[11px] font-semibold" disabled={busy || !draft.checked || !draft.model} onClick={() => void save()}>
              {t("hermesEndpoints.saveAndUse")}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex justify-end">
          <button type="button" className="ui-btn-secondary px-2 py-1 text-[11px]" disabled={busy} onClick={() => setDraft({ ...EMPTY })}>
            {t("hermesEndpoints.add")}
          </button>
        </div>
      )}
      {message ? <div className={`mt-2 text-[11px] ${message.kind === "error" ? "ui-text-danger" : "text-muted-foreground"}`}>{message.text}</div> : null}
    </section>
  );
}
