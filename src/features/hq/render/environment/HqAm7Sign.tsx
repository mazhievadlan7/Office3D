"use client";

import { Text } from "@react-three/drei";
import { Suspense, useEffect, useMemo } from "react";
import * as THREE from "three";
import { OFFICE_TEXT_FONT, SceneAssetBoundary } from "@/components/three/sceneAssets";
import { HQ_LEAD_AGENT_NAME, HQ_THEME } from "@/features/hq/core/config";
import type { HqLayout } from "@/features/hq/core/types";
import type { EnvMaterials } from "./envMaterials";
import { noRaycast } from "./glsl";
import { am7SignPlacement } from "./layoutGeometry";
import { GLOW, themeColor } from "./palette";

const FONT_SIZE = 0.62;
const PLATE = { w: 1.75, h: 0.74, d: 0.04 };
const STEM_H = 0.18;

/**
 * Red neon "AM7" above the lead agent's office front. The letters are unlit
 * and pushed far above 1 so bloom turns them into neon; a soft outline adds
 * the halo that bloom alone keeps too tight from a distance.
 */
export function HqAm7Sign({ layout, materials }: { layout: HqLayout; materials: EnvMaterials }) {
  const placement = useMemo(() => am7SignPlacement(layout), [layout]);
  const parts = useMemo(
    () => ({
      plate: new THREE.BoxGeometry(PLATE.w, PLATE.h, PLATE.d),
      stem: new THREE.BoxGeometry(0.03, STEM_H, 0.03),
      halo: themeColor(HQ_THEME.accent, GLOW.line),
    }),
    [],
  );
  useEffect(
    () => () => {
      parts.plate.dispose();
      parts.stem.dispose();
    },
    [parts],
  );

  const stemY = -PLATE.h / 2 - STEM_H / 2;
  return (
    <group position={[placement.x, placement.y, placement.z]} rotation={[0, placement.rotY, 0]}>
      {/* Dark backing plate on two short stems down to the glass top rail. */}
      <mesh geometry={parts.plate} material={materials.metal} position={[0, 0, -PLATE.d / 2 - 0.01]} raycast={noRaycast} />
      <mesh geometry={parts.stem} material={materials.metal} position={[-0.55, stemY, -0.03]} raycast={noRaycast} />
      <mesh geometry={parts.stem} material={materials.metal} position={[0.55, stemY, -0.03]} raycast={noRaycast} />
      <SceneAssetBoundary name="hq-am7-sign">
        <Suspense fallback={null}>
          <Text
            font={OFFICE_TEXT_FONT}
            characters={HQ_LEAD_AGENT_NAME}
            fontSize={FONT_SIZE}
            letterSpacing={0.12}
            anchorX="center"
            anchorY="middle"
            position={[0, 0.02, 0.012]}
            outlineWidth="9%"
            outlineBlur="45%"
            outlineColor={parts.halo}
            outlineOpacity={0.55}
            raycast={noRaycast}
            material={materials.neon}
          >
            {HQ_LEAD_AGENT_NAME}
          </Text>
        </Suspense>
      </SceneAssetBoundary>
    </group>
  );
}
