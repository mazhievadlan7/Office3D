"use client";

import { memo, useEffect, useMemo, type MutableRefObject } from "react";
import { MeshStandardMaterial, PlaneGeometry } from "three";

import { HQ_THEME } from "../../core/config";
import type { HqSimulation } from "../../core/sim";
import type { HqAgentInput, HqLayout } from "../../core/types";
import { HqCrowd } from "../crowd/HqCrowd";
import { HqEnvironment } from "../environment/HqEnvironment";
import { HqWorldMap } from "../map/HqWorldMap";
import { HqWorkstations } from "../workstations/HqWorkstations";
import { HqAdaptiveQuality, type HqQualityMode } from "./HqAdaptiveQuality";
import { HqCameraRig, type HqCameraApi, type HqCameraMode } from "./HqCameraRig";
import { HqLighting } from "./HqLighting";
import { HqModuleSlot } from "./HqModuleSlot";
import { HqPicking, type HqHoverSink } from "./HqPicking";
import { HqPostFx } from "./HqPostFx";
import { HqSimDriver } from "./HqSimDriver";
import type { HqQuality } from "./quality";
import type { HqQualityTier } from "./qualityGovernor";

const noRaycast = () => null;

/** A bare dark floor, shown only if the environment module cannot render. */
function FallbackFloor({ layout }: { layout: HqLayout }) {
  const { x0, z0, x1, z1 } = layout.bounds;
  const geometry = useMemo(() => new PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2), [x0, z0, x1, z1]);
  const material = useMemo(
    () => new MeshStandardMaterial({ color: HQ_THEME.floor, roughness: 0.32, metalness: 0.1 }),
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
  qualityTiers: readonly HqQualityTier[];
  qualityMode: HqQualityMode;
  onQualityTierChange: (tierIndex: number) => void;
  onCameraModeChange: (mode: HqCameraMode) => void;
  onSelect: (agentId: string) => void;
  onFocus: (agentId: string) => void;
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
  qualityTiers,
  qualityMode,
  onQualityTierChange,
  onCameraModeChange,
  onSelect,
  onFocus,
}: HqSceneProps) {
  const resetKey = layout.capacity;
  return (
    <>
      <HqSimDriver simRef={simRef} activityRef={activityRef} />
      <HqAdaptiveQuality tiers={qualityTiers} mode={qualityMode} onTierChange={onQualityTierChange} />
      <HqCameraRig layout={layout} simRef={simRef} apiRef={cameraApiRef} onModeChange={onCameraModeChange} />
      <HqLighting layout={layout} quality={quality} />

      <HqModuleSlot name="environment" resetKey={resetKey} fallback={<FallbackFloor layout={layout} />}>
        <HqEnvironment layout={layout} quality={quality} />
      </HqModuleSlot>
      <HqModuleSlot name="map" resetKey={resetKey}>
        <HqWorldMap wall={layout.mapWall} quality={quality} activity={activityRef} />
      </HqModuleSlot>
      <HqModuleSlot name="workstations" resetKey={resetKey}>
        <HqWorkstations layout={layout} simRef={simRef} quality={quality} />
      </HqModuleSlot>
      <HqModuleSlot name="crowd" resetKey={resetKey}>
        <HqCrowd
          simRef={simRef}
          agentsRef={agentsRef}
          hoveredIdRef={hoveredIdRef}
          selectedId={selectedId}
          quality={quality}
        />
      </HqModuleSlot>

      <HqPicking
        simRef={simRef}
        hoveredIdRef={hoveredIdRef}
        hoverSinkRef={hoverSinkRef}
        onSelect={onSelect}
        onFocus={onFocus}
      />
      <HqPostFx quality={quality} />
    </>
  );
});
