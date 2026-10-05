"use client";

import { Canvas, useFrame, type GLProps } from "@react-three/fiber";
import { Environment, Lightformer, OrbitControls, useGLTF } from "@react-three/drei";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import * as THREE from "three";
import { PCFShadowMap, WebGLRenderer } from "three";

import { HQ_CHARACTER_URL, HQ_COUNCIL_URL, HQ_THEME } from "@/features/hq/core/config";
import type { HqAgentInput } from "@/features/hq/core/types";
import { COUNCIL_FLOORS } from "@/features/hq/core/council/agenda";
import { HqCrowdRuntime, type HqCharacterSource } from "@/features/hq/render/crowd/crowdRuntime";
import { SceneAssetBoundary } from "@/components/three/sceneAssets";
import { clearForegroundSpeechLog, foregroundSpeechLog } from "@/lib/voice/speechDuck";
import { speakSystem } from "@/lib/voice/systemVoice";
import { CouncilSimulation } from "./councilSim";
import { CouncilController, type CouncilScreenPaint } from "./councilController";
import { buildCouncilFurniture, type CouncilFurniture } from "./councilGlb";
import { COUNCIL_ROOM, COUNCIL_SCREEN_X } from "./councilLayout";
import { paintCouncilHeader, paintCouncilScreen } from "./councilScreenPaint";
import type { CouncilKind } from "@/features/hq/core/council/machine";

const MAX_DT = 0.1;

/** The council cast: AM7 plus the 26 chiefs, in speaking (seat) order. */
function councilAgents(): HqAgentInput[] {
  const chiefs = COUNCIL_FLOORS.map<HqAgentInput>((floor) => ({
    id: `council-chief-${String(floor.floor).padStart(2, "0")}`,
    name: `${floor.name} · ${floor.callsign}`,
    role: "Шеф управления",
    status: "working",
  }));
  return [{ id: "am7", name: "AM7", role: "Верховная сущность", status: "working" }, ...chiefs];
}

const createRenderer: Extract<GLProps, (defaultProps: never) => unknown> = (defaults) =>
  new WebGLRenderer({ ...defaults, antialias: true, alpha: false, stencil: false, powerPreference: "high-performance" });

/** Dark premium cabinet: a polished floor, graphite walls, warm key + red rim. */
function Floor27Room() {
  const materials = useMemo(() => {
    const floor = new THREE.MeshStandardMaterial({ color: HQ_THEME.floor, roughness: 0.3, metalness: 0.2 });
    const wall = new THREE.MeshStandardMaterial({ color: HQ_THEME.wall, roughness: 0.8, metalness: 0.05 });
    const trim = new THREE.MeshBasicMaterial({ color: new THREE.Color(HQ_THEME.accent).multiplyScalar(2.2), toneMapped: false });
    return { floor, wall, trim };
  }, []);
  useEffect(() => () => Object.values(materials).forEach((m) => m.dispose()), [materials]);
  const W = COUNCIL_ROOM.width;
  const D = COUNCIL_ROOM.depth;
  const H = COUNCIL_ROOM.height;
  const back = COUNCIL_SCREEN_X - 1.2;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow material={materials.floor}>
        <planeGeometry args={[W, D]} />
      </mesh>
      {/* back wall behind the screen (−X), side walls, ceiling */}
      <mesh position={[back, H / 2, 0]} rotation={[0, Math.PI / 2, 0]} material={materials.wall}>
        <planeGeometry args={[D, H]} />
      </mesh>
      <mesh position={[W / 2 - 1, H / 2, 0]} rotation={[0, -Math.PI / 2, 0]} material={materials.wall}>
        <planeGeometry args={[D, H]} />
      </mesh>
      <mesh position={[0, H / 2, -D / 2]} material={materials.wall}>
        <planeGeometry args={[W, H]} />
      </mesh>
      <mesh position={[0, H / 2, D / 2]} rotation={[0, Math.PI, 0]} material={materials.wall}>
        <planeGeometry args={[W, H]} />
      </mesh>
      <mesh position={[0, H, 0]} rotation={[Math.PI / 2, 0, 0]} material={materials.wall}>
        <planeGeometry args={[W, D]} />
      </mesh>
      {/* a red light line along the floor at the foot of the side walls */}
      <mesh position={[0, 0.02, -D / 2 + 0.1]} material={materials.trim}>
        <boxGeometry args={[W, 0.03, 0.04]} />
      </mesh>
    </group>
  );
}

