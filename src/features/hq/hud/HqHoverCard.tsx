"use client";

import { useEffect, useRef, type MutableRefObject } from "react";

import { t } from "@/lib/i18n";
import { HQ_LEAD_AGENT_IDS, HQ_LEAD_AGENT_NAME, HQ_THEME } from "../core/config";
import { HQ_PLACE, type HqAgentInput, type HqAgentStatus } from "../core/types";
import type { HqHoverSink } from "../render/scene/HqPicking";

const STATUS_COLOR: Record<HqAgentStatus, string> = {
  working: HQ_THEME.statusWorking,
  idle: HQ_THEME.statusIdle,
  error: HQ_THEME.statusError,
};

const statusLabel = (status: HqAgentStatus): string =>
  status === "working"
    ? t("hqScene.statusWorking")
    : status === "error"
      ? t("hqScene.statusError")
      : t("hqScene.statusIdle");

// The bottom line: a place the agent is at overrides the status label, so a
// hacker drilling on the range reads «на киберполигоне», not «работает».
const metaLabel = (status: HqAgentStatus, place: number): string =>
  place === HQ_PLACE.cyberrange
    ? t("hqScene.placeCyberrange")
    : place === HQ_PLACE.lounge
      ? t("hqScene.placeLounge")
      : statusLabel(status);

export const isHqLeadAgent = (agent: Pick<HqAgentInput, "id" | "name">): boolean =>
  (HQ_LEAD_AGENT_IDS as readonly string[]).includes(agent.id.toLowerCase()) ||
  agent.name.trim().toUpperCase() === HQ_LEAD_AGENT_NAME;

/**
 * The name card that follows the pointer over an agent. Picking drives it
 * imperatively through `sinkRef` from inside the render loop, so hovering
 * across a crowd writes a few DOM properties and never re-renders React.
 */
export function HqHoverCard({
  sinkRef,
  agentsRef,
}: {
  sinkRef: MutableRefObject<HqHoverSink | null>;
  agentsRef: MutableRefObject<HqAgentInput[]>;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLSpanElement>(null);
  const metaRef = useRef<HTMLSpanElement>(null);
  const dotRef = useRef<HTMLSpanElement>(null);
  const leadRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const place = (x: number, y: number) => {
      const box = boxRef.current;
      if (box) box.style.transform = `translate3d(${Math.round(x + 16)}px, ${Math.round(y + 18)}px, 0)`;
    };
    const sink: HqHoverSink = {
      show: (agentId, x, y, placeCode) => {
        const agent = agentsRef.current.find((entry) => entry.id === agentId);
        const box = boxRef.current;
        if (!agent || !box) return;
        if (nameRef.current) nameRef.current.textContent = agent.name;
        // Live state only: «работает» while on a task, «ожидает» when idle,
        // «на киберполигоне» when drilling — never the static operation glued on.
        if (metaRef.current) metaRef.current.textContent = metaLabel(agent.status, placeCode);
        if (dotRef.current) dotRef.current.style.backgroundColor = STATUS_COLOR[agent.status];
        if (leadRef.current) leadRef.current.style.display = isHqLeadAgent(agent) ? "" : "none";
        place(x, y);
        box.style.opacity = "1";
      },
      move: place,
      hide: () => {
        if (boxRef.current) boxRef.current.style.opacity = "0";
      },
    };
    sinkRef.current = sink;
    return () => {
      if (sinkRef.current === sink) sinkRef.current = null;
    };
  }, [sinkRef, agentsRef]);

  return (
    <div
      ref={boxRef}
      aria-hidden="true"
      className="pointer-events-none absolute left-0 top-0 z-20 max-w-[260px] rounded-lg border border-red-600/35 bg-black/80 px-3 py-2 opacity-0 shadow-[0_0_24px_rgba(255,26,26,0.18)] backdrop-blur-sm transition-opacity duration-150"
    >
      <div className="flex items-center gap-2">
        <span ref={dotRef} className="h-2 w-2 shrink-0 rounded-full" />
        <span ref={nameRef} className="truncate font-mono text-[12px] font-semibold tracking-wide text-white" />
        <span
          ref={leadRef}
          className="shrink-0 rounded-sm border border-red-500/40 px-1 font-mono text-[9px] uppercase tracking-[0.14em] text-red-300"
        >
          {t("hqScene.leadBadge")}
        </span>
      </div>
      <span ref={metaRef} className="mt-0.5 block truncate font-mono text-[10px] text-white/65" />
    </div>
  );
}
