"use client";

import { Canvas, type GLProps } from "@react-three/fiber";
import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PCFShadowMap, WebGLRenderer } from "three";

import { t } from "@/lib/i18n";
import { loadHqAssignments, saveHqAssignments } from "./core/assignments";
import { HQ_DEFAULT_CAPACITY, HQ_LEAD_AGENT_IDS, HQ_LEAD_AGENT_NAME, HQ_THEME, type HqCapacity } from "./core/config";
import { generateHqLayout } from "./core/layout";
import { HqSimulation } from "./core/sim";
import type { HqAgentInput } from "./core/types";
import { HqHoverCard } from "./hud/HqHoverCard";
import { HqHud, type HqHudCounts } from "./hud/HqHud";
import {
  nextHqQualityMode,
  readHqQualityMode,
  writeHqQualityMode,
} from "./hud/hqPrefs";
import type { HqQualityMode } from "./render/scene/HqAdaptiveQuality";
import { buildQualityTiers } from "./render/scene/qualityGovernor";
import type { HqCameraApi, HqCameraMode } from "./render/scene/HqCameraRig";
import type { HqHoverSink } from "./render/scene/HqPicking";
import { HqScene } from "./render/scene/HqScene";
import { HQ_CAMERA, type HqCameraPreset } from "./render/scene/cameraMath";

export type HqOfficeProps = {
  agents: HqAgentInput[];
  /** Scopes persisted desk assignments, e.g. the active floor id. */
  namespace: string;
  selectedAgentId?: string | null;
  onAgentSelect?: (agentId: string) => void;
};

// What the sim sees of an agent; anything else changing is not its business.
const agentsSignature = (agents: readonly HqAgentInput[]): string => {
  let signature = "";
  for (const agent of agents) {
    signature += `${agent.id}\u0001${agent.status}\u0001${agent.name}\u0001${agent.role ?? ""}\u0002`;
  }
  return signature;
};

// The lead (AM7): the same rule as the simulation, by id first, then by name.
const findLeadId = (agents: readonly HqAgentInput[]): string | null => {
  const ids = HQ_LEAD_AGENT_IDS as readonly string[];
  const byId = agents.find((agent) => ids.includes(agent.id.trim().toLowerCase()));
  if (byId) return byId.id;
  const byName = agents.find((agent) => agent.name.trim().toLowerCase() === HQ_LEAD_AGENT_NAME.toLowerCase());
  return byName?.id ?? null;
};

