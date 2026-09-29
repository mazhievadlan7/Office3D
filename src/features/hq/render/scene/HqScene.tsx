"use client";

import { useFrame, useThree, type RootState } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { MeshStandardMaterial, PlaneGeometry } from "three";

import { briefingScreens } from "../../core/briefing";
import { HQ_THEME } from "../../core/config";
import type { HqSimulation } from "../../core/sim";
import type { HqAgentInput, HqLayout } from "../../core/types";
import { HqCrowd } from "../crowd/HqCrowd";
import { HqEnvironment } from "../environment/HqEnvironment";
import { HqWorldMap } from "../map/HqWorldMap";
import { HqScreenDriver } from "../screens/HqScreenDriver";
import { HqScreenHub } from "../screens/screenHub";
import type { HqOperationSnapshot } from "../screens/screenPaint";
import { HqWorkstations } from "../workstations/HqWorkstations";
import { HqCameraRig, type HqCameraApi, type HqCameraMode } from "./HqCameraRig";
import { HqLighting } from "./HqLighting";
import { HqModuleSlot } from "./HqModuleSlot";
import { HqPicking, type HqHoverSink } from "./HqPicking";
import { HqPostFx } from "./HqPostFx";
import { HqSimDriver } from "./HqSimDriver";
import type { HqQuality } from "./quality";
import { disposePrewarm, HqPrewarmGate } from "./shaderPrewarm";

const noRaycast = () => null;

/**
 * Runs after every content update (priority 0) and before the post chain
 * draws the frame (priority 1), so it sees each object before its first draw.
 */
const PREWARM_PRIORITY = 0.5;

/**
 * Compiles every shader program before its first draw. Left to itself
 * three.js compiles a program synchronously the first time its object is
 * drawn — the whole room on the first frame, a model that just loaded, the
 * nameplate on the first hover, the tribune when it rises — and on Windows
 * (ANGLE over Direct3D) each such compile froze the HQ for 10-40 ms, a room's
 * worth for ~250 ms. HqPrewarmGate (shaderPrewarm.ts) compiles them ahead,
 * exactly as the frame will use them, holds the objects back until the
 * driver has built them in parallel and they have been drawn once off
 * screen, then lets them in together. Objects whose programs already exist
 * are never held back. Nothing is drawn differently.
 */
function HqShaderPrewarm({ gate }: { gate: HqPrewarmGate }) {
  const gl = useThree((state) => state.gl);
  useEffect(
    () => () => {
      gate.dispose();
      disposePrewarm(gl);
    },
    [gl, gate],
  );
  useFrame(({ gl: renderer, scene, camera }) => gate.update(renderer, scene, camera), PREWARM_PRIORITY);
  return null;
}

/**
 * Development aid: the R3F state, e.g. to time whole frames from the console
 * (window.__hqThree().advance(t) then a readPixels to wait for the GPU).
 */
function HqDevThreeHook() {
  const get = useThree((state) => state.get);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const w = window as unknown as { __hqThree?: () => RootState };
    w.__hqThree = get;
    return () => {
      delete w.__hqThree;
    };
  }, [get]);
  return null;
}

/** A bare dark floor, shown only if the environment module cannot render. */
function FallbackFloor({ layout }: { layout: HqLayout }) {
  const { x0, z0, x1, z1 } = layout.bounds;
  const geometry = useMemo(() => new PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2), [x0, z0, x1, z1]);
  const material = useMemo(
    () => new MeshStandardMaterial({ color: HQ_THEME.floor, roughness: 1, metalness: 0 }),
    [],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);
  return (
    <mesh
      geometry={geometry}
      material={material}
      position={[(x0 + x1) / 2, 0, (z0 + z1) / 2]}
      receiveShadow
      raycast={noRaycast}
    />
  );
}

/**
 * Hands the «ХОД ЗАДАЧИ» tracker to the hub (the same three wall screens as a
 * briefing; the hub paints it only while no briefing is up). Read from a ref
 * each frame and pushed only when the snapshot object changes, like an effect
 * on it would, so a new snapshot never re-renders the scene tree, and a dev
 * preview (__hqOperationPreview) is not overwritten while nothing changes.
 * Allocation-free per frame.
 */
function HqOperationFeed({
  screens,
  operationRef,
}: {
  screens: HqScreenHub;
  operationRef: MutableRefObject<HqOperationSnapshot | null>;
}) {
  const pushed = useRef<HqOperationSnapshot | null>(null);
  useFrame(() => {
    const next = operationRef.current;
    if (next === pushed.current) return;
    pushed.current = next;
    screens.setOperation(next);
  });
  return null;
}

