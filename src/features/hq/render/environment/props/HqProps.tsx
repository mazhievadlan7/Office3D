"use client";

import { useGLTF } from "@react-three/drei";
import { Suspense, useEffect, useMemo } from "react";
import type * as THREE from "three";
import { SceneAssetBoundary } from "@/components/three/sceneAssets";
import { HQ_PROPS_URL } from "@/features/hq/core/config";
import type { HqArchiveStation, HqArchiveView, HqProp, HqTribune as HqTribunePlacement } from "@/features/hq/core/types";
import type { HqQuality } from "@/features/hq/render/scene/quality";
import { HqArchive } from "./HqArchive";
import { HqTribune } from "./HqTribune";
import { applyPropShadows, buildPropBatches, disposePropBatches, type PropMaterialSet } from "./propBatches";
import type { HqScreenHub } from "@/features/hq/render/screens/screenHub";
import { screenAnchors } from "@/features/hq/render/screens/screenViews";
import {
  createExecScreenMaterial,
  createFallbackMaterials,
  createScreenMaterial,
  createWallScreenMaterial,
  type PropUniforms,
} from "./propMaterials";

type Props = {
  props: HqProp[];
  quality: HqQuality;
  uniforms: PropUniforms;
  screens: HqScreenHub | null;
  /** AM7's briefing tribune, drawn from the same GLB, risen while `tribuneUp()` holds. */
  tribune: HqTribunePlacement;
  tribuneUp: () => boolean;
  /** The archive station by the entrance, driven by `archiveView()` every frame (null: parked, empty). */
  archive: HqArchiveStation;
  archiveView: () => Readonly<HqArchiveView> | null;
  /** The bytes the cart's load stands for (shown on its tablet), or null when unknown. */
  archiveBytes?: () => number | null;
};

/**
 * All static props, instanced per (kind, material). Until props.glb loads, or
 * if it is missing, procedural stand-ins take its place so the room is never
 * empty.
 */
export function HqProps({ props, quality, uniforms, screens, tribune, tribuneUp, archive, archiveView, archiveBytes }: Props) {
  const materials = useMemo<PropMaterialSet>(() => {
    // With the screen hub, wall screens show its channels and AM7's monitor
    // its command centre; without it, the procedural dashboard everywhere.
    const screen = screens ? createWallScreenMaterial(screens.walls) : createScreenMaterial(uniforms);
    const execScreen = screens ? createExecScreenMaterial(screens.exec) : undefined;
    return { screen, execScreen, screenChannels: screens !== null, fallback: createFallbackMaterials(uniforms, screen) };
  }, [uniforms, screens]);
  useEffect(
    () => () => {
      for (const m of new Set(Object.values(materials.fallback))) m.dispose();
      materials.screen.dispose();
      materials.execScreen?.dispose();
    },
    [materials],
  );
  // The hub repaints a big screen at full rate only while the camera can see it.
  useEffect(() => screens?.setAnchors(screenAnchors(props)), [screens, props]);

  const shared = { props, materials, quality, uniforms, tribune, tribuneUp, archive, archiveView, archiveBytes };
  const standIns = <PropInstances {...shared} scene={null} />;
  return (
    <SceneAssetBoundary name="hq-props" fallback={standIns}>
      <Suspense fallback={standIns}>
        <GlbProps {...shared} />
      </Suspense>
    </SceneAssetBoundary>
  );
}

function GlbProps(p: Omit<InstancesProps, "scene">) {
  // No Draco/meshopt decoders: the production CSP blocks their wasm.
  const gltf = useGLTF(HQ_PROPS_URL, false, false);
  return <PropInstances {...p} scene={gltf.scene} />;
}

type InstancesProps = {
  props: HqProp[];
  scene: THREE.Object3D | null;
  materials: PropMaterialSet;
  quality: HqQuality;
  uniforms: PropUniforms;
  tribune: HqTribunePlacement;
  tribuneUp: () => boolean;
  archive: HqArchiveStation;
  archiveView: () => Readonly<HqArchiveView> | null;
  archiveBytes?: () => number | null;
};

function PropInstances({
  props,
  scene,
  materials,
  quality,
  uniforms,
  tribune,
  tribuneUp,
  archive,
  archiveView,
  archiveBytes,
}: InstancesProps) {
  const batches = useMemo(
    () => buildPropBatches(props, scene, materials, uniforms),
    [props, scene, materials, uniforms],
  );
  useEffect(() => () => disposePropBatches(batches), [batches]);
  useEffect(() => applyPropShadows(batches, quality === "high"), [batches, quality]);
  return (
    <>
      <primitive object={batches.root} />
      <HqTribune
        tribune={tribune}
        scene={scene}
        materials={materials}
        uniforms={uniforms}
        quality={quality}
        isUp={tribuneUp}
      />
      <HqArchive
        archive={archive}
        scene={scene}
        materials={materials}
        uniforms={uniforms}
        quality={quality}
        view={archiveView}
        bytes={archiveBytes}
      />
    </>
  );
}
