import * as THREE from "three";
import { HQ_THEME } from "@/features/hq/core/config";
import type { HqQuality } from "@/features/hq/render/scene/quality";
import type { HqScreenHub } from "@/features/hq/render/screens/screenHub";
import { UNPACK_DESK_STATE_GLSL, screenAppsGlsl } from "@/features/hq/render/screens/screenApps";
import { MONITOR_ATLAS, SRGB_DECODE_GLSL, atlasUvGlsl } from "@/features/hq/render/screens/screenSurfaces";

// Per-instance attributes shared by the screen and LED batches:
//   aSeed  (float) stable random 0..1 per desk, varies content between desks;
//   aState (vec2)  x = desk status and its agent's role family, packed by
//                  packDeskState (screens/screenApps.ts), y = uTime when it
//                  last changed (drives the boot wipe and LED flash).
// Status is decoded in the shader so a pulsing error LED costs no uploads.

// uTime wraps at this period to keep sin() and the hashes precise; the shader
// takes differences modulo the same period.
export const WS_TIME_WRAP = 3600;

const STATE_GLSL = /* glsl */ `
float hqSince(float changedAt) {
  float since = mod(uTime - changedAt + ${(WS_TIME_WRAP / 2).toFixed(1)}, ${WS_TIME_WRAP.toFixed(1)}) - ${(WS_TIME_WRAP / 2).toFixed(1)};
  // Far in the past (or wrapped): treat as settled long ago.
  return since < -5.0 ? 1.0e4 : since;
}
`;

const SCREEN_VERTEX_HEADER = /* glsl */ `
attribute float aSeed;
attribute vec2 aState;
varying vec2 vScreenUv;
varying float vScreenSeed;
varying vec2 vScreenState;
`;

const SCREEN_VERTEX_MAIN = /* glsl */ `
vScreenUv = uv;
vScreenSeed = aSeed;
vScreenState = aState;
`;

