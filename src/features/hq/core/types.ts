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
  | "floor_lamp"
  /**
   * AM7's briefing lectern (HqLayout.tribune). Never placed as a static prop:
   * the tribune renderer rises it from the floor for a briefing.
   */
  | "tribune"
  // The archive station (HqLayout.archive). None of these is placed as a
  // static prop: the archive renderer draws them from the sim's archive view.
  /** The wheeled archive cart (blender/hq/props_archive.py): origin = deck centre, nose +Z, grips -Z. */
  | "archive_cart"
  /** The cart's handle light strip, shown only while it is loaded or moving. */
  | "archive_cart_lit"
  /** The cart tablet's content: loaded / empty. */
  | "archive_cart_display_full"
  | "archive_cart_display_empty"
  /** Additive load tiers on the cart deck: tier k is shown when k <= level. */
  | "archive_load_1"
  | "archive_load_2"
  | "archive_load_3"
  | "archive_load_4"
  /** The docking bay: its mouth faces local +Z; a parked cart noses in toward -Z (bay heading + pi). */
  | "archive_bay"
  /** The bay's lit gauge segments, bottom to top (4 blinks at full). */
  | "archive_bay_led_1"
  | "archive_bay_led_2"
  | "archive_bay_led_3"
  | "archive_bay_led_4"
  /** The intake cabinet on the apron outside the entrance; roller lip and slot at local +Z. */
  | "archive_chute"
  /** The chute's slatted shutter (rolled up about the slot top while a case feeds). */
  | "archive_chute_shutter"
  /** The glow inside the chute's slot (driven 0..1). */
  | "archive_chute_slot"
  /** One loose hard case, for the unload animation. */
  | "archive_case";

export type HqProp = {
  kind: HqPropKind;
  x: number;
  z: number;
  rotY: number;
  scale?: number;
  /** Wall screens: what they show (HQ_WALL_SCREEN). */
  screen?: HqWallScreen;
};

/**
 * Channels of the wall screens; the layer order of the screen hub's wall
 * texture: AM7's report, HACKING NEWS, AM7 BUSINESS (markets) and AM7 RADIO.
 */
export const HQ_WALL_SCREEN = { exec: 0, news: 1, markets: 2, music: 3 } as const;
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
  /**
   * The display is concave toward the room: a circular arc whose two ends
   * stand this far (metres) in front of the wall while its middle touches it.
   * 0 is a flat display.
   */
  curve: number;
};

/**
 * AM7's command island in front of the video wall: a round dais with a glass
 * balustrade (open to the north, where AM7 steps in behind the chair).
 */
export type HqDeck = { x: number; z: number; radius: number };

/**
 * AM7's briefing lectern between the island and the rows. It stays under the
 * floor until a briefing; then it rises, AM7 steps behind it at (standX,
 * standZ) and addresses the rows with the video wall at his back. Its front
 * (rotY; 0 faces +Z) faces the rows.
 */
export type HqTribune = { x: number; z: number; rotY: number; standX: number; standZ: number };

/**
 * The amphitheatre of desks: rows on concentric arcs round (x, z), every
 * desk facing the centre (the video wall). Angles are measured from due south
 * (+Z), positive toward the east (+X): a point at angle a and radius r is at
 * (x + r sin a, z + r cos a).
 */
export type HqArena = {
  x: number;
  z: number;
  /** Chair-centre radius of each row, inner first. */
  rows: number[];
  /** Half the angle each row's desks span (radians), per row. */
  spans: number[];
  /** Radius of the walkway ring behind each row (in front of the next one), per row. */
  rings: number[];
  /** Angles of the straight aisles that run out from the stage through the rows. */
  aisles: number[];
  /** Radius of the walkway arc in front of the first row. */
  stage: number;
};

/** A position on the floor with a heading (rotation.y; 0 faces +Z). */
export type HqPose = { x: number; z: number; rotY: number };

/**
 * A pre-sampled path of the archive cart. Every sample is the pusher's root
 * and the cart's heading; the cart origin is always root + forward(rotY) *
 * HQ_ARCHIVE_CART.reach. Samples are at most HQ_ARCHIVE.step apart.
 */
export type HqArchiveLane = {
  x: Float32Array;
  z: Float32Array;
  /** Cart heading per sample, unwrapped (continuous along the lane). */
  rotY: Float32Array;
  /** Distance along the lane (metres) per sample, from 0. */
  s: Float32Array;
  /** 1 where the cart must not be left standing: the doorway and walkway crossings. */
  noStop: Uint8Array;
  /**
   * 1 where the cart travels backward, handle first (the pusher pulls it out
   * of the bay: the Push clip plays in reverse); 0 where it is pushed nose first.
   */
  reverse: Uint8Array;
  /** Total length in metres (= s[last]). The sample count is x.length. */
  length: number;
};

