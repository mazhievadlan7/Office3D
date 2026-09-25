import type { HqCapacity, HqClip } from "./config";

export type Vec2 = { x: number; z: number };

export type HqRect = { x0: number; z0: number; x1: number; z1: number };

export type HqDesk = {
  /** Position in `HqLayout.desks`; AM7's desk is not in that list. */
  index: number;
  /** Stable id, e.g. "hq-desk-0042". Used for persisted assignments. */
  id: string;
  /** Chair centre on the floor = character root while seated. */
  x: number;
  z: number;
  /** Heading of the seated character (radians, rotation.y; 0 faces +Z). */
  rotY: number;
  /** Standing point where a walker stops before SitDown. */
  approach: Vec2;
  /** Index of the nav node the approach point connects to. */
  navNode: number;
  podId: number;
};

export type HqSegmentKind = "glass" | "wall" | "glass-door";

export type HqSegment = {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  height: number;
  kind: HqSegmentKind;
};

export type HqPropKind =
  | "planter_tall"
  | "planter_low"
  | "server_rack"
  /** Slim black rack column with a smoked glass door and blinking red LEDs. */
  | "server_pillar"
  /** Glossy black stele with a vertical red light slit and a lit base. */
  | "data_monolith"
  /** Black planter with a red rim and near-black foliage (AM7's office only). */
  | "dark_plant"
  | "sofa"
  | "lounge_chair"
  | "coffee_table"
  | "coffee_bar"
  | "meeting_table"
  | "meeting_chair"
  | "exec_desk"
  | "exec_chair"
  | "exec_shelf"
  | "wall_screen"
  | "floor_lamp";

export type HqProp = {
  kind: HqPropKind;
  x: number;
  z: number;
  rotY: number;
  scale?: number;
  /** Wall screens: what they show (HQ_WALL_SCREEN). */
  screen?: HqWallScreen;
};

/** Channels of the wall screens; the layer order of the screen hub's wall texture. */
export const HQ_WALL_SCREEN = { exec: 0, news: 1, security: 2, music: 3 } as const;
export type HqWallScreen = (typeof HQ_WALL_SCREEN)[keyof typeof HQ_WALL_SCREEN];

/**
 * A soft seat in the lounge (a sofa cushion or a lounge chair). Same SitDown
 * contract as HqDesk: the character root sits on (x, z) facing rotY, and a
 * walker stops at `approach`, 0.14 m in front, before playing SitDown.
 */
export type HqSeat = {
  x: number;
  z: number;
  /** Heading of the seated character (radians, rotation.y; 0 faces +Z). */
  rotY: number;
  approach: Vec2;
  /** Nav node straight in front of the seat, in the aisle around the table. */
  navNode: number;
  /** Index into HqLayout.loungeGroups. */
  group: number;
};

/** One lounge seating group: sofas and chairs around a coffee table. */
export type HqLoungeGroup = {
  /** Centre of the group's coffee table, where idle sitters look. */
  tableX: number;
  tableZ: number;
};

export type HqSocialSpotKind = "coffee" | "map" | "lounge" | "meeting" | "server";

export type HqSocialSpot = {
  kind: HqSocialSpotKind;
  x: number;
  z: number;
  /** Direction people standing here face (e.g. toward the map). */
  rotY: number;
  /** How many agents may gather here at once. */
  capacity: number;
  navNode: number;
};

export type HqMapWall = {
  /** Centre of the map surface, on the inner face of the north wall. */
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  /** The holographic globe floating in front of the wall's centre, on a floor projector. */
  globe: { x: number; y: number; z: number; radius: number };
};

export type HqNavGraph = {
  /** Node positions, interleaved x,z. */
  positions: Float32Array;
  /** Undirected edges as node index pairs. */
  edges: Uint32Array;
};

export type HqLayout = {
  capacity: HqCapacity;
  /** Interior floor rectangle (inside the walls). */
  bounds: HqRect;
  wallHeight: number;
  desks: HqDesk[];
  leadDesk: HqDesk;
  am7Office: HqRect;
  meetingRooms: HqRect[];
  lounge: HqRect;
  serverRoom: HqRect;
  mapWall: HqMapWall;
  partitions: HqSegment[];
  props: HqProp[];
  socialSpots: HqSocialSpot[];
  /** Seats in the lounge, grouped: every group's seats are contiguous. */
  loungeSeats: HqSeat[];
  loungeGroups: HqLoungeGroup[];
  nav: HqNavGraph;
  /** Entrance, where new agents appear. */
  spawn: Vec2;
  /** Camera framing hint: centre of the interesting area and its radius. */
  focus: { x: number; z: number; radius: number };
};

export type HqAgentStatus = "working" | "idle" | "error";

/** What the scene receives per agent from the app. */
export type HqAgentInput = {
  id: string;
  name: string;
  role?: string | null;
  status: HqAgentStatus;
};

export const HQ_STATUS_CODE: Record<HqAgentStatus, number> = { working: 0, idle: 1, error: 2 };

/**
 * Per-frame simulation output, struct-of-arrays so 1000 agents cost nothing
 * to read. Index i is the i-th entry of `ids`. Renderers never write here.
 */
export type HqAgentFrame = {
  count: number;
  ids: string[];
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** rotation.y, 0 faces +Z. */
  facing: Float32Array;
  /** Current clip (HqClip) and seconds since it started, already wrapped or clamped. */
  clip: Uint8Array;
  clipTime: Float32Array;
  /** Previous clip for the crossfade and its time, and the weight of `clip` (0..1). */
  prevClip: Uint8Array;
  prevClipTime: Float32Array;
  blend: Float32Array;
  /** Where the head should look (world), and how strongly (0 = animation only). */
  lookX: Float32Array;
  lookY: Float32Array;
  lookZ: Float32Array;
  lookWeight: Float32Array;
  /** HQ_STATUS_CODE of the agent. */
  status: Uint8Array;
  /** 1 for the lead agent (AM7). */
  lead: Uint8Array;
};

export type HqClipId = HqClip;