const SCREEN_FRAGMENT_HEADER = /* glsl */ `
uniform float uTime;
uniform float uDetail;
uniform float uScreenGain;
uniform vec3 uScreenText;
uniform vec3 uScreenSoft;
uniform vec3 uScreenBg;
uniform vec3 uScreenAlert;
uniform sampler2D uScreenAtlas;
varying vec2 vScreenUv;
varying float vScreenSeed;
varying vec2 vScreenState;

${STATE_GLSL}
${UNPACK_DESK_STATE_GLSL}
${screenAppsGlsl()}
${atlasUvGlsl("hqMonitorUv", MONITOR_ATLAS)}
${SRGB_DECODE_GLSL}

float hqHash1(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hqHash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float hqRect(vec2 p, vec2 a, vec2 b) {
  vec2 s = step(a, p) * step(p, b);
  return s.x * s.y;
}

// Monitor content comes from the screen atlas (render/screens): one tile per
// app, painted with real text and charts and repainted several times a
// second. Which app a monitor shows follows its agent's role family and
// status (screenApps.ts); each desk picks among a few candidates by its seed
// and crops the layer a little differently, so neighbours never match.
vec3 hqScreenColor() {
  vec2 uv = vScreenUv;
  float mon = floor(clamp(uv.x, 0.0, 0.9999) * 3.0);
  vec2 p = vec2(uv.x * 3.0 - mon, uv.y);
  float seed = vScreenSeed;

  vec2 desk = hqUnpackDesk(vScreenState.x);
  float status = desk.x;
  int family = int(clamp(desk.y, 0.0, 7.0));
  float since = hqSince(vScreenState.y);
  float empty = step(status, -0.5);
  float idle = step(0.5, status) * step(status, 1.5);
  float alert = step(1.5, status);

  int monitor = int(mon);
  int pickIndex = int(floor(hqHash2(vec2(seed * 91.7, mon * 5.3 + 1.0)) * 3.999));
  int app = hqAppFor(family, monitor, pickIndex);
  // Idle: a calm centre screen; about half the side screens lock, the rest
  // keep the agent's work open, dimmed.
  if (idle > 0.5) {
    if (monitor == 1) app = HQ_APP_IDLE[pickIndex];
    else if (hqHash2(vec2(seed * 3.7, mon * 11.0 + 2.0)) < 0.45) app = HQ_APP_LOCK;
  }
  if (alert > 0.5) app = monitor == 1 ? HQ_APP_ALERT : (monitor == 0 ? HQ_APP_LOGS : app);

  // Error screens glitch in short bursts.
  float burst = step(0.62, hqHash1(floor(uTime * 5.0) + seed * 3.0)) * alert;
  p.x += burst * (hqHash2(vec2(floor(p.y * 32.0), floor(uTime * 16.0))) - 0.5) * 0.04;

  // A slightly different crop per desk and monitor.
  vec2 crop = vec2(hqHash2(vec2(seed * 13.0, mon)), hqHash2(vec2(mon * 7.0, seed * 17.0))) * vec2(0.05, 0.07);
  vec2 q = crop + clamp(p, 0.0, 1.0) * (1.0 - vec2(0.05, 0.07));
  vec3 color = hqSrgbToLinear(texture(uScreenAtlas, hqMonitorUv(float(app), vec2(q.x, 1.0 - q.y))).rgb);
  float level = 1.0 - idle * 0.45;
  color = color * 2.1 * level + uScreenBg * 1.5;
  color = mix(color, color * vec3(1.15, 0.8, 0.75), alert * 0.5);

  // Standby for empty desks: near black, a breathing ring and a slow cursor.
  float breathe = 0.5 + 0.5 * sin(uTime * 1.2 + seed * 6.2831);
  vec2 c = (p - 0.5) * vec2(1.75, 1.0);
  float ring = (1.0 - smoothstep(0.01, 0.028, abs(length(c) - 0.12))) * step(0.5, mon) * step(mon, 1.5);
  float cursor = hqRect(p, vec2(0.05, 0.84), vec2(0.075, 0.9)) * step(0.5, fract(uTime * 0.9 + seed));
  vec3 standby = uScreenBg * 1.5 + uScreenText * (ring * (0.04 + 0.08 * breathe) + cursor * 0.08);
  color = mix(color, standby, empty);

  // Boot wipe after every status change, top to bottom with a bright edge.
  float boot = clamp(since / 0.8, 0.0, 1.0);
  float wipe = (1.0 - p.y) - boot * 1.15 + 0.1;
  color = mix(uScreenBg, color, step(wipe, 0.0));
  color += uScreenSoft * exp(-abs(wipe) * 55.0) * (1.0 - boot) * (2.0 - 1.6 * empty);
  // Not powered on yet (staggered start).
  color = mix(color, uScreenBg, step(since, 0.0));

  // Scanlines when resolvable, and a soft vignette per monitor.
  vec2 px = 1.0 / max(fwidth(vec2(uv.x * 3.0, uv.y)), vec2(1.0e-5));
  float scan = 0.9 + 0.1 * sin(p.y * 565.5);
  color *= mix(1.0, scan, smoothstep(2.5, 5.0, px.y / 90.0) * uDetail);
  vec2 vc = p - 0.5;
  color *= 1.0 - 0.8 * dot(vc, vc);
  return color * uScreenGain;
}
`;

const LED_VERTEX_HEADER = /* glsl */ `
attribute vec2 aState;
varying vec2 vLedState;
varying float vLedX;
`;

const LED_VERTEX_MAIN = /* glsl */ `
vLedState = aState;
vLedX = position.x;
`;

const LED_FRAGMENT_HEADER = /* glsl */ `
uniform float uTime;
uniform vec3 uLedWorking;
uniform vec3 uLedError;
uniform vec3 uLedEmpty;
varying vec2 vLedState;
varying float vLedX;

${STATE_GLSL}
${UNPACK_DESK_STATE_GLSL}

// Saturated red carries a fifth of white's luminance, so a strip that should
// bloom (threshold 1) needs values around 5 and up.
vec3 hqLedColor() {
  float status = hqUnpackDesk(vLedState.x).x;
  float since = hqSince(vLedState.y);
  vec3 color;
  if (status < -0.5) {
    color = uLedEmpty * 0.4;
  } else if (status < 0.5) {
    // Working: bright red with a slow light running along the strip.
    color = uLedWorking * (5.2 + 1.6 * sin(vLedX * 5.0 - uTime * 2.6));
  } else if (status < 1.5) {
    color = uLedWorking * (0.9 + 0.15 * sin(uTime * 1.1 + vLedX * 2.0));
  } else {
    float pulse = 0.5 + 0.5 * sin(uTime * 7.0);
    color = uLedError * (0.5 + 6.5 * pulse * pulse);
  }
  // Flash on a status change; dark until the desk has powered on.
  color += uLedWorking * 5.0 * exp(-since * 5.0) * step(0.0, since) * step(-0.5, status);
  return mix(color, uLedEmpty * 0.4, step(since, 0.0));
}
`;

