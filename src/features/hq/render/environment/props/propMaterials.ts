import * as THREE from "three";
import { HQ_THEME } from "@/features/hq/core/config";
import { GLSL_HQ_NOISE, patchMaterial } from "../glsl";
import { GLOW, themeColor } from "../palette";
import {
  GLASS_FRAGMENT_PARS,
  GLASS_VERTEX,
  GLASS_VERTEX_PARS,
  createScreenTextureMaterial,
} from "@/features/hq/render/screens/screenMaterial";
import { EXEC_H, EXEC_W, SRGB_DECODE_GLSL, WALL_ATLAS, WALL_H, WALL_W, atlasUvGlsl } from "@/features/hq/render/screens/screenSurfaces";

// Animated prop materials. Time and the animation switch are shared uniforms
// owned by HqEnvironment, so switching quality flips a uniform instead of
// compiling another program.

export type PropUniforms = {
  uHqTime: THREE.IUniform<number>;
  /** 1 animates LEDs and screens, 0 freezes them (low quality). */
  uHqAnimate: THREE.IUniform<number>;
};

export function createPropUniforms(): PropUniforms {
  return { uHqTime: { value: 0 }, uHqAnimate: { value: 1 } };
}

export function setPropTime(uniforms: PropUniforms, seconds: number): void {
  uniforms.uHqTime.value = seconds;
}

export function setPropAnimation(uniforms: PropUniforms, animate: boolean): void {
  uniforms.uHqAnimate.value = animate ? 1 : 0;
}

// LED convention shared with blender/hq/props_tech.py: every LED quad of the
// "emissive_red" material carries a constant UV, u = blink phase in [0, 1),
// v = 1 for LEDs that blink and 0 for steady strips. The instance position is
// mixed into the phase so no two racks blink in step. Flat, so each LED
// switches as a whole.
const BLINK_VERTEX_PARS = /* glsl */ `
${GLSL_HQ_NOISE}
flat varying vec2 vHqBlink;
`;
const BLINK_VERTEX = /* glsl */ `
{
  vec2 hqInst = vec2(0.0);
  #ifdef USE_INSTANCING
    hqInst = instanceMatrix[3].xz;
  #endif
  vHqBlink = vec2(fract(uv.x + hqHash12(hqInst * 3.7 + 0.5)), uv.y);
}
`;
const BLINK_FRAGMENT_PARS = /* glsl */ `
flat varying vec2 vHqBlink;
uniform float uHqTime;
uniform float uHqAnimate;
`;
const BLINK_FRAGMENT = /* glsl */ `
{
  float hqS = vHqBlink.x;
  float hqRate = 0.35 + 2.4 * fract(hqS * 7.13);
  float hqPhase = fract(uHqTime * hqRate + hqS * 13.7);
  // Mostly on with short dips; a few LEDs flicker in quick bursts (disk activity).
  float hqOn = step(0.22, hqPhase);
  hqOn *= mix(1.0, step(0.5, fract(hqPhase * 7.0)), step(0.8, fract(hqS * 5.3)));
  outgoingLight *= mix(1.0, mix(0.22, 1.0, hqOn), uHqAnimate * step(0.5, vHqBlink.y));
}
`;

/**
 * Makes an LED material blink per LED and per instance (any lit or unlit
 * built-in material), following the UV convention above.
 */
export function patchBlink<T extends THREE.Material>(material: T, uniforms: PropUniforms): T {
  return patchMaterial(material, {
    key: "hq-led-blink-v2",
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexPars: BLINK_VERTEX_PARS,
    fragmentPars: BLINK_FRAGMENT_PARS,
    vertex: [["begin_vertex", BLINK_VERTEX]],
    fragment: [["opaque_fragment", BLINK_FRAGMENT, "before"]],
  });
}

