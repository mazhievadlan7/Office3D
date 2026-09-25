"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import type { HqMapWall } from "@/features/hq/core/types";
import { GLOBE_HALO_SCALE, GlobeRig } from "@/features/hq/render/map/globeRig";
import type { LandMask } from "@/features/hq/render/map/landMask";
import { DEFAULT_MAP_ACTIVITY } from "@/features/hq/render/map/mapRig";
import type { HqQuality } from "@/features/hq/render/scene/quality";

type Props = {
  globe: HqMapWall["globe"];
  mask: LandMask | null;
  quality: HqQuality;
  activity?: MutableRefObject<number>;
};

/** Earth's axial tilt. */
const TILT = THREE.MathUtils.degToRad(23.44);
const SEGMENTS: Record<HqQuality, [number, number]> = { high: [160, 96], medium: [112, 72], low: [72, 48] };
const noRaycast = () => null;

/**
 * The HQ's Earth: a holographic globe on a floor projector in front of the
 * map wall. Continents are a dot matrix sampled from the same land data as
 * the map, the day side glows red and the night side shows city lights, with
 * the terminator placed from the real Sun position at this moment, so the lit
 * half is where it is daytime now. The globe turns slowly on its tilted axis;
 * the hub cities pulse and arcs fly between them along great circles, more
 * and faster the busier the HQ is. A red atmosphere, two orbit rings with
 * satellites and the projector's beam frame it.
 */
export function HqGlobe({ globe, mask, quality, activity }: Props) {
  const R = globe.radius;
  // Quality sets the arc slots, so a quality change builds a new rig.
  const rig = useMemo(() => new GlobeRig(R, quality), [R, quality]);
  useEffect(() => () => rig.dispose(), [rig]);
  useEffect(() => rig.setLand(mask), [rig, mask]);

  const [segW, segH] = SEGMENTS[quality];
  const geometries = useMemo(() => {
    const sphere = new THREE.SphereGeometry(R, segW, segH);
    const shell = new THREE.SphereGeometry(R * GLOBE_HALO_SCALE, 64, 32);
    const ringA = new THREE.TorusGeometry(R * 1.32, R * 0.0035, 6, 180);
    const ringB = new THREE.TorusGeometry(R * 1.5, R * 0.0028, 6, 200);
    const sat = new THREE.SphereGeometry(R * 0.022, 12, 8);
    const baseY = 0.1;
    const beamTop = globe.y - R * 0.82;
    const beam = new THREE.CylinderGeometry(R * 0.5, R * 0.34, beamTop - baseY, 48, 1, true);
    beam.translate(0, (beamTop + baseY) / 2 - globe.y, 0);
    const base = new THREE.CylinderGeometry(R * 0.42, R * 0.5, baseY, 48);
    base.translate(0, baseY / 2 - globe.y, 0);
    const baseRing = new THREE.TorusGeometry(R * 0.4, R * 0.012, 6, 96);
    baseRing.rotateX(Math.PI / 2);
    baseRing.translate(0, baseY + 0.004 - globe.y, 0);
    return { sphere, shell, ringA, ringB, sat, beam, base, baseRing };
  }, [R, segW, segH, globe.y]);
  useEffect(() => () => Object.values(geometries).forEach((g) => g.dispose()), [geometries]);

  const spin = useRef<THREE.Group>(null);
  const ringA = useRef<THREE.Group>(null);
  const ringB = useRef<THREE.Group>(null);
  useFrame((_state, delta) => {
    const angle = rig.frame(delta, activity ? activity.current : DEFAULT_MAP_ACTIVITY, Date.now());
    const t = rig.clock;
    if (spin.current) spin.current.rotation.y = angle;
    if (ringA.current) ringA.current.rotation.y = t * 0.35;
    if (ringB.current) ringB.current.rotation.y = -t * 0.22;
  });

  return (
    <group position={[globe.x, globe.y, globe.z]}>
      <group rotation={[0, 0, -TILT]}>
        <group ref={spin}>
          <mesh geometry={geometries.sphere} material={rig.surface} raycast={noRaycast} />
          <mesh geometry={rig.arcs.geometry} material={rig.arcMaterial} raycast={noRaycast} frustumCulled={false} />
        </group>
      </group>
      <mesh geometry={geometries.shell} material={rig.halo} raycast={noRaycast} />
      <group rotation={[0.42, 0, 0.28]}>
        <group ref={ringA}>
          <mesh geometry={geometries.ringA} material={rig.ring} rotation={[Math.PI / 2, 0, 0]} raycast={noRaycast} />
          <mesh geometry={geometries.sat} material={rig.satellite} position={[R * 1.32, 0, 0]} raycast={noRaycast} />
        </group>
      </group>
      <group rotation={[-0.3, 0, -0.5]}>
        <group ref={ringB}>
          <mesh geometry={geometries.ringB} material={rig.ring} rotation={[Math.PI / 2, 0, 0]} raycast={noRaycast} />
          <mesh geometry={geometries.sat} material={rig.satellite} position={[0, 0, R * 1.5]} raycast={noRaycast} />
          <mesh geometry={geometries.sat} material={rig.satellite} position={[0, 0, -R * 1.5]} raycast={noRaycast} />
        </group>
      </group>
      <mesh geometry={geometries.beam} material={rig.beam} raycast={noRaycast} />
      <mesh geometry={geometries.base} material={rig.base} raycast={noRaycast} receiveShadow />
      <mesh geometry={geometries.baseRing} material={rig.baseGlow} raycast={noRaycast} />
    </group>
  );
}