/**
 * Floor 27 lighting, brought to the main hall's bar (src/features/hq/render/scene/
 * HqLighting.tsx): a warm hemisphere, two even fills from both ends, one shadowed
 * key, red + warm accents, and — the piece the cabinet was missing — a baked
 * studio Environment so the dark techwear and piano-black furniture actually read
 * instead of going black. Even light, no glare, dark-premium with a red accent.
 */
function Floor27Lighting() {
  return (
    <>
      <ambientLight intensity={0.32} color="#ffe6cc" />
      <hemisphereLight args={["#e8e1d6", "#2a2521", 1.35]} />
      {/* Even fills from all four upper corners so the table, throne and seated
          chiefs read the same whatever way the orbit camera faces — no dark side. */}
      <directionalLight position={[12, 15, 14]} intensity={0.75} color="#fff0e0" />
      <directionalLight position={[-12, 13, -12]} intensity={0.62} color="#e8e3ec" />
      <directionalLight position={[-12, 13, 12]} intensity={0.5} color="#f3eee8" />
      <directionalLight position={[12, 13, -12]} intensity={0.5} color="#eceaf0" />
      {/* A broad, soft overhead fill centred on the table lifts everyone evenly. */}
      <pointLight position={[0, 4.6, 0]} intensity={26} distance={30} decay={2} color="#fff1df" />
      {/* Shadowed key from high east, shadows falling west toward the screen. */}
      <directionalLight
        position={[9, 16, 7]}
        intensity={2.0}
        color="#fff2e0"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0003}
        shadow-radius={3}
      >
        <orthographicCamera attach="shadow-camera" args={[-13, 13, 10, -10, 0.1, 44]} />
      </directionalLight>
      {/* Red wash off the screen wall behind AM7, and a warm key over the table. */}
      <pointLight position={[COUNCIL_SCREEN_X + 1.6, 3.4, 0]} intensity={14} distance={16} decay={2} color={HQ_THEME.accent} />
      <pointLight position={[3, 4.2, 4.8]} intensity={10} distance={16} decay={2} color={HQ_THEME.ledWarm} />
      {/*
        A dark studio for reflections instead of a daylight HDRI, mirroring the
        hall: warm ceiling strips, a cool fill and a red glow from the screen
        side. Baked once into a cube map; the polished stone, piano-black table
        and android skin pick it up — this is what makes the figures read.
      */}
      <Environment frames={1} resolution={256} environmentIntensity={1.25}>
        <Lightformer form="rect" intensity={4.2} color="#fff4e8" scale={[16, 1.1, 1]} position={[0, 4.6, 0]} rotation-x={Math.PI / 2} />
        <Lightformer form="rect" intensity={2.8} color={HQ_THEME.statusSelected} scale={[12, 0.8, 1]} position={[2, 4.6, 3]} rotation-x={Math.PI / 2} />
        <Lightformer form="rect" intensity={2.6} color="#eef1f6" scale={[12, 0.8, 1]} position={[-2, 4.6, -3]} rotation-x={Math.PI / 2} />
        <Lightformer form="rect" intensity={1.2} color={HQ_THEME.accent} scale={[8, 3, 1]} position={[COUNCIL_SCREEN_X, 2.6, 0]} rotation-y={Math.PI / 2} />
        <Lightformer form="rect" intensity={1.5} color="#c8d2e6" scale={[10, 4, 1]} position={[11, 3, 6]} rotation-y={-Math.PI / 2} />
      </Environment>
    </>
  );
}

/** Loads council.glb, builds the furniture, and hands the paint handle up. */
function CouncilFurnitureAsset({ onReady }: { onReady: (f: CouncilFurniture | null) => void }) {
  const gltf = useGLTF(HQ_COUNCIL_URL, false, false);
  const built = useMemo(() => buildCouncilFurniture(gltf.scene), [gltf.scene]);
  useEffect(() => {
    onReady(built);
    return () => {
      onReady(null);
      built.dispose();
    };
  }, [built, onReady]);
  return <primitive object={built.group} />;
}

