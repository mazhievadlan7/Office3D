/**
 * Floor 27 council cabinet layout. The long table sits at the room origin, its
 * long axis X; 13 chiefs a side (z = ±ROW), AM7 at the −X head, the screen wall
 * behind him. Mirrors blender/hq/council.py (TABLE_L / TABLE_W / seat spacing)
 * so the furniture GLB and the seated androids line up.
 *
 * Seats follow the workstation seat contract: `(x, z)` is the chair centre on
 * the floor (the seated character root) and `rotY` the heading (0 faces +Z).
 * `approach` is where a walker stops before sitting (a short step back from the
 * aisle side of the chair); `turn` is the seated-talk direction toward AM7.
 */

export const COUNCIL_TABLE_L = 11.8;
export const COUNCIL_TABLE_W = 2.3;

/**
 * The cabinet shell (metres), shared by the room renderer (Floor27Room) and the
 * furniture placement (councilGlb) so walls, the emblem and the lounge agree.
 * The east wall's inner face is at width / 2 − 1 (Floor27Room insets it); the
 * north wall is at −depth / 2.
 */
export const COUNCIL_ROOM = { width: COUNCIL_TABLE_L + 10, depth: 14, height: 5 } as const;
export const COUNCIL_ROOM_EAST_X = COUNCIL_ROOM.width / 2 - 1;

const ROW = COUNCIL_TABLE_W / 2 + 0.6; // chair centre, clear of the table edge
const SEAT_PITCH = 0.9;
const SEATS_PER_SIDE = 13;
/**
 * Where AM7 sits at the head (−X end), facing down the table toward +X. He sits
 * right up at the table like the chiefs sit at theirs (≈0.8 m from the head edge
 * to his seat centre), not set back from it.
 */
export const COUNCIL_HEAD = { x: -(COUNCIL_TABLE_L / 2 + 0.8), z: 0, rotY: Math.PI / 2 } as const;
/**
 * Where AM7 enters from before taking his throne: his own door at the head end
 * (the screen side), clear of the table so he never walks through it. He steps
 * in and crosses to the throne while the chiefs stream in from the far door.
 * (When the 27-floor tower + elevator exist this becomes him stepping off the
 * lift; the chiefs enter from COUNCIL_DOOR, the future lift lobby.)
 */
export const COUNCIL_AM7_ENTRANCE = { x: COUNCIL_HEAD.x - 0.7, z: ROW + 2.6, rotY: Math.PI } as const;
/** Centre of the screen wall (behind AM7); the camera frames the table toward it. */
export const COUNCIL_SCREEN_X = -(COUNCIL_TABLE_L / 2 + 2.6);
/** Where agents enter the cabinet from (the +X end), spread across z. */
export const COUNCIL_DOOR = { x: COUNCIL_TABLE_L / 2 + 3.2, z: 0 } as const;

export type CouncilSeat = {
  /** Chair centre on the floor (seated root). */
  x: number;
  z: number;
  /** Seated heading (0 faces +Z). */
  rotY: number;
  /** Standing point a walker stops at before SitDown (aisle side of the chair). */
  approach: { x: number; z: number };
  /** Seated-talk turn toward AM7 at the head: -1 turn-right, +1 turn-left. */
  turn: -1 | 1;
};

/**
 * The 26 chief seats, in the council's speaking order (COUNCIL_FLOORS order):
 * the first 13 down the +Z side (west→east), the next 13 down the −Z side, so
 * neighbours in the speaking order sit next to each other.
 */
export function councilSeats(): CouncilSeat[] {
  const seats: CouncilSeat[] = [];
  const x0 = -((SEATS_PER_SIDE - 1) * SEAT_PITCH) / 2;
  for (const side of [1, -1] as const) {
    for (let k = 0; k < SEATS_PER_SIDE; k += 1) {
      const x = x0 + k * SEAT_PITCH;
      const z = side * ROW;
      // Face the table: +Z-side chairs face −Z (rotY = π), −Z-side face +Z (0).
      const rotY = side === 1 ? Math.PI : 0;
      // Approach from the aisle side (further from the table) of the chair.
      const approach = { x, z: z + side * 0.75 };
      // Turn toward AM7 at the −X head while reporting.
      const turn: -1 | 1 = side === 1 ? 1 : -1;
      seats.push({ x, z, rotY, approach, turn });
    }
  }
  return seats;
}

/** The focus the camera frames: the table centre and a radius that holds it all. */
export const COUNCIL_FOCUS = { x: 0, z: 0, radius: COUNCIL_TABLE_L / 2 + 3 } as const;
