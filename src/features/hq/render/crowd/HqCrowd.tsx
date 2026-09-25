"use client";

import { Suspense, useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import type { Group } from "three";

import { SceneAssetBoundary } from "@/components/three/sceneAssets";
import { HQ_CHARACTER_URL } from "@/features/hq/core/config";
import type { HqSimulation } from "@/features/hq/core/sim";
import type { HqAgentInput } from "@/features/hq/core/types";
import type { HqQuality } from "@/features/hq/render/scene/quality";
import { HqCrowdRuntime, type HqCharacterSource } from "./crowdRuntime";

export type HqCrowdProps = {
  simRef: MutableRefObject<HqSimulation | null>;
  agentsRef: MutableRefObject<HqAgentInput[]>;
  hoveredIdRef: MutableRefObject<string | null>;
  selectedId: string | null;
  quality: HqQuality;
};

// Long frames (tab switch) must not snap the gaze smoothing.
const MAX_DT = 0.1;

/**
 * Every agent in the HQ: a GPU-skinned instanced crowd for everyone, real
 * skinned rigs with head look-at and shadows for the nearest few, floor
 * rings and blob shadows, and pill nameplates. Reads the simulation frame in
 * useFrame; React renders this component once.
 *
 * Until the character GLB is loaded (or if it fails) the same agents are
 * drawn as capsule figures, so the scene never goes empty.
 */
export function HqCrowd({ simRef, agentsRef, hoveredIdRef, selectedId, quality }: HqCrowdProps) {
  const groupRef = useRef<Group>(null);
  const runtimeRef = useRef<HqCrowdRuntime | null>(null);
  const characterRef = useRef<HqCharacterSource | null>(null);

  // Created in an effect (not during render) so StrictMode's mount, unmount,
  // mount leaves exactly one live runtime and every GPU resource is freed.
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const runtime = new HqCrowdRuntime();
    group.add(runtime.root);
    runtimeRef.current = runtime;
    return () => {
      group.remove(runtime.root);
      runtime.dispose();
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
  }, []);

  const onCharacter = useCallback((source: HqCharacterSource | null) => {
    characterRef.current = source;
  }, []);

  useFrame((state, delta) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.setQuality(quality);
    const character = characterRef.current;
    if (!runtime.hasCharacter(character)) runtime.setCharacter(character, state.gl);
    runtime.update(
      state.gl,
      simRef.current,
      agentsRef.current,
      hoveredIdRef.current,
      selectedId,
      state.camera,
      state.size.height,
      Math.min(Math.max(delta, 0), MAX_DT),
      state.clock.elapsedTime,
    );
  });

  return (
    <group ref={groupRef} name="hq-crowd-root">
      <SceneAssetBoundary name="hq-character" fallback={null}>
        <Suspense fallback={null}>
          <CharacterAsset onChange={onCharacter} />
        </Suspense>
      </SceneAssetBoundary>
    </group>
  );
}

/** Loads the character GLB and hands it to the runtime; renders nothing. */
function CharacterAsset({ onChange }: { onChange: (source: HqCharacterSource | null) => void }) {
  // No Draco/meshopt: the production CSP blocks their wasm decoders.
  const gltf = useGLTF(HQ_CHARACTER_URL, false, false);
  useEffect(() => {
    onChange(gltf);
    return () => onChange(null);
  }, [gltf, onChange]);
  return null;
}
