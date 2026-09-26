import { MeshStandardMaterial, type IUniform, type Material, type Texture } from "three";
import { HQ_THEME } from "@/features/hq/core/config";

/**
 * Materials for the character.
 *
 * The instanced crowd reuses the GLB's own PBR material but swaps three.js
 * skinning for the per-frame bone palette (crowdPalette.ts): instance k reads
 * its bone matrices from row k.
 *
 * AM7 wears exactly what everyone else wears. The lead used to get a brighter
 * emissive and a red fresnel trim along the silhouette, which read as the
 * clothes glowing red; only the larger scale (HQ_LEAD_SCALE) and the
 * nameplate set the lead apart now.
 */

const CROWD_VERTEX_PARS = /* glsl */ `
uniform highp sampler2D hqPalette;
attribute vec4 skinIndex;
attribute vec4 skinWeight;

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
`;

const CROWD_SKINNORMAL = /* glsl */ `
  objectNormal = mat3( hqSkin ) * objectNormal;
`;

const CROWD_SKINNING = /* glsl */ `
  transformed = ( hqSkin * vec4( transformed, 1.0 ) ).xyz;
`;

/** A standalone copy of the GLB material (textures shared, never disposed here). */
export function cloneCharacterMaterial(base: Material | Material[] | undefined): MeshStandardMaterial {
  const first = Array.isArray(base) ? base[0] : base;
  if (first && (first as MeshStandardMaterial).isMeshStandardMaterial) {
    return (first as MeshStandardMaterial).clone();
  }
  return new MeshStandardMaterial({ color: HQ_THEME.metal, roughness: 0.6, metalness: 0.2 });
}

/** Uniforms the crowd material reads; the owner swaps the texture when buffers grow. */
export type HqCrowdUniforms = {
  hqPalette: IUniform<Texture | null>;
};

/** The crowd material: GLB PBR look with palette GPU skinning. */
export function createCrowdMaterial(base: Material | Material[] | undefined, uniforms: HqCrowdUniforms): MeshStandardMaterial {
  const material = cloneCharacterMaterial(base);
  material.name = "hq-crowd";
  material.onBeforeCompile = (shader) => {
    shader.uniforms.hqPalette = uniforms.hqPalette;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${CROWD_VERTEX_PARS}`)
      .replace("#include <skinbase_vertex>", CROWD_SKINBASE)
      .replace("#include <skinnormal_vertex>", CROWD_SKINNORMAL)
      .replace("#include <skinning_vertex>", CROWD_SKINNING);
  };
  // v2: the lead trim is gone; a new key keeps a hot-reloaded page from
  // reusing the old program.
  material.customProgramCacheKey = () => "hq-crowd-palette-v2";
  return material;
}

/**
 * Hero rig material: the plain character. `lead` is the same material — AM7
 * no longer wears a variant — and is kept only so owners that hold and
 * dispose both entries stay valid (disposing a material twice is harmless).
 */
export function createHeroMaterials(base: Material | Material[] | undefined): {
  normal: MeshStandardMaterial;
  lead: MeshStandardMaterial;
} {
  const normal = cloneCharacterMaterial(base);
  normal.name = "hq-hero";
  return { normal, lead: normal };
}
