// Shared constants for the hacker HQ scene. World units are metres, Y is up.
// The camera looks from the south-east (+x, +z) toward the north-west, so the
// north (z = bounds.z0) and west (x = bounds.x0) walls are the visible back
// walls; the south and east walls are kept low so they never hide the room.

export const HQ_CAPACITIES = [100, 300, 1000] as const;
export type HqCapacity = (typeof HQ_CAPACITIES)[number];
export const HQ_DEFAULT_CAPACITY: HqCapacity = 100;

// The lead agent: matched by id first, then by display name.
export const HQ_LEAD_AGENT_IDS = ["am7", "main"] as const;
export const HQ_LEAD_AGENT_NAME = "AM7";

// Workstation contract, shared with blender/hacker/build.py and
// blender/hq/workstation.py. Local frame: origin = chair centre on the floor,
// which is also the character root while seated; the seated character faces
// local +Z; the desk top spans z 0.36..1.10 and x -0.80..0.80.
export const WORKSTATION = {
  width: 1.6,
  deskFront: 0.36,
  deskBack: 1.1,
  deskHeight: 0.75,
  seatHeight: 0.47,
  // Where a walker stops before playing SitDown (clip starts 0.14 m forward).
  approachOffset: 0.14,
  // Monitor centres in local space. The sitter faces +Z, so +X is their left.
  // Side monitors are turned toward the sitter (rotY about +Y).
  monitors: [
    { x: 0.58, z: 0.95, y: 1.08, rotY: 0.45 },
    { x: 0, z: 0.95, y: 1.08, rotY: 0 },
    { x: -0.58, z: 0.95, y: 1.08, rotY: -0.45 },
  ],
  keyboard: { x: 0, y: 0.765, z: 0.5 },
  mouse: { x: -0.3, y: 0.765, z: 0.5 },
} as const;

// A pod is four workstations: two side by side facing +Z and two facing -Z,
// desk backs touching (monitors back to back).
export const POD = {
  deskPitchX: 1.6,
  // Distance between the two facing rows' chair centres.
  rowGap: 2.2,
  // Walkable aisle between pods.
  aisle: 2.6,
} as const;

// Character clips exported from blender/hacker (action names in the GLB).
export const HQ_CLIPS = ["Idle", "Walk", "Run", "SitDown", "SitType", "SitIdle", "Talk"] as const;
export type HqClipName = (typeof HQ_CLIPS)[number];
// Clip codes used in HqAgentFrame.clip; HQ_CLIPS[code] is the action name.
export const HqClip = {
  Idle: 0,
  Walk: 1,
  Run: 2,
  SitDown: 3,
  SitType: 4,
  SitIdle: 5,
  Talk: 6,
} as const;
export type HqClip = (typeof HqClip)[keyof typeof HqClip];
export const HQ_CLIP_FPS = 30;
// Durations in seconds and native locomotion speeds (m/s). The GLB is the
// source of truth; the scene checks these against the loaded clips in dev.
export const HQ_CLIP_INFO: Record<HqClipName, { duration: number; loop: boolean; speed: number }> = {
  Idle: { duration: 120 / 30, loop: true, speed: 0 },
  Walk: { duration: 32 / 30, loop: true, speed: 1.4 / (32 / 30) },
  Run: { duration: 20 / 30, loop: true, speed: 2.4 / (20 / 30) },
  SitDown: { duration: 40 / 30, loop: false, speed: 0 },
  SitType: { duration: 96 / 30, loop: true, speed: 0 },
  SitIdle: { duration: 150 / 30, loop: true, speed: 0 },
  Talk: { duration: 144 / 30, loop: true, speed: 0 },
};

export const HQ_CHARACTER_URL = "/office-assets/models/characters/hacker.glb";
export const HQ_WORKSTATION_URL = "/office-assets/models/hq/workstation.glb";
export const HQ_PROPS_URL = "/office-assets/models/hq/props.glb";
export const HQ_WORLD_LAND_URL = "/office-assets/data/land-110m.json";

// Crossfade between clips, seconds.
export const HQ_BLEND_TIME = 0.28;
export const HQ_WALK_SPEED = 1.31;
export const HQ_AGENT_RADIUS = 0.32;

// Visual theme. Everything in the HQ reads colours from here.
export const HQ_THEME = {
  background: "#040405",
  fog: "#060607",
  floor: "#0c0c0e",
  floorGrout: "#050506",
  wall: "#0b0b0d",
  wallPanel: "#101013",
  ceilingTrim: "#141417",
  deskTop: "#0d0d0f",
  metal: "#1a1b1e",
  glass: "#1b2126",
  glassEdge: "#2a2d31",
  accent: "#ff1a1a",
  accentSoft: "#ff4d4d",
  accentDeep: "#6e0000",
  ledWarm: "#ffb070",
  screenText: "#ff3b30",
  screenBackground: "#070203",
  statusWorking: "#ff2a2a",
  statusIdle: "#ffb020",
  statusError: "#ff00aa",
  statusSelected: "#ffffff",
} as const;