// A red operations dashboard drawn procedurally from the screen's UVs:
// header text blocks, a bar chart, a live line graph with a scan cursor, and
// a ticker. Each instance gets its own seed from its position.
const SCREEN_VERTEX_PARS = /* glsl */ `
${GLSL_HQ_NOISE}
flat varying float vHqScreenSeed;
`;
const SCREEN_VERTEX = /* glsl */ `
{
  vec2 hqInst = vec2(0.37, 0.61);
  #ifdef USE_INSTANCING
    hqInst = instanceMatrix[3].xz;
  #endif
  vHqScreenSeed = hqHash12(hqInst * 1.31 + 4.2);
}
`;
const SCREEN_FRAGMENT_PARS = /* glsl */ `
${GLSL_HQ_NOISE}
flat varying float vHqScreenSeed;
uniform float uHqTime;
uniform float uHqAnimate;
uniform vec3 uHqInk;
uniform vec3 uHqHot;
uniform vec3 uHqBg;

vec3 hqDashboard(vec2 uv, float t, float seed) {
  vec3 col = uHqBg;
  vec2 edge = min(uv, 1.0 - uv);
  float frame = step(min(edge.x, edge.y), 0.012);
  if (uv.y > 0.86) {
    // Header: rows of pseudo text.
    float row = floor((uv.y - 0.86) / 0.04);
    float cell = floor(uv.x * 30.0);
    float on = step(0.42, hqHash12(vec2(cell, row + seed * 50.0)));
    on *= step(fract(uv.x * 30.0), 0.78) * step(fract((uv.y - 0.86) / 0.04), 0.5);
    on *= step(0.04, uv.x) * step(uv.x, 0.96);
    col = mix(col, uHqInk * 0.7, on);
  } else if (uv.y < 0.12) {
    // Ticker scrolling left.
    float x = uv.x * 42.0 + t * 3.0;
    float on = step(0.45, hqHash12(vec2(floor(x), seed * 91.0))) * step(fract(x), 0.7);
    on *= step(abs(uv.y - 0.065), 0.022) * step(0.04, uv.x) * step(uv.x, 0.96);
    col = mix(col, uHqHot, on);
  } else if (uv.x < 0.38) {
    // Bar chart.
    float gx = (uv.x - 0.04) / 0.034;
    float i = floor(gx);
    float h = 0.2 + 0.6 * (0.5 + 0.5 * sin(t * (0.5 + hqHash12(vec2(i, seed)) * 1.6) + i * 1.7 + seed * 6.0));
    float y = (uv.y - 0.17) / 0.64;
    float on = step(fract(gx), 0.7) * step(y, h) * step(0.0, y) * step(0.0, gx) * step(i, 9.0);
    col = mix(col, mix(uHqInk * 0.45, uHqHot, y), on);
  } else {
    // Line graph with a faint grid and a scan cursor.
    vec2 g = (uv - vec2(0.42, 0.17)) / vec2(0.54, 0.64);
    if (g.x > 0.0 && g.x < 1.0 && g.y > 0.0 && g.y < 1.0) {
      vec2 grid = abs(fract(g * vec2(8.0, 5.0) + 0.5) - 0.5);
      float gridOn = step(min(grid.x, grid.y), 0.03);
      float f = 0.5 + 0.22 * sin(g.x * 11.0 + t * 1.3 + seed * 20.0) + 0.12 * sin(g.x * 27.0 - t * 2.1 + seed * 3.0);
      float d = abs(g.y - f);
      float lineOn = 1.0 - smoothstep(0.012, 0.035, d);
      float fill = step(g.y, f) * 0.12;
      float cursor = step(abs(g.x - fract(t * 0.12 + seed)), 0.005);
      col += uHqInk * (gridOn * 0.06 + cursor * 0.35) + uHqHot * (lineOn + fill);
    }
  }
  col = mix(col, uHqInk * 0.45, frame);
  // Scanlines, faded out where they would alias.
  float scan = uv.y * 160.0;
  float scanAA = clamp(fwidth(scan) - 0.5, 0.0, 1.0);
  col *= mix(0.82 + 0.18 * step(0.5, fract(scan)), 0.91, scanAA);
  return col;
}
`;
const SCREEN_FRAGMENT = /* glsl */ `
diffuseColor.rgb = hqDashboard(vUv, uHqTime * uHqAnimate + vHqScreenSeed * 30.0, vHqScreenSeed) * ${GLOW.screen.toFixed(2)};
`;

/** Unlit dashboard material for any "screen" surface with 0..1 UVs. */
export function createScreenMaterial(uniforms: PropUniforms): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  material.name = "hq-screen";
  material.defines = { ...(material.defines ?? {}), USE_UV: "" };
  return patchMaterial(material, {
    key: "hq-screen-v1",
    uniforms: {
      ...(uniforms as unknown as Record<string, THREE.IUniform>),
      uHqInk: { value: themeColor(HQ_THEME.screenText) },
      uHqHot: { value: themeColor(HQ_THEME.accent, 1.4) },
      uHqBg: { value: themeColor(HQ_THEME.screenBackground) },
    },
    vertexPars: SCREEN_VERTEX_PARS,
    fragmentPars: SCREEN_FRAGMENT_PARS,
    vertex: [["begin_vertex", SCREEN_VERTEX]],
    fragment: [["color_fragment", SCREEN_FRAGMENT]],
  });
}