/**
 * The archive station by the entrance: a docking bay where the cart fills up,
 * the lanes out through the entrance to the intake chute on the apron and back,
 * and the nav spur the hauler walks in on.
 */
export type HqArchiveStation = {
  /** archive_bay prop pose (its mouth faces rotY, into the hall). */
  bay: HqPose;
  /** The parked cart's origin and heading (the bay's heading + pi: nose in). */
  cart: HqPose;
  /** The pusher's root while gripping the parked cart (= laneOut start = laneBack end). */
  stand: HqPose;
  /** Where the hauler walks up to before stepping to the handle (stand - forward * 0.8). */
  approach: Vec2;
  /** From the stand out through the entrance to the handover pose beside the chute. */
  laneOut: HqArchiveLane;
  /** From the handover pose (= laneOut end) back into the bay (ends at the stand). */
  laneBack: HqArchiveLane;
  /** The floor outside the entrance the cart may use (the apron plane). */
  apron: HqRect;
  /** archive_chute pose; `slot` is its slot mouth on the floor plan, facing the cart at the handover. */
  chute: HqPose & { slot: Vec2 };
  /** The entrance jambs (inner faces of the curb cut, on the curb's centre line), west then east. */
  gate: { from: Vec2; to: Vec2 };
  /** Nav node at the end of the station's spur (at `approach`): where the hauler walks to. */
  entryNode: number;
  /** Nav node the hauler walks away from after parking (the same spur end). */
  leaveNode: number;
};

/** What the archive renderer and the host read from the sim, one reused object. */
export type HqArchiveView = {
  /** Cart origin and heading. */
  x: number;
  z: number;
  rotY: number;
  /** Load tiers shown (0..4). */
  level: number;
  /** Unload progress at the handover (0..1). */
  unload: number;
  /** Entrance gate posts' glow (0..1). */
  gate: number;
  /** Chute slot glow (0..1). */
  chute: number;
  phase: "parked" | "fetch" | "push-out" | "handover" | "push-back" | "left";
  pusherId: string | null;
};

export type HqArchiveEvent = {
  type: "taken" | "paused" | "resumed" | "reassigned" | "handover" | "parked" | "auto";
  runId: string;
  agentId: string | null;
  name: string;
  previousName?: string;
  freedBytes: number;
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
  /** Height of the west wall (the south and east sides are low curbs). */
  wallHeight: number;
  /** Height of the north wall, which carries the video wall. */
  northWallHeight: number;
  desks: HqDesk[];
  leadDesk: HqDesk;
  /** Bounding square of AM7's command island (`deck`). */
  am7Office: HqRect;
  deck: HqDeck;
  tribune: HqTribune;
  arena: HqArena;
  meetingRooms: HqRect[];
  /** The west lounge, with the coffee bar (`lounges[0]`). */
  lounge: HqRect;
  /** Every lounge: the west one first, then the east one. */
  lounges: HqRect[];
  /** The west server room in the north-west corner (`serverRooms[0]`). */
  serverRoom: HqRect;
  /** Every server room: the west one, then the east rack gallery. */
  serverRooms: HqRect[];
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
  /** The archive station east of the entrance (bay, lanes, chute, nav spur). */
  archive: HqArchiveStation;
  /** Camera framing hint: centre of the interesting area and its radius. */
  focus: { x: number; z: number; radius: number };
};

export type HqAgentStatus = "working" | "idle" | "error";

/**
 * Mission mode («боевая задача»), as the sim reports it (one reused object):
 * the floor is on duty — nobody goes on breaks, whoever was away is back at
 * their desk, the cyber-range is off.
 */
export type HqMissionView = {
  active: boolean;
  /** Seconds since the mission started (0 while inactive). */
  elapsed: number;
  /** Seconds until it ends by itself (0 while inactive). */
  remaining: number;
};

/**
 * Where an agent currently is, for the hover card. `none` means "use the
 * status label"; the others name a place that overrides it («на киберполигоне»).
 */
export const HQ_PLACE = { none: 0, lounge: 1, cyberrange: 2, briefing: 3, podium: 4 } as const;
export type HqPlace = (typeof HQ_PLACE)[keyof typeof HQ_PLACE];

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
  /** HQ_PLACE of the agent: where it is, for the hover card (0 = use status). */
  place: Uint8Array;
};

export type HqClipId = HqClip;