// Deterministic per-floor seed, so the same floor looks the same on reload.
const hashSeed = (value: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

// WebGL2 with no MSAA (SMAA runs in the post chain) and no alpha or stencil.
// A factory rather than an options object: R3F re-applies an options object
// to the renderer on every Canvas render.
const createRenderer: Extract<GLProps, (defaultProps: never) => unknown> = (defaults) =>
  new WebGLRenderer({
    ...defaults,
    antialias: false,
    alpha: false,
    stencil: false,
    depth: true,
    powerPreference: "high-performance",
  });

type CanvasBoundaryState = { failed: boolean };

/** WebGL2 missing or the context failing to start: say so instead of a blank page. */
class HqCanvasBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, CanvasBoundaryState> {
  state: CanvasBoundaryState = { failed: false };

  static getDerivedStateFromError(): CanvasBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("The HQ scene could not start.", error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * The hacker HQ («Штаб»): one Canvas for the lifetime of the view. Agents flow
 * in through refs to the simulation, so roster changes never remount WebGL;
 * the hall size is HQ_DEFAULT_CAPACITY (core/config.ts).
 */
export function HqOffice({
  agents,
  namespace,
  selectedAgentId = null,
  onAgentSelect,
}: HqOfficeProps) {
  const capacity: HqCapacity = HQ_DEFAULT_CAPACITY;
  const [qualityMode, setQualityMode] = useState<HqQualityMode>(readHqQualityMode);
  const [qualityTiers] = useState(() => buildQualityTiers(window.devicePixelRatio));
  const [tierIndex, setTierIndex] = useState(0);
  const [cameraMode, setCameraMode] = useState<HqCameraMode>("overview");
  const [deskPoll, setDeskPoll] = useState<{ capacity: HqCapacity; free: number } | null>(null);
  const [ready, setReady] = useState(false);

  const layout = useMemo(() => generateHqLayout(capacity), [capacity]);

  const simRef = useRef<HqSimulation | null>(null);
  const agentsRef = useRef<HqAgentInput[]>(agents);
  const signatureRef = useRef<string | null>(null);
  const hoveredIdRef = useRef<string | null>(null);
  const hoverSinkRef = useRef<HqHoverSink | null>(null);
  const activityRef = useRef(0);
  const cameraApiRef = useRef<HqCameraApi | null>(null);
  const cameraModeRef = useRef<HqCameraMode>("overview");
  const selectedRef = useRef<string | null>(selectedAgentId);
  const callbacksRef = useRef({ onAgentSelect });

  useEffect(() => {
    callbacksRef.current.onAgentSelect = onAgentSelect;
    selectedRef.current = selectedAgentId;
  });

  // One simulation per layout and floor. Built in a layout effect so it is in
  // place before the next frame reads simRef.
  useLayoutEffect(() => {
    const sim = new HqSimulation(layout, {
      seed: hashSeed(namespace),
      assignments: loadHqAssignments(namespace, layout.capacity),
    });
    sim.onAssignmentsChange = (assignments) => saveHqAssignments(namespace, layout.capacity, assignments);
    sim.setAgents(agentsRef.current);
    signatureRef.current = agentsSignature(agentsRef.current);
    simRef.current = sim;
    return () => {
      sim.onAssignmentsChange = undefined;
      if (simRef.current === sim) simRef.current = null;
    };
  }, [layout, namespace]);

  // Roster changes: tell the sim only when something it uses changed.
  useEffect(() => {
    agentsRef.current = agents;
    const signature = agentsSignature(agents);
    if (signature === signatureRef.current) return;
    signatureRef.current = signature;
    simRef.current?.setAgents(agents);
  }, [agents]);

  // Free desks come from the sim's assignment; poll it gently, not per frame.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const sim = simRef.current;
      if (!sim) return;
      let free = 0;
      const status = sim.deskStatus;
      for (let i = 0; i < status.length; i += 1) if (status[i] === -1) free += 1;
      setDeskPoll((previous) =>
        previous && previous.capacity === capacity && previous.free === free ? previous : { capacity, free },
      );
    }, 1000);
    return () => window.clearInterval(timer);
  }, [capacity]);

  // Following the selected agent keeps following when the selection changes.
  useEffect(() => {
    if (cameraModeRef.current === "follow" && selectedAgentId) {
      cameraApiRef.current?.follow(selectedAgentId);
    }
  }, [selectedAgentId]);

  // Esc leaves follow mode, unless the key was meant for a text field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || cameraModeRef.current !== "follow") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      cameraApiRef.current?.stopFollow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const counts = useMemo<HqHudCounts>(() => {
    let working = 0;
    let idle = 0;
    let error = 0;
    for (const agent of agents) {
      if (agent.status === "working") working += 1;
      else if (agent.status === "error") error += 1;
      else idle += 1;
    }
    // Until the first poll, estimate: everyone but the lead takes a desk.
    const estimate = Math.max(0, layout.desks.length - Math.max(0, agents.length - 1));
    const free = deskPoll && deskPoll.capacity === capacity ? deskPoll.free : estimate;
    return { total: agents.length, working, idle, error, free };
  }, [agents, capacity, deskPoll, layout.desks.length]);

  const handleCameraMode = useCallback((mode: HqCameraMode) => {
    cameraModeRef.current = mode;
    setCameraMode(mode);
  }, []);

  const handleSelect = useCallback((agentId: string) => {
    callbacksRef.current.onAgentSelect?.(agentId);
  }, []);

  const handleFocus = useCallback((agentId: string) => {
    callbacksRef.current.onAgentSelect?.(agentId);
    cameraApiRef.current?.follow(agentId);
  }, []);

  const handleCameraPreset = useCallback((preset: HqCameraPreset) => {
    const api = cameraApiRef.current;
    if (!api) return;
    if (preset !== "follow") {
      api.goTo(preset);
      return;
    }
    if (cameraModeRef.current === "follow") {
      api.stopFollow();
      return;
    }
    const target = selectedRef.current;
    if (target) api.follow(target);
  }, []);

  const handleQualityCycle = useCallback(() => {
    setQualityMode((mode) => {
      const next = nextHqQualityMode(mode);
      writeHqQualityMode(next);
      return next;
    });
  }, []);

  const tier = qualityTiers[Math.min(tierIndex, qualityTiers.length - 1)];
  const quality = tier.quality;
  const canFollow = Boolean(selectedAgentId && agents.some((agent) => agent.id === selectedAgentId));
  const leadId = useMemo(() => findLeadId(agents), [agents]);

  const failure = (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="max-w-md font-mono text-[13px] text-white/70">{t("hqScene.webglFailed")}</p>
    </div>
  );

  return (
    <div className="relative h-full w-full overflow-hidden" style={{ backgroundColor: HQ_THEME.background }}>
      <HqCanvasBoundary fallback={failure}>
        <Canvas
          // AgX tone mapping and sRGB output happen in the post chain.
          flat
          // Owned here, not set from inside: R3F re-applies this prop on
          // every Canvas render.
          dpr={tier.dpr}
          // PCFSoftShadowMap is deprecated in three r183; PCF with a shadow
          // radius gives the same soft edge.
          shadows={{ type: PCFShadowMap }}
          gl={createRenderer}
          camera={{ fov: HQ_CAMERA.fov, near: 0.1, far: 600, position: [40, 40, 40] }}
          onCreated={() => setReady(true)}
          style={{ position: "absolute", inset: 0 }}
        >
          <HqScene
            layout={layout}
            simRef={simRef}
            agentsRef={agentsRef}
            hoveredIdRef={hoveredIdRef}
            hoverSinkRef={hoverSinkRef}
            activityRef={activityRef}
            cameraApiRef={cameraApiRef}
            selectedId={selectedAgentId}
            quality={quality}
            qualityTiers={qualityTiers}
            qualityMode={qualityMode}
            onQualityTierChange={setTierIndex}
            onCameraModeChange={handleCameraMode}
            onSelect={handleSelect}
            onFocus={handleFocus}
          />
        </Canvas>
        <HqHoverCard sinkRef={hoverSinkRef} agentsRef={agentsRef} />
        <HqHud
          counts={counts}
          cameraMode={cameraMode}
          canFollow={canFollow}
          onCameraPreset={handleCameraPreset}
          qualityMode={qualityMode}
          quality={quality}
          onQualityCycle={handleQualityCycle}
          onMessageLead={leadId && onAgentSelect ? () => onAgentSelect(leadId) : undefined}
        />
      </HqCanvasBoundary>
      {/* Fades in from black as the intro swoop starts. */}
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 transition-opacity duration-[1400ms] ease-out ${ready ? "opacity-0" : "opacity-100"}`}
        style={{ backgroundColor: HQ_THEME.background }}
      />
    </div>
  );
}
