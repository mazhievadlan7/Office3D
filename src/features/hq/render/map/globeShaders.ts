import * as THREE from "three";
import { HQ_THEME } from "@/features/hq/core/config";
import { COMMON, FOG_KEEP, FRAG_OUTPUT } from "@/features/hq/render/map/mapShaders";
import {
  MAP_HOTSPOT_COUNT,
  MAP_LAT_NORTH,
  MAP_LAT_SOUTH,
  MAP_LON_EAST,
  MAP_LON_WEST,
} from "@/features/hq/render/map/mapProjection";

// The holographic Earth in front of the map wall. Every material is unlit,
// fog- and log-depth-aware, with tone mapping off so highlights reach bloom.
//
// Earth frame = the globe mesh's object space, matching three's SphereGeometry
// UVs (u = 0 at longitude -180, v = 0 at the south pole): a direction for
// (lon, lat) is x = -cos(lon + 180) cos(lat), y = sin(lat),
// z = sin(lon + 180) cos(lat). globeDirection() below is the same in TS.

/** Unit vector for a longitude/latitude (degrees) in the globe's frame. */
export function globeDirection(lonDeg: number, latDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const phi = THREE.MathUtils.degToRad(lonDeg + 180);
  const lat = THREE.MathUtils.degToRad(latDeg);
  return out.set(-Math.cos(phi) * Math.cos(lat), Math.sin(lat), Math.sin(phi) * Math.cos(lat));
}

