"use client";

import { Canvas, useFrame, type GLProps } from "@react-three/fiber";
import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PCFShadowMap, WebGLRenderer } from "three";

import { t } from "@/lib/i18n";
import { loadHqAssignments, saveHqAssignments } from "./core/assignments";
import {
  HQ_DEFAULT_CAPACITY,
  HQ_LEAD_AGENT_IDS,
  HQ_LEAD_AGENT_NAME,
  HQ_THEME,
  type HqCapacity,
} from "./core/config";
import { generateHqLayout } from "./core/layout";
import { MISSION_MAX_DEFAULT } from "./core/beats";
import { HqSimulation } from "./core/sim";
import { hqCaptionsOn, hqSoundOn, saveHqSoundOn } from "./core/soundPreference";
import type { HqAgentInput, HqArchiveEvent } from "./core/types";
import { HqHoverCard } from "./hud/HqHoverCard";
import { HqHud, HqSettingsControls, type HqHudCounts, type HqRuntimeStatus } from "./hud/HqHud";
import { HqSubtitles } from "./hud/HqSubtitles";
import {
  createArchiveRunGuard,
  shouldLogMaintenanceMemory,
  type ArchiveRunGuard,
  type HqMaintenanceLogEvent,
  type MaintenanceFeedMemory,
} from "./maintenance/maintenanceStatus";
import { useMaintenanceFeed } from "./maintenance/useMaintenanceFeed";
import { HqSoundscape, type HqSubtitleSink } from "./render/audio/HqSoundscape";
import type { HqCameraApi, HqCameraMode } from "./render/scene/HqCameraRig";
import type { HqOperationSnapshot } from "./render/screens/screenPaint";
import type { HqHoverSink } from "./render/scene/HqPicking";
import { HqScene } from "./render/scene/HqScene";
import { HQ_INTRO_SECONDS } from "./render/scene/cameraIntro";
import { HQ_CAMERA, type HqCameraPreset } from "./render/scene/cameraMath";
import type { HqQuality } from "./render/scene/quality";

/** Highest pixel ratio the HQ renders at: sharp on HiDPI screens without doubling the work. */
const HQ_MAX_DPR = 1.5;

export type HqOfficeProps = {
  agents: HqAgentInput[];
  /** Scopes persisted desk assignments, e.g. the active floor id. */
  namespace: string;
  selectedAgentId?: string | null;
  onAgentSelect?: (agentId: string) => void;
  /** The connected backend, shown in the HUD next to the settings button. */
  runtimeStatus?: HqRuntimeStatus | null;
  /** Whether the office settings are open, for the button's pressed state. */
  settingsOpen?: boolean;
  /** Toggles the office settings from the HUD. */
  onOpenSettings?: () => void;
  /** Opens the combat console from the HUD's camera bar. */
  onOpenCombat?: () => void;
  /** True while the opening fly-through plays, so the screen can hide its own panels. */
  onIntroChange?: (playing: boolean) => void;
  /**
   * A briefing in progress: AM7 at the podium addressing the floor, everyone
   * standing at their desks. Null when there is none.
   */
  briefing?: HqBriefing | null;
  /**
   * Mission mode («боевая задача»): true from a briefing until the screen
   * judges the work done (or its time limit). No breaks, the away walk back,
   * AM7 makes rounds. A briefing starts one in the sim by itself; this ends it.
   */
  mission?: boolean;
  /** The «ХОД ЗАДАЧИ» tracker for the video wall, or null (a briefing keeps priority). */
  operation?: HqOperationSnapshot | null;
  /** Whether there is an operation the wall switch can show. */
  wallAvailable?: boolean;
  /** The wall switch: true shows the operation, false the usual panels. */
  wallShowsOperation?: boolean;
  /** Flips the wall between the operation and the panels; the switch is hidden without it. */
  onToggleWall?: () => void;
  /**
   * AM7 has reached his spot behind the tribune for this briefing (once per
   * briefing): the screen starts his answer out loud from there.
   */
  onLeadAtTribune?: (briefingId: string) => void;
  /**
   * The archive cart and the server's upkeep, for the console: the cart's own
   * events (taken, paused, handover, …), a run with nothing to take out
   * ("checked"), and the server's memory advice ("memory"). Delivered from the
   * view's poll, never during render; at most ARCHIVE_EVENT_QUEUE_MAX queue up
   * between two polls.
   */
  onArchiveEvent?: (event: HqMaintenanceLogEvent) => void;
  /** The owner is signed in: «СОЗДАТЕЛЬ В СЕТИ» in the HUD. */
  creatorOnline?: boolean;
  /**
   * The owner has just signed in (the greeting is on): AM7 acknowledges them
   * once — turned to the camera through the opening fly-through and a little
   * after, standing he speaks, in his chair he looks up from the keys.
   */
  creatorEntered?: boolean;
};

