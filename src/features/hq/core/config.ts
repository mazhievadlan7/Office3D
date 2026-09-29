// Shared constants for the hacker HQ scene. World units are metres, Y is up.
// The camera looks from the south-east (+x, +z) toward the north-west, so the
// north (z = bounds.z0) and west (x = bounds.x0) walls are the visible back
// walls; the south and east walls are kept low so they never hide the room.


// Hall sizes the layout, simulation and renderers are built and tested for.
export const HQ_CAPACITIES = [100, 300, 1000] as const;
export type HqCapacity = (typeof HQ_CAPACITIES)[number];
// The HQ's desk count. The standard team is 300; every size in HQ_CAPACITIES
// works, so growing to 1000 is this one line (plus DEMO_AGENT_COUNT for the demo).
export const HQ_DEFAULT_CAPACITY: HqCapacity = 300;

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
// New clips go at the end so existing codes never change.
export const HQ_CLIPS = ["Idle", "Walk", "Run", "SitDown", "SitType", "SitIdle", "Talk", "Present", "Push"] as const;
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
  // AM7 at the briefing podium, in place: from facing the rows he half turns
  // right (feet planted), presents the video wall behind him to his right with
  // his right hand, turns back and explains. The root keeps facing the rows.
  Present: 7,
  // Walking behind the archive cart, both hands on its grip bar, in place
  // (blender/hacker/anims/push.py): the sim moves the root along the cart's
  // lane and carries the cart HQ_ARCHIVE_CART.reach ahead of it. Played
  // backward while the cart is pulled out of its bay.
  Push: 8,
} as const;
export type HqClip = (typeof HqClip)[keyof typeof HqClip];
export const HQ_CLIP_FPS = 30;
export type HqClipInfo = {
  /** Seconds. */
  duration: number;
  loop: boolean;
  /** Native locomotion speed (m/s); > 0 marks a distance-driven clip (Walk, Run, Push). */
  speed: number;
  /** Played sitting (label and capsule height, blob size). */
  seated: boolean;
  /** Hands on the keyboard (key clicks). */
  typing: boolean;
  /** Speaking (voices, subtitles). */
  talk: boolean;
  /**
   * Crossfade into this clip, seconds. Anything to or from a locomotion clip
   * uses HQ_BLEND_TIME instead, so the feet never slide through a long fade.
   */
  blend: number;
};
// Durations in seconds and native locomotion speeds (m/s). The GLB is the
// source of truth; the scene checks these against the loaded clips in dev.
export const HQ_CLIP_INFO: Record<HqClipName, HqClipInfo> = {
  Idle: { duration: 120 / 30, loop: true, speed: 0, seated: false, typing: false, talk: false, blend: 0.4 },
  Walk: { duration: 32 / 30, loop: true, speed: 1.4 / (32 / 30), seated: false, typing: false, talk: false, blend: 0.28 },
  Run: { duration: 20 / 30, loop: true, speed: 2.4 / (20 / 30), seated: false, typing: false, talk: false, blend: 0.28 },
  SitDown: { duration: 40 / 30, loop: false, speed: 0, seated: true, typing: false, talk: false, blend: 0.35 },
  // Seated pose changes fade slowly (0.5-0.8 s): hands leave and find the keyboard.
  SitType: { duration: 96 / 30, loop: true, speed: 0, seated: true, typing: true, talk: false, blend: 0.6 },
  SitIdle: { duration: 150 / 30, loop: true, speed: 0, seated: true, typing: false, talk: false, blend: 0.75 },
  Talk: { duration: 144 / 30, loop: true, speed: 0, seated: false, typing: false, talk: true, blend: 0.45 },
  Present: { duration: 168 / 30, loop: true, speed: 0, seated: false, typing: false, talk: true, blend: 0.5 },
  // 32 frames, stride 1.12 m: 1.05 m/s, the same foot timing as Walk.
  Push: { duration: 32 / 30, loop: true, speed: 1.12 / (32 / 30), seated: false, typing: false, talk: false, blend: 0.28 },
};

/**
 * Bumped whenever a model under public/office-assets/models is rebuilt, so
 * browsers and proxies holding the old file fetch the new one.
 */
