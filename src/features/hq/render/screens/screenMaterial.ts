import * as THREE from "three";
import { SRGB_DECODE_GLSL } from "./screenSurfaces";

/**
 * An unlit material showing one of the screen hub's textures (sRGB bytes in
 * RGBA8, decoded here), brightened by `gain` so the bright parts bloom.
 */
export function createScreenTextureMaterial(map: THREE.Texture, gain: number, name: string): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ map, toneMapped: false });
  material.color.setScalar(gain);
  material.name = name;
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${SRGB_DECODE_GLSL}`)
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  sampledDiffuseColor.rgb = hqSrgbToLinear( sampledDiffuseColor.rgb );
  diffuseColor *= sampledDiffuseColor;
#endif`,
      );
  };
  material.customProgramCacheKey = () => "hq-screen-texture-v1";
  return material;
}
