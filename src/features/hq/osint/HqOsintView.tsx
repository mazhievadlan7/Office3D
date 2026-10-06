"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Globe2, KeyRound, X } from "lucide-react";

import { t } from "@/lib/i18n";
import { HQ_HUD_GLASS, hqHudButtonClass } from "@/features/hq/hud/hudStyle";
import { DEMO_OSINT } from "./demoData";
import { layoutGraph } from "./graphLayout";
import { osintController } from "./osintController";
import { OSINT_ENTITY_STYLE, OSINT_RELATION_STYLE, OSINT_SEVERITY_STYLE } from "./osintStyle";
import {
  OSINT_CATEGORY_LABEL,
  OSINT_CATEGORY_ORDER,
  OSINT_TOOLS,
  OSINT_TOOL_BY_ID,
  type OsintTool,
} from "./tools";
import type { OsintDataset, OsintEntity, OsintSeverity } from "./types";

const SEVERITY_WEIGHT: Record<OsintSeverity, number> = { high: 3, medium: 2, low: 1, info: 0 };

export type HqOsintViewProps = {
  onClose: () => void;
  /** Opens the globe centred on a geolocation (the ГЕО view); falls back to a globe fly-to. */
  onFlyToGlobe?: (lat: number, lon: number) => void;
};

/**
 * The full-screen «РАЗВЕДКА / OSINT» panel: the hackers' open-source toolkit, a
 * lightweight entity graph and a findings feed, all for ONE authorized engagement
 * and scope. A showcase layer over normalized demo data today; the scope-enforced
 * Execution Plane will drive the same osintController later.
 *
 * Perf: mounted only while summoned (HqOffice pauses the hall's R3F render then,
 * as it does for the globe). The graph is a static SVG — its force layout runs
 * once in a useMemo on open, so there is no animation loop and nothing is added
 * to the hall's per-frame cost.
 */
