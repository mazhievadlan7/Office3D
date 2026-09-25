import { Color, MeshStandardMaterial, type IUniform, type Material, type Texture } from "three";
import { HQ_THEME } from "@/features/hq/core/config";
import { PARAMS_WIDTH } from "./crowdPalette";

/**
 * Materials for the character.
 *
 * The instanced crowd reuses the GLB's own PBR material but swaps three.js
 * skinning for the per-frame bone palette (crowdPalette.ts): instance k reads
 * its bone matrices from row k, and its lead flag from the params texture.
 *
 * The lead agent (AM7) wears his own mesh (a black suit with thin red
 * accents) on a hero rig of his own, with a brighter emissive so the accents
 * read. A character file without that mesh falls back to the body with a
 * brighter emissive and a thin red fresnel trim, driven by the per-instance
 * flag in the crowd and by a separate material on the hero rig.
 */

// Linear-space trim colour; >1 so bloom picks it up.
const TRIM_COLOR = new Color(HQ_THEME.accent).multiplyScalar(3.2);

const CROWD_VERTEX_PARS = /* glsl */ `
uniform highp sampler2D hqPalette;
uniform highp sampler2D hqParams;
attribute vec4 skinIndex;
attribute vec4 skinWeight;
varying float vHqLead;

// Final skinning matrix of one bone for this instance (see crowdPalette.ts).
mat4 hqBone( const in float bone ) {
  int x = int( bone + 0.5 ) * 4;
  return mat4(
    texelFetch( hqPalette, ivec2( x, gl_InstanceID ), 0 ),
    texelFetch( hqPalette, ivec2( x + 1, gl_InstanceID ), 0 ),
    texelFetch( hqPalette, ivec2( x + 2, gl_InstanceID ), 0 ),
    texelFetch( hqPalette, ivec2( x + 3, gl_InstanceID ), 0 ) );
}
`;

const CROWD_SKINBASE = /* glsl */ `
  mat4 hqSkin = mat4( 0.0 );
  if ( skinWeight.x > 0.0 ) hqSkin += skinWeight.x * hqBone( skinIndex.x );
  if ( skinWeight.y > 0.0 ) hqSkin += skinWeight.y * hqBone( skinIndex.y );
  if ( skinWeight.z > 0.0 ) hqSkin += skinWeight.z * hqBone( skinIndex.z );
  if ( skinWeight.w > 0.0 ) hqSkin += skinWeight.w * hqBone( skinIndex.w );
  vHqLead = texelFetch( hqParams, ivec2( gl_InstanceID % ${PARAMS_WIDTH}, gl_InstanceID / ${PARAMS_WIDTH} ), 0 ).w;
`;

const CROWD_SKINNORMAL = /* glsl */ `
  objectNormal = mat3( hqSkin ) * objectNormal;
`;

const CROWD_SKINNING = /* glsl */ `
  transformed = ( hqSkin * vec4( transformed, 1.0 ) ).xyz;
`;

const TRIM_FRAGMENT = /* glsl */ `
  {
    // Thin fresnel trim along the silhouette plus a brighter emissive atlas.
    float hqFacing = saturate( dot( normal, normalize( vViewPosition ) ) );
    float hqRim = smoothstep( 0.62, 0.96, 1.0 - hqFacing );
    totalEmissiveRadiance = totalEmissiveRadiance * ( 1.0 + 0.8 * vHqLead ) + hqRimColor * ( hqRim * vHqLead );
  }
`;

/** A standalone copy of the GLB material (textures shared, never disposed here). */
export function cloneCharacterMaterial(base: Material | Material[] | undefined): MeshStandardMaterial {
  const first = Array.isArray(base) ? base[0] : base;
  if (first && (first as MeshStandardMaterial).isMeshStandardMaterial) {
    return (first as MeshStandardMaterial).clone();
  }
  return new MeshStandardMaterial({ color: HQ_THEME.metal, roughness: 0.6, metalness: 0.2 });
}

/** Uniforms the crowd material reads; the owner swaps the textures when buffers grow. */
export type HqCrowdUniforms = {
  hqPalette: IUniform<Texture | null>;
  hqParams: IUniform<Texture | null>;
};

/** The crowd material: GLB PBR look, palette GPU skinning, per-instance lead trim. */
export function createCrowdMaterial(base: Material | Material[] | undefined, uniforms: HqCrowdUniforms): MeshStandardMaterial {
  const material = cloneCharacterMaterial(base);
  material.name = "hq-crowd";
  material.onBeforeCompile = (shader) => {
    shader.uniforms.hqPalette = uniforms.hqPalette;
    shader.uniforms.hqParams = uniforms.hqParams;
    shader.uniforms.hqRimColor = { value: TRIM_COLOR };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${CROWD_VERTEX_PARS}`)
      .replace("#include <skinbase_vertex>", CROWD_SKINBASE)
      .replace("#include <skinnormal_vertex>", CROWD_SKINNORMAL)
      .replace("#include <skinning_vertex>", CROWD_SKINNING);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 hqRimColor;\nvarying float vHqLead;")
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\n${TRIM_FRAGMENT}`);
  };
  material.customProgramCacheKey = () => "hq-crowd-palette-v1";
  return material;
}

/**
 * Hero rig materials: the plain character, the AM7 fallback with the trim,
 * and the material of AM7's own suit mesh.
 */
export function createHeroMaterials(base: Material | Material[] | undefined): {
  normal: MeshStandardMaterial;
  lead: MeshStandardMaterial;
  suit: MeshStandardMaterial;
} {
  const normal = cloneCharacterMaterial(base);
  normal.name = "hq-hero";
  const suit = cloneCharacterMaterial(base);
  suit.name = "hq-hero-suit";
  suit.emissiveIntensity *= 1.6;
  const lead = cloneCharacterMaterial(base);
  lead.name = "hq-hero-lead";
  lead.onBeforeCompile = (shader) => {
    shader.uniforms.hqRimColor = { value: TRIM_COLOR };
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 hqRimColor;\nconst float vHqLead = 1.0;")
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\n${TRIM_FRAGMENT}`);
  };
  lead.customProgramCacheKey = () => "hq-hero-lead-v1";
  return { normal, lead, suit };
}