export type HqSceneProps = {
  layout: HqLayout;
  simRef: MutableRefObject<HqSimulation | null>;
  agentsRef: MutableRefObject<HqAgentInput[]>;
  hoveredIdRef: MutableRefObject<string | null>;
  hoverSinkRef: MutableRefObject<HqHoverSink | null>;
  activityRef: MutableRefObject<number>;
  cameraApiRef: MutableRefObject<HqCameraApi | null>;
  selectedId: string | null;
  quality: HqQuality;
  onCameraModeChange: (mode: HqCameraMode) => void;
  onIntroChange?: (playing: boolean) => void;
  onSelect: (agentId: string) => void;
  onFocus: (agentId: string) => void;
  /** A briefing in progress (the task and AM7's answer so far): shown on the video wall. */
  briefing?: { task: string; reply: string } | null;
  /**
   * The «ХОД ЗАДАЧИ» tracker for the video wall after a briefing, or null; a
   * briefing keeps priority. A ref read every frame, not a prop: a new
   * snapshot (up to once a second during an operation) must not re-render the
   * memoised scene tree.
   */
  operationRef?: MutableRefObject<HqOperationSnapshot | null>;
  /** The character GLB's action names once loaded (passed on to HqCrowd). */
  onClipsChange?: (names: readonly string[]) => void;
  /** Read every frame: the bytes of the archive cart's run under way (its tablet), or null. */
  archiveBytes?: () => number | null;
};

/**
 * Everything inside the Canvas. Frame order: the sim steps first (-100), the
 * camera follows (-50) and integrates (-1), then lighting, picking and the
 * renderers read the fresh frame (0), and the composer draws (1).
 *
 * Each content module sits in its own boundary, so a missing GLB or a module
 * that throws costs that module only; the boundary retries when the layout
 * (capacity) changes. Memoised: the HUD re-renders on every roster update,
 * the scene tree has no reason to.
 */
export const HqScene = memo(function HqScene({
  layout,
  simRef,
  agentsRef,
  hoveredIdRef,
  hoverSinkRef,
  activityRef,
  cameraApiRef,
  selectedId,
  quality,
  onCameraModeChange,
  onIntroChange,
  onSelect,
  onFocus,
  briefing = null,
  operationRef,
  onClipsChange,
  archiveBytes,
}: HqSceneProps) {
  const resetKey = layout.capacity;
  // Every screen's content (monitors, wall screens, AM7's monitor, the map panels).
  const screens = useMemo(() => new HqScreenHub(), []);
  useEffect(() => () => screens.dispose(), [screens]);
  // Holds new objects back until their shaders are built (and the post chain
  // until the room is, at load).
  const gate = useMemo(() => new HqPrewarmGate(), []);
  // The briefing on the video wall: the task on the west wing, AM7's plan on
  // the east wing, the goal across the top of the map.
  const briefingTask = briefing?.task ?? null;
  const briefingReply = briefing?.reply ?? "";
  useEffect(() => {
    screens.setBriefing(briefingTask === null ? null : briefingScreens(briefingTask, briefingReply));
  }, [screens, briefingTask, briefingReply]);
  return (
    <>
      <HqShaderPrewarm gate={gate} />
      <HqDevThreeHook />
      {operationRef ? <HqOperationFeed screens={screens} operationRef={operationRef} /> : null}
      <HqSimDriver simRef={simRef} activityRef={activityRef} />
      <HqScreenDriver screens={screens} agentsRef={agentsRef} quality={quality} />
      <HqCameraRig
        layout={layout}
        simRef={simRef}
        apiRef={cameraApiRef}
        onModeChange={onCameraModeChange}
        onIntroChange={onIntroChange}
      />
      <HqLighting layout={layout} quality={quality} />

      <HqModuleSlot name="environment" resetKey={resetKey} fallback={<FallbackFloor layout={layout} />}>
        <HqEnvironment layout={layout} quality={quality} screens={screens} simRef={simRef} archiveBytes={archiveBytes} />
      </HqModuleSlot>
      <HqModuleSlot name="map" resetKey={resetKey}>
        <HqWorldMap wall={layout.mapWall} quality={quality} activity={activityRef} screens={screens} />
      </HqModuleSlot>
      <HqModuleSlot name="workstations" resetKey={resetKey}>
        <HqWorkstations layout={layout} simRef={simRef} quality={quality} screens={screens} />
      </HqModuleSlot>
      <HqModuleSlot name="crowd" resetKey={resetKey}>
        <HqCrowd
          simRef={simRef}
          agentsRef={agentsRef}
          hoveredIdRef={hoveredIdRef}
          selectedId={selectedId}
          quality={quality}
          onClipsChange={onClipsChange}
        />
      </HqModuleSlot>

      <HqPicking
        simRef={simRef}
        hoveredIdRef={hoveredIdRef}
        hoverSinkRef={hoverSinkRef}
        onSelect={onSelect}
        onFocus={onFocus}
      />
      <HqPostFx quality={quality} gate={gate} />
    </>
  );
});
