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
    <section className="sidebar-section" data-testid="agent-settings-hermes-model">
      <div className="px-1 py-1">
        <div className="sidebar-copy flex flex-col gap-1 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground/88">{t("hermesModels.agentModelTitle")}</span>
          <span>{t("hermesModels.agentModelLead")}</span>
          <div className="mt-2 flex items-center gap-2">
            <select
              aria-label={t("hermesModels.agentModelTitle")}
              className="ui-input h-9 min-w-0 flex-1 rounded-md px-2 text-[11px]"
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
              className="ui-btn-secondary h-9 px-3 text-[11px] font-semibold"
              disabled={busy || !choice || choice === current}
              onClick={() => void save()}
            >
              {t("settings.save")}
            </button>
          </div>
          {message ? <span className="mt-1 text-[10px]">{message}</span> : null}
        </div>
      </div>
    </section>
  );
}
