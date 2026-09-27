import * as THREE from "three";
import { HQ_THEME } from "@/features/hq/core/config";
import type { HqLayout, HqRect } from "@/features/hq/core/types";
import type { FloorGlow } from "./floorGlow";
import { GLSL_HQ_NOISE, GLSL_HQ_WORLD_VARYING, GLSL_HQ_WORLD_VERTEX, patchMaterial } from "./glsl";
import { FLOOR_TILE, themeColor } from "./palette";

// The floor: one plane, one MeshStandardMaterial. Tiles, the room insets
// (AM7's office, meeting room carpet, rugs under the lounge groups, the
// server room's raised floor) and the fake reflections are all procedural in
// its fragment shader, so the whole floor is a single draw call with no
// z-fighting overlays.

/** Fixed array sizes keep a single shader program whatever the capacity. */
const MAX_MEETING_ROOMS = 12;
const MAX_RUGS = 12;
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
  uHqAm7: THREE.IUniform<THREE.Vector4>;
  uHqServer: THREE.IUniform<THREE.Vector4>;
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
uniform vec4 uHqServer;
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

// Runs after <color_fragment>: sets diffuse colour and keeps the zone data
// for the roughness and emissive stages below (same scope in main()).
const FRAGMENT_SURFACE = /* glsl */ `
vec2 hqXZ = vHqWorld.xz;
float hqAA = max(length(fwidth(hqXZ)), 1e-4);
// Beyond a few centimetres per pixel the fine detail would only shimmer.
float hqDetail = 1.0 - smoothstep(0.015, 0.09, hqAA);

// 0 main floor, 1 AM7 office, 2 meeting room carpet, 3 rug, 4 server room.
int hqZone = 0;
float hqRugEdge = 0.0;
for (int i = 0; i < ${MAX_RUGS}; i++) {
  if (i >= uHqRugCount) break;
  if (hqInRect(hqXZ, uHqRugs[i])) { hqZone = 3; hqRugEdge = hqRectEdge(hqXZ, uHqRugs[i]); break; }
}
if (hqZone == 0) {
  if (hqInRect(hqXZ, uHqAm7)) {
    hqZone = 1;
  } else if (hqInRect(hqXZ, uHqServer)) {
    hqZone = 4;
  } else {
    for (int i = 0; i < ${MAX_MEETING_ROOMS}; i++) {
      if (i >= uHqMeetingCount) break;
      if (hqInRect(hqXZ, uHqMeeting[i]) && hqRectEdge(hqXZ, uHqMeeting[i]) > 0.35) { hqZone = 2; break; }
    }
  }
}

vec2 hqSize = vec2(uHqTile);
vec2 hqP = hqXZ - uHqOrigin;
if (hqZone == 1) {
  // Large-format slabs in a running bond.
  hqSize = vec2(1.8, 0.9);
  hqP -= uHqAm7.xy;
  hqP.x += step(1.0, mod(floor(hqP.y / hqSize.y), 2.0)) * hqSize.x * 0.5;
} else if (hqZone == 4) {
  hqSize = vec2(0.6);
  hqP = hqXZ - uHqServer.xy;
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

// Every zone shares one look: a truly black, matte hacker floor with a sparse
// red circuit. Zones differ only by their red accents and how dense the
// circuit is, so the rooms still read as rooms.
float hqCircCell = 1.1;
float hqCircSeed = 3.7;
if (hqZone == 1) {
  // AM7's office: a finer circuit and a red inlay tracing the office outline.
  hqCircCell = 0.7;
  hqCircSeed = 17.3;
  float hqInlay = hqLine(abs(hqRectEdge(hqXZ, uHqAm7) - 0.32), 0.008, hqAA);
  hqEmissiveExtra += uHqAccent * hqInlay * 1.4;
} else if (hqZone == 2) {
  // Meeting rooms: a medium circuit.
  hqCircCell = 0.9;
  hqCircSeed = 29.1;
} else if (hqZone == 3) {
  // Rug: a thin red thread inside its border.
  hqCircCell = 0.8;
  hqCircSeed = 41.7;
  hqEmissiveExtra += uHqAccent * hqLine(abs(hqRugEdge - 0.3), 0.006, hqAA) * 0.5;
} else if (hqZone == 4) {
  // Server room: a dim red glow in the raised-floor joints.
  hqCircCell = 0.9;
  hqCircSeed = 53.9;
  hqEmissiveExtra += uHqAccent * hqLine(hqEdge, 0.004, hqAA) * mix(0.08, 0.22, hqDetail);
}

// Black and matte, with no specular at all: a dielectric still mirrors ~4 % of
// the light whatever its colour, and under the bright even lighting that alone
// lifted a near-black floor to grey. Near-zero albedo and no grout grid.
hqBase = vec3(0.0025, 0.0022, 0.003);
hqStone = 0.0;
hqTone = 1.0;
hqGrout = 0.0;
hqRough = 1.0;
hqGloss = 0.0;
hqSpecular = 0.0;
{
  // A sparse printed-circuit look: most of the floor stays black. Traces run in
  // long segments (three cells at a time) on a line that is offset per row or
  // column, so it never reads as a regular grid, and a small pad marks where a
  // horizontal and a vertical run cross. Dim, below the bloom: crisp, no glow.
  float hqC = hqCircCell;
  vec2 hqCl = floor(hqXZ / hqC);
  vec2 hqF = hqXZ - hqCl * hqC;
  float hqRowOff = (0.2 + 0.6 * hqHash12(vec2(hqCl.y, hqCircSeed))) * hqC;
  float hqColOff = (0.2 + 0.6 * hqHash12(vec2(hqCl.x, hqCircSeed + 7.0))) * hqC;
  float hqHOn = step(hqHash12(vec2(floor(hqCl.x / 3.0), hqCl.y + hqCircSeed * 3.1)), 0.26);
  float hqVOn = step(hqHash12(vec2(hqCl.x + hqCircSeed * 5.3, floor(hqCl.y / 3.0))), 0.18);
  float hqHLine = hqHOn * hqLine(abs(hqF.y - hqRowOff), 0.012, hqAA);
  float hqVLine = hqVOn * hqLine(abs(hqF.x - hqColOff), 0.012, hqAA);
  vec2 hqPd = abs(hqF - vec2(hqColOff, hqRowOff));
  float hqPad = hqHOn * hqVOn * hqLine(max(hqPd.x, hqPd.y), 0.032, hqAA);
  // Dimmer far off rather than gone, so the pattern still reads across the hall.
  float hqFade = 0.5 + 0.5 * hqDetail;
  hqEmissiveExtra += uHqAccent * ((hqHLine + hqVLine) * 0.24 + hqPad * 0.8) * hqFade;
}

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

// No floor glow / reflections at all: the floor is black and matte, its only
// light is the red hacker traces baked into hqEmissiveExtra above.
const FRAGMENT_EMISSIVE = /* glsl */ `
totalEmissiveRadiance += hqEmissiveExtra;
`;

export function createFloorMaterial(): { material: THREE.MeshStandardMaterial; uniforms: FloorUniforms } {
  const uniforms: FloorUniforms = {
    uHqGlowMap: { value: null },
    uHqGlowRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uHqGlowPpm: { value: 1 },
    // The even (view-independent) floor glow strength: red under the LEDs and
    // screens, the same from any camera angle.
    uHqGlowStrength: { value: 0.55 },
    uHqOrigin: { value: new THREE.Vector2() },
    uHqTile: { value: FLOOR_TILE },
    uHqGrout: { value: themeColor(HQ_THEME.floorGrout) },
    uHqAccent: { value: themeColor(HQ_THEME.accent) },
    uHqAm7: { value: new THREE.Vector4(1, 1, -1, -1) },
    uHqServer: { value: new THREE.Vector4(1, 1, -1, -1) },
    uHqMeeting: { value: Array.from({ length: MAX_MEETING_ROOMS }, () => new THREE.Vector4(1, 1, -1, -1)) },
    uHqMeetingCount: { value: 0 },
    uHqRugs: { value: Array.from({ length: MAX_RUGS }, () => new THREE.Vector4(1, 1, -1, -1)) },
    uHqRugCount: { value: 0 },
  };
  const material = new THREE.MeshStandardMaterial({
    color: HQ_THEME.floor,
    // Black and matte: no environment reflection and a very rough lobe, so the
    // floor never mirrors the lights into a white glare that follows the view.
    roughness: 0.95,
    metalness: 0,
    envMapIntensity: 0,
  });
  material.name = "hq-floor";
  patchMaterial(material, {
    key: "hq-floor-v1",
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
  rectToVec(layout.am7Office, uniforms.uHqAm7.value);
  rectToVec(layout.serverRoom, uniforms.uHqServer.value);
  const rooms = layout.meetingRooms.slice(0, MAX_MEETING_ROOMS);
  rooms.forEach((r, i) => rectToVec(r, uniforms.uHqMeeting.value[i]));
  uniforms.uHqMeetingCount.value = rooms.length;
  // A rug under every lounge group, centred on its coffee table.
  const tables = layout.props.filter((p) => p.kind === "coffee_table").slice(0, MAX_RUGS);
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
