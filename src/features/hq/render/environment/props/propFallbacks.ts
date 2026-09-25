import * as THREE from "three";
import type { HqPropKind } from "@/features/hq/core/types";
import type { FallbackRole } from "./propMaterials";

// Procedural stand-ins for every prop kind, used while props.glb is missing or
// lacks a kind. Frames and main dimensions follow blender/hq/props*.py:
// origin on the floor at the footprint centre, front facing +Z; exec_desk
// follows the workstation seat contract (origin = chair centre, desk in +Z).

type Vec3 = [x: number, y: number, z: number];
type ShapeBase = { role: FallbackRole; at: Vec3; rotY?: number; blink?: boolean };
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

const FALLBACKS: Record<HqPropKind, Shape[]> = {
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
};

function shapeGeometry(shape: Shape): THREE.BufferGeometry {
  let g: THREE.BufferGeometry;
  if ("box" in shape) g = new THREE.BoxGeometry(shape.box[0], shape.box[1], shape.box[2]);
  else if ("cyl" in shape) g = new THREE.CylinderGeometry(shape.cyl[0], shape.cyl[1], shape.cyl[2], 18);
  else if ("ico" in shape) g = new THREE.IcosahedronGeometry(shape.ico, 1);
  else g = new THREE.PlaneGeometry(shape.plane[0], shape.plane[1]);
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