/** The subsolar point (degrees) at a moment, accurate to a fraction of a degree. */
export function subsolarPoint(ms: number): { lon: number; lat: number } {
  const days = ms / 86400000 - 10957.5; // days since J2000.0
  const g = THREE.MathUtils.degToRad((357.529 + 0.98560028 * days) % 360);
  const q = (280.459 + 0.98564736 * days) % 360;
  const L = THREE.MathUtils.degToRad(q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
  const e = THREE.MathUtils.degToRad(23.439 - 0.00000036 * days);
  const decl = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const eqTimeMin = 4 * (q - THREE.MathUtils.radToDeg(ra) - 360 * Math.round((q - THREE.MathUtils.radToDeg(ra)) / 360));
  const utcMin = (ms % 86400000) / 60000;
  const lon = -((utcMin + eqTimeMin) / 4 - 180);
  return { lon: ((lon + 540) % 360) - 180, lat: THREE.MathUtils.radToDeg(decl) };
}

function color(hex: string, k = 1): THREE.Color {
  return new THREE.Color(hex).multiplyScalar(k);
}

const DIRECTION_GLSL = /* glsl */ `
vec3 hqGlobeDir(float lonDeg, float latDeg) {
  float phi = radians(lonDeg + 180.0);
  float lat = radians(latDeg);
  return vec3(-cos(phi) * cos(lat), sin(lat), sin(phi) * cos(lat));
}
`;

// ------------------------------------------------------------------------- surface
const SURFACE_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
varying vec3 vN;
varying vec3 vViewN;
varying vec3 vViewPos;
void main() {
  vUv = uv;
  vN = normalize(position);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mvPosition.xyz;
  vViewN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const SURFACE_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uLand;
uniform float uLandReady;
uniform vec3 uSunDir;
uniform float uTime;
uniform float uActivity;
uniform float uFlicker;
uniform float uQuality;
uniform vec4 uCities[HOTSPOT_COUNT];
uniform vec3 uOcean;
uniform vec3 uDeep;
uniform vec3 uAccent;
uniform vec3 uHot;
uniform vec3 uCity;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vViewN;
varying vec3 vViewPos;
${COMMON}

float landAt(vec2 uv) {
  float lat = uv.y * 180.0 - 90.0;
  float mv = (${MAP_LAT_NORTH.toFixed(1)} - lat) / ${(MAP_LAT_NORTH - MAP_LAT_SOUTH).toFixed(1)};
  float inside = step(0.0, mv) * step(mv, 1.0);
  return texture2D(uLand, vec2(uv.x, clamp(mv, 0.0, 1.0))).r * inside * uLandReady;
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vN);
  float lon = vUv.x * 360.0 - 180.0;
  float lat = vUv.y * 180.0 - 90.0;
  float sun = dot(n, uSunDir);
  float day = smoothstep(-0.1, 0.25, sun);
  float night = 1.0 - smoothstep(-0.25, 0.05, sun);

  // Dot matrix: rows every 0.8 degrees of latitude, dots evenly spaced along
  // each row on the sphere, each lit by the land under its centre.
  float dLat = 0.8;
  float row = floor((lat + 90.0) / dLat);
  float latC = -90.0 + (row + 0.5) * dLat;
  float dLon = dLat / max(cos(radians(latC)), 0.06);
  float col = floor((lon + 180.0) / dLon);
  float lonC = -180.0 + (col + 0.5) * dLon;
  vec2 cellUv = vec2((lonC + 180.0) / 360.0, (latC + 90.0) / 180.0);
  float landCell = step(0.5, landAt(cellUv));
  vec2 dd = vec2((lon - lonC) * cos(radians(lat)), lat - latC);
  float d = length(dd);
  float aa = max(fwidth(d), 1e-4);
  float dotShape = 1.0 - smoothstep(0.26 - aa, 0.26 + aa, d);
  // Far away the dots merge into their average coverage instead of shimmering.
  float resolve = 1.0 - smoothstep(0.12, 0.3, aa);
  float landSmooth = landAt(vUv);
  float dots = mix(landSmooth * 0.33, landCell * dotShape, resolve);

  vec3 col3 = uOcean * (0.6 + 0.8 * day);
  // Ocean: a faint latitude/longitude graticule every 15 degrees.
  vec2 g = vec2(lon, lat) / 15.0;
  vec2 gw = fwidth(g) * 1.2;
  vec2 gl = 1.0 - smoothstep(vec2(0.0), gw, abs(fract(g + 0.5) - 0.5));
  col3 += uDeep * max(gl.x, gl.y) * 0.22 * (1.0 - landSmooth);

  // Land: a dim fill, a coastline, and the dots, brighter on the day side.
  col3 += uDeep * landSmooth * (0.18 + 0.5 * day);
  float coast = exp(-abs(landSmooth - 0.5) * 9.0) * step(0.02, landSmooth) * step(landSmooth, 0.98);
  col3 += uAccent * coast * (0.35 + 0.5 * day);
  col3 += mix(uDeep * 1.6, uAccent * 1.9, day) * dots;

  // City lights on the night side: a share of land dots glow warm and flicker.
  float cityHash = hqHash(vec2(row, col) * 0.37);
  float city = landCell * step(0.82, cityHash) * mix(landSmooth * 0.2, dotShape, resolve);
  float flick = 0.8 + 0.2 * sin(uTime * (2.0 + cityHash * 6.0) + cityHash * 40.0);
  col3 += uCity * city * night * flick * (1.6 + 1.4 * uActivity);

  // Hotspot cities: a steady core, a ripple, and a flash when an arc lands.
  for (int i = 0; i < HOTSPOT_COUNT; i++) {
    vec4 c = uCities[i];
    float a = acos(clamp(dot(n, c.xyz), -1.0, 1.0));
    float core = exp(-a * 160.0);
    float ph = fract(uTime * 0.45 + float(i) * 0.618);
    float ripple = exp(-abs(a - ph * 0.09) * 260.0) * (1.0 - ph);
    col3 += uHot * core * 3.2 + uAccent * ripple * 1.4 + uHot * c.w * exp(-a * 45.0) * 3.0;
  }

  // The terminator glows faintly; a scan band sweeps down the globe.
  col3 += uAccent * exp(-abs(sun) * 30.0) * 0.35;
  float scanLat = 90.0 - mod(uTime * 14.0, 220.0);
  col3 += uAccent * exp(-abs(lat - scanLat) * 0.7) * 0.25 * (0.4 + landSmooth);

  // Atmosphere: a red fresnel rim on the lit limb.
  vec3 V = normalize(-vViewPos);
  float rim = pow(1.0 - clamp(dot(normalize(vViewN), V), 0.0, 1.0), 3.0);
  col3 += uAccent * rim * (0.5 + 0.7 * day) * 0.9;

  col3 *= uFlicker;
  gl_FragColor = vec4(col3, 1.0);
  ${FRAG_OUTPUT}
  #include <fog_fragment>
}
`;


export type GlobeUniforms = {
  uTime: THREE.IUniform<number>;
  uActivity: THREE.IUniform<number>;
  uFlicker: THREE.IUniform<number>;
  uQuality: THREE.IUniform<number>;
};

function withFog(shared: GlobeUniforms, own: Record<string, THREE.IUniform>): Record<string, THREE.IUniform> {
  return { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...shared, ...own };
}

export function createGlobeUniforms(): GlobeUniforms {
  return { uTime: { value: 0 }, uActivity: { value: 0.4 }, uFlicker: { value: 1 }, uQuality: { value: 1 } };
}

export function createGlobeSurfaceMaterial(shared: GlobeUniforms, land: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "HqGlobeSurface",
    defines: { HOTSPOT_COUNT: MAP_HOTSPOT_COUNT },
    uniforms: withFog(shared, {
      uLand: { value: land },
      uLandReady: { value: 0 },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uCities: { value: Array.from({ length: MAP_HOTSPOT_COUNT }, () => new THREE.Vector4()) },
      uOcean: { value: color(HQ_THEME.background, 1.6) },
      uDeep: { value: color(HQ_THEME.accentDeep) },
      uAccent: { value: color(HQ_THEME.accent) },
      uHot: { value: color(HQ_THEME.ledWarm) },
      uCity: { value: color("#ff9a6a") },
    }),
    vertexShader: SURFACE_VERTEX,
    fragmentShader: SURFACE_FRAGMENT,
    fog: true,
    toneMapped: false,
  });
}

// ---------------------------------------------------------------------- atmosphere
const HALO_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
varying vec3 vViewN;
varying vec3 vViewPos;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mvPosition.xyz;
  vViewN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

// Drawn on the back faces of a shell a little larger than the globe: brightest
// right at the globe's limb, fading to nothing at the shell's edge.
const HALO_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform float uLimb;
uniform float uFlicker;
uniform float uActivity;
uniform vec3 uAccent;
varying vec3 vViewN;
varying vec3 vViewPos;
${FOG_KEEP}
void main() {
  #include <logdepthbuf_fragment>
  vec3 V = normalize(-vViewPos);
  float k = clamp(-dot(normalize(vViewN), V) / uLimb, 0.0, 1.0);
  float glow = pow(k, 3.2) * (0.9 + 0.3 * uActivity) * uFlicker;
  gl_FragColor = vec4(uAccent * glow * 0.75 * hqFogKeep(), 1.0);
  ${FRAG_OUTPUT}
}
`;

export function createGlobeHaloMaterial(shared: GlobeUniforms, shellScale: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "HqGlobeHalo",
    uniforms: withFog(shared, {
      uLimb: { value: Math.sqrt(1 - 1 / (shellScale * shellScale)) },
      uAccent: { value: color(HQ_THEME.accent) },
    }),
    vertexShader: HALO_VERTEX,
    fragmentShader: HALO_FRAGMENT,
    fog: true,
    toneMapped: false,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
  });
}

