"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

import type { AgentState } from "@/features/agents/state/store";
import type { RunRecord } from "@/features/office/hooks/useRunLog";
import { hqRoleFamily } from "@/features/hq/core/roles";
import { HqClock } from "@/features/hq/hud/HqClock";
import * as aegis from "@/features/aegis/api";
import type { AegisAsset, AegisEngagement, AegisOverview } from "@/lib/aegis/types";
import { t, type TranslationKey } from "@/lib/i18n";

/**
 * The combat console (§3.5): a dense, dark operations screen beside the 3D
 * office. It shows the platform's live state — an attack map of the authorized
 * targets (from the active AEGIS engagement), a findings feed by severity, the
 * team's plain-language chatter, and the legal contour's scope + kill-switch —
 * from real gateway activity and the AEGIS control plane. Confirmed findings
 * with proof flow in once real engagements run; today it reflects the demo
 * team against the demo scope, and the findings panel is marked accordingly.
 */
export function CombatConsole({
  agents,
  runLog,
  onClose,
}: {
  agents: AgentState[];
  runLog: RunRecord[];
  onClose: () => void;
}) {
  const [overview, setOverview] = useState<AegisOverview | null>(null);
  const [active, setActive] = useState<AegisEngagement | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const ov = await aegis.fetchOverview().catch(() => null);
      if (!alive || !ov) return;
      setOverview(ov);
      const activeSummary = ov.engagements.find((engagement) => engagement.status === "active");
      if (activeSummary) {
        const detail = await aegis.fetchEngagement(activeSummary.id).catch(() => null);
        if (alive) setActive(detail?.engagement ?? null);
      } else {
        setActive(null);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 6000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const counts = useMemo(() => {
    let running = 0;
    let error = 0;
    for (const agent of agents) {
      if (agent.status === "running") running += 1;
      else if (agent.status === "error") error += 1;
    }
    return { total: agents.length, running, error, idle: agents.length - running - error };
  }, [agents]);

  const assets = useMemo(() => active?.assets ?? [], [active]);
  const findings = useMemo(() => deriveFindings(assets, agents), [assets, agents]);
  const critical = findings.filter((finding) => finding.severity === "critical" || finding.severity === "high").length;

  const selectedAgent = selectedAgentId ? agents.find((agent) => agent.agentId === selectedAgentId) ?? null : null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-[#050303] text-white">
      <div className="pointer-events-none absolute inset-0 opacity-[0.06] [background:repeating-linear-gradient(0deg,transparent,transparent_2px,rgba(255,40,40,0.6)_3px)]" />

      <header className="relative flex items-center justify-between gap-3 border-b border-red-900/50 bg-black/60 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="h-2 w-2 animate-pulse rounded-full bg-red-500 shadow-[0_0_10px_rgba(255,42,42,0.9)]" />
          <span className="shrink-0 font-mono text-sm font-bold uppercase tracking-[0.34em] text-white [text-shadow:0_0_14px_rgba(255,26,26,0.55)]">
            {t("combat.title")}
          </span>
          <KillChip on={overview?.killSwitch.global ?? false} />
          <ScopeChip name={active?.name ?? null} count={assets.length} />
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <HqClock className="text-right" />
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 items-center gap-1.5 rounded-md border border-red-900/50 bg-black/50 px-3 font-mono text-[11px] uppercase tracking-[0.12em] text-white transition-colors hover:border-red-500/50 hover:bg-red-950/40"
          >
            <X className="h-3.5 w-3.5" />
            {t("combat.toOffice")}
          </button>
        </div>
      </header>

      <div className="relative grid grid-cols-3 gap-px border-b border-red-900/40 bg-red-900/20 sm:grid-cols-4 lg:grid-cols-6">
        <Kpi label={t("combat.kpiAgents")} value={counts.total} />
        <Kpi label={t("combat.kpiWorking")} value={counts.running} accent />
        <Kpi label={t("combat.kpiIdle")} value={counts.idle} />
        <Kpi label={t("combat.kpiError")} value={counts.error} danger={counts.error > 0} />
        <Kpi label={t("combat.kpiFindings")} value={findings.length} />
        <Kpi label={t("combat.kpiCritical")} value={critical} danger={critical > 0} />
      </div>

      <div className="relative grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-hidden p-2 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)_minmax(0,0.95fr)]">
        {assets.length > 0 ? <AttackMap assets={assets} findings={findings} agents={agents} /> : <OpsRadar agents={agents} />}
        <FindingsPanel findings={findings} hasScope={assets.length > 0} />
        <ActivityPanel agents={agents} runLog={runLog} onSelect={setSelectedAgentId} />
      </div>

      {selectedAgent ? <AgentDetail agent={selectedAgent} runLog={runLog} onClose={() => setSelectedAgentId(null)} /> : null}
    </div>
  );
}

// --- header chips -------------------------------------------------------------

function KillChip({ on }: { on: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] ${
        on ? "border-red-500/60 bg-red-600/25 text-red-100" : "border-red-900/40 bg-black/40 text-white/60"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${on ? "animate-pulse bg-red-500" : "bg-white/25"}`} />
      {on ? t("combat.killOn") : t("combat.killOff")}
    </span>
  );
}

function ScopeChip({ name, count }: { name: string | null; count: number }) {
  return (
    <span className="hidden min-w-0 items-center gap-1.5 rounded border border-red-900/40 bg-black/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-white/70 md:inline-flex">
      <span className="shrink-0 text-white/40">{t("combat.scope")}</span>
      {name ? (
        <>
          <span className="max-w-[200px] truncate text-white">{name}</span>
          <span className="shrink-0 text-red-300">· {count}</span>
        </>
      ) : (
        <span className="text-white/40">{t("combat.noScope")}</span>
      )}
    </span>
  );
}

function Kpi({ label, value, accent, danger }: { label: string; value: number; accent?: boolean; danger?: boolean }) {
  const tone = danger ? "text-red-300" : accent ? "text-white" : "text-white";
  return (
    <div className="flex flex-col items-center bg-[#080404] px-2 py-2">
      <span className={`font-mono text-[20px] font-bold tabular-nums leading-none ${tone}`}>{value}</span>
      <span className="mt-1 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-white/45">{label}</span>
    </div>
  );
}

const Panel = ({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) => (
  <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-red-900/40 bg-black/40">
    <div className="flex items-center justify-between gap-2 border-b border-red-900/40 px-3 py-2">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/55">{title}</span>
      {right}
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
  </section>
);

// --- findings -----------------------------------------------------------------

type Severity = "critical" | "high" | "medium" | "low" | "info";
type FindingStatus = "new" | "confirmed" | "poc";
type Finding = {
  id: string;
  severity: Severity;
  title: string;
  target: string;
  status: FindingStatus;
  agent: string;
  at: number;
};

const SEVERITY_ORDER: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const SEVERITY_KEY: Record<Severity, TranslationKey> = {
  critical: "combat.sevCritical",
  high: "combat.sevHigh",
  medium: "combat.sevMedium",
  low: "combat.sevLow",
  info: "combat.sevInfo",
};
const SEVERITY_CLASS: Record<Severity, string> = {
  critical: "border-red-500/60 bg-red-600/30 text-white",
  high: "border-red-500/50 bg-red-600/20 text-red-100",
  medium: "border-orange-400/40 bg-orange-500/10 text-orange-200",
  low: "border-white/20 bg-white/5 text-white/70",
  info: "border-white/15 bg-white/5 text-white/45",
};
const STATUS_KEY: Record<FindingStatus, TranslationKey> = {
  new: "combat.fNew",
  confirmed: "combat.fConfirmed",
  poc: "combat.fPoc",
};

const FINDING_KINDS: { title: string; severity: Severity }[] = [
  { title: "Открытый порт / сервис", severity: "medium" },
  { title: "Устаревший компонент", severity: "high" },
  { title: "Слабые заголовки безопасности", severity: "low" },
  { title: "Раскрытие информации", severity: "medium" },
  { title: "Небезопасная конфигурация", severity: "high" },
  { title: "Нет ограничения частоты запросов", severity: "low" },
  { title: "Возможная инъекция", severity: "critical" },
  { title: "Слабая аутентификация", severity: "critical" },
];

const hash = (text: string): number => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
};

// Deterministic, illustrative findings tied to the (own) scope assets and the
// working agents. Stable frame to frame; a real backend replaces this later.
function deriveFindings(assets: AegisAsset[], agents: AgentState[]): Finding[] {
  const workers = agents.filter((agent) => agent.status !== "idle");
  const pool = workers.length ? workers : agents;
  const out: Finding[] = [];
  assets.forEach((asset, ai) => {
    const n = Math.floor(hash(`${asset.value}#`) * 3.4);
    for (let i = 0; i < n; i++) {
      const kind = FINDING_KINDS[Math.floor(hash(`${asset.value}:${i}`) * FINDING_KINDS.length)];
      const s = hash(`${asset.value}:${i}:s`);
      const status: FindingStatus = kind.severity === "critical" && s > 0.5 ? "poc" : s > 0.55 ? "confirmed" : "new";
      const agent = pool.length ? pool[Math.floor(hash(`${asset.value}:${i}:a`) * pool.length)] : null;
      out.push({
        id: `${asset.id}-${i}`,
        severity: kind.severity,
        title: kind.title,
        target: asset.value,
        status,
        agent: agent?.name || agent?.agentId || "AM7",
        at: 1 + ai * 10 + i,
      });
    }
  });
  return out.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || b.at - a.at);
}

