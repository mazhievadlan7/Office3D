import * as THREE from "three";
import { SRGB_DECODE_GLSL } from "./screenSurfaces";

/**
 * The glass of a real display, shared by the wall TVs and AM7's monitor:
 * slight dimming off-axis, backlight falloff at the edges, the pixel grid when
 * the camera is close (faded out before it could alias), a soft highlight
 * knee so whites bloom a little while text stays crisp, and a Fresnel
 * reflection with a faint streak that slides across the pane as the camera
 * moves. World-space, so it holds for instanced and single meshes alike.
 *
 * Vertex: GLASS_VERTEX_PARS at <common>, GLASS_VERTEX after <project_vertex>.
 * Fragment: GLASS_FRAGMENT_PARS at <common>, then
 * `hqScreenGlass(linearColour, uv, texels, gain)`.
 */
export const GLASS_VERTEX_PARS = /* glsl */ `
varying vec3 vHqGlassWorld;
varying vec3 vHqGlassNormal;
varying vec3 vHqGlassTangent;
`;

export const GLASS_VERTEX = /* glsl */ `
{
  mat3 hqBasis = mat3( modelMatrix );
  vec4 hqGlassPos = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    hqGlassPos = instanceMatrix * hqGlassPos;
    hqBasis = hqBasis * mat3( instanceMatrix );
  #endif
  vHqGlassWorld = ( modelMatrix * hqGlassPos ).xyz;
  vHqGlassNormal = hqBasis * normal;
  vHqGlassTangent = hqBasis * vec3( 1.0, 0.0, 0.0 );
}
`;

export const GLASS_FRAGMENT_PARS = /* glsl */ `
varying vec3 vHqGlassWorld;
varying vec3 vHqGlassNormal;
varying vec3 vHqGlassTangent;

vec3 hqScreenGlass( vec3 emitted, vec2 uv, vec2 texels, float gain ) {
  vec3 hqV = normalize( cameraPosition - vHqGlassWorld );
  vec3 hqN = normalize( vHqGlassNormal );
  float hqNdV = abs( dot( hqN, hqV ) );
  vec3 col = emitted * mix( 0.72, 1.0, smoothstep( 0.05, 0.6, hqNdV ) );
  vec2 hqEdge = min( uv, 1.0 - uv ) * vec2( texels.x / texels.y, 1.0 );
  col *= mix( 0.8, 1.0, smoothstep( 0.0, 0.04, min( hqEdge.x, hqEdge.y ) ) );
  vec2 hqPx = uv * texels;
  vec2 hqCell = abs( fract( hqPx ) - 0.5 );
  // (smoothstep needs edge0 < edge1: GLSL leaves the reversed form undefined.)
  float hqGrid = 1.0 - smoothstep( 0.38, 0.5, max( hqCell.x, hqCell.y ) );
  float hqClose = 1.0 - clamp( max( fwidth( hqPx.x ), fwidth( hqPx.y ) ) * 2.5 - 0.25, 0.0, 1.0 );
  col *= mix( 1.0, 0.55 + 0.45 * hqGrid, hqClose );
  col = col * gain / ( 1.0 + 0.6 * col );
  float hqFres = 0.03 + 0.97 * pow( 1.0 - clamp( hqNdV, 0.0, 1.0 ), 5.0 );
  float hqSlide = dot( hqV, normalize( vHqGlassTangent ) ) * 0.9;
  float hqDiag = uv.x + uv.y * 0.42 - hqSlide;
  float hqStreak = ( 1.0 - smoothstep( 0.0, 0.16, abs( hqDiag - 0.35 ) ) ) * 0.022 + ( 1.0 - smoothstep( 0.0, 0.05, abs( hqDiag - 0.62 ) ) ) * 0.012;
  col += vec3( 0.09, 0.035, 0.035 ) * hqFres + vec3( 1.0, 0.9, 0.88 ) * hqStreak * ( 0.4 + hqFres );
  return col;
}
`;

export type ScreenGlass = {
  /** Pixel size of the picture, for the close-up pixel grid. */
  texels: readonly [number, number];
};

/**
 * An unlit material showing one of the screen hub's textures (sRGB bytes in
 * RGBA8, decoded here), brightened by `gain` so the bright parts bloom; with
 * `glass`, seen through a display's glass (above). Without it, a knee on the
 * highlights keeps big white numerals glowing rather than blown out, while
 * the darks and mid-tones keep their level.
 */
/**
 * The video wall's warm ramp: whatever a tile was painted in, its lightness
 * maps from near black through deep red and red-orange to pale amber, so the
 * wings read as one wall of live red and orange data.
 */
const WARM_RAMP_GLSL = /* glsl */ `
vec3 hqWarmRamp(vec3 c) {
  float l = max(max(c.r, c.g), c.b);
  vec3 r = mix(vec3(0.004, 0.001, 0.001), vec3(0.3, 0.025, 0.012), smoothstep(0.0, 0.22, l));
  r = mix(r, vec3(1.0, 0.14, 0.04), smoothstep(0.18, 0.55, l));
  r = mix(r, vec3(1.0, 0.48, 0.1), smoothstep(0.5, 0.85, l));
  return mix(r, vec3(1.0, 0.84, 0.55), smoothstep(0.85, 1.0, l));
}
`;

export function createScreenTextureMaterial(
  map: THREE.Texture,
  gain: number,
  name: string,
  glass?: ScreenGlass,
  warm = false,
): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ map, toneMapped: false });
  material.color.setScalar(glass ? 1 : gain);
  material.name = name;
  const shade = glass
    ? `sampledDiffuseColor.rgb = hqScreenGlass( sampledDiffuseColor.rgb, vMapUv, vec2( ${glass.texels[0].toFixed(1)}, ${glass.texels[1].toFixed(1)} ), ${gain.toFixed(4)} );`
    : "sampledDiffuseColor.rgb /= 1.0 + 0.5 * sampledDiffuseColor.rgb * sampledDiffuseColor.rgb;";
  material.onBeforeCompile = (shader) => {
    if (glass) {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${GLASS_VERTEX_PARS}`)
        .replace("#include <project_vertex>", `#include <project_vertex>\n${GLASS_VERTEX}`);
    }
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${SRGB_DECODE_GLSL}${glass ? GLASS_FRAGMENT_PARS : ""}${warm ? WARM_RAMP_GLSL : ""}`)
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  sampledDiffuseColor.rgb = hqSrgbToLinear( sampledDiffuseColor.rgb );
  ${warm ? "sampledDiffuseColor.rgb = hqWarmRamp( sampledDiffuseColor.rgb );" : ""}
  ${shade}
  diffuseColor *= sampledDiffuseColor;
#endif`,
      );
  };
  material.customProgramCacheKey = () =>
    glass ? `hq-screen-glass-v1:${glass.texels.join("x")}:${gain.toFixed(4)}:${warm ? 1 : 0}` : `hq-screen-texture-v2:${warm ? 1 : 0}`;
  return material;
}
