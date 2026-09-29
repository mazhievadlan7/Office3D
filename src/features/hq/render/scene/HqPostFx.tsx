"use client";

import { useMemo } from "react";
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
import { BlendFunction, SMAAPreset, ToneMappingMode } from "postprocessing";

import type { HqQuality } from "./quality";

/** A light vignette and fine grain: the room stays readable to the edges. */
const VIGNETTE_DARKNESS = 0.5;
const GRAIN = 0.1;

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
export function HqPostFx({ quality }: { quality: HqQuality }) {
  const aberration = useMemo(() => new Vector2(0.00045, 0.0003), []);
  return (
    <EffectComposer multisampling={0} enableNormalPass={false}>
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
