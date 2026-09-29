import type { HqLayout } from "../../core/types";

/**
 * Camera framing for the HQ, kept free of three.js so it can be reasoned about
 * (and tested) as plain maths.
 *
 * Angles follow camera-controls: `azimuth` turns around +Y with 0 meaning the
 * camera sits on +Z of its target, `polar` is measured down from +Y. The room
 * is always seen from the south-east quadrant (azimuth 0..π/2), which keeps the
 * tall north and west walls behind everything.
 */

export type HqCameraPose = {
  tx: number;
  ty: number;
  tz: number;
  azimuth: number;
  polar: number;
  distance: number;
};

export type HqCameraPreset = "overview" | "am7" | "map" | "briefing" | "follow";

const DEG = Math.PI / 180;

export const HQ_CAMERA = {
  fov: 30,
  azimuth: 45 * DEG,
  polar: (90 - 38) * DEG,
  // Free to orbit the hall all the way round.
  minAzimuth: -Infinity,
  maxAzimuth: Infinity,
  // From a near top-down view to a low cinematic angle.
  minPolar: 16 * DEG,
  maxPolar: 82 * DEG,
  minDistance: 2.5,
  followDistance: 9,
} as const;

type Point = readonly [number, number, number];

/**
 * Distance from `target` at which every point is inside a perspective frustum
 * looking along the given angles. Exact for a pinhole camera: each point needs
 * depth ≥ |offset| / tan(half fov) in both screen axes.
 */
export function fitDistance(
  points: readonly Point[],
  target: Point,
  azimuth: number,
  polar: number,
  fovDeg: number,
  aspect: number,
  margin = 1.08,
): number {
  const sinP = Math.sin(polar);
  const cosP = Math.cos(polar);
  const sinA = Math.sin(azimuth);
  const cosA = Math.cos(azimuth);
  // Unit vector from the target toward the camera.
  const dx = sinP * sinA;
  const dy = cosP;
  const dz = sinP * cosA;
  // Camera right and up vectors for that view direction and world +Y up.
  const rx = cosA;
  const rz = -sinA;
  const ux = -sinA * cosP;
  const uy = sinP;
  const uz = -cosA * cosP;
  const tanV = Math.tan((fovDeg * DEG) / 2) / margin;
  const tanH = tanV * Math.max(0.2, aspect);
  let needed: number = HQ_CAMERA.minDistance;
  for (const [px, py, pz] of points) {
    const vx = px - target[0];
    const vy = py - target[1];
    const vz = pz - target[2];
    const along = vx * dx + vy * dy + vz * dz;
    const sx = Math.abs(vx * rx + vz * rz);
    const sy = Math.abs(vx * ux + vy * uy + vz * uz);
    needed = Math.max(needed, along + sx / tanH, along + sy / tanV);
  }
  return needed;
}

function roomPoints(layout: HqLayout): Point[] {
  const { x0, z0, x1, z1 } = layout.bounds;
  const h = layout.wallHeight;
  const north = Math.max(h, layout.northWallHeight);
  // Floor corners plus the tops of the two tall back walls (the north one, with the video wall, taller).
  return [
    [x0, 0, z0],
    [x1, 0, z0],
    [x1, 0, z1],
    [x0, 0, z1],
    [x0, north, z0],
    [x1, north, z0],
    [x0, h, z1],
  ];
}

/** The whole room, from the signature south-east angle. */
export function overviewPose(layout: HqLayout, aspect: number): HqCameraPose {
  const { x0, z0, x1, z1 } = layout.bounds;
  const target: Point = [(x0 + x1) / 2, 0, (z0 + z1) / 2];
  return {
    tx: target[0],
    ty: target[1],
    tz: target[2],
    azimuth: HQ_CAMERA.azimuth,
    polar: HQ_CAMERA.polar,
    distance: fitDistance(roomPoints(layout), target, HQ_CAMERA.azimuth, HQ_CAMERA.polar, HQ_CAMERA.fov, aspect, 1.04),
  };
}

/**
 * Where the intro lands. A small floor is shown whole; on a large one the full
 * overview makes people specks, so the camera stops closer, centred on the
 * layout's focus hint and pulled toward the north wall so the map stays in
 * frame.
 */
const HOME_MAX_DISTANCE = 78;

