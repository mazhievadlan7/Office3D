import { CatmullRomCurve3, Vector3 } from "three";

import type { HqLayout } from "../../core/types";
import type { HqCameraPose } from "./cameraMath";

/**
 * The cinematic fly-through played when the HQ opens: a high establishing
 * shot, a descent over the desks, a glide along the world map wall, a pass by
 * AM7's glass office, and a rise into the overview the user starts from.
 *
 * Camera and look-at points each follow a centripetal Catmull-Rom spline
 * through shots placed from the real layout, so the flight fits any hall
 * size. The last shot is the home pose, so handing over to the controls is
 * seamless.
 */

export const HQ_INTRO_SECONDS = 16;

export type HqIntroPath = {
  positions: CatmullRomCurve3;
  targets: CatmullRomCurve3;
  duration: number;
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
  const homeLook = poseToLook(home);

  const shots: Array<[Vector3, Vector3]> = [
    // Establishing: high above the south-east corner, the whole hall below.
    [new Vector3(cx + size * 0.85, size * 0.75, cz + size * 0.95), new Vector3(cx, 0, cz)],
    // Descending toward the entrance side.
    [new Vector3(cx + size * 0.32, size * 0.3, z1 + size * 0.12), new Vector3(cx - w * 0.05, 0, cz)],
    // A low glide over the pods, heading for the map.
    [new Vector3(map.x + w * 0.1, 6.5, cz + d * 0.05), new Vector3(map.x, map.y * 0.9, z0)],
    // In front of the map's west side.
    [
      new Vector3(map.x - map.width * 0.32, 3.4, z0 + mapStand),
      new Vector3(map.x - map.width * 0.12, map.y, z0),
    ],
    // Sweeping east along the wall.
    [
      new Vector3(map.x + map.width * 0.22, 3.4, z0 + mapStand * 1.05),
      new Vector3(map.x + map.width * 0.3, map.y - 0.2, z0),
    ],
    // Pulling back off the wall toward AM7's corner.
    [
      new Vector3(office.x0 - ow * 0.7, 6.2, office.z1 + od * 0.9),
      new Vector3(office.x0 + ow * 0.2, 1.4, az),
    ],
    // Looking into AM7's glass office from its south-west corner.
    [new Vector3(office.x0 - ow * 0.25, 5.2, office.z1 + od * 0.75), new Vector3(ax, 0.9, az)],
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
  path.positions.getPoint(eased, position);
  path.targets.getPoint(eased, target);
  return t < 1;
}
