import * as THREE from "three";
import { HQ_THEME } from "@/features/hq/core/config";
import { GEO_BORDER_RANGE, GEO_COAST_RANGE, GEO_SHELF_RANGE } from "@/features/hq/render/map/mapGeo";
import {
  ARC_SAG_GLSL,
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

/** A number as a GLSL float literal (always with a decimal point or exponent). */
function glslFloat(value: number): string {
  const text = String(value);
  return /[.e]/.test(text) ? text : `${text}.0`;
}

const COMMON = /* glsl */ `
float sq(float x) { return x * x; }
// Map longitude/latitude (degrees) to a unit vector, like sun.ts mapDirection.
vec3 hqMapDir(float lonDeg, float latDeg) {
  float lon = radians(lonDeg);
  float lat = radians(latDeg);
  return vec3(cos(lat) * cos(lon), sin(lat), cos(lat) * sin(lon));
}
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

// Anti-aliased periodic line: 1 on lines every "spacing" units of "coord".
const GRID = /* glsl */ `
float gridLine(float coord, float spacing, float halfPx) {
  float w = max(fwidth(coord), 1e-5);
  float d = abs(fract(coord / spacing + 0.5) - 0.5) * spacing;
  return 1.0 - smoothstep(halfPx * w, (halfPx + 1.0) * w, d);
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
  /** Direction to the Sun right now (sun.ts): the map's real day and night. */
  uSunDir: THREE.IUniform<THREE.Vector3>;
  /** 1 draws the glyph panels beside the map; 0 leaves them to the screen hub's canvases. */
  uHud: THREE.IUniform<number>;
  /** Curvature of the display's arc (MapFit.arcK), for layers placed in their vertex shader. */
  uArcK: THREE.IUniform<number>;
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
    uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    uHud: { value: 1 },
    uArcK: { value: 0 },
  };
}

function withShared(
  shared: MapSharedUniforms,
  own: Record<string, THREE.IUniform>,
): Record<string, THREE.IUniform> {
  return { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...shared, ...own };
}

// ---------------------------------------------------------------- glass panel

// The glass is bent onto the display's arc on the CPU (mapGeometry.ts), which
// moves only z: position.xy stays the flat display-local metres, and the
// normal attribute carries the arc's.
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
  vViewNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

// The glass around the Earth: frame, ruler ticks, the fallback glyph panels.
// The Earth itself (and its graticule, day and night, scan) is its own surface
// in front of it (EARTH_FRAGMENT).
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
uniform vec4 uWings;
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
${GRID}

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
  col += uDeep * 0.22 * (1.0 - smoothstep(-uHalf.y, -uHalf.y * 0.2, p.y));

  // Where the land rectangle is, in degrees, for the ruler ticks.
  vec2 mapUv = (p - uMapRect.xy) / (uMapRect.zw - uMapRect.xy);
  float lon = mix(uGeo.x, uGeo.y, mapUv.x);
  float lat = mix(uGeo.z, uGeo.w, mapUv.y);

  vec2 hs = uHalf - vec2(uFrameInset);

  // Data panels in the letterbox space beside the land (only on walls wider
  // than the map): a glyph log on top, a bar graph, and a line chart.
  float margin = uFrameInset * 1.6;
  float sideW = (uMapRect.x + hs.x) - margin * 2.0;
  float mapH = uMapRect.w - uMapRect.y;
  // The branches are uniform; inside them everything is masked, not
  // branched, so the derivatives the helpers take stay well defined.
  if (sideW > 0.35) {
    // A hairline frame round the land, dividing the map from the wings.
    vec2 mapMid = (uMapRect.xy + uMapRect.zw) * 0.5;
    vec2 mapHalf = (uMapRect.zw - uMapRect.xy) * 0.5 + vec2(margin * 0.5);
    col += uAccent * band(sdBox(p - mapMid, mapHalf), 0.003) * 2.0;
  }
  if (uWings.w > 0.5) {
    // The screen hub's panels tile the wings (mapWings.ts): a rule under their title row.
    float ax = abs(p.x);
    col += uAccent * band(p.y - uWings.z, 0.002) * step(uWings.x, ax) * step(ax, uWings.y) * 0.9;
  }
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

  // The scan line's soft glow on the glass as it passes.
  float ds = p.y - uScanY;
  col += uAccent * exp(-abs(ds) * 5.0) * 0.05;

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
      // |x| where the wings begin and end, the y of their title rule, and 1 while the hub's panels are on them.
      uWings: { value: new THREE.Vector4(0, 0, 0, 0) },
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

