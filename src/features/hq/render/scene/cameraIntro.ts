import { CatmullRomCurve3, Vector3 } from "three";

import type { HqLayout } from "../../core/types";
import { arcCurvature, arcSag } from "../map/mapProjection";
import type { HqCameraPose } from "./cameraMath";

/**
 * The cinematic fly-through played when the HQ opens: a high establishing
 * shot, a descent over the desks, a glide along the world map wall, a turn
 * to the view from behind AM7's island and a slow pan along the wall from
 * east to west — AM7 at the command desk passing in the foreground, the
 * whole amphitheatre of desks and agents beyond — and a rise into the
 * overview the user starts from.
 *
 * Camera and look-at points each follow a centripetal Catmull-Rom spline
 * through shots placed from the real layout, so the flight fits any hall
 * size. The last shot is the home pose, so handing over to the controls is
 * seamless.
 */

export const HQ_INTRO_SECONDS = 24;

export type HqIntroPath = {
  positions: CatmullRomCurve3;
  targets: CatmullRomCurve3;
  duration: number;
  /**
   * Share of the flight each leg between two shots takes (one per leg, in
   * order): the pan behind AM7 gets more time than the transfers.
   */
  legWeights: number[];
};

/** Camera position and look-at point of a camera-controls pose. */
export function poseToLook(pose: HqCameraPose, position = new Vector3(), target = new Vector3()) {
  const s = Math.sin(pose.polar);
  target.set(pose.tx, pose.ty, pose.tz);
  position.set(
    pose.tx + pose.distance * s * Math.sin(pose.azimuth),
    pose.ty + pose.distance * Math.cos(pose.polar),
    pose.tz + pose.distance * s * Math.cos(pose.azimuth),
  );
  return { position, target };
}

export function buildIntroPath(layout: HqLayout, home: HqCameraPose): HqIntroPath {
  const { x0, z0, x1, z1 } = layout.bounds;
  const w = x1 - x0;
  const d = z1 - z0;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const size = Math.max(w, d);
  const map = layout.mapWall;
  const office = layout.am7Office;
  const ax = (office.x0 + office.x1) / 2;
  const az = (office.z0 + office.z1) / 2;
  const ow = office.x1 - office.x0;
  const od = office.z1 - office.z0;
  // Standing-off distance from the map wall, wider for a wider map.
  const mapStand = Math.min(14, Math.max(7, map.width * 0.3));
  // A point on the video wall's face: it is concave, its ends forward of the wall.
  const arcK = arcCurvature(map.width, map.curve);
  const onScreen = (dx: number, y: number) => new Vector3(map.x + dx, y, map.z + arcSag(arcK, dx));
  const homeLook = poseToLook(home);
  // The pan behind AM7: along the wall between the island and the screen,
  // looking into the middle of the rows, the look drifting against the move
  // for parallax.
  const hallZ = Math.min(z1 - d * 0.2, az + d * 0.35);
  const panReach = Math.min(11, w * 0.25);
  const panZ = office.z0 - 1.3;
  const pan = (k: number, y: number): [Vector3, Vector3] => [
    new Vector3(ax + panReach * k, y, panZ),
    new Vector3(cx - 3 * k, 0, hallZ),
  ];

  const shots: Array<[Vector3, Vector3]> = [
    // Establishing: high above the south-east corner, the whole hall below.
    [new Vector3(cx + size * 0.85, size * 0.75, cz + size * 0.95), new Vector3(cx, 0, cz)],
    // Descending toward the entrance side.
    [new Vector3(cx + size * 0.32, size * 0.3, z1 + size * 0.12), new Vector3(cx - w * 0.05, 0, cz)],
    // A low glide over the pods, heading for the map.
    [new Vector3(map.x + w * 0.1, 6.5, cz + d * 0.05), onScreen(0, map.y * 0.9)],
    // In front of the map's west side, low enough to feel the wall's height.
    [new Vector3(map.x - map.width * 0.32, 3.4, z0 + mapStand), onScreen(-map.width * 0.12, map.y)],
    // Sweeping east along the wall.
    [new Vector3(map.x + map.width * 0.22, 3.4, z0 + mapStand * 1.05), onScreen(map.width * 0.3, map.y - 0.2)],
    // Turning off the wall east of the island, AM7 in view, so the look
    // swings from the screen to the hall without a jump.
    [new Vector3(office.x1 + ow * 0.9, 6.2, az - od * 0.05), new Vector3(ax, 1.2, az)],
    // The pan behind AM7, east to west: the whole hall, AM7 passing below.
    pan(1, 8.2),
    pan(0.5, 7.8),
    pan(0, 7.4),
    pan(-0.5, 7.8),
    pan(-1, 8.2),
    // Up and back into the overview.
    [homeLook.position.clone(), homeLook.target.clone()],
  ];

  return {
    positions: new CatmullRomCurve3(
      shots.map(([position]) => position),
      false,
      "centripetal",
    ),
    targets: new CatmullRomCurve3(
      shots.map(([, target]) => target),
      false,
      "centripetal",
    ),
    duration: HQ_INTRO_SECONDS,
    // Establishing, descent, glide, map west, along the wall, turn,
    // four legs of the pan, the rise.
    legWeights: [1.1, 1.1, 1.0, 1.3, 0.9, 0.9, 1.35, 1.35, 1.35, 1.35, 1.5],
  };
}

/**
 * Camera position and target at `seconds` into the intro. The flight eases in
 * and out as a whole (a slow start from the establishing shot, a soft landing
 * on the overview). Returns false once the intro is over.
 */
export function sampleIntro(path: HqIntroPath, seconds: number, position: Vector3, target: Vector3): boolean {
  const t = Math.min(1, Math.max(0, seconds / path.duration));
  const eased = 0.5 - 0.5 * Math.cos(Math.PI * t);
  const u = introCurveParam(path.legWeights, eased);
  path.positions.getPoint(u, position);
  path.targets.getPoint(u, target);
  return t < 1;
}

/**
 * Maps the eased time (0..1) to the curves' parameter, each leg taking its
 * weight's share of the time (the curves give every leg an equal share of
 * their parameter).
 */
export function introCurveParam(legWeights: readonly number[], eased: number): number {
  const legs = legWeights.length;
  if (legs === 0) return eased;
  let total = 0;
  for (const w of legWeights) total += w;
  let at = Math.min(1, Math.max(0, eased)) * total;
  for (let i = 0; i < legs; i++) {
    const w = legWeights[i];
    if (at <= w || i === legs - 1) return (i + Math.min(1, at / w)) / legs;
    at -= w;
  }
  return 1;
}
