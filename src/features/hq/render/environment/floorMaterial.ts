import * as THREE from "three";
import { HQ_THEME } from "@/features/hq/core/config";
import type { HqLayout, HqProp, HqRect } from "@/features/hq/core/types";
import type { FloorGlow } from "./floorGlow";
import { GLSL_HQ_NOISE, GLSL_HQ_WORLD_VARYING, GLSL_HQ_WORLD_VERTEX, patchMaterial } from "./glsl";
import { FLOOR_TILE, themeColor } from "./palette";

// The floor: one plane, one MeshStandardMaterial. Tiles, the room insets
// (AM7's island, meeting room carpet, rugs under the lounge groups, the
// server rooms' raised floor) and the fake reflections are all procedural in
// its fragment shader, so the whole floor is a single draw call with no
// z-fighting overlays.

/** Fixed array sizes keep a single shader program whatever the capacity. */
const MAX_MEETING_ROOMS = 12;
const MAX_SERVER_ROOMS = 4;
const MAX_RUGS = 16;
/** Rug half extents in a coffee table's local frame (x across, z front-back). */
const RUG_HALF = { x: 1.6, z: 1.65 };

export type FloorUniforms = {
  uHqGlowMap: THREE.IUniform<THREE.Texture | null>;
  uHqGlowRect: THREE.IUniform<THREE.Vector4>;
  uHqGlowPpm: THREE.IUniform<number>;
  uHqGlowStrength: THREE.IUniform<number>;
  uHqOrigin: THREE.IUniform<THREE.Vector2>;
  uHqTile: THREE.IUniform<number>;
  uHqGrout: THREE.IUniform<THREE.Color>;
  uHqAccent: THREE.IUniform<THREE.Color>;
  /** AM7's zone: the circle inscribed in HqLayout.am7Office (x, z, radius; radius 0 = none). */
  uHqAm7: THREE.IUniform<THREE.Vector4>;
  uHqServers: THREE.IUniform<THREE.Vector4[]>;
  uHqServerCount: THREE.IUniform<number>;
  uHqMeeting: THREE.IUniform<THREE.Vector4[]>;
  uHqMeetingCount: THREE.IUniform<number>;
  uHqRugs: THREE.IUniform<THREE.Vector4[]>;
  uHqRugCount: THREE.IUniform<number>;
};

const FRAGMENT_PARS = /* glsl */ `
${GLSL_HQ_NOISE}
${GLSL_HQ_WORLD_VARYING}
uniform sampler2D uHqGlowMap;
uniform vec4 uHqGlowRect;
uniform float uHqGlowPpm;
uniform float uHqGlowStrength;
uniform vec2 uHqOrigin;
uniform float uHqTile;
uniform vec3 uHqGrout;
uniform vec3 uHqAccent;
uniform vec4 uHqAm7;
uniform vec4 uHqServers[${MAX_SERVER_ROOMS}];
uniform int uHqServerCount;
uniform vec4 uHqMeeting[${MAX_MEETING_ROOMS}];
uniform int uHqMeetingCount;
uniform vec4 uHqRugs[${MAX_RUGS}];
uniform int uHqRugCount;

bool hqInRect(vec2 p, vec4 r) {
  return p.x >= r.x && p.x <= r.z && p.y >= r.y && p.y <= r.w;
}
float hqRectEdge(vec2 p, vec4 r) {
  return min(min(p.x - r.x, r.z - p.x), min(p.y - r.y, r.w - p.y));
}
// One tap of the pre-blurred glow map; wider blur = coarser mip.
vec3 hqGlowTap(vec2 xz, float blurMetres) {
  vec2 uv = (xz - uHqGlowRect.xy) * uHqGlowRect.zw;
  float lod = log2(max(blurMetres * uHqGlowPpm, 1.0));
  return textureLod(uHqGlowMap, uv, lod).rgb;
}
// Antialiased thin line mask at distance d (metres) from a line.
float hqLine(float d, float halfWidth, float aa) {
  return 1.0 - smoothstep(halfWidth - aa * 0.5, halfWidth + aa * 0.5, d);
}
`;

