"use client";

import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, Lightformer, OrbitControls, useGLTF } from "@react-three/drei";
import { AgXToneMapping, Vector3, type Group, type PerspectiveCamera } from "three";
import { SceneAssetBoundary } from "@/components/three/sceneAssets";
import {
  HqPreviewRig,
  PREVIEW_FRAME,
  createRadialTexture,
  previewCameraDistance,
  type PreviewClip,
} from "@/features/agents/components/avatarPreview/previewRig";
import { HQ_CHARACTER_URL, HQ_THEME } from "@/features/hq/core/config";
import type { AgentAvatarProfile } from "@/lib/avatars/profile";
import { t } from "@/lib/i18n";

/**
 * The agent as it stands in the HQ: the same character GLB, material and
 * clips, on a small dark stage — warm key, faint fill, red rims from behind,
 * the HQ's red floor ring — swaying gently so the silhouette reads.
 *
 * The HQ draws every agent with that one model, so the preview looks the same
 * for every profile; the profile only picks where the idle clip starts, so
 * previews side by side do not move in lockstep.
 *
 * Cheap to keep open: one skinned draw plus four flat meshes, the reflection
 * environment is rendered once, the GLTF comes from the cache the HQ already
 * filled, and a preview scrolled out of view stops rendering.
 */

type PreviewStatus = "loading" | "ready" | "failed";

const FOV = 30;
const TARGET = new Vector3(0, PREVIEW_FRAME.centerY, 0);
const TARGET_TUPLE: [number, number, number] = [0, PREVIEW_FRAME.centerY, 0];
// Hoisted: R3F re-applies renderer and camera options whenever they change
// identity, which would reset the orbit on every re-render.
const GL_OPTIONS = { antialias: true, alpha: false, toneMapping: AgXToneMapping, toneMappingExposure: 1.1 };
const CAMERA_OPTIONS = { fov: FOV, near: 0.1, far: 40, position: [0, PREVIEW_FRAME.centerY + 0.08, 4] as [number, number, number] };
const DPR: [number, number] = [1, 1.75];
const STAGE_BACKGROUND = "#050404";
// Long frames (tab switch, preview scrolled back into view) must not jump the clip.
const MAX_DT = 0.1;
// A gentle sway rather than a full turn: the face stays toward the viewer.
const SWAY_SPEED = 0.32;
const SWAY_ANGLE = 0.42;

const _offset = new Vector3();

export type AgentAvatarPreview3DProps = {
  profile: AgentAvatarProfile | null | undefined;
  className?: string;
  /** Which HQ clip plays (default Idle); changes crossfade. */
  clip?: PreviewClip;
  /** Drag to orbit (default on). */
  interactive?: boolean;
};

