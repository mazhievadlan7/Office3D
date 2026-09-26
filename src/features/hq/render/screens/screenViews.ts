import { HQ_WALL_SCREEN, type HqProp } from "@/features/hq/core/types";
import type { ScreenView } from "./screenSurfaces";

/**
 * Where the big screens hang, so the hub can tell which of them the camera
 * can see and repaint only those at full rate. Pure: plain numbers, no
 * three.js.
 */

export type ScreenAnchor = {
  /** Centre of the display, world metres. */
  x: number;
  y: number;
  z: number;
  /** Bounding radius of the display. */
  r: number;
  /** Outward normal on the floor plane; null for a display seen from all round (curved). */
  nx: number | null;
  nz: number | null;
};

const WALL_SCREEN_Y = 1.55;
const WALL_SCREEN_R = 1.3;
// AM7's curved monitor: about a metre in front of his seat, eyes high (props_exec.py).
const EXEC_MONITOR_AHEAD = 1.0;
const EXEC_MONITOR_Y = 1.06;
const EXEC_MONITOR_R = 0.9;

const CHANNEL_VIEW: Record<number, ScreenView> = {
  [HQ_WALL_SCREEN.exec]: "execWall",
  [HQ_WALL_SCREEN.news]: "news",
  [HQ_WALL_SCREEN.markets]: "markets",
  [HQ_WALL_SCREEN.music]: "music",
};

/** Every big screen of a layout, by what it shows. */
export function screenAnchors(props: readonly HqProp[]): Map<ScreenView, ScreenAnchor[]> {
  const out = new Map<ScreenView, ScreenAnchor[]>();
  const add = (view: ScreenView, anchor: ScreenAnchor) => {
    const list = out.get(view) ?? [];
    list.push(anchor);
    out.set(view, list);
  };
  for (const p of props) {
    const sin = Math.sin(p.rotY);
    const cos = Math.cos(p.rotY);
    if (p.kind === "wall_screen") {
      const view = CHANNEL_VIEW[p.screen ?? HQ_WALL_SCREEN.exec];
      if (view) add(view, { x: p.x, y: WALL_SCREEN_Y, z: p.z, r: WALL_SCREEN_R, nx: sin, nz: cos });
    } else if (p.kind === "exec_desk") {
      add("exec", { x: p.x + sin * EXEC_MONITOR_AHEAD, y: EXEC_MONITOR_Y, z: p.z + cos * EXEC_MONITOR_AHEAD, r: EXEC_MONITOR_R, nx: null, nz: null });
    }
  }
  return out;
}

/** Beyond this a 2.2 m screen is a few dozen pixels wide: its idle rate is plenty. */
export const SCREEN_VIEW_DISTANCE = 60;

/**
 * Whether a camera at (cx, cy, cz) could be looking at the front of an anchor
 * (the frustum test itself is the hub's): close enough and in front of it.
 */
export function anchorFacing(anchor: ScreenAnchor, cx: number, cy: number, cz: number): boolean {
  const dx = cx - anchor.x;
  const dy = cy - anchor.y;
  const dz = cz - anchor.z;
  if (dx * dx + dy * dy + dz * dz > SCREEN_VIEW_DISTANCE * SCREEN_VIEW_DISTANCE) return false;
  if (anchor.nx === null || anchor.nz === null) return true;
  return dx * anchor.nx + dz * anchor.nz > 0.05;
}