// Polished grey stone slabs with a fine grout; the zones
// change the finish (the island glossier and darker, carpet in the meeting
// rooms and under the lounge groups, a raised floor in the server rooms).
const ZONES = /* glsl */ `
// Slabs differ only a little in tone: a stronger spread reads as a checkerboard.
hqTone = 0.94 + 0.1 * hqR1;
if (hqZone == 1) {
  hqTone *= 0.55;
  hqRough = 0.12 + 0.06 * hqR2;
  hqGloss = 1.25;
  hqGrout *= 0.6;
  // A thin red inlay tracing the island's rim.
  float hqInlay = hqLine(abs(hqAm7Edge - 0.32), 0.008, hqAA);
  hqEmissiveExtra += uHqAccent * hqInlay * 1.4;
} else if (hqZone == 2 || hqZone == 3) {
  // Carpet: no grout, fine fibre noise, matte and darker than the stone.
  hqGrout = 0.0;
  hqTone = hqZone == 2 ? 0.46 : 0.52;
  hqStone = hqNoise(hqXZ * 38.0) * hqDetail * 0.8 + hqNoise(hqXZ * 3.0) * 0.4;
  hqRough = 0.9;
  hqGloss = 0.1;
  hqSpecular = 0.3;
  if (hqZone == 3) {
    // Rug: a darker woven border band with a thin red thread inside it.
    hqTone *= mix(0.65, 1.0, smoothstep(0.2, 0.24, hqRugEdge));
    hqEmissiveExtra += uHqAccent * hqLine(abs(hqRugEdge - 0.3), 0.006, hqAA) * 0.5;
  }
} else if (hqZone == 4) {
  // Raised floor: slightly lighter satin tiles, a dim red glow in the joints.
  hqTone = 1.15 + 0.12 * hqR1;
  hqRough = 0.36 + 0.1 * hqR2;
  hqGloss = 0.7;
  hqEmissiveExtra += uHqAccent * hqLine(hqEdge, 0.004, hqAA) * mix(0.08, 0.22, hqDetail);
}
`;

// Runs after <color_fragment>: sets diffuse colour and keeps the zone data
// for the roughness and emissive stages below (same scope in main()).
const FRAGMENT_SURFACE = /* glsl */ `
vec2 hqXZ = vHqWorld.xz;
float hqAA = max(length(fwidth(hqXZ)), 1e-4);
// Beyond a few centimetres per pixel the fine detail would only shimmer.
float hqDetail = 1.0 - smoothstep(0.015, 0.09, hqAA);

// 0 main floor, 1 AM7's island, 2 meeting room carpet, 3 rug, 4 server room.
int hqZone = 0;
float hqRugEdge = 0.0;
// Distance in from the rim of AM7's round zone (negative outside it).
float hqAm7Edge = uHqAm7.z - distance(hqXZ, uHqAm7.xy);
vec4 hqServerRect = vec4(0.0);
for (int i = 0; i < ${MAX_RUGS}; i++) {
  if (i >= uHqRugCount) break;
  if (hqInRect(hqXZ, uHqRugs[i])) { hqZone = 3; hqRugEdge = hqRectEdge(hqXZ, uHqRugs[i]); break; }
}
if (hqZone == 0) {
  if (uHqAm7.z > 0.0 && hqAm7Edge >= 0.0) {
    hqZone = 1;
  } else {
    for (int i = 0; i < ${MAX_SERVER_ROOMS}; i++) {
      if (i >= uHqServerCount) break;
      if (hqInRect(hqXZ, uHqServers[i])) { hqZone = 4; hqServerRect = uHqServers[i]; break; }
    }
  }
  if (hqZone == 0) {
    for (int i = 0; i < ${MAX_MEETING_ROOMS}; i++) {
      if (i >= uHqMeetingCount) break;
      if (hqInRect(hqXZ, uHqMeeting[i]) && hqRectEdge(hqXZ, uHqMeeting[i]) > 0.35) { hqZone = 2; break; }
    }
  }
}

vec2 hqSize = vec2(uHqTile);
vec2 hqP = hqXZ - uHqOrigin;
if (hqZone == 1) {
  // Large-format slabs in a running bond, set out from the island's centre.
  hqSize = vec2(1.8, 0.9);
  hqP = hqXZ - uHqAm7.xy;
  hqP.x += step(1.0, mod(floor(hqP.y / hqSize.y), 2.0)) * hqSize.x * 0.5;
} else if (hqZone == 4) {
  hqSize = vec2(0.6);
  hqP = hqXZ - hqServerRect.xy;
}
vec2 hqCell = hqP / hqSize;
vec2 hqId = floor(hqCell);
vec2 hqF = fract(hqCell);
vec2 hqEdgeM = min(hqF, 1.0 - hqF) * hqSize;
float hqEdge = min(hqEdgeM.x, hqEdgeM.y);

float hqR1 = hqHash12(hqId + float(hqZone) * 37.0);
float hqR2 = hqHash12(hqId * 1.7 + 91.3);
// Stone: broad clouding plus a fine grain that fades out with distance.
float hqStone = hqNoise(hqXZ * 1.9 + hqR1 * 17.0) * 0.6
  + hqNoise(hqXZ * 7.3 + hqR2 * 5.0) * 0.4 * hqDetail;

float hqGrout = hqLine(hqEdge, 0.006, hqAA) * mix(0.45, 1.0, hqDetail);
float hqRough = 0.24 + 0.16 * hqR2 + 0.08 * hqStone;
float hqGloss = 1.0;
// Carpet barely reflects: a rough lobe would average the studio environment
// into a grey sheen that reads lighter than the dark stone around it.
float hqSpecular = 1.0;
float hqTone = 0.84 + 0.3 * hqR1;
vec3 hqEmissiveExtra = vec3(0.0);
vec3 hqBase = diffuseColor.rgb;

${ZONES}
hqBase *= hqTone * (0.9 + 0.2 * hqStone);
diffuseColor.rgb = mix(hqBase, uHqGrout, hqGrout);
`;

