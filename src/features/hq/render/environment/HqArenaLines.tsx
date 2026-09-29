"use client";

import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { HQ_THEME } from "@/features/hq/core/config";
import type { HqLayout } from "@/features/hq/core/types";
import { ARENA_LINE_WIDTH, buildArenaLines, type ArenaKeepOut } from "./arenaLines";
import { noRaycast } from "./glsl";
import { DECK_LIP } from "./HqCommandDeck";
import { themeColor } from "./palette";

/**
 * The amphitheatre's floor markings (arenaLines.ts): one merged mesh, one
 * draw call. Dim and unlit, well under the bloom threshold, so they read as
 * crisp hairlines rather than a glow; lifted a few millimetres and pulled
 * forward with polygonOffset so they never fight the floor.
 *
 * A 2.5 cm line is thinner than a pixel from the far end of the hall and would
 * break into dashes, so the shader keeps every line at least MIN_PIXELS wide
 * on screen and dims it by the same factor: the line keeps its brightness
 * overall and reads as one faint, unbroken thread.
 */

/** Line brightness (linear): a faint thread on the stone, well below bloom. */
const ARENA_LINE_GLOW = 0.14;
/** Narrowest a line may get on screen (pixels). */
const MIN_PIXELS = 1.4;
/** Floor kept clear round the tribune's hatch and AM7's island. */
const TRIBUNE_CLEAR = 1.4;
const DECK_CLEAR = 0.4;

type LineUniforms = {
  uColor: THREE.IUniform<THREE.Color>;
  /** Drawing buffer size in pixels. */
  uViewport: THREE.IUniform<THREE.Vector2>;
};

const VERTEX = /* glsl */ `
attribute vec2 aCross;
uniform vec2 uViewport;
varying float vCoverage;
void main() {
  vec3 across = vec3(aCross.x, 0.0, aCross.y);
  vec4 centre = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vec4 probe = projectionMatrix * modelViewMatrix * vec4(position + across * 0.01, 1.0);
  // Pixels per metre across the line here, foreshortening included.
  float perMetre = length((probe.xy / probe.w - centre.xy / centre.w) * 0.5 * uViewport) * 100.0;
  float halfWidth = ${(ARENA_LINE_WIDTH / 2).toFixed(4)};
  float widened = max(halfWidth, ${(MIN_PIXELS / 2).toFixed(2)} / max(perMetre, 1e-3));
  vCoverage = halfWidth / widened;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position + across * widened, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColor;
varying float vCoverage;
void main() {
  gl_FragColor = vec4(uColor * vCoverage, 1.0);
  #include <colorspace_fragment>
}
`;

function createLineMaterial(): { material: THREE.ShaderMaterial; uniforms: LineUniforms } {
  const uniforms: LineUniforms = {
    uColor: { value: themeColor(HQ_THEME.accent, ARENA_LINE_GLOW) },
    uViewport: { value: new THREE.Vector2(1920, 1080) },
  };
  const material = new THREE.ShaderMaterial({
    name: "hq-arena-lines",
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    toneMapped: false,
  });
  return { material, uniforms };
}

function setLineViewport(uniforms: LineUniforms, width: number, height: number): void {
  uniforms.uViewport.value.set(Math.max(1, width), Math.max(1, height));
}

export function HqArenaLines({ layout }: { layout: HqLayout }) {
  const { arena, deck, tribune } = layout;
  const geometry = useMemo(() => {
    const keepOuts: ArenaKeepOut[] = [
      { x: tribune.x, z: tribune.z, radius: TRIBUNE_CLEAR },
      { x: deck.x, z: deck.z, radius: deck.radius + DECK_LIP + DECK_CLEAR },
    ];
    return buildArenaLines(arena, keepOuts);
  }, [arena, deck, tribune]);
  useEffect(() => () => geometry?.dispose(), [geometry]);

  const shading = useMemo(() => createLineMaterial(), []);
  useEffect(() => () => shading.material.dispose(), [shading]);
  const width = useThree((state) => state.size.width * state.viewport.dpr);
  const height = useThree((state) => state.size.height * state.viewport.dpr);
  useEffect(() => setLineViewport(shading.uniforms, width, height), [shading, width, height]);

  if (!geometry) return null;
  return <mesh name="hq-arena-lines" geometry={geometry} material={shading.material} raycast={noRaycast} />;
}
