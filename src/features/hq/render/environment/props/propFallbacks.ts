import * as THREE from "three";
import type { HqPropKind } from "@/features/hq/core/types";
import type { FallbackRole } from "./propMaterials";

// Procedural stand-ins for every prop kind, used while props.glb is missing or
// lacks a kind. Frames and main dimensions follow blender/hq/props*.py:
// origin on the floor at the footprint centre, front facing +Z; exec_desk
// follows the workstation seat contract (origin = chair centre, desk in +Z).

type Vec3 = [x: number, y: number, z: number];
/** rotX turns the shape about its own x before rotY (a plane with rotX -pi/2 faces up). */
/** uvTop: a plane whose v is 0 at its top edge, like props.glb display quads (canvas rows). */
type ShapeBase = { role: FallbackRole; at: Vec3; rotX?: number; rotY?: number; blink?: boolean; uvTop?: boolean };
type Shape = ShapeBase &
  (
    | { box: [w: number, h: number, d: number] }
    | { cyl: [rTop: number, rBottom: number, h: number] }
    | { ico: number }
    | { plane: [w: number, h: number] }
  );

const RACK = { w: 0.6, h: 2.1, d: 1.1 };

const rackLeds = (): Shape[] => {
  const out: Shape[] = [];
  const z = RACK.d / 2 + 0.012;
  for (let i = 0; i < 28; i++) {
    const y = 0.2 + i * 0.0667;
    out.push({ role: "led", box: [0.02, 0.012, 0.008], at: [0.19, y, z], blink: true });
    out.push({ role: "led", box: [0.02, 0.012, 0.008], at: [0.235, y, z], blink: true });
    if (i % 3 === 0) out.push({ role: "led", box: [0.14, 0.006, 0.008], at: [-0.1, y + 0.02, z], blink: false });
  }
  return out;
};

// Server pillar: a 0.62 m square column 1.35 m tall like props.glb's, a smoked
// glass door on its front with a grid of blinking LEDs behind it and a steady
// red strip up each edge.
const PILLAR = { w: 0.62, h: 1.35 };
const PILLAR_DOOR = { y0: 0.12, y1: 1.25 };

const pillarLeds = (): Shape[] => {
  const out: Shape[] = [];
  const z = PILLAR.w / 2 + 0.008;
  const rows = 12;
  const pitch = (PILLAR_DOOR.y1 - PILLAR_DOOR.y0 - 0.1) / rows;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < 5; col++) {
      // A fixed pattern, about half the grid lit.
      if ((row * 7 + col * 3 + (row % 3) * col) % 9 > 4) continue;
      const y = PILLAR_DOOR.y0 + 0.05 + pitch * (row + 0.5);
      out.push({ role: "led", box: [0.03, 0.012, 0.006], at: [-0.16 + col * 0.08, y, z], blink: true });
    }
  }
  return out;
};

// Tribune (blender/hq/props_tech.py tribune): AM7's lectern, its front to +Z
// (the rows) with a red light line, the reading desk sloping toward the
// speaker behind it (-Z) and a microphone on his side.
const TRIBUNE = { w: 0.86, d: 0.8, h: 1.07, desk: 1.16 };

// Archive station (blender/hq/props_archive.py), in three.js frames (Blender
// -Y is +Z here). Cart: origin at the deck centre, nose +Z, the grip bar
// 0.62 m behind at 0.97 m. Bay: mouth +Z, bumper wall and gauge tower at -Z.
// Chute: roller lip and slot at +Z, slot floor 0.62 m.
const CART = { w: 0.6, l: 1.0, deck: 0.2, gripZ: -0.62, gripY: 0.97, tabletY: 1.05, tabletZ: -0.6 };
/**
 * The tablet leans back 35 degrees: its face looks at the pusher (-Z) and a
 * little up. A +Z-facing plane turned by rotX TABLET_TILT, then rotY pi.
 */
