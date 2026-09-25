"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import type { HqLayout } from "@/features/hq/core/types";
import type { HqQuality } from "@/features/hq/render/scene/quality";
import type { HqScreenHub } from "@/features/hq/render/screens/screenHub";
import { applyLayoutToEnvMaterials, createEnvMaterials, disposeEnvMaterials } from "./envMaterials";
import { buildFloorGlow } from "./floorGlow";
import { applyGlowToFloor, applyLayoutToFloor, createFloorMaterial } from "./floorMaterial";
import { noRaycast } from "./glsl";
import { WALL_THICKNESS } from "./palette";
import { buildPartitions, createUnitBox } from "./partitions";
import { HqProps } from "./props/HqProps";
import { createPropUniforms, setPropAnimation, setPropTime } from "./props/propMaterials";
import { buildRoomShell } from "./roomShell";

type Props = { layout: HqLayout; quality: HqQuality; screens?: HqScreenHub | null };

/**
 * The HQ room and its static dressing: glossy stone floor with fake
 * reflections, tall north/west walls and low south/east curbs, glass
 * partitions, AM7's office, and every layout prop. Workstations, the crowd
 * and the world map are separate modules.
 *
 * Everything is built once per layout; quality only swaps the reflection
 * texture and flips uniforms, so it never adds or removes a shader program.
 * No lights here: the shell's fixed light set already covers AM7's office.
 */
export function HqEnvironment({ layout, quality, screens = null }: Props) {
  const env = useMemo(() => createEnvMaterials(), []);
  const floor = useMemo(() => createFloorMaterial(), []);
  const propUniforms = useMemo(() => createPropUniforms(), []);
  const unitBox = useMemo(() => createUnitBox(), []);
  useEffect(
    () => () => {
      disposeEnvMaterials(env);
      floor.material.dispose();
      unitBox.dispose();
    },
    [env, floor, unitBox],
  );

  useLayoutEffect(() => {
    applyLayoutToFloor(floor.uniforms, layout);
    applyLayoutToEnvMaterials(env, layout);
  }, [layout, floor, env]);

  const glow = useMemo(() => buildFloorGlow(layout, quality), [layout, quality]);
  useLayoutEffect(() => {
    applyGlowToFloor(floor.uniforms, glow);
    return () => glow.texture.dispose();
  }, [glow, floor]);

  useLayoutEffect(() => {
    setPropAnimation(propUniforms, quality !== "low");
  }, [quality, propUniforms]);

  const floorGeometry = useMemo(() => {
    const { x0, z0, x1, z1 } = layout.bounds;
    const t = WALL_THICKNESS;
    // Runs under the walls and curbs so no seam shows at the room edge.
    const g = new THREE.PlaneGeometry(x1 - x0 + t * 2, z1 - z0 + t * 2);
    g.rotateX(-Math.PI / 2);
    g.translate((x0 + x1) / 2, 0, (z0 + z1) / 2);
    return g;
  }, [layout.bounds]);
  useEffect(() => () => floorGeometry.dispose(), [floorGeometry]);

  const shell = useMemo(() => buildRoomShell(layout), [layout]);
  useEffect(
    () => () => {
      shell.walls.dispose();
      shell.caps.dispose();
      shell.lines.dispose();
      shell.curbLines.dispose();
    },
    [shell],
  );

  const partitions = useMemo(() => buildPartitions(layout, env, unitBox), [layout, env, unitBox]);
  useEffect(
    () => () => {
      for (const child of partitions.children) (child as THREE.InstancedMesh).dispose();
    },
    [partitions],
  );

  useFrame((state) => {
    setPropTime(propUniforms, state.clock.elapsedTime);
  });

  return (
    <group name="hq-environment">
      <mesh geometry={floorGeometry} material={floor.material} receiveShadow raycast={noRaycast} />
      <mesh geometry={shell.walls} material={env.wall} receiveShadow raycast={noRaycast} />
      <mesh geometry={shell.caps} material={env.metal} raycast={noRaycast} />
      <mesh geometry={shell.lines} material={env.line} raycast={noRaycast} />
      <mesh geometry={shell.curbLines} material={env.lineCurb} raycast={noRaycast} />
      <primitive object={partitions} />
      <HqProps props={layout.props} quality={quality} uniforms={propUniforms} screens={screens} />
    </group>
  );
}