const HQ_MODELS_VERSION = "2026-09-28e";
export const HQ_CHARACTER_URL = `/office-assets/models/characters/hacker.glb?v=${HQ_MODELS_VERSION}`;
export const HQ_WORKSTATION_URL = `/office-assets/models/hq/workstation.glb?v=${HQ_MODELS_VERSION}`;
export const HQ_PROPS_URL = `/office-assets/models/hq/props.glb?v=${HQ_MODELS_VERSION}`;
// World map. Coastlines and borders: Natural Earth 1:50m countries via the
// world-atlas package (public domain / ISC). Imagery is optional (the map
// falls back to a look built from the vector data): NASA Earth Observatory,
// public domain — Blue Marble Next Generation with topography and bathymetry
// (December 2004, 5400 x 2700) and Black Marble 2016 night lights (3600 x 1800),
// both whole-globe equirectangular with north up.
export const HQ_WORLD_COUNTRIES_URL = "/office-assets/data/countries-50m.json";
export const HQ_MAP_DAY_URL = "/office-assets/textures/earth-topo-bathy-5400.jpg";
export const HQ_MAP_NIGHT_URL = "/office-assets/textures/earth-night-3600.jpg";

// The archive cart (blender/hq/props_archive.py archive_cart), in its own
// frame: origin = deck centre on the floor, nose toward +Z, the handle's grips
// behind it. `nose` and `tail` are how far the cart reaches ahead of and
// behind its origin (length = nose + tail); `reach` is the pusher's root to
// the cart origin while pushing (blender/hacker/anims/push.py CART_OFFSET).
export const HQ_ARCHIVE_CART = { length: 1.153, width: 0.625, reach: 1.02, nose: 0.513, tail: 0.64 } as const;
// Where the pusher's hands close on the grips, from his root: `reach` ahead,
// `height` up, `halfSpan` either side; `holdFrame` is the Push frame he holds
// when he stops. Must match push.py (GRIP_X, GRIP_Y, GRIP_Z).
export const HQ_PUSH_GRIP = { reach: 0.4, height: 0.97, halfSpan: 0.2, holdFrame: 9 } as const;

/**
 * Where a guest stands to look over a seated hacker's shoulder (AM7's visits,
 * a colleague dropping by), in the workstation's local frame (origin = chair
 * centre, the sitter faces +Z, +X is the sitter's left): behind the sitter's
 * right shoulder, clear of the chair back (z -0.25..-0.31) and 1 m from the
 * neighbour's chair. `hand` is where a future StandLookOver clip rests its
 * left hand: the chair back's right top corner. The guest faces the centre
 * monitor.
 */
export const HQ_SHOULDER = { x: -0.55, z: -0.42, hand: { x: -0.2, y: 1.02, z: -0.29 } } as const;

// Crossfade between locomotion clips (and into or out of them), seconds.
// Other clips fade over their own HQ_CLIP_INFO[...].blend.
export const HQ_BLEND_TIME = 0.28;
export const HQ_WALK_SPEED = 1.31;
export const HQ_AGENT_RADIUS = 0.32;

// Visual theme. Everything in the HQ reads colours from here: a realistic
// operations centre — grey polished stone, graphite walls and desks, warm
// white light, amber strips under the desks; the world map, the server racks
// and the lead's island keep their red.
export const HQ_THEME = {
  background: "#0d0c0b",
  fog: "#12110f",
  floor: "#2f2d2b",
  floorGrout: "#1a1918",
  wall: "#1f1e1d",
  wallPanel: "#2a2927",
  ceilingTrim: "#34322f",
  deskTop: "#232326",
  metal: "#4a4a4f",
  glass: "#3c4852",
  glassEdge: "#5c6167",
  accent: "#e8352a",
  accentSoft: "#ff6a50",
  accentDeep: "#5a140a",
  ledWarm: "#ffb36b",
  /** Light lines along the walls, curbs and partition rails. */
  trim: "#ffd2a0",
  /** The LED strip under every desk front and its glow on the floor. */
  deskLed: "#ffa24a",
  screenText: "#ff6a4a",
  screenBackground: "#070506",
  statusWorking: "#ff2a2a",
  statusIdle: "#ffb020",
  statusError: "#ff00aa",
  statusSelected: "#ffffff",
} as const;
