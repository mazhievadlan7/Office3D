"use client";

import { useCallback, useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { useHermesControl } from "@/features/hermes/HermesControlContext";

type MemoryTarget = "memory" | "user";
type MemoryFile = { entries: string[]; chars: number; limit: number; enabled: boolean; version: string };
type MemoryView = { provider: string | null; targets: Record<MemoryTarget, MemoryFile> };

const DELIMITER_LENGTH = 3; // "\n§\n" between entries, as Hermes counts
const TARGETS: MemoryTarget[] = ["memory", "user"];

const charsOf = (entries: string[]) => {
  const kept = entries.map((entry) => entry.trim()).filter(Boolean);
  return kept.reduce((sum, entry) => sum + entry.length, 0) + Math.max(0, kept.length - 1) * DELIMITER_LENGTH;
};

/**
 * What the agent remembers in Hermes: its own notes and what it knows about
 * the person. The person can correct, remove and add entries; a session reads
 * memory when it starts, so edits reach the agent's next conversations.
 */
export function HermesMemorySection({ agentId }: { agentId: string }) {
  const control = useHermesControl();
  const [view, setView] = useState<MemoryView | null>(null);
  const [editing, setEditing] = useState<{ target: MemoryTarget; entries: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!control) return;
    try {
      setView(await control.call<MemoryView>("hermes.memory.get", { agentId }));
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, [agentId, control]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!control) return null;

  const save = async () => {
    if (!editing || !view) return;
    setBusy(true);
    setMessage(null);
    try {
      const next = await control.call<MemoryView>("hermes.memory.set", {
        agentId,
        target: editing.target,
        entries: editing.entries,
        version: view.targets[editing.target].version,
      });
      setView(next);
      setEditing(null);
      setMessage({ kind: "ok", text: t("hermesMemory.saved") });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessage({ kind: "error", text });
      // The agent changed its memory meanwhile: show what it holds now.
      if ((error as { code?: string } | null)?.code === "CONFLICT") {
        setEditing(null);
        void load();
      }
    } finally {
      setBusy(false);
    }
  };

  const setEntry = (index: number, value: string) =>
    setEditing((current) => (current ? { ...current, entries: current.entries.map((entry, i) => (i === index ? value : entry)) } : current));

  return (
    <section className="mt-4 rounded-lg border border-border/50 bg-muted/20 px-4 py-3" data-testid="hermes-memory">
      <div className="text-[11px] font-medium text-foreground">{t("hermesMemory.title")}</div>
      <div className="mt-1 text-[10px] text-muted-foreground">{t("hermesMemory.lead")}</div>
      {view?.provider ? <div className="mt-1 text-[10px] text-muted-foreground">{t("hermesMemory.provider", { provider: view.provider })}</div> : null}
      {view === null ? <div className="mt-3 text-[11px] text-muted-foreground">{t("hermesMemory.loading")}</div> : null}
      {view
        ? TARGETS.map((target) => {
            const file = view.targets[target];
            const isEditing = editing?.target === target;
            const entries = isEditing ? editing.entries : file.entries;
            const used = isEditing ? charsOf(editing.entries) : file.chars;
            const over = used > file.limit;
            return (
              <div key={target} className="mt-3" data-testid={`hermes-memory-${target}`}>
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-foreground">{target === "memory" ? t("hermesMemory.notes") : t("hermesMemory.aboutYou")}</span>
                  <span className={over ? "ui-text-danger" : "text-muted-foreground"}>{t("hermesMemory.usage", { used, limit: file.limit })}</span>
                </div>
                {!file.enabled ? <div className="text-[10px] text-amber-700 dark:text-amber-300">{t("hermesMemory.disabled")}</div> : null}
                <div className="mt-1 space-y-1">
                  {entries.length === 0 && !isEditing ? <div className="text-[11px] text-muted-foreground">{t("hermesMemory.empty")}</div> : null}
                  {entries.map((entry, index) =>
                    isEditing ? (
                      <div key={index} className="flex items-start gap-2">
                        <textarea
                          className="min-h-[2.5rem] min-w-0 flex-1 ui-input rounded px-2 py-1 text-[11px]"
                          aria-label={t("hermesMemory.entry", { n: index + 1 })}
                          value={entry}
                          onChange={(event) => setEntry(index, event.target.value)}
                        />
                        <button
                          type="button"
                          className="ui-btn-secondary shrink-0 px-2 py-0.5 text-[10px]"
                          onClick={() => setEditing((current) => (current ? { ...current, entries: current.entries.filter((_, i) => i !== index) } : current))}
                        >
                          {t("hermesMemory.remove")}
                        </button>
                      </div>
                    ) : (
                      <div key={index} className="whitespace-pre-wrap rounded bg-muted/40 px-2 py-1 text-[11px] text-foreground">
                        {entry}
                      </div>
                    ),
                  )}
                </div>
                <div className="mt-2 flex justify-end gap-2">
                  {isEditing ? (
                    <>
                      <button
                        type="button"
                        className="ui-btn-secondary px-2 py-1 text-[11px]"
                        onClick={() => setEditing((current) => (current ? { ...current, entries: [...current.entries, ""] } : current))}
                      >
                        {t("hermesMemory.add")}
                      </button>
                      <button type="button" className="ui-btn-secondary px-2 py-1 text-[11px]" onClick={() => setEditing(null)}>
                        {t("hermesMemory.cancel")}
                      </button>
                      <button type="button" className="ui-btn-primary px-2 py-1 text-[11px] font-semibold" disabled={busy || over} onClick={() => void save()}>
                        {t("hermesMemory.save")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="ui-btn-secondary px-2 py-1 text-[11px]"
                      disabled={busy || editing !== null}
                      onClick={() => {
                        setMessage(null);
                        setEditing({ target, entries: [...file.entries] });
                      }}
                    >
                      {t("hermesMemory.edit")}
                    </button>
                  )}
                </div>
              </div>
            );
          })
        : null}
      {message ? (
        <div className={`mt-2 text-[11px] ${message.kind === "error" ? "ui-text-danger" : "text-muted-foreground"}`}>{message.text}</div>
      ) : null}
    </section>
  );
}
