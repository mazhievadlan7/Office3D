"use client";

import { useCallback, useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import {
  HQ_FORM_BADGE_MUTED,
  HQ_FORM_BADGE_WARN,
  HQ_FORM_CHECKBOX,
  HQ_FORM_HINT,
  HQ_FORM_SECTION,
  HQ_FORM_SECTION_TITLE,
} from "@/features/agents/components/hqFormStyles";
import { useHermesControl } from "@/features/hermes/HermesControlContext";

type Toolset = {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  configured: boolean;
  tools: string[];
  locked: boolean;
};

/**
 * Which of Hermes' tool groups this agent has. A change applies from the
 * agent's next run.
 */
export function HermesToolsetsSection({ agentId }: { agentId: string }) {
  const control = useHermesControl();
  const [toolsets, setToolsets] = useState<Toolset[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!control) return;
    try {
      setToolsets((await control.call<{ toolsets: Toolset[] }>("hermes.toolsets.list", { agentId })).toolsets);
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, [agentId, control]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!control) return null;

  const toggle = async (toolset: Toolset) => {
    setBusy(toolset.name);
    setMessage(null);
    try {
      const result = await control.call<{ toolsets: Toolset[] }>("hermes.toolsets.set", {
        agentId,
        name: toolset.name,
        enabled: !toolset.enabled,
      });
      setToolsets(result.toolsets);
      setMessage({ kind: "ok", text: t("hermesToolsets.applied") });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={`mt-4 ${HQ_FORM_SECTION}`} data-testid="hermes-toolsets">
      <div className={HQ_FORM_SECTION_TITLE}>{t("hermesToolsets.title")}</div>
      <div className={`mt-1.5 ${HQ_FORM_HINT}`}>{t("hermesToolsets.lead")}</div>
      <div className="mt-3 space-y-1.5">
        {toolsets === null ? (
          <div className="text-[11px] text-white/50">{t("hermesToolsets.loading")}</div>
        ) : (
          toolsets.map((toolset) => (
            <label key={toolset.name} className="flex items-start justify-between gap-3 text-[11px]" title={toolset.tools.join(", ")}>
              <span className="min-w-0">
                <span className="text-white">{toolset.label}</span>
                {!toolset.configured ? <span className={`ml-2 ${HQ_FORM_BADGE_WARN}`}>{t("hermesToolsets.needsSetup")}</span> : null}
                {toolset.locked ? <span className={`ml-2 ${HQ_FORM_BADGE_MUTED}`}>{t("hermesToolsets.locked")}</span> : null}
                {toolset.description ? <span className="block truncate text-white/50">{toolset.description}</span> : null}
              </span>
              <input
                type="checkbox"
                className={HQ_FORM_CHECKBOX}
                aria-label={t("hermesToolsets.toggle", { name: toolset.label })}
                checked={toolset.enabled}
                disabled={busy !== null || (toolset.locked && toolset.enabled)}
                onChange={() => void toggle(toolset)}
              />
            </label>
          ))
        )}
      </div>
      {message ? (
        <div className={`mt-2 text-[11px] ${message.kind === "error" ? "text-red-400" : "text-white/70"}`}>{message.text}</div>
      ) : null}
    </section>
  );
}
