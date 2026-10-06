"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Globe2, X } from "lucide-react";

import type { AgentState } from "@/features/agents/state/store";
import { hqRoleFamily } from "@/features/hq/core/roles";
import { HqClock } from "@/features/hq/hud/HqClock";
import * as aegis from "@/features/aegis/api";
import type { AegisAsset, AegisEngagement, AegisOverview } from "@/lib/aegis/types";
import { osintController, DEMO_OSINT, OSINT_TOOL_BY_ID } from "@/features/hq/osint";
import type { OsintDataset, OsintSeverity } from "@/features/hq/osint";
import { geoController } from "@/features/hq/geo";
import type { GeoSceneData, GeoTarget } from "@/features/hq/geo";
import { chatterController } from "@/features/hq/chatter";
import type { ChatterKind, ChatterMessage, ChatterSeverity } from "@/features/hq/chatter";
import { opsController, OpsReportPanel } from "@/features/hq/ops";
import { t, type TranslationKey } from "@/lib/i18n";

/**
 * The combat console (§3.5): the UNIFIED live operations view beside the 3D
 * office. It connects the pieces that otherwise live apart into one screen:
 *
 *  - ATTACK MAP — the authorized targets of the active scope, read from the SAME
 *    shared globe controller (geoController) the God's-Eye view uses; clicking a
 *    target flies the globe to it, so map and globe never disagree.
 *  - FINDINGS — ONE stream: the OSINT feed (osintController, the same source the
 *    РАЗВЕДКА view reads) merged with the AEGIS scope's surface findings. A
 *    finding discovered in recon shows here too, with its severity, confidence
 *    and source tool.
 *  - LIVE CHATTER — agents talking and delegating in plain Russian
 *    (chatterController), authorized-recon flavour, demo-scripted now behind a
 *    clean seam for the real runtime.
 *
 * All three come from framework-free controllers that demo data populates today
 * and the scope-enforced Execution Plane will drive later. The pult only
 * DISPLAYS — it never acts on a target and sends nothing externally.
 */