// ---------------------------------------------------------------------- earth

/**
 * How dark the night side gets (1 = as bright as day), and the twilight: the
 * night side fades in over EARTH_TWILIGHT of the Sun's height (sin of its
 * elevation), so the terminator is a wide, soft shading, never a line.
 */
export const EARTH_NIGHT_LEVEL = 0.4;
export const EARTH_TWILIGHT: readonly [number, number] = [-0.25, 0.3];
/** City lights switch on over this range of the Sun's height. */
export const EARTH_LIGHTS_ON: readonly [number, number] = [-0.14, 0.1];

// Terrain palette, like a real operations-centre wall: a near-black ocean,
// graphite continents lit by warm orange city lights, red only on the live
// markers and the arcs between them.
const EARTH_COLORS = {
  ocean: "#030304",
  shelf: "#0b0c0f",
  landLow: "#15161a",
  landMid: "#1f2025",
  landHigh: "#2b2c32",
  landPeak: "#3d3e45",
  cityWarm: "#ff8c32",
  cityCore: "#ffe6b0",
} as const;

/**
 * Arcs between busy cities (indices into MAP_HOTSPOTS): mostly neighbouring
 * regions, the way traffic between them is drawn on a real wall.
 */
const MAP_ARCS: ReadonlyArray<readonly [number, number]> = [
  [0, 7], // New York - London
  [1, 0], // Los Angeles - New York
  [4, 0], // Mexico City - New York
  [3, 7], // Toronto - London
  [5, 8], // Sao Paulo - Paris
  [6, 5], // Buenos Aires - Sao Paulo
  [7, 10], // London - Moscow
  [9, 11], // Berlin - Istanbul
  [8, 13], // Paris - Cairo
  [10, 19], // Moscow - Beijing
  [12, 16], // Dubai - Mumbai
  [13, 14], // Cairo - Lagos
  [15, 12], // Johannesburg - Dubai
  [16, 17], // Mumbai - Singapore
  [18, 20], // Hong Kong - Tokyo
  [17, 21], // Singapore - Sydney
];

const ARCS_GLSL = /* glsl */ `
const int HQ_ARC_COUNT = ${MAP_ARCS.length};
const ivec2 HQ_ARCS[${MAP_ARCS.length}] = ivec2[${MAP_ARCS.length}](${MAP_ARCS.map(([a, b]) => `ivec2(${a}, ${b})`).join(", ")});

// The arcs: circular arcs bowed north from the chord between two markers, a
// dim red line with a bright pulse running from one end to the other.
vec3 hqArcs(vec2 p, float width) {
  vec3 acc = vec3(0.0);
  float px = max(max(fwidth(p.x), fwidth(p.y)), 1e-4);
  float w = max(width, px * 0.8);
  for (int k = 0; k < HQ_ARC_COUNT; k++) {
    vec2 a = uHotspots[HQ_ARCS[k].x].xy;
    vec2 b = uHotspots[HQ_ARCS[k].y].xy;
    vec2 ch = b - a;
    float len = max(length(ch), 1e-3);
    vec2 u = ch / len;
    vec2 n = vec2(-u.y, u.x);
    if (n.y < 0.0) n = -n;
    float sag = len * 0.22;
    vec2 mid = (a + b) * 0.5;
    vec2 d = p - mid;
    float side = dot(d, n);
    float along = dot(d, u);
    // Outside the arc's own box: nothing to draw.
    // Nothing below the chord (the circle's far side) or outside the arc's box.
    if (side < -w * 2.0 || side > sag + w * 6.0 || abs(along) > 0.5 * len + w * 6.0) continue;
    float radius = (sag * sag + 0.25 * len * len) / (2.0 * sag);
    vec2 c = mid - n * (radius - sag);
    float dist = abs(length(p - c) - radius);
    float line = exp(-sq(dist / w));
    float halo = exp(-dist / (w * 6.0));
    float t = clamp(along / len + 0.5, 0.0, 1.0);
    // 0.12 cycles/s: a whole number of them in the wrapped clock's hour.
    float head = fract(uTime * 0.12 + float(k) * 0.37);
    float pulse = exp(-sq((t - head) * 16.0));
    float trail = smoothstep(head - 0.4, head, t) * step(t, head);
    acc += uAccent * (line * (0.3 + 0.9 * trail) + halo * 0.12) + uCityCore * line * pulse * 1.8;
  }
  return acc;
}
`;

