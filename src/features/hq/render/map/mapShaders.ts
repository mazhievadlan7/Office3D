import * as THREE from "three";
import { HQ_THEME } from "@/features/hq/core/config";
import {
  MAP_HOTSPOT_COUNT,
  MAP_LAT_NORTH,
  MAP_LAT_SOUTH,
  MAP_LON_EAST,
  MAP_LON_WEST,
} from "@/features/hq/render/map/mapProjection";

// All map materials are unlit, fog-aware, log-depth-aware ShaderMaterials with
// toneMapped off so HDR highlights (> 1) reach the bloom pass. Quality is a
// uniform, never a define, so switching it never recompiles a program.

const HOTSPOT_DEFINE = { HOTSPOT_COUNT: MAP_HOTSPOT_COUNT } as const;

const COMMON = /* glsl */ `
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
const FOG_KEEP = /* glsl */ `
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

const FRAG_OUTPUT = /* glsl */ `
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
  uReveal: THREE.IUniform<number>;
  uQuality: THREE.IUniform<number>;
  uMapRect: THREE.IUniform<THREE.Vector4>;
  /** Per hotspot: x, y (display-local metres), ripple phase, landing flash 0..1. */
  uHotspots: THREE.IUniform<THREE.Vector4[]>;
};

export function createSharedUniforms(): MapSharedUniforms {
  return {
    uTime: { value: 0 },
    uActivity: { value: 0 },
    uFlicker: { value: 1 },
    uScanY: { value: -1000 },
    uReveal: { value: 0 },
    uQuality: { value: 1 },
    uMapRect: { value: new THREE.Vector4(-1, -1, 1, 1) },
    uHotspots: { value: Array.from({ length: MAP_HOTSPOT_COUNT }, () => new THREE.Vector4()) },
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
  if (sideW > 0.35) {
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

// ------------------------------------------------------------------ land dots

const DOTS_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
attribute vec4 aDot;
uniform float uTime;
uniform float uActivity;
uniform float uFlicker;
uniform float uScanY;
uniform float uDotSize;
uniform float uRipple;
uniform float uReveal;
uniform vec4 uMapRect;
uniform vec4 uHotspots[HOTSPOT_COUNT];
varying vec2 vUv;
varying float vBright;
varying float vHot;
${COMMON}
void main() {
  vec2 mp = mix(uMapRect.xy, uMapRect.zw, aDot.xy);
  float seed = aDot.w;

  // Two octaves of slow drifting noise give the matrix its uneven brightness.
  float n1 = hqNoise(mp * 0.42 + vec2(uTime * 0.045, -uTime * 0.02));
  float n2 = hqNoise(mp * 1.9 - vec2(uTime * 0.12, uTime * 0.05));
  float b = (0.22 + 0.62 * n1 * n1 + 0.2 * n2) * mix(0.65, 1.0, seed);

  // Horizontal scan line sweeping down with a fading trail above it.
  float ds = mp.y - uScanY;
  float scan = exp(-ds * ds * 60.0) * 1.6 + step(0.0, ds) * exp(-ds * 2.2) * 0.35;

  // A few dots twinkle.
  float tw = step(0.94, seed) * pow(0.5 + 0.5 * sin(uTime * (1.1 + seed * 3.0) + seed * 97.0), 18.0);

  // Hotspots: steady glow, a repeating ripple, and a big ring when an arc lands.
  float hot = 0.0;
  for (int i = 0; i < HOTSPOT_COUNT; i++) {
    vec4 h = uHotspots[i];
    float d = distance(mp, h.xy);
    float ph = fract(uTime * 0.2 + h.z);
    float ring = (1.0 - ph) * exp(-sq((d - ph * uRipple) / (uDotSize * 1.8)));
    float glow = exp(-sq(d / (uDotSize * 2.6)));
    float fr = (1.0 - h.w) * uRipple * 1.7;
    float flash = h.w * exp(-sq((d - fr) / (uDotSize * 2.4)));
    hot += ring * 0.7 + glow * 1.6 + flash * 2.6;
  }

  // Boot-up reveal: the land wipes in from the top with a bright leading edge.
  float edgeV = 1.0 - aDot.y;
  float reveal = smoothstep(edgeV, edgeV + 0.06, uReveal * 1.1);
  float revealEdge = exp(-sq((uReveal * 1.1 - edgeV) * 18.0)) * step(uReveal, 0.999);

  vHot = hot;
  vBright = ((b * (0.8 + 0.4 * uActivity) + scan + tw * 2.2) * uFlicker + revealEdge * 2.0) * reveal;

  float size = uDotSize * mix(0.55, 1.0, aDot.z) * (1.0 + min(hot, 1.6) * 0.22) * reveal;
  vUv = position.xy + 0.5;
  // Lit dots lift off the glass a few millimetres for a touch of parallax.
  vec3 pos = vec3(mp + position.xy * size, min(hot + scan * 0.3, 2.0) * 0.012);
  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const DOTS_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform vec3 uAccent;
uniform vec3 uDeep;
uniform vec3 uHot;
varying vec2 vUv;
varying float vBright;
varying float vHot;
${FOG_KEEP}
void main() {
  #include <logdepthbuf_fragment>
  // Round SDF dot with a one-pixel edge centred on the rim at any zoom. When a
  // dot shrinks below a few pixels the ramp widens and alpha settles near its
  // mean coverage, so far-away land keeps its brightness without shimmering.
  float r = length(vUv - 0.5) * 2.0;
  float aa = max(fwidth(r), 1e-4);
  float a = clamp((1.0 - r) / aa + 0.5, 0.0, 1.0);
  if (a <= 0.001) discard;
  float core = 1.0 - smoothstep(0.0, 0.75, r);
  float lum = vBright + vHot;
  // Most dots stay deep red; only lit ones (scan, hotspots) reach full red and
  // then warm up past 1 for the bloom.
  vec3 col = mix(uDeep * 2.4, uAccent, smoothstep(0.3, 1.4, lum)) * lum * 0.85;
  col += uHot * smoothstep(1.3, 3.5, lum) * lum * 0.45 * core;
  col *= hqFogKeep();
  gl_FragColor = vec4(col, a);
  ${FRAG_OUTPUT}
}
`;