export function HqOsintView({ onClose, onFlyToGlobe }: HqOsintViewProps) {
  const [data, setLocal] = useState<OsintDataset | null>(() => osintController.getData() ?? DEMO_OSINT);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Seed the controller the first time the view opens (projects the geo entities
  // onto the shared globe), then track updates. The initial render already reads
  // the controller (falling back to the demo seed), so there is no empty flash.
  useEffect(() => {
    if (!osintController.getData()) osintController.setData(DEMO_OSINT);
    return osintController.subscribe(setLocal);
  }, []);

  // Esc closes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const entities = useMemo(() => data?.entities ?? [], [data]);
  const relations = useMemo(() => data?.relations ?? [], [data]);
  const findings = useMemo(() => data?.findings ?? [], [data]);

  const layout = useMemo(() => layoutGraph(entities, relations), [entities, relations]);
  const posById = useMemo(() => new Map(layout.nodes.map((node) => [node.id, node])), [layout]);
  const entityById = useMemo(() => new Map(entities.map((entity) => [entity.id, entity])), [entities]);

  // Neighbours of the hovered node, so the rest can dim.
  const neighbours = useMemo(() => {
    if (!hoverId) return null;
    const set = new Set<string>([hoverId]);
    for (const relation of relations) {
      if (relation.from === hoverId) set.add(relation.to);
      if (relation.to === hoverId) set.add(relation.from);
    }
    return set;
  }, [hoverId, relations]);

  const sortedFindings = useMemo(
    () =>
      [...findings].sort(
        (a, b) =>
          SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] || b.confidence - a.confidence,
      ),
    [findings],
  );

  const flyEntity = useCallback(
    (entity: OsintEntity | undefined) => {
      if (!entity?.geo) return;
      if (onFlyToGlobe) onFlyToGlobe(entity.geo.lat, entity.geo.lon);
      else osintController.flyToEntity(entity.id);
    },
    [onFlyToGlobe],
  );

  const toolsByCategory = useMemo(() => {
    const map = new Map<OsintTool["category"], OsintTool[]>();
    for (const tool of OSINT_TOOLS) {
      const list = map.get(tool.category) ?? [];
      list.push(tool);
      map.set(tool.category, list);
    }
    return map;
  }, []);

  const confPct = (value: number) => Math.round(value * 100);

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-[#06080c]" role="dialog" aria-label={t("hqOsint.title")}>
      {/* Header: title, lawful banner, engagement/scope, close. */}
      <div className="flex items-start justify-between gap-3 border-b border-red-900/40 px-3 py-2.5">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-400 shadow-[0_0_8px_rgba(255,42,42,0.8)]" />
            <span className="font-mono text-[13px] font-semibold uppercase tracking-[0.28em] text-white">
              {t("hqOsint.title")}
            </span>
            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-amber-200/90">
              {t("hqOsint.demoBadge")}
            </span>
          </div>
          <span className="max-w-[640px] font-mono text-[9px] leading-relaxed uppercase tracking-[0.08em] text-white/55">
            {t("hqOsint.lawful")}
          </span>
          {data ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-white/60">
              <span>
                <span className="text-white/40">{t("hqOsint.engagement")}:</span> {data.engagement.name}
              </span>
              <span className="truncate">
                <span className="text-white/40">{t("hqOsint.scope")}:</span> {data.engagement.scope}
              </span>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("hqOsint.close")}
          title={t("hqOsint.close")}
          className={`flex h-9 w-9 shrink-0 items-center justify-center ${hqHudButtonClass(false)}`}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Body: toolkit / graph / findings. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-y-auto p-2 lg:grid-cols-[280px_minmax(0,1fr)_340px] lg:overflow-hidden">
        {/* (a) Toolkit. */}
        <section className={`flex min-h-0 flex-col overflow-hidden ${HQ_HUD_GLASS}`}>
          <PanelHeader title={t("hqOsint.toolkit")} />
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {OSINT_CATEGORY_ORDER.map((category) => {
              const list = toolsByCategory.get(category);
              if (!list || list.length === 0) return null;
              return (
                <div key={category} className="mt-2 first:mt-1">
                  <div className="mb-1 px-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-red-300/70">
                    {OSINT_CATEGORY_LABEL[category]}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {list.map((tool) => (
                      <ToolCard key={tool.id} tool={tool} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* (b) Entity graph. */}
        <section className={`flex min-h-0 flex-col overflow-hidden ${HQ_HUD_GLASS}`}>
          <PanelHeader title={t("hqOsint.graph")} />
          <div className="relative min-h-0 flex-1">
            {entities.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center font-mono text-[11px] text-white/40">
                {t("hqOsint.empty")}
              </div>
            ) : (
              <svg
                ref={svgRef}
                viewBox={`${layout.minX} ${layout.minY} ${layout.width} ${layout.height}`}
                preserveAspectRatio="xMidYMid meet"
                className="h-full w-full"
                role="img"
                aria-label={t("hqOsint.graph")}
              >
                {/* Edges. */}
                {relations.map((relation) => {
                  const a = posById.get(relation.from);
                  const b = posById.get(relation.to);
                  if (!a || !b) return null;
                  const lit = !neighbours || (neighbours.has(relation.from) && neighbours.has(relation.to));
                  return (
                    <line
                      key={relation.id}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke={OSINT_RELATION_STYLE[relation.kind].color}
                      strokeWidth={lit ? 1.4 : 0.8}
                      strokeOpacity={lit ? 0.6 : 0.12}
                    />
                  );
                })}
                {/* Nodes. */}
                {layout.nodes.map((node) => {
                  const entity = entityById.get(node.id);
                  if (!entity) return null;
                  const style = OSINT_ENTITY_STYLE[entity.kind];
                  const big = entity.kind === "org" || entity.kind === "domain";
                  const r = big ? 9 : 6.5;
                  const lit = !neighbours || neighbours.has(node.id);
                  const hasGeo = entity.geo !== undefined;
                  return (
                    <g
                      key={node.id}
                      transform={`translate(${node.x} ${node.y})`}
                      opacity={lit ? 1 : 0.2}
                      style={{ cursor: hasGeo ? "pointer" : "default" }}
                      onMouseEnter={() => setHoverId(node.id)}
                      onMouseLeave={() => setHoverId((current) => (current === node.id ? null : current))}
                      onClick={() => flyEntity(entity)}
                    >
                      {hasGeo ? (
                        <circle r={r + 4} fill="none" stroke={style.color} strokeOpacity={0.5} strokeWidth={1} />
                      ) : null}
                      <circle
                        r={r}
                        fill={style.color}
                        stroke="#06080c"
                        strokeWidth={2}
                        style={{ filter: hoverId === node.id ? `drop-shadow(0 0 6px ${style.color})` : undefined }}
                      />
                      <text
                        x={0}
                        y={r + 11}
                        textAnchor="middle"
                        fontSize={10}
                        fontFamily="ui-monospace, monospace"
                        fill="#ffffff"
                        opacity={0.82}
                      >
                        {entity.label}
                      </text>
                    </g>
                  );
                })}
              </svg>
            )}
            {/* Legend + hint. */}
            <div className="pointer-events-none absolute bottom-1.5 left-1.5 right-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
              {(Object.keys(OSINT_ENTITY_STYLE) as Array<keyof typeof OSINT_ENTITY_STYLE>).map((kind) => (
                <span key={kind} className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: OSINT_ENTITY_STYLE[kind].color }} />
                  <span className="font-mono text-[8.5px] uppercase tracking-[0.08em] text-white/55">
                    {OSINT_ENTITY_STYLE[kind].label}
                  </span>
                </span>
              ))}
              <span className="ml-auto flex items-center gap-1 font-mono text-[8.5px] uppercase tracking-[0.08em] text-white/45">
                <Globe2 className="h-3 w-3" /> {t("hqOsint.flyHint")}
              </span>
            </div>
          </div>
        </section>

        {/* (c) Findings feed. */}
        <section className={`flex min-h-0 flex-col overflow-hidden ${HQ_HUD_GLASS}`}>
          <PanelHeader title={t("hqOsint.findings")} count={findings.length} />
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            <div className="flex flex-col gap-1.5 pt-1">
              {sortedFindings.map((finding) => {
                const tool = OSINT_TOOL_BY_ID[finding.sourceToolId];
                const entity = finding.entityId ? entityById.get(finding.entityId) : undefined;
                const sev = OSINT_SEVERITY_STYLE[finding.severity];
                const flyable = entity?.geo !== undefined;
                return (
                  <button
                    key={finding.id}
                    type="button"
                    disabled={!flyable}
                    onClick={() => flyEntity(entity)}
                    title={flyable ? t("hqOsint.flyTo") : undefined}
                    className={`group flex flex-col gap-1 rounded-md border border-red-900/30 bg-black/40 px-2 py-1.5 text-left transition-colors ${
                      flyable ? "hover:border-red-500/50 hover:bg-red-950/30" : "cursor-default"
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className="rounded px-1 py-0.5 font-mono text-[8.5px] font-semibold uppercase tracking-[0.1em]"
                        style={{ backgroundColor: `${sev.color}22`, color: sev.color }}
                      >
                        {sev.label}
                      </span>
                      <span className="font-mono text-[9px] text-white/40">{finding.id}</span>
                      {flyable ? <Globe2 className="ml-auto h-3 w-3 text-white/35 group-hover:text-red-300" /> : null}
                    </div>
                    <span className="font-mono text-[11px] leading-snug text-white/90">{finding.title}</span>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[9px] text-white/50">
                      <span className="text-red-300/80">{tool?.name ?? finding.sourceToolId}</span>
                      {entity ? <span className="text-white/40">· {entity.label}</span> : null}
                      {finding.target ? <span className="text-white/40">· {finding.target}</span> : null}
                      <span className="ml-auto text-white/45">{t("hqOsint.confidence", { value: confPct(finding.confidence) })}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function PanelHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center justify-between border-b border-red-900/40 px-2.5 py-1.5">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-white/80">{title}</span>
      {count !== undefined ? (
        <span className="font-mono text-[10px] tabular-nums text-red-300/80">{count}</span>
      ) : null}
    </div>
  );
}

function ToolCard({ tool }: { tool: OsintTool }) {
  return (
    <div className="rounded-md border border-red-900/30 bg-black/40 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[11px] font-semibold text-white">{tool.name}</span>
        {tool.needsKey ? (
          <span className="flex items-center gap-0.5 rounded border border-amber-500/40 bg-amber-500/10 px-1 py-0.5 font-mono text-[8px] uppercase tracking-[0.08em] text-amber-200/90">
            <KeyRound className="h-2.5 w-2.5" /> {t("hqOsint.needsKey")}
          </span>
        ) : null}
        <a
          href={tool.link}
          target="_blank"
          rel="noopener noreferrer"
          title={tool.link}
          className="ml-auto text-white/40 transition-colors hover:text-red-300"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      <p className="mt-0.5 font-mono text-[9.5px] leading-snug text-white/65">{tool.descRu}</p>
      <p className="mt-0.5 font-mono text-[8.5px] leading-snug text-white/40">{tool.lawfulRu}</p>
    </div>
  );
}

export default HqOsintView;