function FindingsPanel({ findings, hasScope }: { findings: Finding[]; hasScope: boolean }) {
  const summary = useMemo(() => {
    const by: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const finding of findings) by[finding.severity] += 1;
    return by;
  }, [findings]);

  return (
    <Panel
      title={t("combat.findings")}
      right={<span className="rounded border border-red-900/40 bg-black/40 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.12em] text-white/40">{t("combat.demo")}</span>}
    >
      <div className="flex flex-wrap gap-1 border-b border-red-900/25 px-3 py-1.5">
        {(["critical", "high", "medium", "low"] as Severity[]).map((severity) => (
          <span key={severity} className={`rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] ${SEVERITY_CLASS[severity]}`}>
            {t(SEVERITY_KEY[severity])} {summary[severity]}
          </span>
        ))}
      </div>
      {findings.length === 0 ? (
        <p className="p-3 font-mono text-[11px] text-white/40">{hasScope ? t("combat.noFindings") : t("combat.noScopeFindings")}</p>
      ) : (
        <ul className="divide-y divide-red-900/25">
          {findings.map((finding) => (
            <li key={finding.id} className="px-3 py-1.5">
              <div className="flex items-center gap-2">
                <span className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-[0.1em] ${SEVERITY_CLASS[finding.severity]}`}>
                  {t(SEVERITY_KEY[finding.severity])}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-white">{finding.title}</span>
                {finding.status === "poc" ? (
                  <span className="shrink-0 rounded bg-red-600/30 px-1 py-0.5 font-mono text-[8px] font-bold uppercase text-red-100">{t("combat.fPoc")}</span>
                ) : (
                  <span className="shrink-0 font-mono text-[8px] uppercase text-white/40">{t(STATUS_KEY[finding.status])}</span>
                )}
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-2 font-mono text-[9px] text-white/45">
                <span className="truncate text-red-300/80">{finding.target}</span>
                <span className="shrink-0">{finding.agent}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// --- attack map (targets from scope) ------------------------------------------

function AttackMap({ assets, findings, agents }: { assets: AegisAsset[]; findings: Finding[]; agents: AgentState[] }) {
  const working = agents.filter((agent) => agent.status === "running").length;
  return (
    <Panel title={t("combat.attackMap")} right={<span className="font-mono text-[9px] text-white/35">{t("combat.targets", { count: assets.length })}</span>}>
      <ul className="space-y-1.5 p-2">
        {assets.map((asset) => {
          const targetFindings = findings.filter((finding) => finding.target === asset.value);
          const worst = targetFindings.reduce<Severity>((acc, finding) => (SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[acc] ? finding.severity : acc), "info");
          // A little live activity per target, seeded so it is stable.
          const busy = Math.max(1, Math.round(hash(`${asset.value}!`) * Math.min(6, Math.max(1, working))));
          const status = targetFindings.length ? t("combat.tgtFinding") : working ? t("combat.tgtProbe") : t("combat.tgtQueued");
          return (
            <li key={asset.id} className="rounded-md border border-red-900/40 bg-[#0b0606]/70 px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0 font-mono text-[9px] uppercase text-red-300">{asset.kind}</span>
                  <span className="min-w-0 truncate font-mono text-[11px] text-white">{asset.value}</span>
                </span>
                {targetFindings.length ? (
                  <span className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[8px] uppercase ${SEVERITY_CLASS[worst]}`}>{targetFindings.length}</span>
                ) : null}
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-white/45">{status}</span>
                <span className="flex items-center gap-0.5">
                  {Array.from({ length: busy }).map((_, index) => (
                    <span
                      key={index}
                      className="h-1.5 w-1.5 rounded-full bg-red-500"
                      style={{ animation: "combat-dot-pulse 1.6s ease-in-out infinite", animationDelay: `${index * 0.18}s` }}
                    />
                  ))}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      <style>{`@keyframes combat-dot-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
    </Panel>
  );
}

// --- operations radar (fallback when no active scope) -------------------------

function OpsRadar({ agents }: { agents: AgentState[] }) {
  const dots = useMemo(() => {
    const ranked = [...agents].sort((a, b) => rank(b) - rank(a)).slice(0, 260);
    return ranked.map((agent) => {
      const family = String(hqRoleFamily(agent.role ?? ""));
      const angle = (hash(family) + hash(agent.agentId) * 0.22) * Math.PI * 2;
      const radius = 8 + hash(`${agent.agentId}r`) * 34 + (agent.status === "running" ? 0 : 4);
      return { id: agent.agentId, x: 50 + Math.cos(angle) * radius, y: 50 + Math.sin(angle) * radius, status: agent.status };
    });
  }, [agents]);

  return (
    <Panel title={t("combat.radar")}>
      <div className="relative h-full min-h-[220px] w-full">
        <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" className="h-full w-full">
          <defs>
            <radialGradient id="combat-sweep" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(255,40,40,0.35)" />
              <stop offset="100%" stopColor="rgba(255,40,40,0)" />
            </radialGradient>
          </defs>
          {[12, 24, 36, 46].map((r) => (
            <circle key={r} cx="50" cy="50" r={r} fill="none" stroke="rgba(255,40,40,0.14)" strokeWidth="0.2" />
          ))}
          <g style={{ transformOrigin: "50px 50px", animation: "combat-radar-spin 6s linear infinite" }}>
            <path d="M50 50 L50 4 A46 46 0 0 1 82 15 Z" fill="url(#combat-sweep)" />
          </g>
          {dots.map((dot) => (
            <circle
              key={dot.id}
              cx={dot.x}
              cy={dot.y}
              r={dot.status === "running" ? 0.9 : 0.6}
              fill={dot.status === "error" ? "#ff3b3b" : dot.status === "running" ? "#ff6a6a" : "rgba(255,150,150,0.4)"}
              className={dot.status === "running" ? "combat-dot-pulse" : ""}
            />
          ))}
        </svg>
        <style>{`
          @keyframes combat-radar-spin { to { transform: rotate(360deg); } }
          @keyframes combat-dot-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
          .combat-dot-pulse { animation: combat-dot-pulse 1.6s ease-in-out infinite; }
        `}</style>
      </div>
    </Panel>
  );
}

const rank = (agent: AgentState): number => (agent.status === "error" ? 3 : agent.status === "running" ? 2 : 1) + (agent.lastActivityAt ?? 0) / 1e13;

// --- activity / chatter -------------------------------------------------------

const AG_STATUS_KEY: Record<AgentState["status"], TranslationKey> = { running: "combat.stWorking", idle: "combat.stIdle", error: "combat.stError" };
const AG_STATUS_CLASS: Record<AgentState["status"], string> = { running: "text-red-300", idle: "text-white/45", error: "text-red-400" };

const timeOf = (ms: number | null | undefined): string => {
  if (!ms) return "--:--";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const previewOf = (agent: AgentState): string => (agent.latestPreview || agent.lastResult || "").replace(/\s+/g, " ").trim();

function ActivityPanel({ agents, runLog, onSelect }: { agents: AgentState[]; runLog: RunRecord[]; onSelect: (id: string) => void }) {
  const rows = useMemo(
    () =>
      agents
        .filter((agent) => agent.status !== "idle" || previewOf(agent))
        .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
        .slice(0, 40),
    [agents],
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <Panel title={t("combat.chatter")} right={<span className="font-mono text-[9px] text-white/35">{t("combat.runs", { count: runLog.length })}</span>}>
      <div ref={scrollRef} className="h-full">
        {rows.length === 0 ? (
          <p className="p-3 font-mono text-[11px] text-white/40">{t("combat.quiet")}</p>
        ) : (
          <ul className="space-y-1.5 p-2">
            {rows.map((agent) => (
              <li key={agent.agentId}>
                <button
                  type="button"
                  onClick={() => onSelect(agent.agentId)}
                  className="w-full rounded border border-red-900/30 bg-[#0b0606]/80 px-2.5 py-1.5 text-left transition-colors hover:border-red-500/50 hover:bg-red-950/30"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-[10px] font-semibold text-red-200">{agent.name || agent.agentId}</span>
                    <span className="flex shrink-0 items-center gap-2 font-mono text-[9px]">
                      <span className={AG_STATUS_CLASS[agent.status]}>{t(AG_STATUS_KEY[agent.status])}</span>
                      <span className="text-white/30">{timeOf(agent.lastActivityAt)}</span>
                    </span>
                  </div>
                  {previewOf(agent) ? <p className="mt-0.5 truncate font-mono text-[10px] text-white/70">{previewOf(agent)}</p> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

// --- per-agent detail ---------------------------------------------------------

function AgentDetail({ agent, runLog, onClose }: { agent: AgentState; runLog: RunRecord[]; onClose: () => void }) {
  const runs = useMemo(() => runLog.filter((run) => run.agentId === agent.agentId).slice(0, 12), [runLog, agent.agentId]);
  return (
    <div className="absolute inset-0 z-10 flex justify-end bg-black/50" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="flex h-full w-full max-w-[380px] flex-col border-l border-red-900/50 bg-[#080404]/98 shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-red-900/40 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate font-mono text-[13px] font-semibold text-white">{agent.name || agent.agentId}</div>
            <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.1em]">
              <span className={AG_STATUS_CLASS[agent.status]}>{t(AG_STATUS_KEY[agent.status])}</span>
              {agent.role ? <span className="text-white/50">{agent.role}</span> : null}
            </div>
          </div>
          <button type="button" onClick={onClose} className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-red-900/40 text-white/70 transition-colors hover:border-red-500/50 hover:text-white">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {previewOf(agent) ? (
            <div>
              <div className="font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-white/45">{t("combat.latest")}</div>
              <p className="mt-1 font-mono text-[11px] leading-snug text-white/80">{previewOf(agent)}</p>
            </div>
          ) : null}
          <div>
            <div className="font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-white/45">{t("combat.runsTitle")}</div>
            {runs.length === 0 ? (
              <p className="mt-1 font-mono text-[10px] text-white/40">{t("combat.noRuns")}</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {runs.map((run) => (
                  <li key={run.runId} className="flex items-center justify-between gap-2 rounded bg-black/40 px-2 py-1 font-mono text-[10px]">
                    <span className="text-white/70">{run.trigger}</span>
                    <span className={run.outcome === "error" ? "text-red-400" : "text-white/50"}>{run.outcome}</span>
                    <span className="text-white/30">{timeOf(run.startedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