export function createDotsMaterial(shared: MapSharedUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "HqMapDots",
    defines: { ...HOTSPOT_DEFINE },
    uniforms: withShared(shared, {
      uDotSize: { value: 0.05 },
      uRipple: { value: 0.8 },
      uAccent: { value: color(HQ_THEME.accent) },
      uDeep: { value: color(HQ_THEME.accentDeep) },
      uHot: { value: color(HQ_THEME.ledWarm) },
    }),
    vertexShader: DOTS_VERTEX,
    fragmentShader: DOTS_FRAGMENT,
    fog: true,
    toneMapped: false,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

// ------------------------------------------------------------------- hotspots

const HOTSPOT_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
attribute float aIndex;
uniform float uSize;
uniform vec4 uHotspots[HOTSPOT_COUNT];
uniform float uReveal;
varying vec2 vUv;
varying float vPhase;
varying float vFlash;
void main() {
  vec4 h = uHotspots[int(aIndex + 0.5)];
  float s = uSize * (1.0 + h.w * 0.6) * smoothstep(0.85, 1.0, uReveal);
  vUv = position.xy + 0.5;
  vPhase = h.z;
  vFlash = h.w;
  vec4 mvPosition = modelViewMatrix * vec4(h.xy + position.xy * s, 0.01, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const HOTSPOT_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform float uActivity;
uniform float uFlicker;
uniform vec3 uAccent;
uniform vec3 uSoft;
uniform vec3 uHot;
varying vec2 vUv;
varying float vPhase;
varying float vFlash;
${FOG_KEEP}
float ringAt(float r, float radius, float width) {
  float x = (r - radius) / width;
  return exp(-x * x);
}
void main() {
  #include <logdepthbuf_fragment>
  vec2 q = (vUv - 0.5) * 2.0;
  float r = length(q);
  float aa = max(fwidth(r), 1e-4);
  if (r > 1.0) discard;
  float core = 1.0 - smoothstep(0.075 - aa, 0.075 + aa, r);
  float halo = exp(-r * r * 60.0);
  float ph = fract(uTime * 0.55 + vPhase);
  float pulse = ringAt(r, 0.14 + ph * 0.7, 0.03 + aa) * (1.0 - ph);
  float steady = ringAt(r, 0.2, 0.012 + aa) * 0.6;
  float flash = ringAt(r, 0.2 + (1.0 - vFlash) * 0.75, 0.05) * vFlash;
  // Four short crosshair ticks outside the steady ring.
  vec2 aq = abs(q);
  float crosshair = (step(aq.y, 0.012 + aa) * step(0.27, aq.x) * step(aq.x, 0.38)
    + step(aq.x, 0.012 + aa) * step(0.27, aq.y) * step(aq.y, 0.38)) * 0.7;
  float energy = 0.75 + 0.5 * uActivity;
  vec3 col = uHot * core * 7.0
    + uSoft * halo * 1.4
    + uAccent * (pulse * 1.8 + steady + crosshair) * energy
    + mix(uAccent, uHot, 0.4) * flash * 4.0;
  col *= uFlicker * hqFogKeep();
  gl_FragColor = vec4(col, 1.0);
  ${FRAG_OUTPUT}
}
`;

export function createHotspotMaterial(shared: MapSharedUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "HqMapHotspots",
    defines: { ...HOTSPOT_DEFINE },
    uniforms: withShared(shared, {
      uSize: { value: 0.6 },
      uAccent: { value: color(HQ_THEME.accent) },
      uSoft: { value: color(HQ_THEME.accentSoft) },
      uHot: { value: color(HQ_THEME.ledWarm) },
    }),
    vertexShader: HOTSPOT_VERTEX,
    fragmentShader: HOTSPOT_FRAGMENT,
    fog: true,
    toneMapped: false,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

// ----------------------------------------------------------------------- arcs

const ARC_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
attribute vec4 aEnds;
attribute vec4 aTiming;
uniform float uTime;
uniform float uWidth;
uniform float uLift;
uniform vec4 uMapRect;
varying float vT;
varying float vSide;
varying float vLife;
varying float vLen;

vec3 arcAt(vec2 a, vec2 b, vec2 c, float lift, float t) {
  vec2 p = mix(mix(a, c, t), mix(c, b, t), t);
  return vec3(p, 0.02 + sin(PI * t) * lift);
}

void main() {
  float t = position.x;
  float side = position.y;
  vT = t;
  vSide = side;
  vLife = -1.0;
  vLen = 1.0;
  if (aTiming.y <= 0.0) {
    // Free slot: collapse every vertex outside the clip volume.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 a = mix(uMapRect.xy, uMapRect.zw, aEnds.xy);
  vec2 b = mix(uMapRect.xy, uMapRect.zw, aEnds.zw);
  vec2 d = b - a;
  float len = max(length(d), 1e-3);
  vec2 n = vec2(-d.y, d.x) / len;
  vec2 c = 0.5 * (a + b) + n * len * aTiming.z;
  float lift = len * uLift;
  vec3 p = arcAt(a, b, c, lift, t);
  vec3 tangent = arcAt(a, b, c, lift, min(t + 0.004, 1.0)) - arcAt(a, b, c, lift, max(t - 0.004, 0.0));

  // Screen-facing ribbon: offset across the tangent and the view ray.
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  vec3 tv = (modelViewMatrix * vec4(tangent, 0.0)).xyz;
  vec3 across = cross(tv, mvPosition.xyz);
  float al = length(across);
  across = al > 1e-8 ? across / al : vec3(0.0, 1.0, 0.0);
  float taper = 0.55 + 0.45 * smoothstep(0.0, 0.06, t) * smoothstep(1.0, 0.94, t);
  mvPosition.xyz += across * side * uWidth * taper;

  vLife = (uTime - aTiming.x) / aTiming.y;
  vLen = len * (1.0 + abs(aTiming.z)) + lift;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const ARC_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform float uTail;
uniform float uSmooth;
uniform float uFade;
uniform float uIntensity;
uniform vec3 uAccent;
uniform vec3 uDeep;
uniform vec3 uHot;
varying float vT;
varying float vSide;
varying float vLife;
varying float vLen;
${FOG_KEEP}
void main() {
  #include <logdepthbuf_fragment>
  float behind = vLife - vT;
  if (behind < 0.0) discard;
  // Soft ribbon edges (hard on low quality).
  float e = 1.0 - abs(vSide);
  float edge = mix(step(0.35, e), e * e * (3.0 - 2.0 * e), uSmooth);
  // Comet tail behind the head, then a faint dashed trail that fades out after
  // the arc lands.
  float tail = mix(step(behind, uTail), 1.0 - smoothstep(0.0, uTail, behind), uSmooth);
  float after = max(vLife - 1.0, 0.0);
  float fadeOut = 1.0 - smoothstep(0.0, uFade, after - uTail * 0.5);
  float fadeIn = mix(1.0, smoothstep(0.0, 0.08, vLife), uSmooth);
  float along = vT * vLen;
  float dashPhase = fract(along * 4.0 - uTime * 1.6);
  float dash = smoothstep(0.0, 0.08, dashPhase) * (1.0 - smoothstep(0.42, 0.5, dashPhase));
  float trail = 0.16 + 0.22 * dash;
  float headGlow = exp(-behind * vLen * 14.0) * (1.0 - smoothstep(1.0, 1.04, vLife));
  vec3 col = uDeep * 2.4 * trail
    + uAccent * tail * 1.5 * (1.0 - smoothstep(1.0, 1.0 + uTail, vLife) * 0.6)
    + uHot * headGlow * 6.0;
  col *= edge * fadeOut * fadeIn * uIntensity * hqFogKeep();
  gl_FragColor = vec4(col, 1.0);
  ${FRAG_OUTPUT}
}
`;

export function createArcMaterial(shared: MapSharedUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "HqMapArcs",
    uniforms: withShared(shared, {
      uWidth: { value: 0.02 },
      uLift: { value: 0.07 },
      uTail: { value: 0.32 },
      uSmooth: { value: 1 },
      uFade: { value: 0.5 },
      uIntensity: { value: 1 },
      uAccent: { value: color(HQ_THEME.accent) },
      uDeep: { value: color(HQ_THEME.accentDeep) },
      uHot: { value: color(HQ_THEME.ledWarm) },
    }),
    vertexShader: ARC_VERTEX,
    fragmentShader: ARC_FRAGMENT,
    fog: true,
    toneMapped: false,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
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
