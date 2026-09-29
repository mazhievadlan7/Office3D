import * as THREE from "three";
import { HQ_THEME } from "@/features/hq/core/config";
import type { HqLayout } from "@/features/hq/core/types";
import { GLSL_HQ_NOISE, GLSL_HQ_WORLD_VARYING, GLSL_HQ_WORLD_VERTEX, patchMaterial } from "./glsl";
import { GLOW, WALL_LINE, themeColor } from "./palette";

// Materials shared by the room shell and the partitions. Each is created once
// per HqEnvironment mount; layout-dependent values live in uniforms, so a new
// layout never compiles a new program.

export type EnvMaterials = {
  wall: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  line: THREE.MeshBasicMaterial;
  /** The low curbs sit closest to the camera; a softer line keeps them from framing the shot. */
  lineCurb: THREE.MeshBasicMaterial;
  lineFaint: THREE.MeshBasicMaterial;
  wallUniforms: {
    uHqWallTop: THREE.IUniform<number>;
    /** The north wall's top line: it is taller than the others (it carries the video wall). */
    uHqNorthTop: THREE.IUniform<number>;
    uHqOrigin: THREE.IUniform<THREE.Vector2>;
  };
};

/** Panel width of the wall cladding (metres). */
const WALL_PANEL = 1.5;
/**
 * The warm white light lines run well under the glow levels (palette GLOW,
 * made for red): soft cove light rather than neon.
 */
const TRIM_GAIN = 0.32;

const WALL_FRAGMENT_PARS = /* glsl */ `
${GLSL_HQ_NOISE}
${GLSL_HQ_WORLD_VARYING}
uniform float uHqWallTop;
uniform float uHqNorthTop;
uniform vec2 uHqOrigin;
uniform vec3 uHqAccent;
`;

// Vertical seams between cladding panels. "Along" is x + z measured from the
// room origin, which runs continuously round the north-west corner and along
// any axis-aligned partition.
const WALL_SURFACE = /* glsl */ `
float hqAlong = (vHqWorld.x - uHqOrigin.x) + (vHqWorld.z - uHqOrigin.y);
float hqAA = max(fwidth(hqAlong), 1e-4);
float hqU = hqAlong / ${WALL_PANEL.toFixed(2)};
float hqSeamD = abs(fract(hqU + 0.5) - 0.5) * ${WALL_PANEL.toFixed(2)};
float hqSeam = 1.0 - smoothstep(0.005 - hqAA * 0.5, 0.005 + hqAA * 0.5, hqSeamD);
// Each wall's own top line: the north wall (its face at the room's origin z, or behind it) is taller.
float hqTop = vHqWorld.z < uHqOrigin.y + 0.005 ? uHqNorthTop : uHqWallTop;
// Horizontal reveal a third of the way up the tall walls.
float hqRevealD = abs(vHqWorld.y - hqTop * 0.34);
float hqReveal = (1.0 - smoothstep(0.004, 0.004 + fwidth(vHqWorld.y) + 1e-4, hqRevealD)) * step(2.0, hqTop);
float hqPanel = hqHash12(vec2(floor(hqU), 7.0));
float hqGrain = hqNoise(vec2(hqAlong * 3.0, vHqWorld.y * 0.6));
diffuseColor.rgb *= (0.88 + 0.22 * hqPanel) * (0.94 + 0.12 * hqGrain);
// Slightly lighter toward the floor, as if the glossy floor bounced light up.
diffuseColor.rgb *= mix(1.15, 0.85, clamp(vHqWorld.y / max(hqTop, 1.0), 0.0, 1.0));
diffuseColor.rgb *= 1.0 - 0.8 * max(hqSeam, hqReveal * 0.7);
`;

const WALL_ROUGHNESS = /* glsl */ `
roughnessFactor = mix(roughnessFactor + (hqPanel - 0.5) * 0.12, 0.95, max(hqSeam, hqReveal));
`;

