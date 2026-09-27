"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

import type { AgentState } from "@/features/agents/state/store";
import type { RunRecord } from "@/features/office/hooks/useRunLog";
import { hqRoleFamily } from "@/features/hq/core/roles";
import { HqClock } from "@/features/hq/hud/HqClock";
import * as aegis from "@/features/aegis/api";
import type { AegisOverview } from "@/lib/aegis/types";
import { t, type TranslationKey } from "@/lib/i18n";

/**
 * The combat console (§3.5): a dense, dark operations screen beside the 3D
 * office. It shows the platform's live state — an operations radar of the
 * team, a feed of what agents are doing, their plain-language chatter, and the
 * legal contour's scope + kill-switch — all from real gateway activity and the
 * AEGIS control plane. Confirmed findings with proof arrive here once real
 * engagements run; today it reflects the demo team's activity.
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

  useEffect(() => {
    let alive = true;
    const load = () =>
      aegis
        .fetchOverview()
        .then((value) => {
          if (alive) setOverview(value);
        })
        .catch(() => {});
    void load();
    const timer = window.setInterval(load, 6000);
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

  const activeScope = useMemo(() => {
    const active = overview?.engagements.find((engagement) => engagement.status === "active");
    return active ?? null;
  }, [overview]);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-[#050303] text-white">
      <div className="pointer-events-none absolute inset-0 opacity-[0.06] [background:repeating-linear-gradient(0deg,transparent,transparent_2px,rgba(255,40,40,0.6)_3px)]" />

      {/* Header */}
      <header className="relative flex items-center justify-between gap-3 border-b border-red-900/50 bg-black/60 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <span className="h-2 w-2 animate-pulse rounded-full bg-red-500 shadow-[0_0_10px_rgba(255,42,42,0.9)]" />
          <span className="font-mono text-sm font-bold uppercase tracking-[0.34em] text-white [text-shadow:0_0_14px_rgba(255,26,26,0.55)]">
            {t("combat.title")}
          </span>
          <KillChip on={overview?.killSwitch.global ?? false} />
          <ScopeChip name={activeScope?.name ?? null} count={activeScope?.assetCount ?? 0} />
        </div>
        <div className="flex items-center gap-3">
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

      {/* KPI strip */}
      <div className="relative grid grid-cols-2 gap-px border-b border-red-900/40 bg-red-900/20 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label={t("combat.kpiAgents")} value={counts.total} />
        <Kpi label={t("combat.kpiWorking")} value={counts.running} accent />
        <Kpi label={t("combat.kpiIdle")} value={counts.idle} />
        <Kpi label={t("combat.kpiError")} value={counts.error} danger={counts.error > 0} />
        <Kpi label={t("combat.kpiScope")} value={activeScope ? activeScope.assetCount : 0} />
        <Kpi label={t("combat.kpiAudit")} value={overview?.audit.count ?? 0} ok={overview?.audit.ok ?? true} />
      </div>

      {/* Main grid */}
      <div className="relative grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-hidden p-2 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,0.9fr)]">
        <OpsRadar agents={agents} />
        <OpsFeed agents={agents} runLog={runLog} />
        <ChatterFeed agents={agents} />
      </div>
    </div>
  );
}

function KillChip({ on }: { on: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] ${
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
    <span className="hidden items-center gap-1.5 rounded border border-red-900/40 bg-black/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-white/70 md:inline-flex">
      <span className="text-white/40">{t("combat.scope")}</span>
      {name ? (
        <>
          <span className="max-w-[220px] truncate text-white">{name}</span>
          <span className="text-red-300">· {count}</span>
        </>
      ) : (
        <span className="text-white/40">{t("combat.noScope")}</span>
      )}
    </span>
  );
}

function Kpi({
  label,
  value,
  accent,
  danger,
  ok,
}: {
  label: string;
  value: number;
  accent?: boolean;
  danger?: boolean;
  ok?: boolean;
}) {
  const tone = danger ? "text-red-300" : accent ? "text-white" : ok === false ? "text-red-300" : "text-white";
  return (
    <div className="flex flex-col items-center bg-[#080404] px-2 py-2">
      <span className={`font-mono text-[20px] font-bold tabular-nums leading-none ${tone}`}>{value}</span>
      <span className="mt-1 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-white/45">{label}</span>
    </div>
  );
}

const Panel = ({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) => (
  <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-red-900/40 bg-black/40">
    <div className="flex items-center justify-between border-b border-red-900/40 px-3 py-2">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/55">{title}</span>
      {right}
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
  </section>
);

// --- operations radar ---------------------------------------------------------

// Deterministic angle/radius for an agent, so the radar is stable frame to frame.
const hash = (text: string): number => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
};

