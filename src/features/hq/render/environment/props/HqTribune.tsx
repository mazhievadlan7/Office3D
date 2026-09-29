"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { HQ_THEME } from "@/features/hq/core/config";
import type { HqTribune as HqTribunePlacement } from "@/features/hq/core/types";
import type { HqQuality } from "@/features/hq/render/scene/quality";
import { noRaycast } from "../glsl";
import { themeColor } from "../palette";
import { applyPropShadows, buildPropBatches, disposePropBatches, type PropMaterialSet } from "./propBatches";
import type { PropUniforms } from "./propMaterials";

/** Seconds the tribune takes to rise out of the floor, or to sink back. */
const TRAVEL_SECONDS = 2.6;
/** Lowered, the whole lectern (microphone included) is this far under the floor. */
const SINK_DEPTH = 1.6;
/** The hatch seam on the floor: a hexagon just outside the lectern's body. */
const SEAM_RADIUS = 0.6;
const SEAM_WIDTH = 0.018;
/** Seam brightness (linear): a faint line at rest, into bloom while the tribune moves or stands. */
const SEAM_REST = 0.5;
const SEAM_UP = 2.2;
const SEAM_MOVING = 5;

type Props = {
  tribune: HqTribunePlacement;
  scene: THREE.Object3D | null;
  materials: PropMaterialSet;
  uniforms: PropUniforms;
  quality: HqQuality;
  /** Read every frame: whether the tribune should stand raised. */
  isUp: () => boolean;
};

const ease = (t: number) => t * t * (3 - 2 * t);

/**
 * AM7's briefing tribune: the props.glb "tribune" lectern, kept under the
 * floor (the floor hides it) until a briefing, then risen through a hatch
 * whose seam lights up while it moves. It sinks again once AM7 has left it.
 */
export function HqTribune({ tribune, scene, materials, uniforms, quality, isUp }: Props) {
  const batch = useMemo(
    () => buildPropBatches([{ kind: "tribune", x: tribune.x, z: tribune.z, rotY: tribune.rotY }], scene, materials, uniforms),
    [tribune, scene, materials, uniforms],
  );
  useEffect(() => () => disposePropBatches(batch), [batch]);
  useEffect(() => applyPropShadows(batch, quality === "high"), [batch, quality]);

  const seam = useMemo(() => {
    // Flat sides front and back, like the lectern's hexagon.
    const g = new THREE.RingGeometry(SEAM_RADIUS - SEAM_WIDTH, SEAM_RADIUS, 6, 1);
    g.rotateX(-Math.PI / 2);
    g.rotateY(tribune.rotY);
    g.translate(tribune.x, 0.004, tribune.z);
    return g;
  }, [tribune]);
  useEffect(() => () => seam.dispose(), [seam]);
  const seamColor = useMemo(() => themeColor(HQ_THEME.accent), []);
  const seamMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: seamColor.clone().multiplyScalar(SEAM_REST),
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    [seamColor],
  );
  useEffect(() => () => seamMaterial.dispose(), [seamMaterial]);

  const lift = useRef(0);
  const lifter = useRef<THREE.Group>(null);
  const seamMesh = useRef<THREE.Mesh>(null);
  useFrame((_, delta) => {
    const target = isUp() ? 1 : 0;
    const step = Math.min(delta, 0.1) / TRAVEL_SECONDS;
    const was = lift.current;
    lift.current = target > was ? Math.min(1, was + step) : Math.max(0, was - step);
    const t = lift.current;
    const group = lifter.current;
    if (group) {
      group.position.y = (ease(t) - 1) * SINK_DEPTH;
      group.visible = t > 0;
    }
    const level = t !== was ? SEAM_MOVING : SEAM_REST + (SEAM_UP - SEAM_REST) * t;
    const seamLine = seamMesh.current;
    if (seamLine) (seamLine.material as THREE.MeshBasicMaterial).color.copy(seamColor).multiplyScalar(level);
  });

  return (
    <group name="hq-tribune">
      <group ref={lifter} visible={false}>
        <primitive object={batch.root} />
      </group>
      <mesh ref={seamMesh} geometry={seam} material={seamMaterial} raycast={noRaycast} />
    </group>
  );
}
