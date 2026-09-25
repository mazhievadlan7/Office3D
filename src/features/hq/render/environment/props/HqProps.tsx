"use client";

import { useGLTF } from "@react-three/drei";
import { Suspense, useEffect, useMemo } from "react";
import type * as THREE from "three";
import { SceneAssetBoundary } from "@/components/three/sceneAssets";
import { HQ_PROPS_URL } from "@/features/hq/core/config";
import type { HqProp } from "@/features/hq/core/types";
import type { HqQuality } from "@/features/hq/render/scene/quality";
import { applyPropShadows, buildPropBatches, disposePropBatches, type PropMaterialSet } from "./propBatches";
import { createFallbackMaterials, createScreenMaterial, type PropUniforms } from "./propMaterials";

type Props = { props: HqProp[]; quality: HqQuality; uniforms: PropUniforms };

/**
 * All static props, instanced per (kind, material). Until props.glb loads, or
 * if it is missing, procedural stand-ins take its place so the room is never
 * empty.
 */
export function HqProps({ props, quality, uniforms }: Props) {
  const materials = useMemo<PropMaterialSet>(() => {
    const screen = createScreenMaterial(uniforms);
    return { screen, fallback: createFallbackMaterials(uniforms, screen) };
  }, [uniforms]);
  useEffect(
    () => () => {
      for (const m of new Set(Object.values(materials.fallback))) m.dispose();
      materials.screen.dispose();
    },
    [materials],
  );

  const standIns = <PropInstances props={props} scene={null} materials={materials} quality={quality} uniforms={uniforms} />;
  return (
    <SceneAssetBoundary name="hq-props" fallback={standIns}>
      <Suspense fallback={standIns}>
        <GlbProps props={props} materials={materials} quality={quality} uniforms={uniforms} />
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
};

function PropInstances({ props, scene, materials, quality, uniforms }: InstancesProps) {
  const batches = useMemo(
    () => buildPropBatches(props, scene, materials, uniforms),
    [props, scene, materials, uniforms],
  );
  useEffect(() => () => disposePropBatches(batches), [batches]);
  useEffect(() => applyPropShadows(batches, quality === "high"), [batches, quality]);
  return <primitive object={batches.root} />;
}
