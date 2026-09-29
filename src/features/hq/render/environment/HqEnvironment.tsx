"use client";

import { useFrame } from "@react-three/fiber";
import { useCallback, useEffect, useLayoutEffect, useMemo, type MutableRefObject } from "react";
import * as THREE from "three";
import type { HqSimulation } from "@/features/hq/core/sim";
import type { HqLayout } from "@/features/hq/core/types";
import type { HqQuality } from "@/features/hq/render/scene/quality";
import type { HqScreenHub } from "@/features/hq/render/screens/screenHub";
import { applyLayoutToEnvMaterials, createEnvMaterials, disposeEnvMaterials } from "./envMaterials";
import { buildFloorGlow } from "./floorGlow";
import { applyGlowToFloor, applyLayoutToFloor, createFloorMaterial } from "./floorMaterial";
import { noRaycast } from "./glsl";
import { HqArenaLines } from "./HqArenaLines";
import { HqCommandDeck } from "./HqCommandDeck";
import { WALL_THICKNESS } from "./palette";
import { buildPartitions, createUnitBox } from "./partitions";
import { HqProps } from "./props/HqProps";
import { createPropUniforms, setPropAnimation, setPropTime } from "./props/propMaterials";
import { boxesToGeometry, buildRoomShell } from "./roomShell";

type Props = {
  layout: HqLayout;
  quality: HqQuality;
  screens?: HqScreenHub | null;
  /** The running sim: raises the briefing tribune, drives the archive cart. */
  simRef?: MutableRefObject<HqSimulation | null>;
  /**
   * Read every frame: the bytes the archive cart's load stands for (the run's
   * freed bytes from its `taken` event until it is parked), or null when
   * unknown. Shown on the cart's tablet; without it the tablet shows the load tier.
   */
  archiveBytes?: () => number | null;
};

/** The metal edge round the apron's open sides: width and height (metres). */
const APRON_EDGE = { width: 0.05, height: 0.02 } as const;

/**
 * The HQ room and its static dressing: glossy stone floor with fake
 * reflections, tall north/west walls and low south/east curbs, glass
 * partitions, the dais of AM7's island, the amphitheatre's floor lines,
 * every layout prop, AM7's briefing tribune, and the archive station (its
 * bay, cart and intake chute on the apron outside the entrance). Workstations, the
 * crowd and the world map are separate modules.
 *
 * Everything is built once per layout; quality only swaps the reflection
 * texture and flips uniforms, so it never adds or removes a shader program.
 * No lights here: the shell's fixed light set already covers AM7's office.
 */
export function HqEnvironment({ layout, quality, screens = null, simRef, archiveBytes }: Props) {
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

  // The apron outside the entrance, where the archive cart hands its load to
  // the intake chute: the same stone floor (same material, so the slabs run on
  // from the hall's), starting where the hall's floor plane ends under the
  // curb, with a thin metal edge round its three open sides.
  const apron = useMemo(() => {
    const { x0, x1, z1 } = layout.archive.apron;
    const zStart = Math.min(layout.bounds.z1 + WALL_THICKNESS, z1);
    const plane = new THREE.PlaneGeometry(x1 - x0, z1 - zStart);
    plane.rotateX(-Math.PI / 2);
    plane.translate((x0 + x1) / 2, 0, (zStart + z1) / 2);
    const w = APRON_EDGE.width;
    const h = APRON_EDGE.height;
    const edge = boxesToGeometry([
      [x0 - w, 0, zStart, x0, h, z1 + w],
      [x1, 0, zStart, x1 + w, h, z1 + w],
      [x0, 0, z1, x1, h, z1 + w],
    ]);
    return { plane, edge };
  }, [layout.archive.apron, layout.bounds.z1]);
  useEffect(
    () => () => {
      apron.plane.dispose();
      apron.edge.dispose();
    },
    [apron],
  );

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
  const tribuneUp = useCallback(() => simRef?.current?.tribuneUp ?? false, [simRef]);
  const archiveView = useCallback(() => simRef?.current?.archive ?? null, [simRef]);

  return (
    <group name="hq-environment">
      <mesh geometry={floorGeometry} material={floor.material} receiveShadow raycast={noRaycast} />
      <mesh geometry={apron.plane} material={floor.material} receiveShadow raycast={noRaycast} />
      <mesh geometry={apron.edge} material={env.metal} receiveShadow raycast={noRaycast} />
      <mesh geometry={shell.walls} material={env.wall} receiveShadow raycast={noRaycast} />
      <mesh geometry={shell.caps} material={env.metal} raycast={noRaycast} />
      <mesh geometry={shell.lines} material={env.line} raycast={noRaycast} />
      <mesh geometry={shell.curbLines} material={env.lineCurb} raycast={noRaycast} />
      <primitive object={partitions} />
      {/* The SOC floor: AM7's dais, the amphitheatre's walkway lines, the tribune. */}
      <HqCommandDeck deck={layout.deck} />
      <HqArenaLines layout={layout} />
      <HqProps
        props={layout.props}
        quality={quality}
        uniforms={propUniforms}
        screens={screens}
        tribune={layout.tribune}
        tribuneUp={tribuneUp}
        archive={layout.archive}
        archiveView={archiveView}
        archiveBytes={archiveBytes}
      />
    </group>
  );
}