// Wall screens show a tile of the screen hub's wall atlas (one per channel:
// AM7's report, news, business, radio) behind a display's glass
// (screenMaterial.ts). The channel rides on a per-instance attribute written
// from HqProp.screen; props.glb display UVs have v = 0 at the top, like the
// canvas rows.
const WALL_VERTEX_PARS = /* glsl */ `
attribute float aPanel;
flat varying float vHqPanel;
${GLASS_VERTEX_PARS}
`;
const WALL_VERTEX = /* glsl */ `
vHqPanel = aPanel;
`;
const WALL_FRAGMENT_PARS = /* glsl */ `
uniform sampler2D uHqWalls;
uniform float uHqWallGain;
flat varying float vHqPanel;
${atlasUvGlsl("hqWallUv", WALL_ATLAS)}
${SRGB_DECODE_GLSL}
${GLASS_FRAGMENT_PARS}
`;
const WALL_FRAGMENT = /* glsl */ `
{
  vec3 hqWall = hqSrgbToLinear(texture2D(uHqWalls, hqWallUv(vHqPanel, vUv)).rgb);
  diffuseColor.rgb = hqScreenGlass(hqWall, vUv, vec2(${WALL_W.toFixed(1)}, ${WALL_H.toFixed(1)}), uHqWallGain);
}
`;

/** Unlit wall-screen material sampling `walls` (a layer per HqProp.screen channel). */
export function createWallScreenMaterial(walls: THREE.Texture): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  material.name = "hq-wall-screen";
  material.defines = { ...(material.defines ?? {}), USE_UV: "" };
  return patchMaterial(material, {
    key: "hq-wall-screen-v4",
    // A little more gain than before: the glass's highlight knee takes the
    // edge off the whites, so the picture is brighter without blooming more.
    uniforms: { uHqWalls: { value: walls }, uHqWallGain: { value: GLOW.screen * 1.375 } },
    vertexPars: WALL_VERTEX_PARS,
    fragmentPars: WALL_FRAGMENT_PARS,
    vertex: [
      ["begin_vertex", WALL_VERTEX],
      ["project_vertex", GLASS_VERTEX],
    ],
    fragment: [["color_fragment", WALL_FRAGMENT]],
  });
}

/** AM7's curved monitor: the command-centre canvas behind glass, pushed a little into bloom. */
export function createExecScreenMaterial(map: THREE.Texture): THREE.MeshBasicMaterial {
  return createScreenTextureMaterial(map, GLOW.screen * 1.375, "hq-exec-screen", { texels: [EXEC_W, EXEC_H] });
}

/** Materials for the procedural stand-ins drawn while props.glb is missing. */
export type FallbackRole = "body" | "dark" | "cushion" | "foliage" | "led" | "ledStatic" | "warm" | "screen";

export function createFallbackMaterials(uniforms: PropUniforms, screen: THREE.Material): Record<FallbackRole, THREE.Material> {
  const led = new THREE.MeshBasicMaterial({ color: themeColor(HQ_THEME.accent, GLOW.led), toneMapped: false });
  led.name = "hq-fallback-led";
  return {
    // Satin, not glossy: no white key-light hotspots that follow the camera.
    body: named(new THREE.MeshStandardMaterial({ color: HQ_THEME.metal, roughness: 0.6, metalness: 0.5, envMapIntensity: 0.4 }), "body"),
    dark: named(new THREE.MeshStandardMaterial({ color: HQ_THEME.deskTop, roughness: 0.8, metalness: 0.1, envMapIntensity: 0.3 }), "dark"),
    cushion: named(new THREE.MeshStandardMaterial({ color: HQ_THEME.wallPanel, roughness: 0.92, metalness: 0 }), "cushion"),
    foliage: named(new THREE.MeshStandardMaterial({ color: HQ_THEME.glass, roughness: 0.8, metalness: 0, flatShading: true }), "foliage"),
    led: patchBlink(led, uniforms),
    ledStatic: named(new THREE.MeshBasicMaterial({ color: themeColor(HQ_THEME.accent, GLOW.line), toneMapped: false }), "led-static"),
    warm: named(new THREE.MeshBasicMaterial({ color: themeColor(HQ_THEME.ledWarm, GLOW.warm), toneMapped: false }), "warm"),
    screen,
  };
}

function named<T extends THREE.Material>(material: T, name: string): T {
  material.name = `hq-fallback-${name}`;
  return material;
}
