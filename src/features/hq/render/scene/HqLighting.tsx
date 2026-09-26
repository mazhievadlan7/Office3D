"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Environment, Lightformer } from "@react-three/drei";
import {
  Color,
  type DirectionalLight,
  type Fog,
  Object3D,
  type PointLight,
  type SpotLight,
  Vector3,
} from "three";

import { HQ_THEME } from "../../core/config";
import type { HqLayout } from "../../core/types";
import type { HqQuality } from "./quality";

/**
 * Lighting, fog and the reflection environment of the HQ.
 *
 * The light set is fixed (one hemisphere, one shadowed key, three red
 * accents) and never mounts or unmounts, so every material compiles once.
 * Only the key casts shadows, through an orthographic shadow camera that is
 * refitted to what the camera actually sees: a 1000-desk floor is ~60 m
 * across, and one fixed 2048² map over all of it would give 3 cm texels
 * everywhere instead of sharp shadows where you look.
 */

// Light colours derived from the theme: a near-white key with a warm cast.
const KEY_COLOR = new Color(HQ_THEME.statusSelected).lerp(new Color(HQ_THEME.ledWarm), 0.14);
// Direction toward the key light: high, from the east and a touch south, so
// shadows fall west, visible from the south-east camera.
const KEY_DIRECTION = new Vector3(0.62, 1.25, 0.28).normalize();
const SHADOW_MAP_SIZE: Record<HqQuality, number> = { high: 2048, medium: 1024, low: 512 };
// Tallest thing that should cast into view (server racks, partitions).
const CASTER_TOP = 2.6;

// Scratch objects for the per-frame refit; never allocated in the loop.
const _ray = new Vector3();
const _hit = new Vector3();
const _pos = new Vector3();
// Shadow-camera axes, matching what Object3D.lookAt builds for the light:
// x = up × dir, y = dir × x.
const LIGHT_RIGHT = new Vector3(0, 1, 0).cross(KEY_DIRECTION).normalize();
const LIGHT_UP = KEY_DIRECTION.clone().cross(LIGHT_RIGHT).normalize();
// Screen corners, then the centre (used for the fog and near/far distance).
const NDC_X = [-1, 1, 1, -1, 0];
const NDC_Y = [-1, -1, 1, 1, 0];