const FRAGMENT_ROUGHNESS = /* glsl */ `
roughnessFactor = mix(clamp(hqRough * roughnessFactor / 0.25, 0.06, 1.0), 0.9, hqGrout);
`;

const FRAGMENT_SPECULAR = /* glsl */ `
reflectedLight.directSpecular *= hqSpecular;
reflectedLight.indirectSpecular *= hqSpecular;
`;

// Fake reflections on the polished stone: taps
// pushed away from the camera across the floor pick up glow from lights
// further back, which is where a glossy floor would mirror them. Tap distance
// scales with (horizontal distance / camera height), the geometry of a
// reflection off a plane.
const FRAGMENT_EMISSIVE = /* glsl */ `
{
  vec3 hqToCam = cameraPosition - vHqWorld;
  float hqCamH = max(hqToCam.y, 0.5);
  float hqFlat = max(length(hqToCam.xz), 1e-3);
  vec2 hqAway = -hqToCam.xz / hqFlat;
  float hqReach = clamp(hqFlat / hqCamH, 0.15, 3.0);
  vec3 hqRefl = hqGlowTap(hqXZ, 0.12) * 0.5;
  hqRefl += hqGlowTap(hqXZ + hqAway * (0.3 * hqReach), 0.22) * 0.42;
  hqRefl += hqGlowTap(hqXZ + hqAway * (0.8 * hqReach), 0.42) * 0.32;
  hqRefl += hqGlowTap(hqXZ + hqAway * (1.6 * hqReach), 0.8) * 0.2;
  hqRefl += hqGlowTap(hqXZ + hqAway * (2.9 * hqReach), 1.4) * 0.12;
  float hqFresnel = 0.6 + 0.4 * pow(1.0 - clamp(hqCamH / length(hqToCam), 0.0, 1.0), 2.0);
  float hqSheen = hqGloss * clamp(1.35 - roughnessFactor * 1.6, 0.1, 1.2);
  totalEmissiveRadiance += hqRefl * (uHqGlowStrength * hqSheen * hqFresnel * (1.0 - hqGrout));
  totalEmissiveRadiance += hqEmissiveExtra;
}
`;

