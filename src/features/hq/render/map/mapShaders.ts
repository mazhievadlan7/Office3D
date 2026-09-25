import * as THREE from "three";
import { HQ_THEME } from "@/features/hq/core/config";
import { MAP_LAT_NORTH, MAP_LAT_SOUTH, MAP_LON_EAST, MAP_LON_WEST } from "@/features/hq/render/map/mapProjection";

// All map materials are unlit, fog-aware, log-depth-aware ShaderMaterials with
// toneMapped off so HDR highlights (> 1) reach the bloom pass. Quality is a
// uniform, never a define, so switching it never recompiles a program.

export const COMMON = /* glsl */ `
float sq(float x) { return x * x; }
float hqHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float hqNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hqHash(i), hqHash(i + vec2(1.0, 0.0)), u.x),
    mix(hqHash(i + vec2(0.0, 1.0)), hqHash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}
`;

// Additive layers fade toward black in fog instead of mixing in the fog colour.
export const FOG_KEEP = /* glsl */ `
float hqFogKeep() {
#ifdef USE_FOG
  #ifdef FOG_EXP2
    return exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
    return 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
  #endif
#else
  return 1.0;
#endif
}
`;

export const FRAG_OUTPUT = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

function color(hex: string): THREE.Color {
  return new THREE.Color(hex);
}

/** Uniform objects shared by every map material, so one write per frame reaches all of them. */
export type MapSharedUniforms = {
  uTime: THREE.IUniform<number>;
  uActivity: THREE.IUniform<number>;
  uFlicker: THREE.IUniform<number>;
  uScanY: THREE.IUniform<number>;
  uQuality: THREE.IUniform<number>;
  uMapRect: THREE.IUniform<THREE.Vector4>;
  /** 1 draws the glyph panels beside the map rectangle; 0 leaves them to the screen hub's canvases. */
  uHud: THREE.IUniform<number>;
};

export function createSharedUniforms(): MapSharedUniforms {
  return {
    uTime: { value: 0 },
    uActivity: { value: 0 },
    uFlicker: { value: 1 },
    uScanY: { value: -1000 },
    uQuality: { value: 1 },
    uMapRect: { value: new THREE.Vector4(-1, -1, 1, 1) },
    uHud: { value: 1 },
  };
}

function withShared(
  shared: MapSharedUniforms,
  own: Record<string, THREE.IUniform>,
): Record<string, THREE.IUniform> {
  return { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...shared, ...own };
}

// ---------------------------------------------------------------- glass panel