export function CombatConsole({
  agents,
  onClose,
  onFlyToGlobe,
}: {
  agents: AgentState[];
  onClose: () => void;
  /** Flies the shared God's-Eye globe to a point (and opens it); set by the host. */
  onFlyToGlobe?: (lat: number, lon: number) => void;
}) {
  const [overview, setOverview] = useState<AegisOverview | null>(null);
  const [active, setActive] = useState<AegisEngagement | null>(null);
  const [osint, setOsint] = useState<OsintDataset | null>(() => osintController.getData() ?? DEMO_OSINT);
  const [scene, setScene] = useState<GeoSceneData>(() => geoController.getScene());
  const [chatter, setChatter] = useState<readonly ChatterMessage[]>(() => chatterController.getMessages());

  // The legal contour (kill-switch + active engagement name/scope), polled.
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

  // One source of truth for recon: seed the OSINT controller if nothing has yet
  // (this also projects the geo entities onto the shared globe), then track it.
  useEffect(() => {
    if (!osintController.getData()) osintController.setData(DEMO_OSINT);
    return osintController.subscribe(setOsint);
  }, []);

  // The attack map reads the same targets the globe draws. Re-read the scene on
  // subscribe: the OSINT seed above may have projected its pins before this
  // listener existed, so the initial snapshot can be stale.
  useEffect(() => {
    const unsubscribe = geoController.subscribe(setScene);
    // The OSINT seed above may have fired BEFORE this subscription attached,
    // so sync once off-render on the next microtask to pick up any stale state.
    queueMicrotask(() => setScene(geoController.getScene()));
    return unsubscribe;
  }, []);

  // Live chatter + the OPS organism. The ops controller drives the swarm: the
  // lead announces the task, allocates operatives, they self-delegate across
  // flat roles and post human-language chatter + findings as they chain toward
  // full control (in sandbox). It posts into the SAME chatterController and
  // osintController the pult reads, so one coherent live demo covers the pult.
  // Ref-counted — closed pults cost nothing.
  useEffect(() => {
    const unsubscribe = chatterController.subscribe(setChatter);
    const release = opsController.ensureDemo();
    // Any backfilled lines from ensureDemo arrive via the subscription above;
    // sync once off-render in case ensureDemo emitted before we subscribed.
    queueMicrotask(() => setChatter(chatterController.getMessages()));
    return () => {
      release();
      unsubscribe();
    };
  }, []);

  // Report overlay («Отчёт» — owner 2026-10-07, Strix-like, tool-free).
  const [reportOpen, setReportOpen] = useState(false);

  // Esc closes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
  const findings = useMemo(() => mergeFindings(osint, assets, agents), [osint, assets, agents]);
  const critical = findings.filter((finding) => finding.severity === "critical" || finding.severity === "high").length;

  // The map's targets: the shared globe's pins, minus the HQ anchor itself.
  const mapTargets = useMemo(() => scene.targets.filter((target) => target.kind !== "hq"), [scene]);

  const fly = useMemo(
    () => (geo: { lat: number; lon: number } | undefined) => {
      if (!geo || !onFlyToGlobe) return;
      onFlyToGlobe(geo.lat, geo.lon);
    },
    [onFlyToGlobe],
  );

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
          <ScopeChip name={active?.name ?? osint?.engagement.name ?? null} count={assets.length || mapTargets.length} />
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <HqClock className="text-right" />
          <button
            type="button"
            onClick={() => setReportOpen(true)}
            className="flex h-8 items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/15 px-3 font-mono text-[11px] uppercase tracking-[0.12em] text-amber-100 transition-colors hover:border-amber-400/60 hover:bg-amber-500/25"
            title="Собрать отчёт по текущей операции"
          >
            Сформировать отчёт
          </button>
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
        {mapTargets.length > 0 ? (
          <AttackMap targets={mapTargets} findings={findings} working={counts.running} canFly={Boolean(onFlyToGlobe)} onFly={fly} />
        ) : (
          <OpsRadar agents={agents} />
        )}
        <FindingsPanel findings={findings} hasScope={findings.length > 0} canFly={Boolean(onFlyToGlobe)} onFly={fly} />
        <ChatterPanel messages={chatter} canFly={Boolean(onFlyToGlobe)} onFly={fly} />
      </div>

      <OpsReportPanel open={reportOpen} onClose={() => setReportOpen(false)} />
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

const DemoTag = () => (
  <span className="rounded border border-red-900/40 bg-black/40 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.12em] text-white/40">
    {t("combat.demo")}
  </span>
);

// --- findings (one stream: OSINT feed + AEGIS scope surface) ------------------

type Severity = "critical" | "high" | "medium" | "low" | "info";
type FindingStatus = "new" | "confirmed" | "poc";
type Finding = {
  id: string;
  severity: Severity;
  title: string;
  /** Display target (entity label / asset value). */
  target: string;
  status: FindingStatus;
  /** Where it came from: the OSINT tool name, or «AEGIS». */
  source: string;
  at: number;
  /** 0..1, when known (OSINT findings). */
  confidence?: number;
  /** Geolocation, when the target has one — enables fly-to. */
  geo?: { lat: number; lon: number };
  /** The shared globe target id this maps to (for the attack map's severity). */
  targetId?: string;
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

/** OSINT severities map straight onto the pult's (no OSINT finding is critical). */
const osintSeverity = (severity: OsintSeverity): Severity => severity;

/**
 * The ONE findings stream: the OSINT feed (the same osintController the РАЗВЕДКА
 * view reads) first — so a finding discovered in recon shows here with its
 * severity, confidence, source tool and geolocation — then the AEGIS scope's
 * illustrative surface findings tied to the active engagement's assets.
 */
function mergeFindings(osint: OsintDataset | null, assets: AegisAsset[], agents: AgentState[]): Finding[] {
  const out: Finding[] = [];

  if (osint) {
    const entityById = new Map(osint.entities.map((entity) => [entity.id, entity]));
    osint.findings.forEach((finding, index) => {
      const entity = finding.entityId ? entityById.get(finding.entityId) : undefined;
      const tool = OSINT_TOOL_BY_ID[finding.sourceToolId];
      out.push({
        id: finding.id,
        severity: osintSeverity(finding.severity),
        title: finding.title,
        target: entity?.label ?? finding.target ?? "—",
        status: finding.confidence >= 0.85 ? "confirmed" : "new",
        source: tool?.name ?? finding.sourceToolId,
        at: 1_000 + index,
        confidence: finding.confidence,
        geo: entity?.geo ? { lat: entity.geo.lat, lon: entity.geo.lon } : undefined,
        targetId: entity ? `osint:${entity.id}` : undefined,
      });
    });
  }

  // The AEGIS scope's surface findings: deterministic, illustrative, tied to the
  // active engagement's assets and the working agents. A real backend replaces
  // this with confirmed, proof-carrying findings later.
  const workers = agents.filter((agent) => agent.status !== "idle");
  const pool = workers.length ? workers : agents;
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
        source: agent?.name || agent?.agentId || "AEGIS",
        at: ai * 10 + i,
      });
    }
  });

  return out.sort(
    (a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || (b.confidence ?? 0) - (a.confidence ?? 0) || b.at - a.at,
  );
}

