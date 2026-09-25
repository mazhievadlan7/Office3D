import * as THREE from "three";
import { HQ_THEME } from "@/features/hq/core/config";
import type { HqQuality } from "@/features/hq/render/scene/quality";
import { createWorldMaskTexture, WORLD_MASK_HEIGHT, WORLD_MASK_WIDTH } from "./worldMask";

// Per-instance attributes shared by the screen and LED batches:
//   aSeed  (float) stable random 0..1 per desk, varies content between desks;
//   aState (vec2)  x = desk status (-1 empty, else HQ_STATUS_CODE), y = uTime
//                  when it last changed (drives the boot wipe and LED flash).
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

// Procedural monitor content. The three monitors share one quad strip whose u
// spans thirds (i/3..(i+1)/3 = monitor i); v runs bottom to top. Everything is
// drawn in the screen's own panel space and fades to its average brightness
// when features get smaller than a few pixels, so far screens glow instead of
// shimmering.
const SCREEN_FRAGMENT_HEADER = /* glsl */ `
uniform float uTime;
uniform float uDetail;
uniform float uScreenGain;
uniform vec3 uScreenText;
uniform vec3 uScreenSoft;
uniform vec3 uScreenBg;
uniform vec3 uScreenAlert;
uniform sampler2D uWorldMask;
varying vec2 vScreenUv;
varying float vScreenSeed;
varying vec2 vScreenState;

${STATE_GLSL}

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

float hqNoise(float x, float seed) {
  float i = floor(x);
  float f = fract(x);
  float u = f * f * (3.0 - 2.0 * f);
  return mix(hqHash2(vec2(i, seed)), hqHash2(vec2(i + 1.0, seed)), u);
}

float hqRect(vec2 p, vec2 a, vec2 b) {
  vec2 s = step(a, p) * step(p, b);
  return s.x * s.y;
}

vec2 hqLocal(vec2 p, vec2 a, vec2 b) {
  return (p - a) / (b - a);
}

// One-pixel outline of a panel; px = pixels per panel unit.
float hqFrame(vec2 p, vec2 a, vec2 b, vec2 px) {
  vec2 e = max(1.0 / px, vec2(0.004));
  return hqRect(p, a, b) * (1.0 - hqRect(p, a + e, b - e));
}

// Scrolling code. p is 0..1 inside the panel (y up), px its pixels per unit.
// lines = lines scrolled so far, typed = progress of the newest line.
float hqCode(vec2 p, vec2 px, float rows, float cols, float lines, float typed, float seed) {
  float y = (1.0 - p.y) * rows;
  float row = floor(y);
  float line = row + lines;
  float x = p.x * cols;
  float col = floor(x);
  float h1 = hqHash2(vec2(line, seed * 31.7));
  float h2 = hqHash2(vec2(line * 1.37, seed * 17.3 + 3.1));
  float indent = floor(h1 * 4.0) * 2.0;
  float len = indent + 3.0 + floor(h2 * (cols - indent - 6.0));
  float on = step(indent, col) * step(col, len - 1.0) * step(0.12, fract(h1 * 7.13));
  // The bottom row is still being typed, with a blinking block cursor.
  float last = step(rows - 1.0, row);
  float cut = indent + floor(typed * (len - indent));
  on *= 1.0 - last * step(cut, col);
  float cursor = last * step(abs(col - cut), 0.5) * step(0.5, fract(uTime * 2.2));
  // Word gaps, and brighter tokens as if syntax highlighted.
  on *= step(0.14, hqHash2(vec2(col * 0.731 + line * 1.9, seed)));
  float word = floor(col / 5.0 + hqHash2(vec2(line, 7.0)) * 3.0);
  float token = 1.0 + 0.8 * step(0.74, hqHash2(vec2(word, line + seed)));
  // 3x5 pixel pseudo-glyphs.
  vec2 cell = vec2(fract(x), fract(y));
  vec2 g = (cell - vec2(0.12, 0.2)) / vec2(0.76, 0.62);
  vec2 inside = step(vec2(0.0), g) * step(g, vec2(0.999));
  vec2 pix = floor(g * vec2(3.0, 5.0));
  float bit = step(0.42, hqHash2(pix + vec2(col * 3.1, line * 5.3) + seed * 11.0)) * inside.x * inside.y;
  float cellPx = px.x / cols;
  float rowPx = px.y / rows;
  float glyph = mix(0.3, bit, smoothstep(3.0, 6.0, min(cellPx, rowPx * 0.6)) * uDetail);
  float text = max(on * glyph * token, cursor * 1.2);
  // Rows under ~2 px become paragraph blocks of three rows, and those in turn
  // collapse to the average brightness when they get too thin as well.
  float block = floor(y / 3.0) + floor(lines / 3.0);
  float blockIndent = floor(hqHash2(vec2(block * 1.7, seed)) * 3.0) * 0.07;
  float blockEnd = blockIndent + 0.25 + 0.6 * hqHash2(vec2(block, seed * 5.1));
  float coarse = step(blockIndent, p.x) * step(p.x, blockEnd) * step(0.15, fract(block * 0.618)) * 0.42;
  coarse = mix(0.17, coarse, smoothstep(1.0, 2.5, rowPx * 3.0));
  return mix(coarse, text, smoothstep(1.2, 2.6, rowPx));
}

float hqSpark(vec2 p, vec2 px, float t, float seed) {
  float v = 0.5 + 0.45 * (hqNoise(p.x * 7.0 + t * 1.3, seed) - 0.5) + 0.12 * sin(p.x * 19.0 - t * 1.9 + seed * 6.0);
  v = clamp(v, 0.08, 0.92);
  float w = max(0.035, 1.3 / px.y);
  float line = 1.0 - smoothstep(w * 0.5, w, abs(p.y - v));
  float fill = step(p.y, v) * 0.14;
  return max(line * 1.3, fill);
}

float hqBars(vec2 p, float n, float t, float seed) {
  float i = floor(p.x * n);
  float f = fract(p.x * n);
  float h = 0.1 + 0.82 * hqNoise(t * 1.7 + i * 3.7, seed + i);
  float bar = step(0.2, f) * step(f, 0.8) * step(p.y, h);
  return bar * (0.6 + 0.8 * step(h - 0.05, p.y));
}

// A few real cities (map space: x = (lon + 180) / 360, y = (lat + 58) / 142).
const vec2 HQ_CITIES[16] = vec2[16](
  vec2(0.294, 0.695), vec2(0.160, 0.675), vec2(0.371, 0.243), vec2(0.500, 0.771),
  vec2(0.524, 0.761), vec2(0.604, 0.801), vec2(0.654, 0.586), vec2(0.703, 0.543),
  vec2(0.788, 0.418), vec2(0.888, 0.660), vec2(0.920, 0.170), vec2(0.578, 0.224),
  vec2(0.509, 0.454), vec2(0.853, 0.673), vec2(0.823, 0.689), vec2(0.225, 0.545)
);

// Dotted world map with a sweep and traffic between cities.
// Returns (base glow, hot accents).
vec2 hqWorld(vec2 p, vec2 px, float t, float seed) {
  vec2 grid = vec2(${WORLD_MASK_WIDTH.toFixed(1)}, ${WORLD_MASK_HEIGHT.toFixed(1)});
  vec2 q = vec2(p.x, 1.0 - p.y) * grid;
  vec2 cell = floor(q);
  float land = texture2D(uWorldMask, (cell + 0.5) / grid).r;
  vec2 f = fract(q) - 0.5;
  float dotPx = min(px.x / grid.x, px.y / grid.y);
  float dotShape = 1.0 - smoothstep(0.24, 0.38, length(f));
  float dots = land * mix(0.4, dotShape, smoothstep(2.0, 4.0, dotPx) * max(uDetail, 0.5));
  float sweep = exp(-abs(p.x - fract(t * 0.06 + seed)) * 30.0);
  float base = dots * (0.5 + 1.4 * sweep);
  float hot = 0.0;
  vec2 aspect = vec2(2.5, 1.0);
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float tt = t / (2.6 + fk * 0.8) + hqHash1(seed * 13.0 + fk * 5.0);
    float epoch = floor(tt);
    float ph = fract(tt);
    vec2 a = HQ_CITIES[int(hqHash2(vec2(epoch, fk + seed * 7.0)) * 15.99)];
    vec2 b = HQ_CITIES[int(hqHash2(vec2(epoch * 1.3 + 5.0, fk * 3.0 + seed)) * 15.99)];
    // First half: a comet travels a -> b. Second half: b pings.
    float head = clamp(ph * 2.0, 0.0, 1.0);
    vec2 ab = b - a;
    float s = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-4), max(head - 0.35, 0.0), head);
    float d = length((p - (a + ab * s)) * aspect);
    float trail = (1.0 - smoothstep(0.004, 0.012, d)) * (1.0 - (head - s) / 0.35) * step(ph, 0.5);
    float r = length((p - b) * aspect);
    float ring = (1.0 - smoothstep(0.0, 0.016, abs(r - (ph - 0.5) * 0.3))) * step(0.5, ph) * (1.0 - ph) * 2.0;
    float core = 1.0 - smoothstep(0.01, 0.02, r);
    hot += trail * 0.9 + ring * 0.9 + core * 0.7;
  }
  return vec2(base, hot);
}

vec3 hqScreenColor() {
  vec2 uv = vScreenUv;
  float mon = floor(clamp(uv.x, 0.0, 0.9999) * 3.0);
  vec2 p = vec2(uv.x * 3.0 - mon, uv.y);
  vec2 px = 1.0 / max(fwidth(vec2(uv.x * 3.0, uv.y)), vec2(1.0e-5));
  float seed = vScreenSeed;
  // Swap the side monitors on half the desks so neighbours differ.
  float content = mon;
  if (seed > 0.5 && mon != 1.0) content = 2.0 - mon;

  float status = vScreenState.x;
  float since = hqSince(vScreenState.y);
  float empty = step(status, -0.5);
  float working = (1.0 - empty) * step(status, 0.5);
  float idle = step(0.5, status) * step(status, 1.5);
  float alert = step(1.5, status);

  float lineRate = working * 2.6 + idle * 0.18 + alert * 1.4;
  float scroll = uTime * lineRate + seed * 500.0;
  float lines = floor(scroll);
  float typed = fract(scroll);
  float t = uTime * (working + idle * 0.15 + alert * 0.6) + seed * 97.0;

  // Error screens glitch in short bursts.
  float burst = step(0.62, hqHash1(floor(uTime * 5.0) + seed * 3.0)) * alert;
  p.x += burst * (hqHash2(vec2(floor(p.y * 32.0), floor(uTime * 16.0))) - 0.5) * 0.06;

  float v = 0.0;
  float hot = 0.0;
  // Title bar with tabs.
  v += 0.28 * hqRect(p, vec2(0.02, 0.945), vec2(0.98, 0.975))
    * (0.5 + 0.9 * step(0.55, hqHash2(vec2(floor(p.x * 9.0), content + seed * 9.0))));

  if (content < 0.5) {
    vec2 a = vec2(0.03, 0.05);
    vec2 b = vec2(0.97, 0.92);
    v += 1.3 * hqRect(p, a, b) * hqCode(hqLocal(p, a, b), px * (b - a), 20.0, 46.0, lines, typed, seed);
  } else if (content < 1.5) {
    vec2 a = vec2(0.03, 0.36);
    vec2 b = vec2(0.97, 0.92);
    vec2 w = hqWorld(hqLocal(p, a, b), px * (b - a), t, seed) * hqRect(p, a, b);
    v += w.x;
    hot += w.y;
    v += 0.35 * hqFrame(p, a, b, px);
    vec2 a2 = vec2(0.03, 0.05);
    vec2 b2 = vec2(0.48, 0.3);
    v += hqRect(p, a2, b2) * hqSpark(hqLocal(p, a2, b2), px * (b2 - a2), t, seed + 1.0);
    v += 0.3 * hqFrame(p, a2, b2, px);
    vec2 a3 = vec2(0.52, 0.05);
    vec2 b3 = vec2(0.97, 0.3);
    v += hqRect(p, a3, b3) * hqBars(hqLocal(p, a3, b3), 14.0, t, seed + 2.0);
    v += 0.3 * hqFrame(p, a3, b3, px);
  } else {
    vec2 a = vec2(0.03, 0.66);
    vec2 b = vec2(0.48, 0.92);
    v += hqRect(p, a, b) * hqSpark(hqLocal(p, a, b), px * (b - a), t * 1.3, seed + 3.0);
    v += 0.3 * hqFrame(p, a, b, px);
    vec2 a2 = vec2(0.52, 0.66);
    vec2 b2 = vec2(0.97, 0.92);
    v += hqRect(p, a2, b2) * hqBars(hqLocal(p, a2, b2), 10.0, t * 0.7, seed + 4.0);
    v += 0.3 * hqFrame(p, a2, b2, px);
    vec2 a3 = vec2(0.03, 0.05);
    vec2 b3 = vec2(0.97, 0.6);
    v += 1.1 * hqRect(p, a3, b3) * hqCode(hqLocal(p, a3, b3), px * (b3 - a3), 12.0, 30.0, floor(scroll * 0.5), fract(scroll * 0.5), seed + 5.0);
  }

  vec3 textColor = mix(uScreenText, uScreenAlert, alert * 0.75);
  float level = working + idle * 0.4 + alert;
  vec3 color = uScreenBg * 2.5 + textColor * (v * 1.3 + hot * 2.2) * level;

  // Alert banner: bright band with dark text, flashing.
  float flash = step(0.45, fract(uTime * 1.6 + seed)) * alert;
  vec2 ba = vec2(0.28, 0.44);
  vec2 bb = vec2(0.72, 0.56);
  float bandText = hqRect(p, ba, bb) * hqCode(hqLocal(p, ba, bb), px * (bb - ba), 1.0, 12.0, floor(seed * 50.0), 1.0, 3.0);
  color = mix(color, uScreenAlert * (2.4 - 2.0 * bandText), hqRect(p, vec2(0.0, 0.4), vec2(1.0, 0.6)) * flash);

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
  float scan = 0.86 + 0.14 * sin(p.y * 565.5);
  color *= mix(1.0, scan, smoothstep(2.5, 5.0, px.y / 90.0) * uDetail);
  vec2 vc = p - 0.5;
  color *= 1.0 - 0.9 * dot(vc, vc);
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

// Saturated red carries a fifth of white's luminance, so a strip that should
// bloom (threshold 1) needs values around 5 and up.
vec3 hqLedColor() {
  float status = vLedState.x;
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

export function createWorkstationMaterials(): WorkstationMaterials {
  const mask = createWorldMaskTexture();
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
    uWorldMask: { value: mask },
  };
  const ledUniforms = {
    uTime,
    uLedWorking: { value: linearColor(HQ_THEME.accent) },
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
  screen.customProgramCacheKey = () => "hq-ws-screen-1";

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
  led.customProgramCacheKey = () => "hq-ws-led-1";

  const glass = new THREE.MeshStandardMaterial({
    name: "hq-ws-glass",
    color: HQ_THEME.glass,
    roughness: 0.06,
    metalness: 0.1,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const desk = new THREE.MeshStandardMaterial({
    name: "hq-ws-desk",
    color: HQ_THEME.deskTop,
    roughness: 0.3,
    metalness: 0.3,
  });
  const metal = new THREE.MeshStandardMaterial({
    name: "hq-ws-metal",
    color: HQ_THEME.metal,
    roughness: 0.38,
    metalness: 0.85,
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
      mask.dispose();
    },
  };
}