/** The androids, driven by the council sim through the shared crowd runtime. */
function Floor27Crowd({
  sim,
  agents,
  characterUrl,
}: {
  sim: CouncilSimulation;
  agents: HqAgentInput[];
  characterUrl: string;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const runtimeRef = useRef<HqCrowdRuntime | null>(null);
  const characterRef = useRef<HqCharacterSource | null>(null);

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const runtime = new HqCrowdRuntime();
    runtime.setQuality("high");
    group.add(runtime.root);
    runtimeRef.current = runtime;
    return () => {
      group.remove(runtime.root);
      runtime.dispose();
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
  }, []);

  useFrame((state, delta) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const character = characterRef.current;
    if (!runtime.hasCharacter(character)) runtime.setCharacter(character, state.gl, state.camera, state.scene);
    runtime.update(
      state.gl,
      sim,
      agents,
      null,
      null,
      state.camera,
      state.size.height,
      Math.min(Math.max(delta, 0), MAX_DT),
    );
  });

  return (
    <group ref={groupRef} name="council-crowd">
      <SceneAssetBoundary name="council-character" fallback={null}>
        <Suspense fallback={null}>
          <CharacterAsset url={characterUrl} onChange={(s) => (characterRef.current = s)} />
        </Suspense>
      </SceneAssetBoundary>
    </group>
  );
}

function CharacterAsset({ url, onChange }: { url: string; onChange: (s: HqCharacterSource | null) => void }) {
  const gltf = useGLTF(url, false, false);
  useEffect(() => {
    onChange(gltf);
    return () => onChange(null);
  }, [gltf, onChange]);
  return null;
}

/** Steps the sim each frame (allocation-free) and repaints the screen on change. */
function CouncilDriver({ sim }: { sim: CouncilSimulation }) {
  useFrame((_, delta) => sim.update(Math.min(Math.max(delta, 0), MAX_DT)));
  return null;
}

export type Floor27OfficeProps = {
  /** Go back down to Floor 24 (the hall). */
  onLeave?: () => void;
  /** Sound / voice replies are on (lines are fetched + played; else silent walk). */
  audible?: boolean;
};

/**
 * Floor 27 — AM7's premium council cabinet. Its own scene (so it slots into the
 * tower later), reusing the HQ crowd runtime, materials and palette. A dev hook
 * window.__hqCouncil('daily'|'evening'|'emergency'|'oneonone') runs a council.
 */