const TABLET_TILT = -0.6109;
/** The display surface, 7.2 mm proud of the tablet's centre plane along its face normal. */
const TABLET_FACE: Vec3 = [0, CART.tabletY + 0.0072 * 0.5736, CART.tabletZ - 0.0072 * 0.8192];
/** A cylinder (axis Y) turned onto the X axis: grips, caster axles. */
const ALONG_X = { rotX: Math.PI / 2, rotY: Math.PI / 2 } as const;
const CASE = { w: 0.27, h: 0.19, l: 0.34, y0: 0.202 };
const archiveCase = (x: number, z: number, y0 = CASE.y0): Shape => ({
  role: "dark",
  box: [CASE.w, CASE.h, CASE.l],
  at: [x, y0 + CASE.h / 2, z],
});
const PAPER = (x: number, z: number, y0: number, h: number): Shape => ({ role: "cushion", box: [0.3, h, 0.21], at: [x, y0 + h / 2, z] });
const CASE_TOP = CASE.y0 + CASE.h + 0.001;
const BAY = { w: 0.95, d: 1.4, wallZ: -0.63, wallH: 0.342, towerH: 1.26, gaugeZ: -0.551 };
const bayLed = (k: number): Shape => ({
  role: k === 4 ? "led" : "ledStatic",
  box: [0.12, 0.085, 0.002],
  at: [0, 0.66 + 0.0425 + (k - 1) * 0.105, BAY.gaugeZ],
  blink: k === 4,
});
const CHUTE = { w: 0.7, h: 0.94, bodyD: 0.46, bodyZ: -0.07, slotY: 0.73, slotZ: 0.16 };