const EARTH_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
varying vec2 vLocal;
varying vec3 vViewPos;
varying vec3 vViewNormal;
void main() {
  vUv = uv;
  // The plane is built in display-local metres and bent in z only (mapGeometry.ts).
  vLocal = position.xy;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mvPosition.xyz;
  vViewNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const EARTH_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform float uActivity;
uniform float uFlicker;
uniform float uScanY;
uniform float uReveal;
uniform float uQuality;
uniform vec4 uMapRect;
uniform vec4 uHotspots[HOTSPOT_COUNT];
uniform vec3 uSunDir;
uniform sampler2D uGeoMap;
uniform sampler2D uDayMap;
uniform sampler2D uNightMap;
uniform float uDayMix;
uniform float uNightMix;
uniform float uSpot;
uniform vec2 uHalf;
uniform vec3 uBase;
uniform vec3 uGlass;
uniform vec3 uEdge;
uniform vec3 uAccent;
uniform vec3 uDeep;
uniform vec3 uOcean;
uniform vec3 uShelf;
uniform vec3 uLandLow;
uniform vec3 uLandMid;
uniform vec3 uLandHigh;
uniform vec3 uLandPeak;
uniform vec3 uCityWarm;
uniform vec3 uCityCore;
varying vec2 vUv;
varying vec2 vLocal;
varying vec3 vViewPos;
varying vec3 vViewNormal;
${COMMON}
${GRID}
${ARCS_GLSL}

const float HQ_LON_W = ${glslFloat(MAP_LON_WEST)};
const float HQ_LON_E = ${glslFloat(MAP_LON_EAST)};
const float HQ_LAT_S = ${glslFloat(MAP_LAT_SOUTH)};
const float HQ_LAT_N = ${glslFloat(MAP_LAT_NORTH)};
const float HQ_COAST_RANGE = ${glslFloat(GEO_COAST_RANGE)};
const float HQ_SHELF_RANGE = ${glslFloat(GEO_SHELF_RANGE)};
const float HQ_BORDER_RANGE = ${glslFloat(GEO_BORDER_RANGE)};
const float HQ_NIGHT_LEVEL = ${glslFloat(EARTH_NIGHT_LEVEL)};
const float HQ_TWILIGHT_0 = ${glslFloat(EARTH_TWILIGHT[0])};
const float HQ_TWILIGHT_1 = ${glslFloat(EARTH_TWILIGHT[1])};
const float HQ_LIGHTS_0 = ${glslFloat(EARTH_LIGHTS_ON[0])};
const float HQ_LIGHTS_1 = ${glslFloat(EARTH_LIGHTS_ON[1])};
// Pitch of the display's LED pixels, metres (seen only up close).
const float HQ_LED_PITCH = 0.006;

// Relief for the look without imagery: domain-warped ridged value noise.
float hqRidge(vec2 p) {
  float n = 1.0 - abs(hqNoise(p) * 2.0 - 1.0);
  return n * n;
}
float hqRelief(vec2 p) {
  vec2 warp = vec2(hqNoise(p * 0.5 + vec2(3.1, 1.7)), hqNoise(p * 0.5 + vec2(7.7, 4.3)));
  p += (warp - 0.5) * 0.6;
  float s = 0.0;
  float a = 0.55;
  // Each octave is turned about 37 degrees so the value noise's grid never shows as streaks.
  mat2 turn = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 4; i++) {
    s += a * hqRidge(p);
    p = turn * p + vec2(1.3, 2.9);
    a *= 0.48;
  }
  return s;
}