function OpsRadar({ agents }: { agents: AgentState[] }) {
  // Cap the drawn dots so a 1000-agent team stays light; keep every working
  // and error agent, fill the rest with idle ones.
  const dots = useMemo(() => {
    const ranked = [...agents].sort((a, b) => rank(b) - rank(a)).slice(0, 260);
    return ranked.map((agent) => {
      const family = String(hqRoleFamily(agent.role ?? ""));
      const angle = (hash(family) + hash(agent.agentId) * 0.22) * Math.PI * 2;
      const radius = 8 + hash(`${agent.agentId}r`) * 34 + (agent.status === "running" ? 0 : 4);
      return {
        id: agent.agentId,
        x: 50 + Math.cos(angle) * radius,
        y: 50 + Math.sin(angle) * radius,
        status: agent.status,
      };
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
          <line x1="50" y1="4" x2="50" y2="96" stroke="rgba(255,40,40,0.1)" strokeWidth="0.2" />
          <line x1="4" y1="50" x2="96" y2="50" stroke="rgba(255,40,40,0.1)" strokeWidth="0.2" />
          {/* sweep */}
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
              className={dot.status === "running" ? "combat-dot-pulse" : dot.status === "error" ? "combat-dot-alarm" : ""}
            />
          ))}
        </svg>
        <style>{`
          @keyframes combat-radar-spin { to { transform: rotate(360deg); } }
          @keyframes combat-dot-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
          @keyframes combat-dot-alarm { 0%,100% { opacity: 1; } 50% { opacity: 0.2; } }
          .combat-dot-pulse { animation: combat-dot-pulse 1.6s ease-in-out infinite; }
          .combat-dot-alarm { animation: combat-dot-alarm 0.7s ease-in-out infinite; }
        `}</style>
      </div>
    </Panel>
  );
}

const rank = (agent: AgentState): number => (agent.status === "error" ? 3 : agent.status === "running" ? 2 : 1) + (agent.lastActivityAt ?? 0) / 1e13;

// --- operations feed ----------------------------------------------------------

const STATUS_LABEL: Record<AgentState["status"], TranslationKey> = {
  running: "combat.stWorking",
  idle: "combat.stIdle",
  error: "combat.stError",
};
const STATUS_CLASS: Record<AgentState["status"], string> = {
  running: "text-red-300",
  idle: "text-white/45",
  error: "text-red-400",
};

const timeOf = (ms: number | null | undefined): string => {
  if (!ms) return "--:--";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function OpsFeed({ agents, runLog }: { agents: AgentState[]; runLog: RunRecord[] }) {
  const rows = useMemo(() => {
    const active = agents
      .filter((agent) => agent.status !== "idle" || agent.latestPreview)
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
      .slice(0, 40)
      .map((agent) => ({
        key: `a-${agent.agentId}`,
        at: agent.lastActivityAt ?? null,
        name: agent.name || agent.agentId,
        status: agent.status,
        text: (agent.latestPreview || agent.lastResult || "").replace(/\s+/g, " ").slice(0, 120),
      }));
    return active;
  }, [agents]);

  return (
    <Panel title={t("combat.opsFeed")} right={<span className="font-mono text-[9px] text-white/35">{t("combat.runs", { count: runLog.length })}</span>}>
      {rows.length === 0 ? (
        <p className="p-3 font-mono text-[11px] text-white/40">{t("combat.quiet")}</p>
      ) : (
        <ul className="divide-y divide-red-900/25">
          {rows.map((row) => (
            <li key={row.key} className="px-3 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-[11px] font-semibold text-white">{row.name}</span>
                <span className="flex shrink-0 items-center gap-2 font-mono text-[9px]">
                  <span className={STATUS_CLASS[row.status]}>{t(STATUS_LABEL[row.status])}</span>
                  <span className="text-white/30">{timeOf(row.at)}</span>
                </span>
              </div>
              {row.text ? <p className="mt-0.5 truncate font-mono text-[10px] text-white/55">{row.text}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// --- agent chatter ------------------------------------------------------------

function ChatterFeed({ agents }: { agents: AgentState[] }) {
  const messages = useMemo(
    () =>
      agents
        .filter((agent) => (agent.latestPreview || agent.lastResult || "").trim().length > 0)
        .sort((a, b) => (b.lastAssistantMessageAt ?? b.lastActivityAt ?? 0) - (a.lastAssistantMessageAt ?? a.lastActivityAt ?? 0))
        .slice(0, 30)
        .map((agent) => ({
          key: `m-${agent.agentId}-${agent.lastAssistantMessageAt ?? agent.lastActivityAt ?? 0}`,
          name: agent.name || agent.agentId,
          at: agent.lastAssistantMessageAt ?? agent.lastActivityAt ?? null,
          text: (agent.latestPreview || agent.lastResult || "").replace(/\s+/g, " ").slice(0, 200),
        })),
    [agents],
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <Panel title={t("combat.chatter")}>
      <div ref={scrollRef} className="h-full">
        {messages.length === 0 ? (
          <p className="p-3 font-mono text-[11px] text-white/40">{t("combat.quiet")}</p>
        ) : (
          <ul className="space-y-1.5 p-2.5">
            {messages.map((message) => (
              <li key={message.key} className="rounded border border-red-900/30 bg-[#0b0606]/80 px-2.5 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-[10px] font-semibold text-red-200">{message.name}</span>
                  <span className="shrink-0 font-mono text-[9px] text-white/30">{timeOf(message.at)}</span>
                </div>
                <p className="mt-0.5 font-mono text-[10px] leading-snug text-white/75">{message.text}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
