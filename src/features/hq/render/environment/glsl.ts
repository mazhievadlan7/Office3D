import type * as THREE from "three";

// GLSL shared by the environment's patched materials. Everything is injected
// through onBeforeCompile so the built-in PBR lighting, fog, shadows and
// environment reflections keep working.

/** Sine-free hash (Dave Hoskins) and value noise; stable on every GPU. */
export const GLSL_HQ_NOISE = /* glsl */ `
float hqHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hqNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hqHash12(i), hqHash12(i + vec2(1.0, 0.0)), u.x),
    mix(hqHash12(i + vec2(0.0, 1.0)), hqHash12(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}
`;

export const GLSL_HQ_WORLD_VARYING = /* glsl */ `
varying vec3 vHqWorld;
`;

/** World position including the instance transform; placed after <project_vertex>. */
export const GLSL_HQ_WORLD_VERTEX = /* glsl */ `
{
  vec4 hqWorldPos = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    hqWorldPos = instanceMatrix * hqWorldPos;
  #endif
  vHqWorld = (modelMatrix * hqWorldPos).xyz;
}
`;

type Shader = THREE.WebGLProgramParametersWithUniforms;

/**
 * Inserts code next to a shader chunk include. A missing anchor means three
 * renamed a chunk; the material then renders unpatched, so say so in dev.
 */
export function injectChunk(
  source: string,
  chunk: string,
  code: string,
  where: "before" | "after" = "after",
): string {
  const anchor = `#include <${chunk}>`;
  if (!source.includes(anchor)) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[hq/environment] shader chunk <${chunk}> not found; patch skipped`);
    }
    return source;
  }
  return source.replace(anchor, where === "after" ? `${anchor}\n${code}` : `${code}\n${anchor}`);
}

export type ShaderPatch = {
  /** Unique per shader variant: materials sharing it share one GL program. */
  key: string;
  uniforms?: Record<string, THREE.IUniform>;
  vertexPars?: string;
  fragmentPars?: string;
  vertex?: Array<[chunk: string, code: string, where?: "before" | "after"]>;
  fragment?: Array<[chunk: string, code: string, where?: "before" | "after"]>;
};

/** Applies a patch to a built-in material; uniforms stay shared by reference. */
export function patchMaterial<T extends THREE.Material>(material: T, patch: ShaderPatch): T {
  material.onBeforeCompile = (shader: Shader) => {
    Object.assign(shader.uniforms, patch.uniforms ?? {});
    let vs = shader.vertexShader;
    let fs = shader.fragmentShader;
    if (patch.vertexPars) vs = injectChunk(vs, "common", patch.vertexPars);
    if (patch.fragmentPars) fs = injectChunk(fs, "common", patch.fragmentPars);
    for (const [chunk, code, where] of patch.vertex ?? []) vs = injectChunk(vs, chunk, code, where);
    for (const [chunk, code, where] of patch.fragment ?? []) fs = injectChunk(fs, chunk, code, where);
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
  };
  material.customProgramCacheKey = () => patch.key;
  return material;
}

/** Visual-only meshes never take part in raycasting; the shell picks on the floor plane. */
export function noRaycast(): void {}