/** A briefing the screen started (a voice command to the whole team). */
export type HqBriefing = {
  /** Changes for every new briefing. */
  id: string;
  /** What the person asked of the team, as transcribed. */
  task: string;
  /** AM7's answer, once it arrives (empty until then). */
  reply: string;
  /** True while AM7's answer is being spoken. */
  speaking: boolean;
};

/** Longest a briefing holds the floor if the screen never ends it. */
const BRIEFING_MAX_SECONDS = 240;
/** How often the view reads the sim's briefing state (ms). */
const BRIEFING_POLL_MS = 250;
/** Archive events kept between two polls; the oldest go first past this. */
const ARCHIVE_EVENT_QUEUE_MAX = 16;
/** How long AM7 keeps acknowledging the creator after the fly-through (seconds). */
const CREATOR_ACK_TAIL_SECONDS = 6;

/** While AM7 acknowledges the creator, he looks at the camera wherever it flies. */
function HqCreatorWatch({ simRef }: { simRef: { current: HqSimulation | null } }) {
  useFrame(({ camera }) => {
    const sim = simRef.current;
    if (!sim || !sim.creatorAck) return;
    sim.setCreatorPoint(camera.position.x, camera.position.y, camera.position.z);
  });
  return null;
}


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
  runtimeStatus = null,
  settingsOpen = false,
  onOpenSettings,
  onOpenCombat,
  onIntroChange,
  briefing = null,
  mission = false,
  operation = null,
  wallAvailable = false,
  wallShowsOperation = true,
  onToggleWall,
  onLeadAtTribune,
  onArchiveEvent,
  creatorOnline = false,
  creatorEntered = false,
}: HqOfficeProps) {
  const capacity: HqCapacity = HQ_DEFAULT_CAPACITY;
  // Always the highest quality: full detail, shadows and effects, rendered at
  // the screen's own pixel ratio (up to 1.5x, sharp without doubling the work).
  const quality: HqQuality = "high";
  const [dpr] = useState(() => Math.min(HQ_MAX_DPR, Math.max(1, window.devicePixelRatio || 1)));
  const [cameraMode, setCameraMode] = useState<HqCameraMode>("overview");
  const [deskPoll, setDeskPoll] = useState<{ capacity: HqCapacity; free: number } | null>(null);
  const [ready, setReady] = useState(false);
  // The opening fly-through: the HUD stays off until it lands.
  const [introPlaying, setIntroPlaying] = useState(false);
  const handleIntroChange = useCallback(
    (playing: boolean) => {
      setIntroPlaying(playing);
      onIntroChange?.(playing);
    },
    [onIntroChange],
  );

  const layout = useMemo(() => generateHqLayout(capacity), [capacity]);
  const [soundOn, setSoundOn] = useState(hqSoundOn);
  const toggleSound = useCallback(() => {
    setSoundOn((on) => {
      saveHqSoundOn(!on);
      return !on;
    });
  }, []);
  const subtitleSinkRef = useRef<HqSubtitleSink | null>(null);
  // Voice, not text: the crew's talk is heard, captioned only when turned on.
  const [captionsOn] = useState(hqCaptionsOn);

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
  // The archive cart: what the host last told the sim (re-applied to a new
  // sim), and the console events waiting for the next poll.
  const archiveFillRef = useRef<number | null>(null);
  const archiveRunsEnabledRef = useRef<boolean | null>(null);
  const archiveQueueRef = useRef<HqMaintenanceLogEvent[]>([]);
  const onArchiveEventRef = useRef(onArchiveEvent);
  useEffect(() => {
    onArchiveEventRef.current = onArchiveEvent;
  }, [onArchiveEvent]);
  const queueArchiveEvent = useCallback((event: HqMaintenanceLogEvent) => {
    const queue = archiveQueueRef.current;
    if (queue.length >= ARCHIVE_EVENT_QUEUE_MAX) queue.shift();
    queue.push(event);
  }, []);
  // The bytes of the cart run under way, for the cart's tablet (read every
  // frame): from the run's first event until the cart is parked again.
  const archiveBytesRef = useRef<number | null>(null);
  const archiveBytes = useCallback(() => archiveBytesRef.current, []);
  const handleSimArchiveEvent = useCallback(
    (event: HqArchiveEvent) => {
      if (event.type === "parked") archiveBytesRef.current = null;
      else if (event.type !== "auto") archiveBytesRef.current = event.freedBytes;
      queueArchiveEvent(event);
    },
    [queueArchiveEvent],
  );
  useEffect(() => {
    // Development aids: the running sim, e.g. window.__hqSim()?.briefing, the
    // camera, e.g. __hqCamera()?.follow("agent-12"), and a cart run with no
    // server clean-up behind it, e.g. __hqArchiveRun(52e6).
    if (process.env.NODE_ENV === "production") return;
    const w = window as unknown as {
      __hqSim?: () => HqSimulation | null;
      __hqCamera?: () => HqCameraApi | null;
      __hqArchiveRun?: (freedBytes?: number) => { agentId: string; name: string } | null;
    };
    let devRuns = 0;
    w.__hqSim = () => simRef.current;
    w.__hqCamera = () => cameraApiRef.current;
    w.__hqArchiveRun = (freedBytes = 50 * 1024 * 1024) => {
      devRuns += 1;
      return simRef.current?.startArchiveRun(`dev-${Date.now().toString(36)}-${devRuns}`, freedBytes) ?? null;
    };
    return () => {
      delete w.__hqSim;
      delete w.__hqCamera;
      delete w.__hqArchiveRun;
    };
  }, []);
  const onLeadAtTribuneRef = useRef(onLeadAtTribune);
  useEffect(() => {
    onLeadAtTribuneRef.current = onLeadAtTribune;
  }, [onLeadAtTribune]);

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
    sim.onArchiveEvent = handleSimArchiveEvent;
    archiveBytesRef.current = null;
    sim.setAgents(agentsRef.current);
    // A new sim (another floor) starts from what the host already knows.
    if (archiveRunsEnabledRef.current !== null) sim.setArchiveRunsEnabled(archiveRunsEnabledRef.current);
    if (archiveFillRef.current !== null) sim.setArchiveFill(archiveFillRef.current);
    signatureRef.current = agentsSignature(agentsRef.current);
    simRef.current = sim;
    return () => {
      sim.onAssignmentsChange = undefined;
      sim.onArchiveEvent = undefined;
      if (simRef.current === sim) simRef.current = null;
    };
  }, [layout, namespace, handleSimArchiveEvent]);

  // The server's upkeep (GET /api/maintenance/status): how full the archive
  // is, its last clean-up and its memory.
  const maintenance = useMaintenanceFeed();
  const archiveFill = maintenance.fill;
  useEffect(() => {
    // Null until the server has measured: the cart keeps what it shows.
    if (archiveFill === null) return;
    archiveFillRef.current = archiveFill;
    simRef.current?.setArchiveFill(archiveFill);
  }, [archiveFill]);
  // Each clean-up once: a trip when the server says it is worth one, the
  // "checked" line when it had nothing to take out, nothing when it is old
  // news (seen before in this browser, or longer ago than 10 minutes).
  const archiveGuardRef = useRef<ArchiveRunGuard | null>(null);
  const lastArchiveRun = maintenance.lastRun;
  useEffect(() => {
    if (!lastArchiveRun) return;
    archiveGuardRef.current ??= createArchiveRunGuard();
    const decision = archiveGuardRef.current.admit(lastArchiveRun);
    if (decision === "trip") simRef.current?.startArchiveRun(lastArchiveRun.id, lastArchiveRun.freedBytes);
    else if (decision === "checked") queueArchiveEvent({ type: "checked", runId: lastArchiveRun.id });
  }, [lastArchiveRun, queueArchiveEvent]);
  // The memory advice, once each time it changes to a new one.
  const serverMemory = maintenance.memory;
  const loggedMemoryRef = useRef<MaintenanceFeedMemory | null>(null);
  useEffect(() => {
    const previous = loggedMemoryRef.current;
    loggedMemoryRef.current = serverMemory;
    if (!shouldLogMaintenanceMemory(previous, serverMemory)) return;
    queueArchiveEvent({
      type: "memory",
      level: serverMemory.level,
      rss: serverMemory.rss,
      recommendation: serverMemory.recommendation,
    });
  }, [serverMemory, queueArchiveEvent]);
  // Cart runs need the character's Push clip; without it every run is applied
  // at once (the console still says so).
  const handleClipsChange = useCallback((names: readonly string[]) => {
    const enabled = names.includes("Push");
    archiveRunsEnabledRef.current = enabled;
    simRef.current?.setArchiveRunsEnabled(enabled);
  }, []);

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

  // A briefing: the sim gathers the floor, the camera takes the briefing view
  // (unless the person is following someone). When the screen ends it, the sim
  // holds it until AM7 has had his say behind the tribune; the wall keeps the
  // task and the camera the view until then, and only then back to the floor.
  const briefingId = briefing?.id ?? null;
  const briefingIdRef = useRef<string | null>(null);
  useEffect(() => {
    briefingIdRef.current = briefingId;
    const sim = simRef.current;
    if (!sim || !briefingId) return;
    // The camera API is re-created with the rig; read it through the ref when used.
    const camera = cameraApiRef;
    const mode = cameraModeRef;
    sim.startBriefing(BRIEFING_MAX_SECONDS);
    if (mode.current !== "follow") camera.current?.goTo("briefing");
    return () => sim.endBriefing();
  }, [briefingId, layout, namespace]);
  // Mission mode follows the screen: on (again, which only moves its end
  // later) while it holds, off when the work is done. Declared after the
  // briefing so a briefing's own start comes first. A new sim (another floor)
  // picks it up too. Never ended with the briefing: it outlasts it.
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    if (mission) sim.startMission(MISSION_MAX_DEFAULT);
    else sim.endMission();
  }, [mission, layout, namespace]);
  // The «ХОД ЗАДАЧИ» tracker reaches the scene through a ref (read each
  // frame), so its snapshots never re-render the memoised scene tree.
  const operationRef = useRef<HqOperationSnapshot | null>(operation);
  useEffect(() => {
    operationRef.current = operation;
  }, [operation]);
  // What the video wall shows: a stable object while the texts stay the same,
  // so the memoised scene does not re-render when only `speaking` flips.
  const briefingTask = briefing?.task ?? null;
  const briefingReply = briefing?.reply ?? "";
  const liveBriefingScene = useMemo(
    () => (briefingTask === null ? null : { task: briefingTask, reply: briefingReply }),
    [briefingTask, briefingReply],
  );
  const lastSceneRef = useRef(liveBriefingScene);
  useEffect(() => {
    if (liveBriefingScene) lastSceneRef.current = liveBriefingScene;
  }, [liveBriefingScene]);
  // The last briefing's wall while the sim winds it down; null otherwise.
  const [heldScene, setHeldScene] = useState<{ task: string; reply: string } | null>(null);
  useEffect(() => {
    let wasActive = false;
    let reported: string | null = null;
    const timer = window.setInterval(() => {
      // The archive events since the last poll, oldest first, to the console.
      const queue = archiveQueueRef.current;
      if (queue.length > 0) {
        const events = queue.splice(0);
        const deliver = onArchiveEventRef.current;
        if (deliver) for (const event of events) deliver(event);
      }
      const sim = simRef.current;
      if (!sim) return;
      const { active, leadAtPodium } = sim.briefing;
      const id = briefingIdRef.current;
      if (active && leadAtPodium && id && reported !== id) {
        reported = id;
        onLeadAtTribuneRef.current?.(id);
      }
      const held = active && !id ? lastSceneRef.current : null;
      setHeldScene((current) => (current === held ? current : held));
      if (wasActive && !active && cameraModeRef.current === "briefing") cameraApiRef.current?.goTo("overview");
      wasActive = active;
    }, BRIEFING_POLL_MS);
    return () => window.clearInterval(timer);
  }, []);
  const briefingScene = liveBriefingScene ?? heldScene;
  const briefingSpeaking = Boolean(briefing?.speaking);
  useEffect(() => {
    // Until an answer is being spoken, AM7 addresses the floor anyway (Talk).
    simRef.current?.setBriefingSpeaking(briefingSpeaking || !briefing?.reply);
  }, [briefingSpeaking, briefing?.reply]);

  // The creator's sign-in: AM7 turns to the camera once, for the fly-through
  // and a few seconds after (HqCreatorWatch keeps his eyes on the camera).
  const creatorAckedRef = useRef(false);
  useEffect(() => {
    if (!creatorEntered || creatorAckedRef.current) return;
    const sim = simRef.current;
    if (!sim) return;
    creatorAckedRef.current = true;
    sim.acknowledgeCreator(HQ_INTRO_SECONDS + CREATOR_ACK_TAIL_SECONDS);
  }, [creatorEntered, layout, namespace]);

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

  const canFollow = Boolean(selectedAgentId && agents.some((agent) => agent.id === selectedAgentId));
  const leadId = useMemo(() => findLeadId(agents), [agents]);

  const failure = (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="max-w-md font-mono text-[13px] text-white/70">{t("hqScene.webglFailed")}</p>
      <div className="flex items-center gap-1.5">
        <HqSettingsControls runtime={runtimeStatus} settingsOpen={settingsOpen} onOpenSettings={onOpenSettings} />
      </div>
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
          dpr={dpr}
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
            onCameraModeChange={handleCameraMode}
            onIntroChange={handleIntroChange}
            onSelect={handleSelect}
            onFocus={handleFocus}
            briefing={briefingScene}
            operationRef={operationRef}
            onClipsChange={handleClipsChange}
            archiveBytes={archiveBytes}
          />
          <HqSoundscape simRef={simRef} enabled={soundOn} subtitleSinkRef={captionsOn ? subtitleSinkRef : undefined} />
          <HqCreatorWatch simRef={simRef} />
        </Canvas>
        <div
          aria-hidden={introPlaying}
          className={`transition-opacity duration-700 ease-out ${introPlaying ? "opacity-0 [&_*]:!pointer-events-none" : "opacity-100"}`}
        >
        {captionsOn ? <HqSubtitles sinkRef={subtitleSinkRef} /> : null}
        <HqHoverCard sinkRef={hoverSinkRef} agentsRef={agentsRef} />
        <HqHud
          counts={counts}
          cameraMode={cameraMode}
          canFollow={canFollow}
          onCameraPreset={handleCameraPreset}
          onMessageLead={leadId && onAgentSelect ? () => onAgentSelect(leadId) : undefined}
          onOpenCombat={onOpenCombat}
          soundOn={soundOn}
          onToggleSound={toggleSound}
          wallAvailable={wallAvailable}
          wallShowsOperation={wallShowsOperation}
          onToggleWall={onToggleWall}
          runtime={runtimeStatus}
          settingsOpen={settingsOpen}
          onOpenSettings={onOpenSettings}
          creatorOnline={creatorOnline}
        />
        </div>
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