const PANEL_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
varying vec2 vLocal;
varying vec3 vViewPos;
varying vec3 vViewNormal;
void main() {
  vLocal = position.xy;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mvPosition.xyz;
  vViewNormal = normalize(normalMatrix * vec3(0.0, 0.0, 1.0));
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const PANEL_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform float uActivity;
uniform float uFlicker;
uniform float uScanY;
uniform float uQuality;
uniform vec4 uMapRect;
uniform float uHud;
uniform vec4 uGeo;
uniform vec2 uHalf;
uniform float uFrameInset;
uniform vec3 uBase;
uniform vec3 uGlass;
uniform vec3 uEdge;
uniform vec3 uAccent;
uniform vec3 uDeep;
uniform vec3 uHot;
varying vec2 vLocal;
varying vec3 vViewPos;
varying vec3 vViewNormal;
${COMMON}

// Anti-aliased periodic line: 1 on lines every "spacing" units of "coord".
float gridLine(float coord, float spacing, float halfPx) {
  float w = max(fwidth(coord), 1e-5);
  float d = abs(fract(coord / spacing + 0.5) - 0.5) * spacing;
  return 1.0 - smoothstep(halfPx * w, (halfPx + 1.0) * w, d);
}

float sdBox(vec2 p, vec2 b) {
  vec2 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}

float band(float d, float halfWidth) {
  float w = max(fwidth(d), 1e-5);
  return 1.0 - smoothstep(halfWidth, halfWidth + w * 1.5, abs(d));
}

// Soft-edged box pulse on a 0..1 coordinate, anti-aliased by its derivative.
float pulseAA(float x, float a, float b) {
  float w = max(fwidth(x), 1e-5);
  return smoothstep(a - w, a + w, x) * (1.0 - smoothstep(b - w, b + w, x));
}

// Scrolling "log" of pixel glyphs. q is metres inside the block, origin at
// its bottom-left. Glyphs are random 3x5 bit patterns, so there is no text to
// translate; far away they merge into solid blocks instead of shimmering.
float hudFeed(vec2 q, vec2 size, float seed) {
  float rowH = clamp(size.y / 12.0, 0.05, 0.14);
  float rowF = (q.y + uTime * rowH * 0.5) / rowH;
  float row = floor(rowF);
  float fy = fract(rowF);
  float cw = rowH * 0.46;
  float cellF = q.x / cw;
  float cell = floor(cellF);
  float fx = fract(cellF);
  float lineLen = mix(0.2, 1.0, hqHash(vec2(row, seed)));
  float inLine = step(q.x, lineLen * size.x);
  float space = step(0.2, hqHash(vec2(cell * 1.7 + row * 13.1, seed + 3.0)));
  float box = pulseAA(fx, 0.14, 0.84) * pulseAA(fy, 0.28, 0.74);
  vec2 bitId = floor(vec2((fx - 0.14) / 0.7 * 3.0, (fy - 0.28) / 0.46 * 5.0));
  float bit = step(0.42, hqHash(vec2(cell * 7.0 + bitId.x, row * 11.0 + bitId.y) + seed));
  float detail = clamp(1.0 - fwidth(cellF) * 5.0, 0.0, 1.0) * step(0.5, uQuality);
  float glyph = box * mix(0.6, bit, detail);
  float age = clamp(q.y / size.y, 0.0, 1.0);
  float bright = mix(1.0, 0.3, age) * mix(0.55, 1.0, hqHash(vec2(row, seed + 9.0)));
  return glyph * space * inLine * bright;
}

// Segmented LED bar graph that breathes with activity.
float hudBars(vec2 q, vec2 size, float seed) {
  float n = 16.0;
  float xf = q.x / size.x * n;
  float i = floor(xf);
  float h = (0.12 + 0.88 * hqNoise(vec2(i * 0.73 + seed * 5.0, uTime * (0.3 + 0.6 * uActivity))))
    * (0.55 + 0.45 * uActivity);
  float top = h * size.y;
  float bar = pulseAA(fract(xf), 0.16, 0.84);
  float seg = pulseAA(fract(q.y / size.y * 14.0), 0.22, 1.0);
  float fill = (1.0 - smoothstep(top - 0.004, top, q.y)) * seg * mix(0.35, 1.0, q.y / size.y);
  float cap = 1.0 - smoothstep(0.0, 0.01, abs(q.y - top - 0.01));
  return bar * (fill + cap * 2.2);
}

// Scrolling line chart with a faint fill under the curve.
float hudWave(vec2 q, vec2 size, float seed) {
  float x = q.x / size.x;
  float v = hqNoise(vec2(x * 5.0 - uTime * 0.35, seed)) * 0.7 + hqNoise(vec2(x * 17.0 - uTime * 0.9, seed + 4.0)) * 0.3;
  float y = (0.15 + 0.7 * v) * size.y;
  float d = q.y - y;
  float line = 1.0 - smoothstep(0.6, 1.6, abs(d) / max(fwidth(d), 1e-5));
  float under = step(d, 0.0) * 0.12 * clamp(q.y / max(y, 1e-3), 0.0, 1.0);
  return line * 1.4 + under;
}

void main() {
  #include <logdepthbuf_fragment>
  vec2 p = vLocal;

  // Dark glass: a faint vertical gradient, a fresnel sheen and a static
  // view-dependent reflection streak so it reads as glass, not paint.
  float gy = clamp(p.y / uHalf.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(uBase, uGlass * 0.32, gy * 0.8);
  vec3 V = normalize(-vViewPos);
  float fres = pow(1.0 - clamp(abs(dot(normalize(vViewNormal), V)), 0.0, 1.0), 4.0);
  col += uEdge * fres * 0.45;
  float streak = smoothstep(0.55, 1.0, sin((p.x * 0.18 + p.y * 0.32) - V.x * 2.2 + 1.3));
  col += uEdge * streak * 0.035;

  // Faint LED-module seams every half metre.
  float seams = max(gridLine(p.x, 0.5, 0.35), gridLine(p.y, 0.5, 0.35));
  col *= 1.0 - seams * 0.35;

  // Red bleed near the bottom of the glass, like an LED wall lighting its trim.
  col += uDeep * 0.22 * smoothstep(-uHalf.y * 0.2, -uHalf.y, p.y);

  // Graticule inside the land rectangle.
  vec2 mapUv = (p - uMapRect.xy) / (uMapRect.zw - uMapRect.xy);
  float lon = mix(uGeo.x, uGeo.y, mapUv.x);
  float lat = mix(uGeo.z, uGeo.w, mapUv.y);
  vec2 mapEdge = min(mapUv, 1.0 - mapUv) * (uMapRect.zw - uMapRect.xy);
  float inMap = smoothstep(0.0, 0.05, min(mapEdge.x, mapEdge.y));
  float major = max(gridLine(lon, 30.0, 0.5), gridLine(lat, 20.0, 0.5));
  float minorFade = clamp(1.0 - fwidth(lon) * 1.5, 0.0, 1.0) * step(0.5, uQuality);
  float minor = max(gridLine(lon, 10.0, 0.35), gridLine(lat, 10.0, 0.35)) * minorFade;
  float axes = max(gridLine(lon + 180.0, 360.0, 0.8), gridLine(lat + 90.0, 180.0, 0.8));
  // Lines keep one pixel of width, so thin them out as the map gets small on
  // screen or the grid would outshine the land.
  float far = smoothstep(0.25, 1.2, fwidth(lon));
  float grat = (major * 0.3 + minor * 0.12 + axes * 0.4) * mix(1.0, 0.45, far);
  // A slow travelling pulse along the graticule keeps the grid alive.
  // 0.6981 rad/s is 400 cycles per hour, so the wrapped clock never jumps.
  float pulse = 0.75 + 0.25 * sin(lon * 0.06 - uTime * 0.6981317);
  col += uDeep * grat * inMap * pulse * (0.8 + 0.4 * uActivity);

  vec2 hs = uHalf - vec2(uFrameInset);

  // Data panels in the letterbox space beside the land (only on walls wider
  // than the map): a glyph log on top, a bar graph, and a line chart.
  float margin = uFrameInset * 1.6;
  float sideW = (uMapRect.x + hs.x) - margin * 2.0;
  float mapH = uMapRect.w - uMapRect.y;
  // The branch is uniform; inside it everything is masked, not branched, so
  // the derivatives the helpers take stay well defined.
  if (sideW > 0.35 && uHud > 0.5) {
    float left = step(-hs.x + margin, p.x) * step(p.x, uMapRect.x - margin);
    float right = step(uMapRect.z + margin, p.x) * step(p.x, hs.x - margin);
    float x0 = mix(uMapRect.z + margin, -hs.x + margin, step(p.x, 0.0));
    float seed = mix(7.0, 1.0, step(p.x, 0.0));
    vec2 q = vec2(p.x - x0, p.y - uMapRect.y);
    float feedY = mapH * 0.56;
    float barY = mapH * 0.27;
    float waveH = mapH * 0.21;
    float inFeed = step(feedY, q.y) * step(q.y, mapH);
    float inBars = step(barY, q.y) * step(q.y, mapH * 0.5);
    float inWave = step(0.0, q.y) * step(q.y, waveH);
    float hud = hudFeed(q - vec2(0.0, feedY), vec2(sideW, mapH - feedY), seed) * 0.8 * inFeed
      + hudBars(q - vec2(0.0, barY), vec2(sideW, mapH * 0.23), seed) * 0.7 * inBars
      + hudWave(q, vec2(sideW, waveH), seed) * inWave;
    // Hairline separators between the blocks.
    float sep = band(q.y - mapH * 0.535, 0.002) + band(q.y - mapH * 0.24, 0.002);
    col += uAccent * (hud * 0.9 + sep * 0.5) * (left + right);
  }

  // Glowing frame line with brighter corner brackets.
  float sd = sdBox(p, hs);
  vec2 fromCorner = hs - abs(p);
  float nearCorner = step(fromCorner.x, uHalf.y * 0.16) * step(fromCorner.y, uHalf.y * 0.16);
  float frame = band(sd, 0.0045);
  float bracket = band(sd + 0.004, 0.012) * nearCorner;
  // Saturated red carries a fifth of white's luminance, so bloom (threshold 1)
  // only catches the frame when it is pushed well above 1.
  col += uAccent * frame * 4.5;
  col += mix(uAccent, uHot, 0.2) * bracket * 8.0;

  // Ruler ticks just inside the frame: every 15 deg of longitude on top and
  // bottom, every 10 deg of latitude on the sides; majors are longer.
  float tickLen = uFrameInset * 0.9;
  float inTop = step(hs.y - tickLen, abs(p.y)) * step(abs(p.y), hs.y);
  float inSide = step(hs.x - tickLen * 0.8, abs(p.x)) * step(abs(p.x), hs.x);
  float lonInside = step(0.0, mapUv.x) * step(mapUv.x, 1.0);
  float latInside = step(0.0, mapUv.y) * step(mapUv.y, 1.0);
  float majorTop = step(hs.y - tickLen * 1.8, abs(p.y)) * step(abs(p.y), hs.y);
  float ticks = gridLine(lon, 15.0, 0.6) * inTop * lonInside
    + gridLine(lon, 45.0, 0.8) * majorTop * lonInside
    + gridLine(lat, 10.0, 0.6) * inSide * latInside;
  col += uAccent * min(ticks, 1.0) * 0.9;

  // The scan line lights the glass as it passes.
  float ds = p.y - uScanY;
  col += uAccent * (exp(-abs(ds) * 5.0) * 0.05 + exp(-ds * ds * 9000.0) * 0.7 * inMap);

  col *= uFlicker;
  gl_FragColor = vec4(col, 1.0);
  ${FRAG_OUTPUT}
  #include <fog_fragment>
}
`;

export function createPanelMaterial(shared: MapSharedUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "HqMapPanel",
    uniforms: withShared(shared, {
      uGeo: { value: new THREE.Vector4(MAP_LON_WEST, MAP_LON_EAST, MAP_LAT_SOUTH, MAP_LAT_NORTH) },
      uHalf: { value: new THREE.Vector2(1, 1) },
      uFrameInset: { value: 0.08 },
      uBase: { value: color(HQ_THEME.background) },
      uGlass: { value: color(HQ_THEME.glass) },
      uEdge: { value: color(HQ_THEME.glassEdge) },
      uAccent: { value: color(HQ_THEME.accent) },
      uDeep: { value: color(HQ_THEME.accentDeep) },
      uHot: { value: color(HQ_THEME.ledWarm) },
    }),
    vertexShader: PANEL_VERTEX,
    fragmentShader: PANEL_FRAGMENT,
    fog: true,
    toneMapped: false,
  });
}

// ---------------------------------------------------------- wall + floor glow

const GLOW_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
varying vec2 vLocal;
void main() {
  vLocal = position.xy;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

// One program for both glows. uMode 0: halo on the wall around the display
// (stronger toward the floor). uMode 1: light spill on the floor.
const GLOW_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform float uMode;
uniform float uActivity;
uniform float uFlicker;
uniform float uStrength;
uniform vec2 uHalf;
uniform vec2 uFloorSize;
uniform vec3 uAccent;
varying vec2 vLocal;
${FOG_KEEP}
float sdBox(vec2 p, vec2 b) {
  vec2 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}
void main() {
  #include <logdepthbuf_fragment>
  float g;
  if (uMode < 0.5) {
    float sd = max(sdBox(vLocal, uHalf), 0.0);
    float below = smoothstep(uHalf.y * 0.2, -uHalf.y * 1.2, vLocal.y);
    g = exp(-sd * mix(3.2, 1.3, below)) * mix(0.35, 1.0, below);
  } else {
    // vLocal.y runs from the wall (+half depth) into the room (-half depth).
    float fromWall = uFloorSize.y * 0.5 - vLocal.y;
    float across = abs(vLocal.x) / (uFloorSize.x * 0.5);
    g = exp(-fromWall * 0.75) * (1.0 - smoothstep(0.55, 1.0, across));
  }
  // Dither against banding in the long, dark gradients.
  float dither = (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  vec3 col = uAccent * (g * uStrength * (0.8 + 0.4 * uActivity) * uFlicker + dither);
  col *= hqFogKeep();
  gl_FragColor = vec4(max(col, 0.0), 1.0);
  ${FRAG_OUTPUT}
}
`;

export function createGlowMaterial(shared: MapSharedUniforms, mode: 0 | 1): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "HqMapGlow",
    uniforms: withShared(shared, {
      uMode: { value: mode },
      uStrength: { value: mode === 0 ? 0.05 : 0.1 },
      uHalf: { value: new THREE.Vector2(1, 1) },
      uFloorSize: { value: new THREE.Vector2(1, 1) },
      uAccent: { value: color(HQ_THEME.accent) },
    }),
    vertexShader: GLOW_VERTEX,
    fragmentShader: GLOW_FRAGMENT,
    fog: true,
    toneMapped: false,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}
