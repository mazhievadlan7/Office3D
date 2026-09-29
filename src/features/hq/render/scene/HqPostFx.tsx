"use client";

import { useMemo, useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { Vector2 } from "three";
import {
  Bloom,
  ChromaticAberration,
  EffectComposer,
  N8AO,
  Noise,
  SMAA,
  ToneMapping,
  Vignette,
} from "@react-three/postprocessing";
import { BlendFunction, SMAAPreset, ToneMappingMode, type EffectComposer as EffectComposerImpl } from "postprocessing";

import type { HqQuality } from "./quality";
import { compilePassesAhead, programsReady, type HqPrewarmGate } from "./shaderPrewarm";

/** A light vignette and fine grain: the room stays readable to the edges. */
const VIGNETTE_DARKNESS = 0.5;
const GRAIN = 0.1;
/** Between the scene gate (0.5) and the composer's own draw (1). */
const LOAD_PRIORITY = 0.9;
/**
 * The first frame is shown after this long even if shaders are still
 * building: both this many milliseconds and this many frames (a background
 * tab runs a frame a second or none).
 */
const MAX_LOAD_HOLD_MS = 5000;
const MAX_LOAD_HOLD_FRAMES = 300;

/**
 * At load, the post chain's own shaders (ambient occlusion, bloom, SMAA, the
 * merged effect pass) compiled in its first draw, ~60 ms on ANGLE/D3D, and
 * the room's first draw followed. Instead the chain's programs are compiled
 * ahead in parallel and the composer draws nothing until they are built and
 * the room has come through the gate (see HqPrewarmGate): the first frame
 * shown is a complete one. Only the first frames are held; afterwards the
 * composer is never touched.
 */
function useLoadHold(composerRef: RefObject<EffectComposerImpl | null>, gate: HqPrewarmGate) {
  const loadRef = useRef({
    composer: null as EffectComposerImpl | null,
    compiled: false,
    open: false,
    since: 0,
    frames: 0,
  });
  useFrame(({ gl, camera }) => {
    const load = loadRef.current;
    if (load.open) return;
    const composer = composerRef.current;
    if (!composer) return;
    if (load.since === 0) load.since = performance.now();
    load.frames += 1;
    if (load.composer !== composer) {
      load.composer = composer;
      load.compiled = false;
      const render = composer.render.bind(composer);
      composer.render = (deltaTime?: number) => {
        if (load.open) render(deltaTime);
      };
    }
    // The render pass plus at least one effect pass: the chain is assembled.
    if (!load.compiled && composer.passes.length > 1) {
      compilePassesAhead(gl, composer.passes, camera);
      load.compiled = true;
      return;
    }
    const ready = load.compiled && gate.released > 0 && !gate.holding && programsReady(gl);
    const expired = load.frames > MAX_LOAD_HOLD_FRAMES && performance.now() - load.since > MAX_LOAD_HOLD_MS;
    if (ready || expired) load.open = true;
  }, LOAD_PRIORITY);
}

/**
 * The post chain. The renderer itself draws linear HDR (the Canvas is `flat`),
 * so bloom sees real emissive values above 1 and AgX does the tone mapping
 * once, here. Antialiasing is SMAA on the tone-mapped image; MSAA stays off
 * because it multiplies the cost of every full-screen pass.
 *
 * The chain keeps the same shape on every level where it can (N8AO is turned
 * off rather than removed, grain fades to zero) so a quality step does not
 * recompile the merged effect shaders; only the high-only chromatic
 * aberration adds a pass.
 */
export function HqPostFx({ quality, gate }: { quality: HqQuality; gate: HqPrewarmGate }) {
  const aberration = useMemo(() => new Vector2(0.00045, 0.0003), []);
  const composerRef = useRef<EffectComposerImpl | null>(null);
  useLoadHold(composerRef, gate);
  return (
    <EffectComposer ref={composerRef} multisampling={0} enableNormalPass={false}>
      <N8AO
        enabled={quality !== "low"}
        quality={quality === "high" ? "high" : "medium"}
        halfRes={quality !== "high"}
        aoRadius={1.4}
        distanceFalloff={0.6}
        intensity={2.2}
      />
      <Bloom
        mipmapBlur
        luminanceThreshold={1}
        luminanceSmoothing={0.25}
        intensity={1}
        radius={0.5}
        levels={5}
      />
      <ToneMapping mode={ToneMappingMode.AGX} />
      <SMAA preset={SMAAPreset.HIGH} />
      {quality === "high" ? (
        <ChromaticAberration offset={aberration} radialModulation modulationOffset={0.35} />
      ) : null}
      <Vignette offset={0.28} darkness={VIGNETTE_DARKNESS} eskil={false} />
      <Noise blendFunction={BlendFunction.SOFT_LIGHT} opacity={quality === "low" ? 0 : GRAIN} />
    </EffectComposer>
  );
}