const FALLBACKS: Record<HqPropKind, Shape[]> = {
  archive_cart: [
    // Moulded deck with its brushed waist band, the side skirts and the nose bumper.
    { role: "dark", box: [CART.w, 0.05, CART.l], at: [0, 0.17, 0] },
    { role: "body", box: [CART.w + 0.005, 0.007, CART.l + 0.005], at: [0, 0.154, 0] },
    ...([-1, 1] as const).map((s): Shape => ({ role: "dark", box: [0.022, 0.068, 0.9], at: [s * 0.289, 0.12, 0] })),
    { role: "dark", box: [0.44, 0.036, 0.02], at: [0, 0.165, 0.502] },
    // The short red running lines on the long sides.
    ...([-1, 1] as const).map((s): Shape => ({ role: "ledStatic", box: [0.003, 0.0035, 0.22], at: [s * 0.3012, 0.169, 0.29] })),
    // Rear spine and the U-yoke: two raked legs up to the grip bar, rubber grips, the hub.
    { role: "dark", box: [0.618, 0.105, 0.073], at: [0, 0.252, -0.468] },
    ...([-1, 1] as const).map((s): Shape => ({ role: "dark", box: [0.036, 0.71, 0.036], at: [s * 0.285, 0.586, -0.537], rotX: -0.213 })),
    { role: "dark", box: [0.606, 0.028, 0.028], at: [0, CART.gripY, CART.gripZ] },
    ...([-1, 1] as const).map((s): Shape => ({ role: "cushion", cyl: [0.0175, 0.0175, 0.09], at: [s * 0.2, CART.gripY, CART.gripZ], ...ALONG_X })),
    { role: "dark", box: [0.2, 0.034, 0.036], at: [0, CART.gripY + 0.004, CART.gripZ] },
    // Swivel casters (axles across the cart).
    ...([-1, 1] as const).flatMap((sx) =>
      ([-1, 1] as const).map((sz): Shape => ({ role: "body", cyl: [0.0625, 0.0625, 0.03], at: [sx * 0.215, 0.0625, sz * 0.37], ...ALONG_X })),
    ),
    // Tablet stalk, frame and display; the renderer draws the read-out on the "screen" quad.
    { role: "body", box: [0.03, 0.09, 0.016], at: [0, CART.gripY + 0.045, CART.gripZ + 0.012] },
    { role: "dark", box: [0.172, 0.108, 0.012], at: [0, CART.tabletY, CART.tabletZ], rotX: TABLET_TILT },
    { role: "screen", plane: [0.154, 0.09], at: TABLET_FACE, rotX: TABLET_TILT, rotY: Math.PI, uvTop: true },
  ],
  archive_cart_lit: [{ role: "ledStatic", box: [0.16, 0.007, 0.004], at: [0, CART.gripY + 0.008, CART.gripZ - 0.02] }],
  archive_cart_display_full: [{ role: "ledStatic", box: [0.13, 0.03, 0.004], at: [0, CART.tabletY + 0.008, CART.tabletZ - 0.005], rotX: TABLET_TILT }],
  archive_cart_display_empty: [{ role: "body", box: [0.13, 0.008, 0.004], at: [0, CART.tabletY + 0.008, CART.tabletZ - 0.005], rotX: TABLET_TILT }],
  archive_load_1: [archiveCase(-0.14, 0.305), archiveCase(0.14, 0.305), PAPER(0, -0.325, CASE.y0, 0.06)],
  archive_load_2: [archiveCase(-0.14, -0.04), archiveCase(0.14, -0.04)],
  archive_load_3: [archiveCase(-0.138, 0.297, CASE_TOP), archiveCase(0.144, 0.291, CASE_TOP), PAPER(0, -0.323, CASE.y0 + 0.061, 0.05)],
  archive_load_4: [archiveCase(-0.14, -0.036, CASE_TOP), PAPER(0.13, -0.045, CASE_TOP, 0.055)],
  archive_case: [archiveCase(0, 0, 0)],
  archive_bay: [
    { role: "dark", box: [BAY.w, 0.022, BAY.d], at: [0, 0.011, 0] },
    ...([-1, 1] as const).map((s): Shape => ({ role: "body", box: [0.045, 0.042, 1.07], at: [s * 0.385, 0.043, 0.075] })),
    { role: "dark", box: [BAY.w, BAY.wallH, 0.14], at: [0, BAY.wallH / 2, BAY.wallZ] },
    { role: "dark", box: [0.26, BAY.towerH - BAY.wallH, 0.13], at: [0, (BAY.wallH + BAY.towerH) / 2, -0.625] },
    { role: "ledStatic", box: [0.17, 0.0025, 0.002], at: [0, 1.15, -0.5535] },
    // The gauge's four dark windows (the lit segments are archive_bay_led_k) and the label plate.
    ...[1, 2, 3, 4].map((k): Shape => ({ role: "body", box: [0.14, 0.095, 0.002], at: [0, 0.66 + 0.0425 + (k - 1) * 0.105, BAY.gaugeZ - 0.001] })),
    { role: "body", box: [0.2, 0.06, 0.004], at: [0, 1.2, BAY.gaugeZ] },
  ],
  archive_bay_led_1: [bayLed(1)],
  archive_bay_led_2: [bayLed(2)],
  archive_bay_led_3: [bayLed(3)],
  archive_bay_led_4: [bayLed(4)],
  archive_chute: [
    { role: "dark", box: [CHUTE.w, 0.62, CHUTE.bodyD], at: [0, 0.31, CHUTE.bodyZ] },
    { role: "dark", box: [CHUTE.w, CHUTE.h - 0.84, CHUTE.bodyD], at: [0, (0.84 + CHUTE.h) / 2, CHUTE.bodyZ] },
    ...([-1, 1] as const).map((s): Shape => ({ role: "dark", box: [0.12, 0.22, CHUTE.bodyD], at: [s * 0.29, 0.73, CHUTE.bodyZ] })),
    { role: "body", box: [0.46, 0.03, 0.14], at: [0, 0.585, 0.23] },
    // Feed rollers across the lip, and a lid.
    ...[0.18, 0.215, 0.25, 0.285].map((z): Shape => ({ role: "dark", cyl: [0.011, 0.011, 0.44], at: [0, 0.611, z], ...ALONG_X })),
    { role: "body", box: [CHUTE.w + 0.02, 0.025, CHUTE.bodyD + 0.02], at: [0, CHUTE.h + 0.0125, CHUTE.bodyZ] },
    { role: "ledStatic", box: [0.4, 0.004, 0.003], at: [0, 0.586, 0.3015] },
  ],
  archive_chute_shutter: [{ role: "dark", box: [0.448, 0.22, 0.01], at: [0, CHUTE.slotY, 0.138] }],
  archive_chute_slot: [{ role: "ledStatic", box: [0.45, 0.21, 0.002], at: [0, CHUTE.slotY, -0.138] }],
  planter_tall: [
    { role: "dark", cyl: [0.27, 0.22, 0.62], at: [0, 0.31, 0] },
    { role: "foliage", ico: 0.42, at: [0, 1.02, 0] },
    { role: "foliage", ico: 0.34, at: [0.08, 1.42, -0.05] },
    { role: "foliage", ico: 0.25, at: [-0.1, 1.7, 0.05] },
  ],
  planter_low: [
    { role: "dark", box: [1.2, 0.42, 0.42], at: [0, 0.21, 0] },
    { role: "foliage", ico: 0.3, at: [-0.35, 0.55, 0] },
    { role: "foliage", ico: 0.33, at: [0, 0.6, 0] },
    { role: "foliage", ico: 0.3, at: [0.35, 0.55, 0] },
  ],
  server_rack: [
    { role: "dark", box: [RACK.w, RACK.h, RACK.d], at: [0, RACK.h / 2, 0] },
    { role: "body", box: [RACK.w - 0.02, RACK.h - 0.12, 0.02], at: [0, RACK.h / 2, RACK.d / 2 + 0.002] },
    { role: "led", box: [0.01, 1.8, 0.008], at: [-0.26, RACK.h / 2, RACK.d / 2 + 0.012], blink: false },
    ...rackLeds(),
  ],
  server_pillar: [
    { role: "body", box: [PILLAR.w, 0.045, PILLAR.w], at: [0, 0.0225, 0] },
    { role: "dark", box: [PILLAR.w, PILLAR.h - 0.045, PILLAR.w], at: [0, (PILLAR.h + 0.045) / 2, 0] },
    {
      role: "body",
      box: [0.5, PILLAR_DOOR.y1 - PILLAR_DOOR.y0, 0.01],
      at: [0, (PILLAR_DOOR.y0 + PILLAR_DOOR.y1) / 2, PILLAR.w / 2 + 0.002],
    },
    ...[-0.28, 0.28].map(
      (x): Shape => ({
        role: "ledStatic",
        box: [0.02, PILLAR_DOOR.y1 - PILLAR_DOOR.y0, 0.008],
        at: [x, (PILLAR_DOOR.y0 + PILLAR_DOOR.y1) / 2, PILLAR.w / 2 + 0.006],
      }),
    ),
    ...pillarLeds(),
  ],
  data_monolith: [
    { role: "body", box: [0.9, 0.05, 0.5], at: [0, 0.025, 0] },
    { role: "ledStatic", box: [0.8, 0.006, 0.01], at: [0, 0.053, 0.23] },
    { role: "dark", box: [0.5, 2.55, 0.18], at: [0, 1.325, 0] },
    { role: "ledStatic", box: [0.02, 2.2, 0.008], at: [0, 1.35, 0.093] },
    ...[0.5, 0.85, 1.2, 1.55, 1.9, 2.25].map((y): Shape => ({ role: "ledStatic", box: [0.26, 0.005, 0.004], at: [0, y, 0.092] })),
  ],
  // A spiky crown of cones for the strap-leaf rosette.
  dark_plant: [
    { role: "dark", cyl: [0.28, 0.25, 0.55], at: [0, 0.275, 0] },
    { role: "ledStatic", cyl: [0.285, 0.285, 0.012], at: [0, 0.55, 0] },
    { role: "dark", cyl: [0.5, 0.06, 0.35], at: [0, 0.74, 0] },
    { role: "dark", cyl: [0.0, 0.3, 0.75], at: [0, 1.0, 0] },
  ],
  sofa: [
    { role: "cushion", box: [2.2, 0.42, 0.9], at: [0, 0.21, 0] },
    { role: "cushion", box: [2.2, 0.45, 0.2], at: [0, 0.645, -0.35] },
    { role: "cushion", box: [0.18, 0.62, 0.9], at: [-1.01, 0.31, 0] },
    { role: "cushion", box: [0.18, 0.62, 0.9], at: [1.01, 0.31, 0] },
  ],
  lounge_chair: [
    { role: "cushion", box: [0.82, 0.4, 0.8], at: [0, 0.2, 0] },
    { role: "cushion", box: [0.82, 0.45, 0.16], at: [0, 0.62, -0.32] },
    { role: "cushion", box: [0.12, 0.55, 0.8], at: [-0.41, 0.275, 0] },
    { role: "cushion", box: [0.12, 0.55, 0.8], at: [0.41, 0.275, 0] },
  ],
  coffee_table: [
    { role: "dark", box: [1.1, 0.04, 0.6], at: [0, 0.4, 0] },
    { role: "body", box: [0.9, 0.38, 0.4], at: [0, 0.19, 0] },
  ],
  coffee_bar: [
    { role: "dark", box: [2.4, 1.0, 0.7], at: [0, 0.5, 0] },
    { role: "body", box: [2.5, 0.04, 0.76], at: [0, 1.02, 0] },
    { role: "ledStatic", box: [2.3, 0.015, 0.015], at: [0, 0.94, 0.356] },
    { role: "body", box: [0.4, 0.45, 0.35], at: [-0.8, 1.265, -0.1] },
  ],
  meeting_table: [
    { role: "dark", box: [3.2, 0.05, 1.3], at: [0, 0.735, 0] },
    { role: "body", box: [0.08, 0.71, 0.9], at: [-1.3, 0.355, 0] },
    { role: "body", box: [0.08, 0.71, 0.9], at: [1.3, 0.355, 0] },
  ],
  meeting_chair: [
    { role: "cushion", box: [0.5, 0.08, 0.5], at: [0, 0.46, 0] },
    { role: "cushion", box: [0.48, 0.5, 0.06], at: [0, 0.77, -0.22] },
    { role: "body", box: [0.05, 0.42, 0.05], at: [0, 0.21, 0] },
    { role: "body", box: [0.5, 0.03, 0.5], at: [0, 0.015, 0] },
  ],
  // The command arc as three slabs (the middle and both wings turned 45
  // degrees toward the chair) on two end pods, and one wide monitor.
  exec_desk: [
    { role: "dark", box: [1.3, 0.075, 0.78], at: [0, 0.712, 0.75] },
    ...([-1, 1] as const).map((side): Shape => ({
      role: "dark",
      box: [1.1, 0.075, 0.78],
      at: [side * 0.93, 0.712, 0.38],
      rotY: -side * 0.7,
    })),
    ...([-1, 1] as const).map((side): Shape => ({ role: "dark", cyl: [0.26, 0.26, 0.6], at: [side * 1.17, 0.3, 0.27] })),
    { role: "body", box: [1.2, 0.6, 0.12], at: [0, 0.3, 1.02] },
    { role: "ledStatic", box: [1.3, 0.004, 0.006], at: [0, 0.713, 0.36] },
    { role: "dark", box: [1.4, 0.44, 0.03], at: [0, 1.065, 1.0] },
    { role: "screen", plane: [1.38, 0.41], at: [0, 1.065, 0.984], rotY: Math.PI },
  ],
  exec_chair: [
    { role: "cushion", box: [0.62, 0.1, 0.6], at: [0, 0.48, 0] },
    { role: "cushion", box: [0.6, 0.8, 0.1], at: [0, 0.95, -0.27] },
    { role: "body", box: [0.06, 0.43, 0.06], at: [0, 0.215, 0] },
    { role: "body", box: [0.6, 0.03, 0.6], at: [0, 0.015, 0] },
  ],
  // 2.0 m units, like props.glb; the layout lines several up side by side.
  exec_shelf: [
    { role: "body", box: [0.03, 2.2, 0.4], at: [-0.985, 1.1, 0] },
    { role: "body", box: [0.03, 2.2, 0.4], at: [0.985, 1.1, 0] },
    { role: "dark", box: [1.94, 2.2, 0.02], at: [0, 1.1, -0.19] },
    ...[0.04, 0.52, 0.96, 1.4, 1.82, 2.185].map((y): Shape => ({ role: "body", box: [1.94, 0.03, 0.38], at: [0, y, 0] })),
    ...[0.5, 0.94, 1.38, 1.8].map((y): Shape => ({ role: "ledStatic", box: [1.86, 0.008, 0.008], at: [0, y, 0.15] })),
  ],
  wall_screen: [
    { role: "dark", box: [2.2, 1.25, 0.05], at: [0, 1.55, 0] },
    { role: "screen", plane: [2.176, 1.226], at: [0, 1.55, 0.0252] },
  ],
  floor_lamp: [
    { role: "dark", cyl: [0.15, 0.15, 0.03], at: [0, 0.015, 0] },
    { role: "body", cyl: [0.011, 0.011, 1.33], at: [0, 0.695, 0] },
    { role: "warm", cyl: [0.19, 0.19, 0.3], at: [0, 1.45, 0] },
  ],
  tribune: [
    { role: "dark", box: [TRIBUNE.w, TRIBUNE.h, TRIBUNE.d], at: [0, TRIBUNE.h / 2, 0] },
    { role: "body", box: [TRIBUNE.w + 0.08, 0.05, TRIBUNE.d + 0.12], at: [0, TRIBUNE.desk - 0.02, -0.04], rotX: -0.2 },
    { role: "ledStatic", box: [0.02, TRIBUNE.h - 0.2, 0.008], at: [0, TRIBUNE.h / 2, TRIBUNE.d / 2 + 0.005] },
    ...([-1, 1] as const).map(
      (side): Shape => ({ role: "ledStatic", box: [0.012, TRIBUNE.h, 0.012], at: [side * (TRIBUNE.w / 2), TRIBUNE.h / 2, TRIBUNE.d / 2] }),
    ),
    { role: "ledStatic", box: [0.3, 0.004, 0.16], at: [0, TRIBUNE.desk + 0.012, -0.1], rotX: -0.2 },
    { role: "body", cyl: [0.006, 0.006, 0.34], at: [0.2, TRIBUNE.desk + 0.16, -0.24], rotX: -0.35 },
  ],
};

