"use client";

import { useCallback, useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { useHermesControl } from "@/features/hermes/HermesControlContext";

type ModelOption = { id: string; name: string; provider: string };

/**
 * The model this agent's Hermes profile thinks with. Only providers that are
 * signed in or have a key are offered; setting them up lives in the studio
 * settings («Модели и провайдеры»).
 */
export function HermesAgentModelSection({ agentId }: { agentId: string }) {
  const control = useHermesControl();
  const [options, setOptions] = useState<ModelOption[]>([]);
  const [current, setCurrent] = useState<string>("");
  const [choice, setChoice] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!control) return;
    try {
      const [models, model] = await Promise.all([
        control.call<{ models: ModelOption[] }>("models.list"),
        control.call<{ provider: string | null; model: string | null }>("hermes.agents.model", { agentId }),
      ]);
      setOptions(models.models);
      const id = model.provider && model.model ? `${model.provider}/${model.model}` : "";
      setCurrent(id);
      setChoice(id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [agentId, control]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!control) return null;

  const save = async () => {
    const option = options.find((entry) => entry.id === choice);
    if (!option) return;
    setBusy(true);
    setMessage(null);
    try {
      await control.call("hermes.agents.setModel", { agentId, provider: option.provider, model: option.name });
      setCurrent(choice);
      setMessage(t("hermesModels.agentModelSaved"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-border/50 bg-muted/20 px-4 py-3" data-testid="agent-settings-hermes-model">
      <div className="text-[11px] font-medium text-foreground">{t("hermesModels.agentModelTitle")}</div>
      <div className="mt-1 text-[10px] text-muted-foreground">{t("hermesModels.agentModelLead")}</div>
      <div className="mt-3 flex items-center gap-2">
        <select
          aria-label={t("hermesModels.agentModelTitle")}
          className="ui-input h-10 min-w-0 flex-1 rounded px-2 text-[11px]"
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
        >
          {current && !options.some((entry) => entry.id === current) ? <option value={current}>{current}</option> : null}
          {!current ? <option value="">{t("hermesModels.chooseModel")}</option> : null}
          {options.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.id}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ui-btn-primary h-10 px-3 text-[11px] font-semibold"
          disabled={busy || !choice || choice === current}
          onClick={() => void save()}
        >
          {t("settings.save")}
        </button>
      </div>
      {message ? <div className="mt-2 text-[11px] text-muted-foreground">{message}</div> : null}
    </section>
  );
}