type Uniform<T> = { value: T };

export type WorkstationMaterials = {
  readonly screen: THREE.MeshBasicMaterial;
  readonly led: THREE.MeshBasicMaterial;
  readonly glass: THREE.MeshStandardMaterial;
  /** Themed stand-ins for the GLB's lit materials (procedural desks). */
  readonly desk: THREE.MeshStandardMaterial;
  readonly metal: THREE.MeshStandardMaterial;
  readonly chair: THREE.MeshStandardMaterial;
  setTime(seconds: number): void;
  setQuality(quality: HqQuality): void;
  dispose(): void;
};

const QUALITY_DETAIL: Record<HqQuality, number> = { high: 1, medium: 1, low: 0 };

function linearColor(hex: string): THREE.Color {
  // THREE.Color converts sRGB hex to the linear working space.
  return new THREE.Color(hex);
}

/** A one-texel dark texture, for when no screen hub is given. */
function blankAtlas(): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  texture.needsUpdate = true;
  return texture;
}

export function createWorkstationMaterials(screens: HqScreenHub | null): WorkstationMaterials {
  const blank = screens ? null : blankAtlas();
  const uTime: Uniform<number> = { value: 0 };
  const uDetail: Uniform<number> = { value: 1 };
  const screenUniforms = {
    uTime,
    uDetail,
    uScreenGain: { value: 1 },
    uScreenText: { value: linearColor(HQ_THEME.screenText) },
    uScreenSoft: { value: linearColor(HQ_THEME.accentSoft) },
    uScreenBg: { value: linearColor(HQ_THEME.screenBackground) },
    uScreenAlert: { value: linearColor(HQ_THEME.statusError) },
    uScreenAtlas: { value: screens?.monitors ?? blank! },
  };
  const ledUniforms = {
    uTime,
    // The warm strips read far brighter than red at the same value.
    uLedWorking: { value: linearColor(HQ_THEME.deskLed).multiplyScalar(0.7) },
    uLedError: { value: linearColor(HQ_THEME.statusError) },
    uLedEmpty: { value: linearColor(HQ_THEME.accentDeep) },
  };

  const screen = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  screen.name = "hq-ws-screen";
  screen.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, screenUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${SCREEN_VERTEX_HEADER}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${SCREEN_VERTEX_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${SCREEN_FRAGMENT_HEADER}`)
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb = hqScreenColor();");
  };
  screen.customProgramCacheKey = () => "hq-ws-screen-5";

  const led = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  led.name = "hq-ws-led";
  led.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, ledUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${LED_VERTEX_HEADER}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${LED_VERTEX_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${LED_FRAGMENT_HEADER}`)
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb = hqLedColor();");
  };
  led.customProgramCacheKey = () => "hq-ws-led-2";

  // Monitor glass: matte and non-reflective. A glossy pane mirrored the high key
  // light into a hotspot above 1, which the bloom spread into a white glow over
  // the desks at the mirror angle — so it followed the camera around the hall.
  const glass = new THREE.MeshStandardMaterial({
    name: "hq-ws-glass",
    color: HQ_THEME.glass,
    roughness: 0.9,
    metalness: 0,
    envMapIntensity: 0,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  // Matte desks and frames: a glossy top mirrors the key light into a white
  // hotspot that slides with the camera. Rough + low env keeps them even.
  const desk = new THREE.MeshStandardMaterial({
    name: "hq-ws-desk",
    color: HQ_THEME.deskTop,
    roughness: 0.7,
    metalness: 0,
    envMapIntensity: 0.25,
  });
  const metal = new THREE.MeshStandardMaterial({
    name: "hq-ws-metal",
    color: HQ_THEME.metal,
    roughness: 0.72,
    metalness: 0.25,
    envMapIntensity: 0.15,
  });
  const chair = new THREE.MeshStandardMaterial({
    name: "hq-ws-chair",
    color: HQ_THEME.deskTop,
    roughness: 0.72,
    metalness: 0.05,
  });

  return {
    screen,
    led,
    glass,
    desk,
    metal,
    chair,
    setTime(seconds) {
      uTime.value = seconds % WS_TIME_WRAP;
    },
    setQuality(quality) {
      uDetail.value = QUALITY_DETAIL[quality];
    },
    dispose() {
      for (const material of [screen, led, glass, desk, metal, chair]) material.dispose();
      blank?.dispose();
    },
  };
}