export function HqLighting({ layout, quality }: { layout: HqLayout; quality: HqQuality }) {
  // The renderer is reached through get() rather than held: its shadow-map
  // switches are ours to flip, and React treats a selected value as frozen.
  const getState = useThree((state) => state.get);
  const keyRef = useRef<DirectionalLight>(null);
  const fogRef = useRef<Fog>(null);
  const mapLightRef = useRef<PointLight>(null);
  const serverLightRef = useRef<PointLight>(null);
  const am7LightRef = useRef<SpotLight>(null);
  const keyTarget = useMemo(() => new Object3D(), []);
  const am7Target = useMemo(() => new Object3D(), []);
  const lastCamera = useRef(new Float32Array(16));
  const refitNeeded = useRef(true);
  const frameIndex = useRef(0);
  const shadowsOn = quality !== "low";

  // Accent positions follow the layout; the lights themselves stay mounted.
  useLayoutEffect(() => {
    const wall = layout.mapWall;
    mapLightRef.current?.position.set(wall.x, Math.max(1.4, wall.y - wall.height * 0.25), wall.z + 2.4);
    const server = layout.serverRoom;
    serverLightRef.current?.position.set((server.x0 + server.x1) / 2, 2.3, (server.z0 + server.z1) / 2);
    const office = layout.am7Office;
    const cx = (office.x0 + office.x1) / 2;
    const cz = (office.z0 + office.z1) / 2;
    am7LightRef.current?.position.set(cx, Math.max(2.6, layout.wallHeight - 0.2), cz);
    am7Target.position.set(cx, 0, cz);
    am7Target.updateMatrixWorld();
    refitNeeded.current = true;
  }, [layout, am7Target]);

  // Shadow map size per level: the map is reallocated on the next shadow render.
  useEffect(() => {
    const light = keyRef.current;
    if (!light) return;
    const size = SHADOW_MAP_SIZE[quality];
    light.shadow.mapSize.set(size, size);
    const map = light.shadow.map;
    if (map && map.width !== size) {
      map.depthTexture?.dispose();
      map.dispose();
      light.shadow.map = null;
    }
    light.castShadow = shadowsOn;
    // Medium renders the shadow map every other frame (see the frame loop).
    const { shadowMap } = getState().gl;
    shadowMap.autoUpdate = quality === "high";
    shadowMap.needsUpdate = true;
    refitNeeded.current = true;
  }, [getState, quality, shadowsOn]);

  useEffect(
    () => () => {
      getState().gl.shadowMap.autoUpdate = true;
    },
    [getState],
  );

  useFrame(({ camera, gl }) => {
    const light = keyRef.current;
    const fog = fogRef.current;
    if (!light) return;
    frameIndex.current += 1;
    if (quality === "medium" && (frameIndex.current & 1) === 0) gl.shadowMap.needsUpdate = true;

    // The controls moved the camera this frame; its world matrix is only
    // refreshed at render time, so bring it up to date before unprojecting.
    camera.updateMatrixWorld();
    const elements = camera.matrixWorld.elements;
    const last = lastCamera.current;
    let moved = refitNeeded.current;
    for (let i = 0; i < 16 && !moved; i += 1) {
      if (Math.abs(elements[i] - last[i]) > 1e-4) moved = true;
    }
    if (!moved) return;
    last.set(elements);
    refitNeeded.current = false;

    const { x0, z0, x1, z1 } = layout.bounds;
    const margin = 1.5;
    let minR = Infinity;
    let maxR = -Infinity;
    let minU = Infinity;
    let maxU = -Infinity;
    let minL = Infinity;
    let maxL = -Infinity;
    let centreDistance = 0;
    const eye = camera.position;
    for (let c = 0; c < NDC_X.length; c += 1) {
      _ray.set(NDC_X[c], NDC_Y[c], 0.5).unproject(camera).sub(eye).normalize();
      if (_ray.y < -1e-3) {
        _hit.copy(_ray).multiplyScalar(-eye.y / _ray.y).add(eye);
      } else {
        // Above the horizon: take a far point along the ground direction.
        _hit.set(_ray.x, 0, _ray.z).normalize().multiplyScalar(1e4).add(eye);
      }
      if (c === 4) {
        centreDistance = _hit.distanceTo(eye);
        continue;
      }
      _hit.x = Math.min(x1 + margin, Math.max(x0 - margin, _hit.x));
      _hit.z = Math.min(z1 + margin, Math.max(z0 - margin, _hit.z));
      for (let level = 0; level < 2; level += 1) {
        _hit.y = level === 0 ? 0 : CASTER_TOP;
        const r = _hit.dot(LIGHT_RIGHT);
        const u = _hit.dot(LIGHT_UP);
        const l = _hit.dot(KEY_DIRECTION);
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (l < minL) minL = l;
        if (l > maxL) maxL = l;
      }
    }

    if (fog) {
      // Depth haze that scales with how far out the camera is.
      fog.near = centreDistance * 0.85;
      fog.far = centreDistance * 2.6 + 18;
    }
    if (!light.castShadow) return;
    const size = light.shadow.mapSize.x;
    // Quantise the extent to 2 m steps and the centre to whole texels, so
    // shadow edges do not crawl while the camera pans.
    const halfR = Math.ceil(((maxR - minR) / 2 + 1) / 2) * 2;
    const halfU = Math.ceil(((maxU - minU) / 2 + 1) / 2) * 2;
    const texelR = (halfR * 2) / size;
    const texelU = (halfU * 2) / size;
    const centreR = Math.round((minR + maxR) / 2 / texelR) * texelR;
    const centreU = Math.round((minU + maxU) / 2 / texelU) * texelU;
    const lift = maxL + 12;
    _pos
      .copy(LIGHT_RIGHT)
      .multiplyScalar(centreR)
      .addScaledVector(LIGHT_UP, centreU)
      .addScaledVector(KEY_DIRECTION, lift);
    light.position.copy(_pos);
    keyTarget.position.copy(_pos).sub(KEY_DIRECTION);
    keyTarget.updateMatrixWorld();
    const cam = light.shadow.camera;
    cam.left = -halfR;
    cam.right = halfR;
    cam.top = halfU;
    cam.bottom = -halfU;
    cam.near = 0.5;
    cam.far = lift - minL + 2;
    cam.updateProjectionMatrix();
    // Normal bias in world units grows with the texel so acne never returns.
    light.shadow.normalBias = Math.max(texelR, texelU) * 1.5;
    gl.shadowMap.needsUpdate = true;
  });

  const office = layout.am7Office;

  return (
    <>
      <color attach="background" args={[HQ_THEME.background]} />
      <fog ref={fogRef} attach="fog" args={[HQ_THEME.fog, 30, 120]} />
      <hemisphereLight args={["#a8b0c2", "#1c1416", 2.4]} />
      {/* Soft fill from the camera side so hooded figures read against the dark floor. */}
      <directionalLight position={[18, 26, 30]} color="#dfe6f2" intensity={1.3} />
      <primitive object={keyTarget} />
      <primitive object={am7Target} />
      <directionalLight
        ref={keyRef}
        color={KEY_COLOR}
        intensity={4.6}
        target={keyTarget}
        castShadow={shadowsOn}
        shadow-mapSize={[SHADOW_MAP_SIZE[quality], SHADOW_MAP_SIZE[quality]]}
        shadow-bias={-0.0003}
        shadow-radius={3}
      />
      <pointLight
        ref={mapLightRef}
        color={HQ_THEME.accent}
        intensity={16}
        distance={12}
        decay={2}
      />
      <pointLight ref={serverLightRef} color={HQ_THEME.accent} intensity={14} distance={9} decay={2} />
      {/*
        AM7's office light is the neutral key colour, not red: a red spot over
        the lead's desk tinted AM7's clothes red, which read as a glitch. The
        office keeps its red from the LED trims and the screens.
      */}
      <spotLight
        ref={am7LightRef}
        color={KEY_COLOR}
        intensity={22}
        distance={Math.max(8, (office.x1 - office.x0) * 1.6)}
        angle={0.95}
        penumbra={0.85}
        decay={2}
        target={am7Target}
      />
      {/*
        A dark studio for reflections instead of a daylight HDRI: a warm
        ceiling strip, a red glow from the map side and a faint cool fill.
        Rendered once into a cube map; glossy floors and screens pick it up.
      */}
      <Environment frames={1} resolution={256} environmentIntensity={1.2}>
        <Lightformer form="rect" intensity={4} color="#fff4e8" scale={[14, 0.8, 1]} position={[0, 6, 0]} rotation-x={Math.PI / 2} />
        <Lightformer form="rect" intensity={3} color={HQ_THEME.statusSelected} scale={[10, 0.6, 1]} position={[0, 6, 3]} rotation-x={Math.PI / 2} />
        <Lightformer form="rect" intensity={0.8} color={HQ_THEME.accent} scale={[12, 3, 1]} position={[0, 2.5, -9]} />
        <Lightformer form="rect" intensity={0.6} color={HQ_THEME.accentSoft} scale={[8, 2, 1]} position={[-9, 2, 0]} rotation-y={Math.PI / 2} />
        <Lightformer form="rect" intensity={1.4} color="#c8d2e6" scale={[10, 4, 1]} position={[9, 3, 6]} rotation-y={-Math.PI / 2} />
      </Environment>
    </>
  );
}