export const AgentAvatarPreview3D = ({
  profile,
  className = "",
  clip = "Idle",
  interactive = true,
}: AgentAvatarPreview3DProps) => {
  const seed = profile?.seed ?? "preview";
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<PreviewStatus>("loading");
  const [onScreen, setOnScreen] = useState(true);

  // A preview scrolled out of view (a long list of roles) stops rendering.
  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setOnScreen(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const onStatus = useCallback((next: PreviewStatus) => setStatus(next), []);

  return (
    <div ref={containerRef} className={`relative overflow-hidden bg-[#050404] ${className}`}>
      <Canvas frameloop={onScreen ? "always" : "never"} dpr={DPR} gl={GL_OPTIONS} camera={CAMERA_OPTIONS}>
        <PreviewStage />
        <FrameCamera />
        <SceneAssetBoundary
          name="avatar-preview-character"
          fallback={<ReportStatus status="failed" onStatus={onStatus} />}
        >
          <Suspense fallback={null}>
            <PreviewCharacter clip={clip} seed={seed} onStatus={onStatus} />
          </Suspense>
        </SceneAssetBoundary>
        {interactive ? (
          <OrbitControls
            target={TARGET_TUPLE}
            enablePan={false}
            enableZoom={false}
            enableDamping
            dampingFactor={0.08}
            rotateSpeed={0.55}
            minPolarAngle={1.18}
            maxPolarAngle={1.72}
          />
        ) : null}
      </Canvas>
      {status !== "ready" ? (
        <div
          role="status"
          className={`pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 ${
            status === "failed" ? "bg-[#050404]/70" : "bg-[#050404]"
          }`}
        >
          {status === "loading" ? (
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#ff2a2a] shadow-[0_0_8px_rgba(255,42,42,0.9)]"
            />
          ) : null}
          <span className="max-w-full px-2 text-center font-mono text-[9px] uppercase leading-3 tracking-[0.16em] text-white/55">
            {status === "failed" ? t("avatar.modelUnavailable") : t("avatar.loading")}
          </span>
        </div>
      ) : null}
    </div>
  );
};

/** Reports a status once mounted (the load-failure fallback). */
function ReportStatus({ status, onStatus }: { status: PreviewStatus; onStatus: (status: PreviewStatus) => void }) {
  useEffect(() => {
    onStatus(status);
  }, [status, onStatus]);
  return null;
}

/** Keeps the whole figure framed whatever the preview's aspect. */
function FrameCamera() {
  // Reached through get(): React treats a selected camera as frozen.
  const get = useThree((state) => state.get);
  const width = useThree((state) => state.size.width);
  const height = useThree((state) => state.size.height);
  useLayoutEffect(() => {
    const { camera, invalidate } = get();
    const distance = previewCameraDistance(width / Math.max(1, height), (camera as PerspectiveCamera).fov);
    // Keep the current orbit direction, change only the distance.
    _offset.copy(camera.position).sub(TARGET);
    if (_offset.lengthSq() < 1e-6) _offset.set(0, 0, 1);
    camera.position.copy(TARGET).addScaledVector(_offset.normalize(), distance);
    camera.lookAt(TARGET);
    invalidate();
  }, [get, width, height]);
  return null;
}

/** Dark stage in the HQ's light: key, fill, two red rims, a fading floor. */
function PreviewStage() {
  const radial = useMemo(() => createRadialTexture(), []);
  useEffect(() => () => radial.dispose(), [radial]);
  return (
    <>
      <color attach="background" args={[STAGE_BACKGROUND]} />
      {/* The HQ's ambient (HqLighting), a little softer in the small frame. */}
      <hemisphereLight args={["#a8b0c2", "#1c1416", 1.2]} />
      {/* Key: warm white, high and front-left. */}
      <directionalLight position={[-2.4, 3.4, 3.2]} intensity={3.4} color="#fff1e6" />
      {/* Fill: faint, from the right, so the black hoodie keeps its folds. */}
      <directionalLight position={[2.8, 1.6, 2.4]} intensity={0.9} color="#e6e8ee" />
      {/* Red rims from behind: the HQ's accent traced along the silhouette. */}
      <directionalLight position={[2.2, 2.6, -2.8]} intensity={5.5} color={HQ_THEME.accent} />
      <directionalLight position={[-2.4, 1.4, -2.6]} intensity={3.2} color={HQ_THEME.accentSoft} />
      {/* Reflections for the visor and metal parts, rendered once. */}
      <Environment frames={1} resolution={128} environmentIntensity={0.9}>
        <Lightformer form="rect" intensity={3} color="#fff4e8" scale={[6, 0.6, 1]} position={[0, 4, 1]} rotation-x={Math.PI / 2} />
        <Lightformer form="rect" intensity={1.2} color={HQ_THEME.accent} scale={[4, 3, 1]} position={[0, 1.5, -4]} />
        <Lightformer form="rect" intensity={0.8} color="#e8ebf2" scale={[3, 3, 1]} position={[4, 1.5, 2]} rotation-y={-Math.PI / 2} />
      </Environment>
      {/* Red haze behind the figure. */}
      <mesh position={[0, 1.15, -2.2]} renderOrder={-1}>
        <planeGeometry args={[5.5, 4.2]} />
        <meshBasicMaterial
          color={HQ_THEME.accentDeep}
          alphaMap={radial}
          transparent
          opacity={0.55}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      {/* Glossy floor fading into the dark. */}
      <mesh rotation-x={-Math.PI / 2}>
        <circleGeometry args={[2.4, 48]} />
        <meshStandardMaterial color="#0d0909" roughness={0.42} metalness={0.2} alphaMap={radial} transparent depthWrite={false} />
      </mesh>
      {/* Contact shadow. */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.004, 0]}>
        <circleGeometry args={[0.5, 32]} />
        <meshBasicMaterial color="#000000" alphaMap={radial} transparent opacity={0.85} depthWrite={false} />
      </mesh>
      {/* The HQ's floor ring. */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.008, 0]}>
        <ringGeometry args={[0.5, 0.52, 64]} />
        <meshBasicMaterial color={HQ_THEME.accent} transparent opacity={0.7} depthWrite={false} toneMapped={false} />
      </mesh>
    </>
  );
}

/** The HQ character: loads (or reuses) the GLB, builds a private rig, plays the clip. */
function PreviewCharacter({
  clip,
  seed,
  onStatus,
}: {
  clip: PreviewClip;
  seed: string;
  onStatus: (status: PreviewStatus) => void;
}) {
  // Same URL and options as the HQ (no Draco/meshopt: the production CSP
  // blocks their decoders), so the GLTF comes from the same cache entry.
  const gltf = useGLTF(HQ_CHARACTER_URL, false, false);
  const groupRef = useRef<Group>(null);
  const rigRef = useRef<HqPreviewRig | null>(null);
  const clipRef = useRef(clip);
  const seedRef = useRef(seed);
  const readyPendingRef = useRef(false);

  // Declared before the rig effect, so a new rig starts on the current clip.
  useEffect(() => {
    clipRef.current = clip;
    rigRef.current?.play(clip);
  }, [clip]);

  // The seed only sets the idle phase of a new rig; a change does not rebuild it.
  useEffect(() => {
    seedRef.current = seed;
  }, [seed]);

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const rig = HqPreviewRig.create(gltf, seedRef.current);
    if (!rig) {
      console.warn("HQ character has no skinned mesh; the avatar preview stays empty.");
      onStatus("failed");
      return;
    }
    group.add(rig.root);
    rig.play(clipRef.current);
    rig.update(0);
    rigRef.current = rig;
    readyPendingRef.current = true;
    return () => {
      if (rigRef.current === rig) rigRef.current = null;
      rig.dispose();
    };
  }, [gltf, onStatus]);

  useFrame((state, delta) => {
    const rig = rigRef.current;
    const group = groupRef.current;
    if (!rig || !group) return;
    rig.update(Math.min(Math.max(delta, 0), MAX_DT));
    group.rotation.y = Math.sin(state.clock.elapsedTime * SWAY_SPEED) * SWAY_ANGLE;
    // Lift the loading cover once the posed figure is about to be drawn.
    if (readyPendingRef.current) {
      readyPendingRef.current = false;
      onStatus("ready");
    }
  });

  return <group ref={groupRef} />;
}