function shapeGeometry(shape: Shape): THREE.BufferGeometry {
  let g: THREE.BufferGeometry;
  if ("box" in shape) g = new THREE.BoxGeometry(shape.box[0], shape.box[1], shape.box[2]);
  else if ("cyl" in shape) g = new THREE.CylinderGeometry(shape.cyl[0], shape.cyl[1], shape.cyl[2], 18);
  else if ("ico" in shape) g = new THREE.IcosahedronGeometry(shape.ico, 1);
  else g = new THREE.PlaneGeometry(shape.plane[0], shape.plane[1]);
  if (shape.uvTop) {
    const uv = g.getAttribute("uv") as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  }
  if (shape.rotX) g.rotateX(shape.rotX);
  if (shape.rotY) g.rotateY(shape.rotY);
  g.translate(shape.at[0], shape.at[1], shape.at[2]);
  if (shape.role === "led") {
    // Same convention as props.glb: constant UV, u = blink phase, v = blink flag.
    const uv = g.getAttribute("uv") as THREE.BufferAttribute;
    const phase = ledPhase();
    for (let i = 0; i < uv.count; i++) uv.setXY(i, phase, shape.blink ? 1 : 0);
  }
  // Mixed indexed and non-indexed parts cannot be merged.
  const flat = g.index ? g.toNonIndexed() : g;
  if (flat !== g) g.dispose();
  return flat;
}

// Deterministic phases so the stand-ins look the same on every load.
let phaseState = 0x9e3779b9;
function ledPhase(): number {
  phaseState = Math.imul(phaseState ^ (phaseState >>> 15), 0x2c1b3c6d) >>> 0;
  phaseState = (phaseState + 0x6d2b79f5) >>> 0;
  return phaseState / 4294967296;
}

/** Stand-in geometry for a kind, one list of parts per material role. */
export function fallbackParts(kind: HqPropKind): Array<{ role: FallbackRole; geometries: THREE.BufferGeometry[] }> {
  const byRole = new Map<FallbackRole, THREE.BufferGeometry[]>();
  for (const shape of FALLBACKS[kind] ?? []) {
    const list = byRole.get(shape.role) ?? [];
    list.push(shapeGeometry(shape));
    byRole.set(shape.role, list);
  }
  return [...byRole].map(([role, geometries]) => ({ role, geometries }));
}