// The emissive lines wash a little red onto the wall around them.
const WALL_EMISSIVE = /* glsl */ `
{
  float hqTopWash = exp(-abs(vHqWorld.y - hqTop) * 7.0) * step(vHqWorld.y, hqTop + 0.1);
  float hqSkirtWash = exp(-abs(vHqWorld.y - ${WALL_LINE.skirt.toFixed(3)}) * 10.0);
  totalEmissiveRadiance += uHqAccent * (hqTopWash * 0.09 + hqSkirtWash * 0.07) * (1.0 - hqSeam);
}
`;

// Smoked glass shows almost no diffuse light of its own, only reflections.
const GLASS_TINT = /* glsl */ `
diffuseColor.rgb *= 0.3;
`;

// Glass grows more reflective (less see-through) at grazing angles.
const GLASS_FRESNEL = /* glsl */ `
{
  float hqNdV = clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0);
  diffuseColor.a = mix(diffuseColor.a, 0.42, pow(1.0 - hqNdV, 4.0));
}
`;

export function createEnvMaterials(): EnvMaterials {
  const wallUniforms = {
    uHqWallTop: { value: 5 },
    uHqNorthTop: { value: 5 },
    uHqOrigin: { value: new THREE.Vector2() },
  };
  const wall = new THREE.MeshStandardMaterial({
    color: HQ_THEME.wallPanel,
    roughness: 0.62,
    metalness: 0.15,
    envMapIntensity: 0.5,
  });
  wall.name = "hq-wall";
  patchMaterial(wall, {
    key: "hq-wall-v2",
    uniforms: { ...wallUniforms, uHqAccent: { value: themeColor(HQ_THEME.trim, TRIM_GAIN) } },
    vertexPars: GLSL_HQ_WORLD_VARYING,
    fragmentPars: WALL_FRAGMENT_PARS,
    vertex: [["project_vertex", GLSL_HQ_WORLD_VERTEX]],
    fragment: [
      ["color_fragment", WALL_SURFACE],
      ["roughnessmap_fragment", WALL_ROUGHNESS],
      ["emissivemap_fragment", WALL_EMISSIVE],
    ],
  });

  // Satin, not mirror: a glossy trim or pane mirrors the high key light into a
  // white hotspot that the bloom blows up and that slides with the camera.
  const metal = new THREE.MeshStandardMaterial({
    color: HQ_THEME.metal,
    roughness: 0.58,
    metalness: 0.6,
    envMapIntensity: 0.45,
  });
  metal.name = "hq-metal";

  const glass = new THREE.MeshStandardMaterial({
    color: HQ_THEME.glass,
    roughness: 0.42,
    metalness: 0.05,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    envMapIntensity: 0.5,
  });
  glass.name = "hq-glass";
  patchMaterial(glass, {
    key: "hq-glass-v1",
    fragment: [
      ["color_fragment", GLASS_TINT],
      ["lights_fragment_end", GLASS_FRESNEL],
    ],
  });

  const line = new THREE.MeshBasicMaterial({ color: themeColor(HQ_THEME.trim, GLOW.line * TRIM_GAIN), toneMapped: false });
  line.name = "hq-line";
  const lineCurb = new THREE.MeshBasicMaterial({
    color: themeColor(HQ_THEME.trim, GLOW.curb * TRIM_GAIN),
    toneMapped: false,
  });
  lineCurb.name = "hq-line-curb";
  const lineFaint = new THREE.MeshBasicMaterial({
    color: themeColor(HQ_THEME.trim, GLOW.faint * TRIM_GAIN),
    toneMapped: false,
  });
  lineFaint.name = "hq-line-faint";

  return { wall, metal, glass, line, lineCurb, lineFaint, wallUniforms };
}

export function applyLayoutToEnvMaterials(materials: EnvMaterials, layout: HqLayout): void {
  materials.wallUniforms.uHqWallTop.value = layout.wallHeight - WALL_LINE.belowTop;
  materials.wallUniforms.uHqNorthTop.value = layout.northWallHeight - WALL_LINE.belowTop;
  materials.wallUniforms.uHqOrigin.value.set(layout.bounds.x0, layout.bounds.z0);
}

export function disposeEnvMaterials(materials: EnvMaterials): void {
  materials.wall.dispose();
  materials.metal.dispose();
  materials.glass.dispose();
  materials.line.dispose();
  materials.lineCurb.dispose();
  materials.lineFaint.dispose();
}
