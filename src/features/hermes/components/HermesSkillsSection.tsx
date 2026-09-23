"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { useHermesControl } from "@/features/hermes/HermesControlContext";

type Skill = { name: string; description: string; category: string | null; enabled: boolean; provenance: string | null };
type HubSkill = { identifier: string; name?: string; description?: string; category?: string; trust_level?: string; installed?: boolean };
type Scan = {
  identifier: string;
  policy: "allow" | "ask" | "block";
  verdict: string | null;
  summary: string | null;
  policyReason: string | null;
  trustLevel: string | null;
  findings: unknown[];
};

const describeFinding = (finding: unknown) => {
  if (typeof finding === "string") return finding;
  if (finding && typeof finding === "object") {
    const row = finding as Record<string, unknown>;
    return String(row.message ?? row.description ?? row.rule ?? JSON.stringify(row)).slice(0, 200);
  }
  return String(finding);
};

/**
 * This agent's skills in Hermes: turn them on and off, and add more from the
 * Hermes Skills Hub. Hermes scans a skill before installing it; a risky one
 * installs only after the person has seen the findings and confirmed.
 */
export function HermesSkillsSection({ agentId }: { agentId: string }) {
  const control = useHermesControl();
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [hub, setHub] = useState<HubSkill[] | null>(null);
  const [query, setQuery] = useState("");
  const [scan, setScan] = useState<Scan | null>(null);
  const [forEveryone, setForEveryone] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!control) return;
    try {
      setSkills((await control.call<{ skills: Skill[] }>("hermes.skills.list", { agentId })).skills);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [agentId, control]);

  useEffect(() => {
    void load();
    return () => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
  }, [load]);

  if (!control) return null;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (skill: Skill) =>
    run(async () => {
      await control.call("hermes.skills.toggle", { agentId, name: skill.name, enabled: !skill.enabled });
      setSkills((list) => list?.map((entry) => (entry.name === skill.name ? { ...entry, enabled: !skill.enabled } : entry)) ?? null);
    });

  const openCatalog = () =>
    run(async () => {
      setHub((await control.call<{ skills: HubSkill[] }>("hermes.skills.catalog", { agentId })).skills);
    });

  const search = () =>
    run(async () => {
      if (!query.trim()) return openCatalog();
      setHub((await control.call<{ results: HubSkill[] }>("hermes.skills.search", { agentId, query: query.trim() })).results);
    });

  const follow = (actions: Array<{ action: string | null }>) => {
    const names = actions.map((entry) => entry.action).filter((name): name is string => Boolean(name));
    if (names.length === 0) return;
    setProgress(t("hermesSkills.installing"));
    const tick = async () => {
      try {
        const states = await Promise.all(
          names.map((action) => control.call<{ running: boolean; exitCode: number | null; lines: string[] }>("hermes.skills.action", { action })),
        );
        if (states.some((state) => state.running)) {
          pollRef.current = window.setTimeout(() => void tick(), 2000);
          return;
        }
        const failed = states.find((state) => state.exitCode !== 0);
        setProgress(failed ? t("hermesSkills.installFailed", { detail: failed.lines.at(-1) ?? "" }) : t("hermesSkills.installed"));
        void load();
        if (hub) void openCatalog();
      } catch (error) {
        setProgress(error instanceof Error ? error.message : String(error));
      }
    };
    pollRef.current = window.setTimeout(() => void tick(), 1500);
  };

  const check = (identifier: string) =>
    run(async () => {
      setProgress(null);
      setScan(await control.call<Scan>("hermes.skills.scan", { agentId, identifier }));
    });

  const install = (confirmRisk: boolean) =>
    run(async () => {
      if (!scan) return;
      const result = await control.call<{ actions: Array<{ action: string | null }> }>("hermes.skills.install", {
        agentId: forEveryone ? "all" : agentId,
        identifier: scan.identifier,
        confirmRisk,
      });
      setScan(null);
      follow(result.actions);
    });

  return (
    <section className="mt-4 rounded-lg border border-border/50 bg-muted/20 px-4 py-3" data-testid="hermes-skills">
      <div className="text-[11px] font-medium text-foreground">{t("hermesSkills.title")}</div>
      <div className="mt-1 text-[10px] text-muted-foreground">{t("hermesSkills.lead")}</div>

      <div className="mt-3 space-y-1">
        {skills === null ? (
          <div className="text-[11px] text-muted-foreground">{t("hermesSkills.loading")}</div>
        ) : skills.length === 0 ? (
          <div className="text-[11px] text-muted-foreground">{t("hermesSkills.none")}</div>
        ) : (
          skills.map((skill) => (
            <label key={skill.name} className="flex items-start justify-between gap-3 text-[11px]">
              <span className="min-w-0">
                <span className="text-foreground">{skill.name}</span>
                {skill.description ? <span className="block truncate text-muted-foreground">{skill.description}</span> : null}
              </span>
              <input
                type="checkbox"
                aria-label={t("hermesSkills.toggle", { name: skill.name })}
                checked={skill.enabled}
                disabled={busy}
                onChange={() => void toggle(skill)}
              />
            </label>
          ))
        )}
      </div>

      <div className="mt-3 flex gap-2">
        <input
          type="text"
          className="min-w-0 flex-1 ui-input rounded px-2 py-1 text-[11px]"
          placeholder={t("hermesSkills.searchPlaceholder")}
          aria-label={t("hermesSkills.searchPlaceholder")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void search();
          }}
        />
        <button type="button" className="ui-btn-secondary px-2 py-1 text-[11px]" disabled={busy} onClick={() => void search()}>
          {query.trim() ? t("hermesSkills.search") : t("hermesSkills.catalog")}
        </button>
      </div>

      {hub ? (
        <div className="mt-2 max-h-56 space-y-1 overflow-auto">
          {hub.length === 0 ? <div className="text-[11px] text-muted-foreground">{t("hermesSkills.nothingFound")}</div> : null}
          {hub.map((entry) => (
            <div key={entry.identifier} className="flex items-start justify-between gap-3 text-[11px]">
              <span className="min-w-0">
                <span className="text-foreground">{entry.name ?? entry.identifier}</span>
                {entry.description ? <span className="block truncate text-muted-foreground">{entry.description}</span> : null}
              </span>
              {entry.installed ? (
                <span className="shrink-0 ui-text-success">{t("hermesSkills.alreadyInstalled")}</span>
              ) : (
                <button type="button" className="ui-btn-secondary shrink-0 px-2 py-0.5 text-[10px]" disabled={busy} onClick={() => void check(entry.identifier)}>
                  {t("hermesSkills.install")}
                </button>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {scan ? (
        <div
          className={`mt-3 rounded border px-3 py-2 text-[11px] ${scan.policy === "block" ? "border-red-400/40" : scan.policy === "ask" ? "border-amber-400/40" : "border-emerald-400/30"}`}
          data-testid="hermes-skill-scan"
        >
          <div className="text-foreground">
            {scan.policy === "block"
              ? t("hermesSkills.scanBlocked", { reason: scan.policyReason ?? scan.summary ?? "" })
              : scan.policy === "ask"
                ? t("hermesSkills.scanAsk", { summary: scan.summary ?? "" })
                : t("hermesSkills.scanOk")}
          </div>
          {scan.findings.length ? (
            <ul className="mt-1 list-disc pl-4 text-muted-foreground">
              {scan.findings.slice(0, 6).map((finding, index) => (
                <li key={index}>{describeFinding(finding)}</li>
              ))}
            </ul>
          ) : null}
          <label className="mt-2 flex items-center gap-2 text-muted-foreground">
            <input type="checkbox" checked={forEveryone} onChange={(event) => setForEveryone(event.target.checked)} />
            {t("hermesSkills.forEveryone")}
          </label>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className="ui-btn-secondary px-2 py-1 text-[11px]" onClick={() => setScan(null)}>
              {t("hermesSkills.cancel")}
            </button>
            {scan.policy !== "block" ? (
              <button type="button" className="ui-btn-primary px-2 py-1 text-[11px] font-semibold" disabled={busy} onClick={() => void install(scan.policy === "ask")}>
                {scan.policy === "ask" ? t("hermesSkills.installAnyway") : t("hermesSkills.install")}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {progress ? <div className="mt-2 text-[11px] text-muted-foreground">{progress}</div> : null}
      {message ? <div className="mt-2 text-[11px] ui-text-danger">{message}</div> : null}
    </section>
  );
}
