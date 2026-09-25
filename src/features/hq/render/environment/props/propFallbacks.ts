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

// Blender turns each monitor by side * 0.3 rad about Z, which is the same
// angle about +Y here; the screen quad faces the sitter (-Z), 1.45 cm proud.
const monitor = (side: -1 | 1): Shape[] => [
  { role: "dark", box: [0.74, 0.44, 0.028], at: [side * 0.39, 1.13, 1.0], rotY: side * 0.3 },
  { role: "screen", plane: [0.72, 0.41], at: [side * (0.39 - 0.0043), 1.135, 0.986], rotY: Math.PI + side * 0.3 },
];

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
  exec_desk: [
    { role: "dark", box: [2.4, 0.05, 0.89], at: [0, 0.725, 0.805] },
    { role: "dark", box: [0.05, 0.7, 0.89], at: [-1.175, 0.35, 0.805] },
    { role: "dark", box: [0.05, 0.7, 0.89], at: [1.175, 0.35, 0.805] },
    { role: "body", box: [2.3, 0.42, 0.02], at: [0, 0.47, 1.19] },
    { role: "ledStatic", box: [2.34, 0.006, 0.004], at: [0, 0.717, 0.3575] },
    ...monitor(-1),
    ...monitor(1),
  ],
  exec_chair: [
    { role: "cushion", box: [0.62, 0.1, 0.6], at: [0, 0.48, 0] },
    { role: "cushion", box: [0.6, 0.8, 0.1], at: [0, 0.95, -0.27] },
    { role: "body", box: [0.06, 0.43, 0.06], at: [0, 0.215, 0] },
    { role: "body", box: [0.6, 0.03, 0.6], at: [0, 0.015, 0] },
  ],
  exec_shelf: [
    { role: "body", box: [0.04, 2.0, 0.4], at: [-0.88, 1.0, 0] },
    { role: "body", box: [0.04, 2.0, 0.4], at: [0.88, 1.0, 0] },
    { role: "dark", box: [1.8, 2.0, 0.02], at: [0, 1.0, -0.19] },
    ...[0.02, 0.5, 1.0, 1.5, 1.98].map((y): Shape => ({ role: "body", box: [1.76, 0.03, 0.38], at: [0, y, 0] })),
    ...[0.47, 0.97, 1.47].map((y): Shape => ({ role: "ledStatic", box: [1.7, 0.008, 0.008], at: [0, y, 0.15] })),
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
