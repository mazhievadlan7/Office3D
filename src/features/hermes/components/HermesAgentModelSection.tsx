"use client";

import { useCallback, useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import {
  HQ_FORM_BUTTON_PRIMARY,
  HQ_FORM_HINT,
  HQ_FORM_SECTION,
  HQ_FORM_SECTION_TITLE,
  HQ_FORM_SELECT,
} from "@/features/agents/components/hqFormStyles";
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
    <section className={HQ_FORM_SECTION} data-testid="agent-settings-hermes-model">
      <div className={HQ_FORM_SECTION_TITLE}>{t("hermesModels.agentModelTitle")}</div>
      <div className={`mt-1.5 ${HQ_FORM_HINT}`}>{t("hermesModels.agentModelLead")}</div>
      <div className="mt-3 flex items-center gap-2">
        <select
          aria-label={t("hermesModels.agentModelTitle")}
          className={`h-10 min-w-0 flex-1 ${HQ_FORM_SELECT}`}
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
          className={`h-10 ${HQ_FORM_BUTTON_PRIMARY}`}
          disabled={busy || !choice || choice === current}
          onClick={() => void save()}
        >
          {t("settings.save")}
        </button>
      </div>
      {message ? <div className="mt-2 text-[11px] text-white/70">{message}</div> : null}
    </section>
  );
}
