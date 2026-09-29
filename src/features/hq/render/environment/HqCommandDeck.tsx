"use client";

import { useEffect, useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { HQ_THEME } from "@/features/hq/core/config";
import type { HqDeck } from "@/features/hq/core/types";
import { GLSL_HQ_WORLD_VARYING, GLSL_HQ_WORLD_VERTEX, noRaycast, patchMaterial } from "./glsl";
import { themeColor } from "./palette";

/**
 * The dais under AM7's island (HqLayout.deck): a thin disc, matte black with
 * fine concentric engraved lines, a thin red line round its rim just outside
 * the glass balustrade (which comes with the partitions, on deck.radius) and a
 * fainter ring round AM7's desk. So low that walkers never sink into it.
 */

/** Height of the dais: agents stand on the floor plane, so it stays within a sole's thickness. */
export const DECK_HEIGHT = 0.015;
/** The dais runs this far past the balustrade, so the glass stands on it and its rim line shows. */
export const DECK_LIP = 0.12;
/** Chamfer on the top edge (metres, both ways). */
const CHAMFER = 0.006;
const SEGMENTS = 192;

/** The red rim line: this far outside the balustrade's radius, this wide. */
const RIM_LINE = { out: 0.065, width: 0.012, glow: 1.6 } as const;
/** A fainter ring round AM7's desk (the command-arc desk reaches ~1.95 m from the chair). */
const INNER_RING = { radius: 2.3, width: 0.008, glow: 0.5 } as const;
/** Engraved rings: their pitch, the band they cover (in from the centre, out to short of the glass). */
const ENGRAVING = { pitch: 0.12, from: 0.35, toInside: 0.2, halfWidth: 0.0012 } as const;

/** A flat disc with a chamfered edge and a short side band, centred on the origin, base on y = 0. */
export function buildDeckGeometry(radius: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const ring = (r: number, y: number, ny: number, nr: number) => {
    const start = positions.length / 3;
    for (let i = 0; i < SEGMENTS; i++) {
      const a = (i / SEGMENTS) * Math.PI * 2;
      const s = Math.sin(a);
      const c = Math.cos(a);
      positions.push(r * s, y, r * c);
      normals.push(nr * s, ny, nr * c);
    }
    return start;
  };
  /** Quads between two rings; faces point out/up when `inner` lies above or inside `outer`. */
  const band = (inner: number, outer: number) => {
    for (let i = 0; i < SEGMENTS; i++) {
      const j = (i + 1) % SEGMENTS;
      indices.push(inner + i, outer + i, inner + j, inner + j, outer + i, outer + j);
    }
  };
  const top = DECK_HEIGHT;
  // Top: a fan from the centre.
  const centre = positions.length / 3;
  positions.push(0, top, 0);
  normals.push(0, 1, 0);
  const topRim = ring(radius - CHAMFER, top, 1, 0);
  for (let i = 0; i < SEGMENTS; i++) indices.push(centre, topRim + i, topRim + ((i + 1) % SEGMENTS));
  // Chamfer and side, each with its own normals so the edges stay crisp.
  const k = Math.SQRT1_2;
  band(ring(radius - CHAMFER, top, k, k), ring(radius, top - CHAMFER, k, k));
  band(ring(radius, top - CHAMFER, 0, 1), ring(radius, 0, 0, 1));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

type DeckUniforms = {
  /** Deck centre (x, z), the balustrade's radius, the dais's own radius. */
  uHqDeck: THREE.IUniform<THREE.Vector4>;
  uHqAccent: THREE.IUniform<THREE.Color>;
};

const FRAGMENT_PARS = /* glsl */ `
${GLSL_HQ_WORLD_VARYING}
uniform vec4 uHqDeck;
uniform vec3 uHqAccent;
float hqDeckLine(float d, float halfWidth, float aa) {
  return 1.0 - smoothstep(halfWidth - aa * 0.5, halfWidth + aa * 0.5, d);
}
`;

// After <color_fragment>: engraved rings darken the albedo on the top face;
// the red lines are kept for the emissive stage below (same scope in main()).
const FRAGMENT_SURFACE = /* glsl */ `
float hqR = distance(vHqWorld.xz, uHqDeck.xy);
float hqAA = max(fwidth(hqR), 1e-4);
float hqTop = step(${(DECK_HEIGHT - 0.002).toFixed(4)}, vHqWorld.y);
// Beyond a few millimetres per pixel the engraving would only shimmer.
float hqDetail = 1.0 - smoothstep(0.004, 0.02, hqAA);
float hqGrooveD = abs(fract(hqR / ${ENGRAVING.pitch.toFixed(3)} + 0.5) - 0.5) * ${ENGRAVING.pitch.toFixed(3)};
float hqGroove = hqDeckLine(hqGrooveD, ${ENGRAVING.halfWidth.toFixed(4)}, hqAA)
  * step(${ENGRAVING.from.toFixed(2)}, hqR) * step(hqR, uHqDeck.z - ${ENGRAVING.toInside.toFixed(2)}) * hqDetail * hqTop;
diffuseColor.rgb *= 1.0 - 0.7 * hqGroove;
float hqRim = hqDeckLine(abs(hqR - uHqDeck.z - ${RIM_LINE.out.toFixed(3)}), ${(RIM_LINE.width / 2).toFixed(4)}, hqAA) * hqTop;
float hqInner = hqDeckLine(abs(hqR - ${INNER_RING.radius.toFixed(2)}), ${(INNER_RING.width / 2).toFixed(4)}, hqAA) * hqTop;
`;

const FRAGMENT_ROUGHNESS = /* glsl */ `
roughnessFactor = mix(roughnessFactor, 1.0, hqGroove);
`;

// Matte: only a trace of specular, so the key light never greys the black out.
const FRAGMENT_SPECULAR = /* glsl */ `
reflectedLight.directSpecular *= 0.1;
reflectedLight.indirectSpecular *= 0.1;
`;

const FRAGMENT_EMISSIVE = /* glsl */ `
totalEmissiveRadiance += uHqAccent * (hqRim * ${RIM_LINE.glow.toFixed(2)} + hqInner * ${INNER_RING.glow.toFixed(2)});
`;

export function createDeckMaterial(): { material: THREE.MeshStandardMaterial; uniforms: DeckUniforms } {
  const uniforms: DeckUniforms = {
    uHqDeck: { value: new THREE.Vector4(0, 0, 1, 1) },
    uHqAccent: { value: themeColor(HQ_THEME.accent) },
  };
  // Black matte, a step above the floor's near-zero black: the dais reads as
  // a slab and its engraving shows, without turning grey under the key light.
  const material = new THREE.MeshStandardMaterial({
    color: HQ_THEME.wallPanel,
    roughness: 0.88,
    metalness: 0,
    envMapIntensity: 0.15,
  });
  material.name = "hq-command-deck";
  patchMaterial(material, {
    key: "hq-command-deck-v2",
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexPars: GLSL_HQ_WORLD_VARYING,
    fragmentPars: FRAGMENT_PARS,
    vertex: [["project_vertex", GLSL_HQ_WORLD_VERTEX]],
    fragment: [
      ["color_fragment", FRAGMENT_SURFACE],
      ["roughnessmap_fragment", FRAGMENT_ROUGHNESS],
      ["emissivemap_fragment", FRAGMENT_EMISSIVE],
      ["lights_fragment_end", FRAGMENT_SPECULAR],
    ],
  });
  return { material, uniforms };
}

export function HqCommandDeck({ deck }: { deck: HqDeck }) {
  const outer = deck.radius + DECK_LIP;
  const geometry = useMemo(() => buildDeckGeometry(outer), [outer]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const shading = useMemo(() => createDeckMaterial(), []);
  useEffect(() => () => shading.material.dispose(), [shading]);
  useLayoutEffect(() => {
    shading.uniforms.uHqDeck.value.set(deck.x, deck.z, deck.radius, outer);
  }, [deck.x, deck.z, deck.radius, outer, shading]);
  if (!(deck.radius > 0)) return null;
  return (
    <mesh
      name="hq-command-deck"
      geometry={geometry}
      material={shading.material}
      position={[deck.x, 0, deck.z]}
      receiveShadow
      raycast={noRaycast}
    />
  );
}