export function Floor27Office({ onLeave, audible = true }: Floor27OfficeProps) {
  const agents = useMemo(() => councilAgents(), []);
  const sim = useMemo(() => new CouncilSimulation(agents.slice(1).map((a) => a.id)), [agents]);
  const furnitureRef = useRef<CouncilFurniture | null>(null);
  const controlsRef = useRef<ComponentRef<typeof OrbitControls> | null>(null);
  const audibleRef = useRef(audible);
  useEffect(() => {
    audibleRef.current = audible;
  }, [audible]);
  const getAudible = useCallback(() => audibleRef.current, []);
  const [status, setStatus] = useState<{ phase: string; speaker: number }>({ phase: "idle", speaker: -1 });

  const paint = useCallback((view: CouncilScreenPaint) => {
    const furniture = furnitureRef.current;
    if (!furniture) return;
    const ctx = furniture.screenCanvas.getContext("2d");
    if (!ctx) return;
    if (view.kind === "floor") paintCouncilScreen(ctx, view.screen);
    else paintCouncilHeader(ctx, view.header);
    furniture.screenTexture.needsUpdate = true;
  }, []);

  // The controller is built in an effect (not during render) so it never reads
  // refs while rendering; the dev hook is wired to it the same way.
  useEffect(() => {
    const controller = new CouncilController({
      sim,
      paint,
      audible: getAudible,
      onStateChange: (phase, speaker) => setStatus({ phase, speaker }),
    });
    const w = window as unknown as {
      __hqCouncil?: (kind?: CouncilKind, floor?: number) => void;
      __hqCouncilCancel?: () => void;
      __hqCouncilTimeline?: () => readonly unknown[];
      __hqSpeechLog?: () => readonly unknown[];
      __hqSpeechLogClear?: () => void;
      __hqTestGreeting?: (text?: string) => void;
    };
    if (process.env.NODE_ENV !== "production") {
      // Dev hook: window.__hqCouncil('daily'); the schedule is exposed but never auto-fires.
      w.__hqCouncil = (kind: CouncilKind = "daily", floor?: number) => {
        void controller.run(kind, floor != null ? { oneononeFloor: floor } : {});
      };
      w.__hqCouncilCancel = () => controller.cancel();
      // Dev check: the real playback window of every council line this run, to
      // confirm one voice at a time (no two intervals overlap).
      w.__hqCouncilTimeline = () => controller.timeline;
      // Dev check across ALL foreground speech (greeting + briefing + council):
      // the single lock's grant→release windows, which cannot overlap.
      w.__hqSpeechLog = () => foregroundSpeechLog();
      w.__hqSpeechLogClear = () => clearForegroundSpeechLog();
      // Dev check: fire the ambient «Система штаба» greeting on demand, to prove
      // it never plays over a council/briefing (it is refused during a session).
      w.__hqTestGreeting = (text = "Система штаба на связи. Проверка очереди голосов.") =>
        void speakSystem(text);
      // Dev aid: pose the orbit camera for a clean screenshot (azimuth/polar in
      // radians, distance in metres); autoRotate: false to hold the frame.
      (w as Record<string, unknown>).__hqCam = (opts: {
        azimuth?: number;
        polar?: number;
        distance?: number;
        autoRotate?: boolean;
        target?: [number, number, number];
      } = {}) => {
        const c = controlsRef.current as unknown as {
          autoRotate: boolean;
          target: THREE.Vector3;
          object: THREE.Camera;
          setAzimuthalAngle: (a: number) => void;
          setPolarAngle: (a: number) => void;
          update: () => void;
        } | null;
        if (!c) return;
        if (opts.autoRotate !== undefined) c.autoRotate = opts.autoRotate;
        if (opts.target) c.target.set(opts.target[0], opts.target[1], opts.target[2]);
        if (opts.azimuth !== undefined) c.setAzimuthalAngle(opts.azimuth);
        if (opts.polar !== undefined) c.setPolarAngle(opts.polar);
        if (opts.distance !== undefined) {
          const dir = c.object.position.clone().sub(c.target).normalize();
          c.object.position.copy(dir.multiplyScalar(opts.distance).add(c.target));
        }
        c.update();
      };
    }
    return () => {
      controller.cancel();
      delete w.__hqCouncil;
      delete w.__hqCouncilCancel;
      delete w.__hqCouncilTimeline;
      delete w.__hqSpeechLog;
      delete w.__hqSpeechLogClear;
      delete w.__hqTestGreeting;
      delete (w as Record<string, unknown>).__hqCam;
    };
  }, [sim, paint, getAudible]);

  const onFurniture = useCallback(
    (f: CouncilFurniture | null) => {
      furnitureRef.current = f;
      if (f) paint({ kind: "header", header: { kind: "daily", gathered: 0, expected: 26, speaking: -1 } });
    },
    [paint],
  );

  return (
    <div className="relative h-full w-full overflow-hidden" style={{ backgroundColor: HQ_THEME.background }}>
      <Canvas
        shadows={{ type: PCFShadowMap }}
        gl={createRenderer}
        camera={{ fov: 42, near: 0.1, far: 200, position: [10, 6.5, 11] }}
        style={{ position: "absolute", inset: 0 }}
      >
        <color attach="background" args={[HQ_THEME.background]} />
        <fog attach="fog" args={[HQ_THEME.fog, 22, 55]} />
        <Floor27Lighting />
        <Floor27Room />
        <SceneAssetBoundary name="council-furniture" fallback={null}>
          <Suspense fallback={null}>
            <CouncilFurnitureAsset onReady={onFurniture} />
          </Suspense>
        </SceneAssetBoundary>
        <Floor27Crowd sim={sim} agents={agents} characterUrl={HQ_CHARACTER_URL} />
        <CouncilDriver sim={sim} />
        <OrbitControls
          ref={controlsRef}
          target={[-1.5, 1.3, 0]}
          enablePan={false}
          minDistance={8}
          maxDistance={26}
          maxPolarAngle={Math.PI / 2.1}
          autoRotate
          autoRotateSpeed={0.3}
        />
      </Canvas>
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-4">
        <div className="pointer-events-auto flex items-center gap-2">
          {onLeave ? (
            <button
              type="button"
              onClick={onLeave}
              className="rounded-md border border-white/15 bg-black/50 px-3 py-1.5 font-mono text-[12px] text-white/80 backdrop-blur hover:bg-black/70"
            >
              ↓ Этаж 24 · Зал
            </button>
          ) : null}
          <span className="rounded-md border border-red-500/30 bg-black/50 px-3 py-1.5 font-mono text-[12px] text-red-300/90 backdrop-blur">
            Этаж 27 · Кабинет AM7
          </span>
        </div>
        {status.phase !== "idle" ? (
          <span className="pointer-events-none rounded-md border border-white/10 bg-black/50 px-3 py-1.5 font-mono text-[11px] text-white/60 backdrop-blur">
            Совет: {status.phase}
            {status.speaker >= 0 ? ` · шеф ${status.speaker + 1}/26` : ""}
          </span>
        ) : null}
      </div>
    </div>
  );
}

useGLTF.preload(HQ_COUNCIL_URL);