export function homePose(layout: HqLayout, aspect: number): HqCameraPose {
  const overview = overviewPose(layout, aspect);
  if (overview.distance <= HOME_MAX_DISTANCE) return overview;
  const { x, z } = layout.focus;
  return {
    ...overview,
    tx: x,
    tz: Math.min(z, layout.bounds.z0 + 36),
    distance: HOME_MAX_DISTANCE,
  };
}

/** AM7's glass office, a little closer and steeper so the desk reads. */
export function am7Pose(layout: HqLayout, aspect: number): HqCameraPose {
  const { x0, z0, x1, z1 } = layout.am7Office;
  const target: Point = [(x0 + x1) / 2, 0.6, (z0 + z1) / 2];
  const h = Math.min(layout.wallHeight, 2.6);
  const points: Point[] = [
    [x0, 0, z0],
    [x1, 0, z0],
    [x1, 0, z1],
    [x0, 0, z1],
    [x0, h, z0],
    [x1, h, z0],
    [x0, h, z1],
  ];
  const azimuth = 40 * DEG;
  const polar = (90 - 42) * DEG;
  return {
    tx: target[0],
    ty: target[1],
    tz: target[2],
    azimuth,
    polar,
    distance: fitDistance(points, target, azimuth, polar, HQ_CAMERA.fov, aspect, 1.12),
  };
}

/**
 * Square-on to the video wall, low enough to feel its height. Its ends stand
 * `curve` in front of the wall (the display is concave), and they frame it.
 */
export function mapPose(layout: HqLayout, aspect: number): HqCameraPose {
  const wall = layout.mapWall;
  const curve = Math.max(0, wall.curve);
  const target: Point = [wall.x, wall.y, wall.z + curve / 2];
  const hw = wall.width / 2;
  const hh = wall.height / 2;
  const ends = wall.z + curve;
  const points: Point[] = [
    [wall.x - hw, wall.y - hh, ends],
    [wall.x + hw, wall.y - hh, ends],
    [wall.x - hw, wall.y + hh, ends],
    [wall.x + hw, wall.y + hh, ends],
    [wall.x, wall.y - hh, wall.z],
    [wall.x, wall.y + hh, wall.z],
  ];
  const azimuth = 12 * DEG;
  const polar = (90 - 19) * DEG;
  return {
    tx: target[0],
    ty: target[1],
    tz: target[2],
    azimuth,
    polar,
    distance: fitDistance(points, target, azimuth, polar, HQ_CAMERA.fov, aspect, 1.1),
  };
}

/**
 * A briefing: from behind the front rows, low, looking at the tribune with the
 * video wall rising behind the lead, the rows' heads in the foreground.
 */
export function briefingPose(layout: HqLayout, aspect: number): HqCameraPose {
  const wall = layout.mapWall;
  const { tribune } = layout;
  // The walkway arc in front of the first row, 2.5 m south of the tribune.
  const podiumZ = tribune.z + 2.5;
  const target: Point = [tribune.x, 2.4, tribune.z];
  // All three screens (both wings and the map) in frame; the display's ends
  // stand `curve` metres in front of the wall.
  const hw = wall.width * 0.5;
  const top = wall.y + wall.height / 2;
  const points: Point[] = [
    [wall.x - hw, top, wall.z + wall.curve],
    [wall.x + hw, top, wall.z + wall.curve],
    [wall.x, top, wall.z],
    [tribune.x, 0, podiumZ],
    [tribune.x - 3, 1.8, podiumZ + 1],
    [tribune.x + 3, 1.8, podiumZ + 1],
  ];
  const azimuth = 7 * DEG;
  const polar = (90 - 18) * DEG;
  return {
    tx: target[0],
    ty: target[1],
    tz: target[2],
    azimuth,
    polar,
    distance: fitDistance(points, target, azimuth, polar, HQ_CAMERA.fov, aspect, 1.06),
  };
}

/** Distance range for the controls: close enough for a face, far enough for the whole floor. */
export function distanceLimits(layout: HqLayout, aspect: number): { min: number; max: number } {
  // Fit for the narrowest aspect the view is likely to have, so a portrait
  // window still reaches the whole room.
  const overview = overviewPose(layout, Math.min(aspect, 1.2));
  return { min: HQ_CAMERA.minDistance, max: overview.distance * 1.3 };
}
