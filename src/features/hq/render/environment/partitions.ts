import * as THREE from "three";
import type { HqLayout, HqSegment } from "@/features/hq/core/types";
import type { EnvMaterials } from "./envMaterials";
import { noRaycast } from "./glsl";
import { isAm7Partition } from "./layoutGeometry";

// Partitions as five instanced meshes (glass, metal frame, solid panels, and
// the two line brightnesses) over one shared unit box. A thousand-desk floor
// has a few hundred segments; this stays at five draw calls.

type Part = { x: number; y: number; w: number; h: number; d: number; z?: number };

type Buckets = {
  glass: THREE.Matrix4[];
  metal: THREE.Matrix4[];
  wall: THREE.Matrix4[];
  line: THREE.Matrix4[];
  lineFaint: THREE.Matrix4[];
};

const RAIL = 0.05;
const POST = 0.045;
const FRAME_DEPTH = 0.06;
const GLASS_DEPTH = 0.012;
const MAX_PANEL = 1.8;
const DOOR_HEIGHT = 2.2;

/** A unit box with its base at y = 0, so instance scale.y is the height. */
export function createUnitBox(): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  return g;
}

export function buildPartitions(layout: HqLayout, materials: EnvMaterials, unitBox: THREE.BufferGeometry): THREE.Group {
  const buckets: Buckets = { glass: [], metal: [], wall: [], line: [], lineFaint: [] };
  const frame = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);

  for (const seg of layout.partitions) {
    const dx = seg.bx - seg.ax;
    const dz = seg.bz - seg.az;
    const length = Math.hypot(dx, dz);
    if (length < 0.05) continue;
    // Local +X runs from a to b: rotation.y = -atan2(dz, dx).
    q.setFromAxisAngle(up, -Math.atan2(dz, dx));
    frame.compose(new THREE.Vector3((seg.ax + seg.bx) / 2, 0, (seg.az + seg.bz) / 2), q, new THREE.Vector3(1, 1, 1));
    // The balustrade round AM7's island carries the bright line all the way round.
    const lead = isAm7Partition(seg, layout);
    const push = (bucket: THREE.Matrix4[], p: Part) => {
      const local = new THREE.Matrix4().compose(
        new THREE.Vector3(p.x, p.y, p.z ?? 0),
        new THREE.Quaternion(),
        new THREE.Vector3(p.w, p.h, p.d),
      );
      bucket.push(new THREE.Matrix4().multiplyMatrices(frame, local));
    };
    addSegment(seg, length, lead, buckets, push);
  }

  const group = new THREE.Group();
  group.name = "hq-partitions";
  const add = (list: THREE.Matrix4[], material: THREE.Material, name: string, opts?: { shadow?: boolean; order?: number }) => {
    if (list.length === 0) return;
    const mesh = new THREE.InstancedMesh(unitBox, material, list.length);
    mesh.name = name;
    list.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.raycast = noRaycast;
    mesh.castShadow = opts?.shadow ?? false;
    mesh.receiveShadow = opts?.shadow ?? false;
    if (opts?.order !== undefined) mesh.renderOrder = opts.order;
    group.add(mesh);
  };
  add(buckets.wall, materials.wall, "hq-partition-walls", { shadow: true });
  add(buckets.metal, materials.metal, "hq-partition-frames");
  add(buckets.line, materials.line, "hq-partition-lines");
  add(buckets.lineFaint, materials.lineFaint, "hq-partition-lines-faint");
  // Glass last among transparents so the smoked tint sits over what is behind it.
  add(buckets.glass, materials.glass, "hq-partition-glass", { order: 2 });
  return group;
}

function addSegment(
  seg: HqSegment,
  L: number,
  lead: boolean,
  b: Buckets,
  push: (bucket: THREE.Matrix4[], p: Part) => void,
): void {
  const H = Math.max(0.4, seg.height);
  const lineBucket = lead ? b.line : b.lineFaint;

  if (seg.kind === "wall") {
    push(b.wall, { x: 0, y: 0, w: L, h: H, d: 0.12 });
    push(b.metal, { x: 0, y: H, w: L + 0.01, h: 0.03, d: 0.14 });
    push(lineBucket, { x: 0, y: H + 0.03, w: L, h: 0.006, d: 0.016 });
    return;
  }

  // Frame shared by glass runs and doors.
  push(b.metal, { x: 0, y: H - RAIL, w: L, h: RAIL, d: FRAME_DEPTH });
  push(lineBucket, { x: 0, y: H, w: L, h: 0.007, d: 0.014 });
  push(b.metal, { x: -L / 2 + POST / 2, y: 0, w: POST, h: H, d: FRAME_DEPTH });
  push(b.metal, { x: L / 2 - POST / 2, y: 0, w: POST, h: H, d: FRAME_DEPTH });

  if (seg.kind === "glass") {
    push(b.metal, { x: 0, y: 0, w: L, h: 0.06, d: FRAME_DEPTH });
    const panels = Math.max(1, Math.ceil(L / MAX_PANEL));
    const pitch = L / panels;
    for (let i = 0; i < panels; i++) {
      const cx = -L / 2 + pitch * (i + 0.5);
      if (i > 0) push(b.metal, { x: -L / 2 + pitch * i, y: 0.06, w: 0.025, h: H - 0.06 - RAIL, d: 0.04 });
      push(b.glass, { x: cx, y: 0.06, w: pitch - 0.03, h: H - 0.06 - RAIL, d: GLASS_DEPTH });
    }
    return;
  }

  // glass-door: two leaves with a small gap, a transom above, pull handles on both faces.
  const doorH = Math.min(DOOR_HEIGHT, H - 0.25);
  const leaf = L / 2 - POST - 0.012;
  push(b.glass, { x: -(leaf / 2 + 0.012), y: 0.015, w: leaf, h: doorH - 0.015, d: GLASS_DEPTH });
  push(b.glass, { x: leaf / 2 + 0.012, y: 0.015, w: leaf, h: doorH - 0.015, d: GLASS_DEPTH });
  push(b.metal, { x: 0, y: doorH, w: L, h: 0.04, d: FRAME_DEPTH });
  const transom = H - RAIL - (doorH + 0.04);
  if (transom > 0.08) push(b.glass, { x: 0, y: doorH + 0.04, w: L - POST * 2, h: transom, d: GLASS_DEPTH });
  for (const side of [-1, 1]) {
    for (const face of [-1, 1]) {
      push(b.metal, { x: side * 0.07, y: 0.8, w: 0.022, h: 0.75, d: 0.022, z: face * 0.035 });
    }
  }
  // A lit threshold strip marks the door on the floor.
  push(lineBucket, { x: 0, y: 0, w: L - POST * 2, h: 0.004, d: 0.03 });
}