function FindingsPanel({
  findings,
  hasScope,
  canFly,
  onFly,
}: {
  findings: Finding[];
  hasScope: boolean;
  canFly: boolean;
  onFly: (geo: { lat: number; lon: number } | undefined) => void;
}) {
  const summary = useMemo(() => {
    const by: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const finding of findings) by[finding.severity] += 1;
    return by;
  }, [findings]);

  return (
    <Panel title={t("combat.findings")} right={<DemoTag />}>
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
          {findings.map((finding) => {
            const flyable = canFly && finding.geo !== undefined;
            return (
              <li key={finding.id}>
                <button
                  type="button"
                  disabled={!flyable}
                  onClick={() => onFly(finding.geo)}
                  title={flyable ? t("combat.flyTo") : undefined}
                  className={`group block w-full px-3 py-1.5 text-left transition-colors ${
                    flyable ? "hover:bg-red-950/30" : "cursor-default"
                  }`}
                >
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
                    {flyable ? <Globe2 className="h-3 w-3 shrink-0 text-white/35 group-hover:text-red-300" /> : null}
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2 font-mono text-[9px] text-white/45">
                    <span className="truncate text-red-300/80">{finding.target}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      {finding.confidence !== undefined ? (
                        <span className="text-white/40">{t("combat.confidence", { value: Math.round(finding.confidence * 100) })}</span>
                      ) : null}
                      <span>{finding.source}</span>
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

// --- attack map (targets from the shared globe) -------------------------------

function AttackMap({
  targets,
  findings,
  working,
  canFly,
  onFly,
}: {
  targets: readonly GeoTarget[];
  findings: Finding[];
  working: number;
  canFly: boolean;
  onFly: (geo: { lat: number; lon: number } | undefined) => void;
}) {
  const worstByTarget = useMemo(() => {
    const map = new Map<string, { worst: Severity; count: number }>();
    for (const finding of findings) {
      if (!finding.targetId) continue;
      const current = map.get(finding.targetId);
      const worst = current && SEVERITY_ORDER[current.worst] >= SEVERITY_ORDER[finding.severity] ? current.worst : finding.severity;
      map.set(finding.targetId, { worst, count: (current?.count ?? 0) + 1 });
    }
    return map;
  }, [findings]);

  return (
    <Panel
      title={t("combat.attackMap")}
      right={<span className="font-mono text-[9px] text-white/35">{t("combat.targets", { count: targets.length })}</span>}
    >
      <ul className="space-y-1.5 p-2">
        {targets.map((target) => {
          const hit = worstByTarget.get(target.id);
          const busy = Math.max(1, Math.round(hash(`${target.label}!`) * Math.min(6, Math.max(1, working))));
          const status = hit ? t("combat.tgtFinding") : working ? t("combat.tgtProbe") : t("combat.tgtQueued");
          return (
            <li key={target.id}>
              <button
                type="button"
                disabled={!canFly}
                onClick={() => onFly({ lat: target.lat, lon: target.lon })}
                title={canFly ? t("combat.flyTo") : undefined}
                className={`group block w-full rounded-md border border-red-900/40 bg-[#0b0606]/70 px-2.5 py-2 text-left transition-colors ${
                  canFly ? "hover:border-red-500/50 hover:bg-red-950/30" : "cursor-default"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="shrink-0 font-mono text-[9px] uppercase text-red-300">{target.kind}</span>
                    <span className="min-w-0 truncate font-mono text-[11px] text-white">{target.label}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {hit ? (
                      <span className={`rounded border px-1.5 py-0.5 font-mono text-[8px] uppercase ${SEVERITY_CLASS[hit.worst]}`}>{hit.count}</span>
                    ) : null}
                    {canFly ? <Globe2 className="h-3 w-3 text-white/30 group-hover:text-red-300" /> : null}
                  </span>
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
              </button>
            </li>
          );
        })}
      </ul>
      <style>{`@keyframes combat-dot-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
    </Panel>
  );
}

// --- operations radar (fallback when the globe has no targets yet) ------------

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

// --- live chatter (human-language ops traffic) --------------------------------

const timeOf = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const CHATTER_KIND_KEY: Record<ChatterKind, TranslationKey> = {
  recon: "combat.chatRecon",
  delegate: "combat.chatDelegate",
  accept: "combat.chatAccept",
  finding: "combat.chatFinding",
  verify: "combat.chatVerify",
  status: "combat.chatStatus",
  escalate: "combat.chatEscalate",
};
const CHATTER_KIND_CLASS: Record<ChatterKind, string> = {
  recon: "border-white/20 bg-white/5 text-white/70",
  delegate: "border-orange-400/40 bg-orange-500/10 text-orange-200",
  accept: "border-red-500/40 bg-red-600/15 text-red-100",
  finding: "border-red-500/50 bg-red-600/20 text-red-100",
  verify: "border-emerald-400/30 bg-emerald-500/10 text-emerald-200",
  status: "border-white/15 bg-white/5 text-white/50",
  escalate: "border-amber-500/40 bg-amber-500/10 text-amber-200",
};
const CHATTER_SEVERITY_CLASS: Record<ChatterSeverity, string> = {
  critical: "text-red-200",
  high: "text-red-300",
  medium: "text-orange-300",
  low: "text-white/60",
  info: "text-white/45",
};

function ChatterPanel({
  messages,
  canFly,
  onFly,
}: {
  messages: readonly ChatterMessage[];
  canFly: boolean;
  onFly: (geo: { lat: number; lon: number } | undefined) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow the tail as new lines arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <Panel
      title={t("combat.chatter")}
      right={
        <span className="flex items-center gap-2">
          <span className="font-mono text-[9px] text-white/35">{t("combat.lines", { count: messages.length })}</span>
          <DemoTag />
        </span>
      }
    >
      <div ref={scrollRef} className="h-full">
        {messages.length === 0 ? (
          <p className="p-3 font-mono text-[11px] text-white/40">{t("combat.channelQuiet")}</p>
        ) : (
          <ul className="space-y-1.5 p-2">
            {messages.map((message) => {
              const flyable = canFly && message.geo !== undefined;
              const severityClass = message.severity ? CHATTER_SEVERITY_CLASS[message.severity] : "text-white/80";
              return (
                <li key={message.id}>
                  <button
                    type="button"
                    disabled={!flyable}
                    onClick={() => onFly(message.geo)}
                    title={flyable ? t("combat.flyTo") : undefined}
                    className={`block w-full rounded border border-red-900/30 bg-[#0b0606]/80 px-2.5 py-1.5 text-left transition-colors ${
                      flyable ? "hover:border-red-500/50 hover:bg-red-950/30" : "cursor-default"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-mono text-[10px] font-semibold text-red-200">{message.callsign}</span>
                        <span className={`shrink-0 rounded border px-1 py-0.5 font-mono text-[7.5px] uppercase tracking-[0.1em] ${CHATTER_KIND_CLASS[message.kind]}`}>
                          {t(CHATTER_KIND_KEY[message.kind])}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5 font-mono text-[9px] text-white/30">
                        {flyable ? <Globe2 className="h-3 w-3 text-white/35" /> : null}
                        {timeOf(message.at)}
                      </span>
                    </div>
                    <p className={`mt-0.5 font-mono text-[10px] leading-snug ${severityClass}`}>{message.text}</p>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
}