vec3 hqLandRamp(float t) {
  vec3 c = mix(uLandLow, uLandMid, smoothstep(0.0, 0.45, t));
  c = mix(c, uLandHigh, smoothstep(0.42, 0.8, t));
  return mix(c, uLandPeak, smoothstep(0.8, 1.0, t));
}

void main() {
  #include <logdepthbuf_fragment>
  vec2 mapUv = vUv;
  // Every map texture keeps north on its first row.
  vec2 tuv = vec2(mapUv.x, 1.0 - mapUv.y);
  float lon = mix(HQ_LON_W, HQ_LON_E, mapUv.x);
  float lat = mix(HQ_LAT_S, HQ_LAT_N, mapUv.y);

  // Boot-up reveal: the Earth wipes in from the top behind a bright edge.
  float edgeV = 1.0 - mapUv.y;
  float wipe = uReveal * 1.1;
  float reveal = smoothstep(edgeV, edgeV + 0.06, wipe);
  float revealEdge = exp(-sq((wipe - edgeV) * 18.0)) * step(0.0005, uReveal) * step(uReveal, 0.999);

  // Vector data (mapGeo.ts): distances in degrees to the coast and borders.
  vec4 geo = texture2D(uGeoMap, tuv);
  float coastD = (geo.r - 0.5) * (2.0 * HQ_COAST_RANGE);
  float shelfD = geo.g * geo.g * HQ_SHELF_RANGE;
  float borderD = geo.b * HQ_BORDER_RANGE;
  // Degrees per pixel along the field: every line below stays one pixel wide.
  float coastW = max(fwidth(coastD), 1e-4);
  float land = smoothstep(-0.5 * coastW, 0.5 * coastW, coastD);
  float landShown = land * reveal;

  // Day imagery: its luma is albedo with NASA's shaded relief and bathymetry;
  // the gap to a blurrier mip is a high-pass that brings the relief out.
  float dayL = texture2D(uDayMap, tuv).r;
  float dayMean = texture2D(uDayMap, tuv, 3.0).r;
  float relief = dayL - dayMean;
  float imgLand = clamp(dayL * 1.05 + relief * 1.8, 0.0, 1.0);
  float imgSea = clamp((dayL - 0.07) * 2.2 + relief * 1.2, 0.0, 1.0);

  // Without imagery: noise relief lit from the north-west, lowlands along the
  // coasts, and seas that deepen away from them. Skipped once imagery is in.
  float procLand = 0.0;
  float procSea = 0.0;
  if (uDayMix < 0.999) {
    vec2 q = vec2(lon, lat) * 0.075;
    float h0 = hqRelief(q);
    float hx = hqRelief(q + vec2(0.035, 0.0));
    float hy = hqRelief(q + vec2(0.0, 0.035));
    float shade = clamp(0.5 - ((hx - h0) * -0.6 + (hy - h0) * 0.8) * 9.0, 0.0, 1.0);
    float inland = smoothstep(0.1, 5.0, shelfD);
    procLand = clamp(0.1 + 0.42 * h0 * h0 * inland + (shade - 0.5) * 0.55 * (0.4 + 0.6 * inland) + 0.06 * inland, 0.0, 1.0);
    procSea = 0.62 * exp(-shelfD * 1.4) + 0.2 * exp(-shelfD * 0.25);
  }
  float landT = mix(procLand, imgLand, uDayMix);
  float seaT = mix(procSea, imgSea, uDayMix) * reveal;

  vec3 col = mix(mix(uOcean, uShelf, seaT * seaT), hqLandRamp(landT), landShown);

  // Real time: the Sun lights the day side; the night side dims through a
  // wide, soft twilight. Deliberately no line or band at the terminator.
  float sunDot = dot(hqMapDir(lon, lat), uSunDir);
  float daylight = smoothstep(HQ_TWILIGHT_0, HQ_TWILIGHT_1, sunDot);
  col *= mix(HQ_NIGHT_LEVEL, 1.0, daylight) * (0.94 + 0.12 * clamp(sunDot, 0.0, 1.0));
  float dim = mix(0.6, 1.0, daylight);

  // Coastline: a faint one-pixel grey line, the continents' edge in the dark.
  float coastLine = 1.0 - smoothstep(0.4 * coastW, 1.2 * coastW, abs(coastD));
  float seaGlow = (1.0 - land) * exp(-shelfD * 1.8);
  col += uLandPeak * coastLine * 0.9 * reveal;
  col += uAccent * seaGlow * 0.02 * reveal * dim;

  // Land borders, fainter than the coast.
  float borderW = max(fwidth(borderD), 1e-4);
  float border = (1.0 - smoothstep(0.35 * borderW, 1.1 * borderW, borderD)) * land;
  col += uLandPeak * border * 0.35 * reveal;

  // City lights, warm orange, brightest on the night side but lit everywhere
  // (a wall display, not a photograph): NASA's Black Marble when it is here,
  // otherwise the metro glows broken into towns by noise.
  vec2 gq = mapUv * vec2(720.0, 272.0);
  float grainOn = clamp(1.6 - fwidth(gq.x) * 1.2, 0.0, 1.0);
  float grain = mix(0.6, 0.2 + 1.4 * hqNoise(gq) * hqNoise(gq * 2.3 + 5.1), grainOn);
  float city = mix(geo.a * grain, texture2D(uNightMap, tuv).r, uNightMix);
  city = min(city, 1.2) * smoothstep(-0.05, 0.02, coastD) * reveal;
  float nightSide = 1.0 - smoothstep(HQ_LIGHTS_0, HQ_LIGHTS_1, sunDot);
  // A slow shimmer; 0.6981 rad/s is 400 cycles per hour, so the wrapped clock never jumps.
  float shimmer = 0.9 + 0.1 * sin(uTime * 0.6981317 + hqNoise(mapUv * vec2(90.0, 34.0)) * 6.2831853);
  float lightsOn = mix(0.55, 1.0, nightSide) * shimmer * (0.85 + 0.3 * uActivity);
  col += (uCityWarm * city * 1.5 + uCityCore * smoothstep(0.5, 1.0, city) * 1.1) * lightsOn;

  // Graticule, fainter over land; a slow pulse travels along it.
  float major = max(gridLine(lon, 30.0, 0.5), gridLine(lat, 20.0, 0.5));
  float minorFade = clamp(1.0 - fwidth(lon) * 1.5, 0.0, 1.0) * step(0.5, uQuality);
  float minor = max(gridLine(lon, 10.0, 0.35), gridLine(lat, 10.0, 0.35)) * minorFade;
  // Lines keep one pixel of width, so thin them out as the map gets small on screen.
  float far = smoothstep(0.25, 1.2, fwidth(lon));
  float grat = (major * 0.5 + minor * 0.18) * mix(1.0, 0.45, far) * mix(1.0, 0.5, landShown);
  float pulse = 0.85 + 0.15 * sin(lon * 0.06 - uTime * 0.6981317);
  col += uDeep * grat * pulse * (0.2 + 0.08 * uActivity);

  // Under each live marker a red glow on the surface.
  float hot = 0.0;
  float reach = uSpot * 6.0;
  for (int i = 0; i < HOTSPOT_COUNT; i++) {
    vec2 dv = vLocal - uHotspots[i].xy;
    float d2 = dot(dv, dv);
    if (d2 > reach * reach) continue;
    hot += exp(-d2 / sq(uSpot * 2.2));
  }
  col += uAccent * hot * 0.45 * (0.8 + 0.4 * uActivity) * smoothstep(0.85, 1.0, uReveal);

  // The arcs between the markers, over the land and sea.
  col += hqArcs(vLocal, uSpot * 0.16) * (0.8 + 0.4 * uActivity) * smoothstep(0.85, 1.0, uReveal);

  // The scan: a thin line sweeping down that briefly lifts what it passes.
  float ds = vLocal.y - uScanY;
  float scanW = max(fwidth(vLocal.y) * 1.2, 0.004);
  float scanTrail = step(0.0, ds) * exp(-ds * 2.4);
  col *= 1.0 + scanTrail * 0.4 * reveal;
  col += uAccent * (exp(-sq(ds / scanW)) * 0.5 + revealEdge * 0.9);

  // The display's own structure, seen only up close: LED pixels (once they
  // span a couple of screen pixels, so they never shimmer; brightness-neutral
  // on average) and the half-metre module seams the rest of the glass has.
  // From across the room the seams would lay a tile grid over the Earth.
  vec2 cell = vLocal / HQ_LED_PITCH;
  float ledOn = clamp(1.0 - max(fwidth(cell.x), fwidth(cell.y)) * 2.0, 0.0, 1.0);
  vec2 wave = 0.5 - 0.5 * cos(cell * 6.2831853);
  col *= 1.0 + ledOn * 0.9 * (wave.x * wave.y - 0.25);
  float seamNear = 1.0 - smoothstep(0.004, 0.01, max(fwidth(vLocal.x), fwidth(vLocal.y)));
  float seams = max(gridLine(vLocal.x, 0.5, 0.35), gridLine(vLocal.y, 0.5, 0.35)) * seamNear;
  col *= 1.0 - seams * 0.35;

  // Melt the edges into the glass around the map (the panel's own gradient and bleed).
  float gy = clamp(vLocal.y / uHalf.y * 0.5 + 0.5, 0.0, 1.0);
  float bleed = 1.0 - smoothstep(-uHalf.y, -uHalf.y * 0.2, vLocal.y);
  vec3 glass = mix(uBase, uGlass * 0.32, gy * 0.8) + uDeep * 0.22 * bleed;
  col += uDeep * 0.12 * bleed;
  vec2 edge = min(mapUv, 1.0 - mapUv) * (uMapRect.zw - uMapRect.xy);
  col = mix(glass, col, smoothstep(0.0, 0.05, min(edge.x, edge.y)));

  // Glass on top: the same fresnel sheen and reflection streak as the panel.
  vec3 V = normalize(-vViewPos);
  float fres = pow(1.0 - clamp(abs(dot(normalize(vViewNormal), V)), 0.0, 1.0), 4.0);
  float streak = smoothstep(0.55, 1.0, sin((vLocal.x * 0.18 + vLocal.y * 0.32) - V.x * 2.2 + 1.3));
  col += uEdge * (fres * 0.45 + streak * 0.035);

  col *= uFlicker;
  gl_FragColor = vec4(col, 1.0);
  ${FRAG_OUTPUT}
  #include <fog_fragment>
}
`;

export type EarthMaps = { geo: THREE.Texture; day: THREE.Texture; night: THREE.Texture };

export function createEarthMaterial(shared: MapSharedUniforms, maps: EarthMaps): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "HqMapEarth",
    defines: { ...HOTSPOT_DEFINE },
    uniforms: withShared(shared, {
      uGeoMap: { value: maps.geo },
      uDayMap: { value: maps.day },
      uNightMap: { value: maps.night },
      uDayMix: { value: 0 },
      uNightMix: { value: 0 },
      uSpot: { value: 0.04 },
      uHalf: { value: new THREE.Vector2(1, 1) },
      uBase: { value: color(HQ_THEME.background) },
      uGlass: { value: color(HQ_THEME.glass) },
      uEdge: { value: color(HQ_THEME.glassEdge) },
      uAccent: { value: color(HQ_THEME.accent) },
      uDeep: { value: color(HQ_THEME.accentDeep) },
      uOcean: { value: color(EARTH_COLORS.ocean) },
      uShelf: { value: color(EARTH_COLORS.shelf) },
      uLandLow: { value: color(EARTH_COLORS.landLow) },
      uLandMid: { value: color(EARTH_COLORS.landMid) },
      uLandHigh: { value: color(EARTH_COLORS.landHigh) },
      uLandPeak: { value: color(EARTH_COLORS.landPeak) },
      uCityWarm: { value: color(EARTH_COLORS.cityWarm) },
      uCityCore: { value: color(EARTH_COLORS.cityCore) },
    }),
    vertexShader: EARTH_VERTEX,
    fragmentShader: EARTH_FRAGMENT,
    fog: true,
    toneMapped: false,
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
uniform float uArcK;
varying vec2 vUv;
varying float vPhase;
${ARC_SAG_GLSL}
void main() {
  vec4 h = uHotspots[int(aIndex + 0.5)];
  float s = uSize * smoothstep(0.85, 1.0, uReveal);
  vUv = position.xy + 0.5;
  vPhase = h.z;
  // Placed on the display's arc like every other layer (mapGeometry.ts bends those on the CPU).
  vec2 at = h.xy + position.xy * s;
  vec4 mvPosition = modelViewMatrix * vec4(at, 0.01 + hqArcSag(uArcK, at.x), 1.0);
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
  // A small crisp point with a thin ring and crosshair ticks, breathing
  // softly: a target marker, not a glowing orb.
  float core = 1.0 - smoothstep(0.1 - aa, 0.1 + aa, r);
  float halo = exp(-r * r * 140.0);
  float breath = 0.8 + 0.2 * sin(uTime * 1.6 + vPhase * 6.2831853);
  float steady = ringAt(r, 0.34, 0.018 + aa) * 0.55;
  vec2 aq = abs(q);
  float crosshair = (step(aq.y, 0.02 + aa) * step(0.46, aq.x) * step(aq.x, 0.66)
    + step(aq.x, 0.02 + aa) * step(0.46, aq.y) * step(aq.y, 0.66)) * 0.45;
  float energy = 0.75 + 0.5 * uActivity;
  vec3 col = uHot * core * 3.2 * breath
    + uSoft * halo * 0.5
    + uAccent * (steady + crosshair) * energy;
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

// ---------------------------------------------------------- wall + floor glow

// Both glows are bent (or laid along the arc) on the CPU, so their own
// display-local metres ride in the uv attribute (mapGeometry.ts).
const GLOW_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
varying vec2 vLocal;
void main() {
  vLocal = uv;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

// One program for both glows. uMode 0: halo on the case's face around the
// display (stronger toward the floor), with the case's steady LED line at
// the walls' skirt height. uMode 1: light spill on the floor.
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
uniform vec2 uFootLine;
uniform vec3 uAccent;
varying vec2 vLocal;
${FOG_KEEP}
float sdBox(vec2 p, vec2 b) {
  vec2 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}
// A 2.5 cm LED line at height "at", like the walls' own lines. Past a pixel
// it widens and dims by as much, so far away it never breaks up or blooms more.
float hqLedLine(float y, float at) {
  float px = max(fwidth(y), 1e-5);
  float hw = max(0.0125, px * 0.75);
  return (1.0 - smoothstep(hw - px * 0.5, hw + px * 0.5, abs(y - at))) * (0.0125 / hw);
}
void main() {
  #include <logdepthbuf_fragment>
  float g;
  float led = 0.0;
  if (uMode < 0.5) {
    float sd = max(sdBox(vLocal, uHalf), 0.0);
    float below = smoothstep(uHalf.y * 0.2, -uHalf.y * 1.2, vLocal.y);
    g = exp(-sd * mix(3.2, 1.3, below)) * mix(0.35, 1.0, below);
    led = hqLedLine(vLocal.y, uFootLine.x) * uFootLine.y;
  } else {
    // vLocal.y runs from the case's foot (+half depth) into the room (-half depth).
    float fromWall = uFloorSize.y * 0.5 - vLocal.y;
    float across = abs(vLocal.x) / (uFloorSize.x * 0.5);
    g = exp(-fromWall * 0.75) * (1.0 - smoothstep(0.55, 1.0, across));
  }
  // Dither against banding in the long, dark gradients.
  float dither = (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  // The LED lines stay steady: the display's flicker and activity are its own.
  vec3 col = uAccent * (g * uStrength * (0.8 + 0.4 * uActivity) * uFlicker + led + dither);
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
      // The case's LED line (halo only): its y and its glow (0 = none).
      uFootLine: { value: new THREE.Vector2(0, 0) },
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

/** For tests: the GLSL of the surfaces that draw day and night. */
export const MAP_SHADER_SOURCES = { panel: PANEL_FRAGMENT, earth: EARTH_FRAGMENT } as const;