// ----------------------------------------------------------------------------- arcs
const ARC_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
attribute vec4 aEnds;
attribute vec4 aTiming;
uniform float uTime;
uniform float uWidth;
uniform float uRadius;
uniform float uLift;
varying float vT;
varying float vSide;
varying float vLife;
varying float vLen;
${DIRECTION_GLSL}

vec3 fromMap(vec2 uv) {
  return hqGlobeDir(mix(${MAP_LON_WEST.toFixed(1)}, ${MAP_LON_EAST.toFixed(1)}, uv.x),
                    mix(${MAP_LAT_SOUTH.toFixed(1)}, ${MAP_LAT_NORTH.toFixed(1)}, uv.y));
}

vec3 arcAt(vec3 a, vec3 b, float omega, float t) {
  float s = sin(omega);
  vec3 d = s > 1e-4 ? (sin((1.0 - t) * omega) * a + sin(t * omega) * b) / s : normalize(mix(a, b, t));
  return d * uRadius * (1.0 + uLift * omega * sin(PI * t));
}

void main() {
  float t = position.x;
  float side = position.y;
  vT = t;
  vSide = side;
  vLife = -1.0;
  vLen = 1.0;
  if (aTiming.y <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 a = fromMap(aEnds.xy);
  vec3 b = fromMap(aEnds.zw);
  float omega = acos(clamp(dot(a, b), -1.0, 1.0));
  vec3 p = arcAt(a, b, omega, t);
  vec3 tangent = arcAt(a, b, omega, min(t + 0.004, 1.0)) - arcAt(a, b, omega, max(t - 0.004, 0.0));
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  vec3 tv = (modelViewMatrix * vec4(tangent, 0.0)).xyz;
  vec3 across = cross(tv, mvPosition.xyz);
  float al = length(across);
  across = al > 1e-8 ? across / al : vec3(0.0, 1.0, 0.0);
  float taper = 0.55 + 0.45 * smoothstep(0.0, 0.06, t) * smoothstep(1.0, 0.94, t);
  mvPosition.xyz += across * side * uWidth * taper;
  vLife = (uTime - aTiming.x) / aTiming.y;
  vLen = omega * uRadius * (1.0 + uLift);
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
uniform float uFade;
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
  float e = 1.0 - abs(vSide);
  float edge = e * e * (3.0 - 2.0 * e);
  float tail = 1.0 - smoothstep(0.0, uTail, behind);
  float after = max(vLife - 1.0, 0.0);
  float fadeOut = 1.0 - smoothstep(0.0, uFade, after - uTail * 0.5);
  float fadeIn = smoothstep(0.0, 0.08, vLife);
  float dashPhase = fract(vT * vLen * 5.0 - uTime * 1.6);
  float dash = smoothstep(0.0, 0.08, dashPhase) * (1.0 - smoothstep(0.42, 0.5, dashPhase));
  float trail = 0.18 + 0.25 * dash;
  float headGlow = exp(-behind * vLen * 10.0) * (1.0 - smoothstep(1.0, 1.04, vLife));
  vec3 col = uDeep * 2.6 * trail
    + uAccent * tail * 1.7 * (1.0 - smoothstep(1.0, 1.0 + uTail, vLife) * 0.6)
    + uHot * headGlow * 6.0;
  col *= edge * fadeOut * fadeIn * hqFogKeep();
  gl_FragColor = vec4(col, 1.0);
  ${FRAG_OUTPUT}
}
`;

export function createGlobeArcMaterial(shared: GlobeUniforms, radius: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "HqGlobeArcs",
    uniforms: withFog(shared, {
      uWidth: { value: radius * 0.012 },
      uRadius: { value: radius * 1.004 },
      uLift: { value: 0.16 },
      uTail: { value: 0.32 },
      uFade: { value: 0.5 },
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

// ----------------------------------------------------------------- projector beam
const BEAM_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
varying vec3 vViewN;
varying vec3 vViewPos;
void main() {
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mvPosition.xyz;
  vViewN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

// A soft cone of light from the projector up to the globe: strongest at the
// base and along the silhouette, with faint rings rising through it.
const BEAM_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform float uFlicker;
uniform vec3 uAccent;
varying vec2 vUv;
varying vec3 vViewN;
varying vec3 vViewPos;
${FOG_KEEP}
void main() {
  #include <logdepthbuf_fragment>
  vec3 V = normalize(-vViewPos);
  float side = 1.0 - abs(dot(normalize(vViewN), V));
  float up = vUv.y;
  float fall = (1.0 - up) * (0.35 + 0.65 * (1.0 - up));
  float rings = pow(0.5 + 0.5 * sin((up - uTime * 0.35) * 40.0), 8.0) * 0.5;
  float g = (0.12 + side * 0.5 + rings * 0.4) * fall * uFlicker;
  gl_FragColor = vec4(uAccent * g * hqFogKeep(), 1.0);
  ${FRAG_OUTPUT}
}
`;

export function createGlobeBeamMaterial(shared: GlobeUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "HqGlobeBeam",
    uniforms: withFog(shared, { uAccent: { value: color(HQ_THEME.accent) } }),
    vertexShader: BEAM_VERTEX,
    fragmentShader: BEAM_FRAGMENT,
    fog: true,
    toneMapped: false,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}