export function createFloorMaterial(): { material: THREE.MeshStandardMaterial; uniforms: FloorUniforms } {
  const uniforms: FloorUniforms = {
    uHqGlowMap: { value: null },
    uHqGlowRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uHqGlowPpm: { value: 1 },
    // How strongly the stone mirrors the glow under the LEDs and screens.
    uHqGlowStrength: { value: 0.95 },
    uHqOrigin: { value: new THREE.Vector2() },
    uHqTile: { value: FLOOR_TILE },
    uHqGrout: { value: themeColor(HQ_THEME.floorGrout) },
    uHqAccent: { value: themeColor(HQ_THEME.accent) },
    uHqAm7: { value: new THREE.Vector4(0, 0, 0, 0) },
    uHqServers: { value: Array.from({ length: MAX_SERVER_ROOMS }, () => new THREE.Vector4(1, 1, -1, -1)) },
    uHqServerCount: { value: 0 },
    uHqMeeting: { value: Array.from({ length: MAX_MEETING_ROOMS }, () => new THREE.Vector4(1, 1, -1, -1)) },
    uHqMeetingCount: { value: 0 },
    uHqRugs: { value: Array.from({ length: MAX_RUGS }, () => new THREE.Vector4(1, 1, -1, -1)) },
    uHqRugCount: { value: 0 },
  };
  // Polished stone that reflects its surroundings.
  const material = new THREE.MeshStandardMaterial({
    color: HQ_THEME.floor,
    roughness: 0.25,
    metalness: 0,
    envMapIntensity: 0.85,
  });
  material.name = "hq-floor";
  patchMaterial(material, {
    key: "hq-floor-v3",
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexPars: GLSL_HQ_WORLD_VARYING,
    fragmentPars: FRAGMENT_PARS,
    vertex: [["project_vertex", GLSL_HQ_WORLD_VERTEX]],
    fragment: [
      ["color_fragment", FRAGMENT_SURFACE],
      ["roughnessmap_fragment", FRAGMENT_ROUGHNESS],
      ["emissivemap_fragment", FRAGMENT_EMISSIVE],
      ["lights_fragment_end", FRAGMENT_SPECULAR],
    ],
  });
  return { material, uniforms };
}

function rectToVec(r: HqRect, target: THREE.Vector4): THREE.Vector4 {
  return target.set(r.x0, r.z0, r.x1, r.z1);
}

export function applyLayoutToFloor(uniforms: FloorUniforms, layout: HqLayout): void {
  uniforms.uHqOrigin.value.set(layout.bounds.x0, layout.bounds.z0);
  // AM7's round island: the circle inscribed in its bounding square.
  const am7 = layout.am7Office;
  const am7Radius = Math.max(0, Math.min(am7.x1 - am7.x0, am7.z1 - am7.z0) / 2);
  uniforms.uHqAm7.value.set((am7.x0 + am7.x1) / 2, (am7.z0 + am7.z1) / 2, am7Radius, 0);
  const servers = layout.serverRooms.slice(0, MAX_SERVER_ROOMS);
  servers.forEach((r, i) => rectToVec(r, uniforms.uHqServers.value[i]));
  uniforms.uHqServerCount.value = servers.length;
  const rooms = layout.meetingRooms.slice(0, MAX_MEETING_ROOMS);
  rooms.forEach((r, i) => rectToVec(r, uniforms.uHqMeeting.value[i]));
  uniforms.uHqMeetingCount.value = rooms.length;
  // A rug under every lounge group, centred on its coffee table; the lounges'
  // tables come first, so every lounge keeps its rugs if there are too many.
  const inLounge = (p: HqProp) => layout.lounges.some((r) => p.x >= r.x0 && p.x <= r.x1 && p.z >= r.z0 && p.z <= r.z1);
  const coffee = layout.props.filter((p) => p.kind === "coffee_table");
  const tables = [...coffee.filter(inLounge), ...coffee.filter((p) => !inLounge(p))].slice(0, MAX_RUGS);
  tables.forEach((p, i) => {
    const quarterTurn = Math.abs(Math.sin(p.rotY)) > 0.7;
    const hx = quarterTurn ? RUG_HALF.z : RUG_HALF.x;
    const hz = quarterTurn ? RUG_HALF.x : RUG_HALF.z;
    uniforms.uHqRugs.value[i].set(p.x - hx, p.z - hz, p.x + hx, p.z + hz);
  });
  uniforms.uHqRugCount.value = tables.length;
}

export function applyGlowToFloor(uniforms: FloorUniforms, glow: FloorGlow): void {
  uniforms.uHqGlowMap.value = glow.texture;
  uniforms.uHqGlowRect.value.copy(glow.rect);
  uniforms.uHqGlowPpm.value = glow.pixelsPerMetre;
}
