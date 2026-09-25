import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { WORKSTATION } from "@/features/hq/core/config";

/**
 * Workstation geometry in its local frame (see WORKSTATION in core/config):
 * origin = chair centre on the floor, the sitter faces +Z, desk top spans
 * x -0.8..0.8 and z 0.36..1.10. One geometry per material group so the whole
 * floor draws as a handful of instanced batches.
 */
export const WS_GROUPS = ["desk", "metal", "chair", "screen", "led", "glass"] as const;
export type WsGroup = (typeof WS_GROUPS)[number];
export type WsLitGroup = "desk" | "metal" | "chair";

export type WorkstationSource = {
  /** Detailed meshes; `desk` and `screen` are always present. */
  lod0: Partial<Record<WsGroup, THREE.BufferGeometry>>;
  /** Far meshes; a missing group reuses its LOD0 geometry. */
  lod1: Partial<Record<WsGroup, THREE.BufferGeometry>>;
  /** Lit materials authored in the GLB; missing ones use the themed stand-ins. */
  materials: Partial<Record<WsLitGroup, THREE.Material>>;
  /** Local bounding sphere of the whole workstation (culling, LOD distance). */
  bounds: THREE.Sphere;
  dispose(): void;
};

const KEEP_ATTRIBUTES = ["position", "normal", "uv"] as const;

// ---------------------------------------------------------------------------
// Procedural fallback: a few boxes per group, used while workstation.glb is
// loading or when it is missing.

type Box = [x0: number, x1: number, y0: number, y1: number, z0: number, z1: number];

function boxGeometry([x0, x1, y0, y1, z0, z1]: Box): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  geometry.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return geometry;
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const geometry = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!geometry) throw new Error("hq workstation: could not merge procedural parts");
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

const SCREEN_W = 0.54;
const SCREEN_H = 0.3;
const HOUSING_DEPTH = 0.03;

/** Monitor i placed in the local frame; `forward` points from the screen to the sitter. */
function monitorFrame(i: number) {
  const m = WORKSTATION.monitors[i];
  const matrix = new THREE.Matrix4()
    .makeRotationY(m.rotY)
    .setPosition(m.x, m.y, m.z);
  const forward = new THREE.Vector3(-Math.sin(m.rotY), 0, -Math.cos(m.rotY));
  return { m, matrix, forward };
}

/** The three screens as one strip; monitor i owns u in [i/3, (i+1)/3], v runs up. */
function screenStrip(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i += 1) {
    const { matrix, forward } = monitorFrame(i);
    const plane = new THREE.PlaneGeometry(SCREEN_W, SCREEN_H);
    // Face the sitter (-Z); u then grows toward -X, which is the sitter's right.
    plane.rotateY(Math.PI);
    const uv = plane.getAttribute("uv") as THREE.BufferAttribute;
    for (let k = 0; k < uv.count; k += 1) uv.setX(k, (i + uv.getX(k)) / 3);
    plane.applyMatrix4(matrix);
    plane.translate(
      forward.x * (HOUSING_DEPTH / 2 + 0.002),
      0,
      forward.z * (HOUSING_DEPTH / 2 + 0.002),
    );
    parts.push(plane);
  }
  return merged(parts);
}

function monitorHousings(withStands: boolean): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i += 1) {
    const { m, matrix, forward } = monitorFrame(i);
    const housing = new THREE.BoxGeometry(SCREEN_W + 0.024, SCREEN_H + 0.024, HOUSING_DEPTH);
    housing.applyMatrix4(matrix);
    parts.push(housing);
    if (!withStands) continue;
    const backX = m.x - forward.x * 0.027;
    const backZ = m.z - forward.z * 0.027;
    const neck = boxGeometry([-0.025, 0.025, WORKSTATION.deskHeight, m.y - 0.02, -0.012, 0.012]);
    neck.rotateY(m.rotY);
    neck.translate(backX, 0, backZ);
    parts.push(neck);
    const foot = boxGeometry([-0.1, 0.1, WORKSTATION.deskHeight, WORKSTATION.deskHeight + 0.012, -0.07, 0.07]);
    foot.rotateY(m.rotY);
    foot.translate(backX, 0, backZ);
    parts.push(foot);
  }
  return parts;
}

function chairBase(): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const lift = new THREE.CylinderGeometry(0.028, 0.028, 0.32, 10);
  lift.translate(0, 0.08 + 0.16, 0);
  parts.push(lift);
  for (let k = 0; k < 5; k += 1) {
    const spoke = boxGeometry([-0.022, 0.022, 0.045, 0.08, 0, 0.3]);
    spoke.rotateY((k / 5) * Math.PI * 2);
    parts.push(spoke);
    const caster = boxGeometry([-0.025, 0.025, 0, 0.045, 0.26, 0.31]);
    caster.rotateY((k / 5) * Math.PI * 2);
    parts.push(caster);
  }
  parts.push(boxGeometry([-0.03, 0.03, 0.45, 0.6, -0.3, -0.24]));
  return parts;
}

export function createProceduralWorkstation(): WorkstationSource {
  const top = WORKSTATION.deskHeight;
  const front = WORKSTATION.deskFront;
  const back = WORKSTATION.deskBack;
  const half = WORKSTATION.width / 2;
  const seat = WORKSTATION.seatHeight;
  const kb = WORKSTATION.keyboard;
  const mouse = WORKSTATION.mouse;

  const deskTop: Box = [-half, half, top - 0.03, top, front, back];
  const modesty: Box = [-half + 0.04, half - 0.04, 0.3, top - 0.03, back - 0.07, back - 0.05];
  const seatBox: Box = [-0.25, 0.25, seat - 0.07, seat, -0.24, 0.24];
  const backrest: Box = [-0.23, 0.23, seat + 0.07, seat + 0.58, -0.31, -0.25];
  const frontLed: Box = [-half + 0.02, half - 0.02, top - 0.026, top - 0.006, front - 0.012, front - 0.002];
  const backLed: Box = [-half + 0.02, half - 0.02, top, top + 0.006, back - 0.045, back - 0.03];
  const glassPane: Box = [-half + 0.01, half - 0.01, top + 0.01, top + 0.56, back - 0.013, back - 0.007];

  const lod0: WorkstationSource["lod0"] = {
    desk: merged([
      boxGeometry(deskTop),
      boxGeometry([-half, -half + 0.03, 0, top - 0.03, front + 0.04, back - 0.04]),
      boxGeometry([half - 0.03, half, 0, top - 0.03, front + 0.04, back - 0.04]),
      boxGeometry(modesty),
    ]),
    metal: merged([
      ...monitorHousings(true),
      ...chairBase(),
      boxGeometry([kb.x - 0.22, kb.x + 0.22, kb.y - 0.009, kb.y + 0.009, kb.z - 0.07, kb.z + 0.07]),
      boxGeometry([mouse.x - 0.03, mouse.x + 0.03, mouse.y - 0.01, mouse.y + 0.01, mouse.z - 0.05, mouse.z + 0.05]),
    ]),
    chair: merged([
      boxGeometry(seatBox),
      boxGeometry(backrest),
      boxGeometry([-0.29, -0.25, seat + 0.12, seat + 0.16, -0.2, 0.14]),
      boxGeometry([0.25, 0.29, seat + 0.12, seat + 0.16, -0.2, 0.14]),
    ]),
    screen: screenStrip(),
    led: merged([boxGeometry(frontLed), boxGeometry(backLed)]),
    glass: merged([boxGeometry(glassPane)]),
  };
  const lod1: WorkstationSource["lod1"] = {
    desk: merged([boxGeometry(deskTop), boxGeometry([-half, half, 0, top - 0.03, back - 0.07, back - 0.05])]),
    metal: merged(monitorHousings(false)),
    chair: merged([boxGeometry(seatBox), boxGeometry(backrest), boxGeometry([-0.04, 0.04, 0.05, seat - 0.07, -0.04, 0.04])]),
  };
  return finishSource(lod0, lod1, {}, () => {
    for (const geometry of [...Object.values(lod0), ...Object.values(lod1)]) geometry?.dispose();
  });
}

// ---------------------------------------------------------------------------
// workstation.glb: meshes ws_<group> and ws_lod1_<group>.

/** Copies one mesh's geometry into the workstation frame as plain float attributes. */
function bakeMesh(mesh: THREE.Mesh, toRoot: THREE.Matrix4): THREE.BufferGeometry {
  const source = mesh.geometry;
  const geometry = new THREE.BufferGeometry();
  for (const name of KEEP_ATTRIBUTES) {
    const attribute = source.getAttribute(name) as
      | THREE.BufferAttribute
      | THREE.InterleavedBufferAttribute
      | undefined;
    if (!attribute) continue;
    // getComponent de-interleaves and de-normalises quantised data.
    const array = new Float32Array(attribute.count * attribute.itemSize);
    for (let i = 0; i < attribute.count; i += 1) {
      for (let c = 0; c < attribute.itemSize; c += 1) {
        array[i * attribute.itemSize + c] = attribute.getComponent(i, c);
      }
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(array, attribute.itemSize));
  }
  const position = geometry.getAttribute("position");
  if (!position) return geometry;
  if (!geometry.getAttribute("uv")) {
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(position.count * 2), 2));
  }
  const index = source.getIndex();
  if (index) {
    geometry.setIndex(Array.from(index.array as ArrayLike<number>));
  } else {
    geometry.setIndex(Array.from({ length: position.count }, (_, i) => i));
  }
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  const matrix = new THREE.Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld);
  geometry.applyMatrix4(matrix);
  // A mirrored node renders with flipped culling in three; baked, its
  // triangles must be rewound instead.
  if (matrix.determinant() < 0) {
    const order = geometry.getIndex()!;
    for (let i = 0; i < order.count; i += 3) {
      const b = order.getX(i + 1);
      order.setX(i + 1, order.getX(i + 2));
      order.setX(i + 2, b);
    }
  }
  return geometry;
}

/**
 * Meshes of one named group. Nested objects that start another ws_ group are
 * skipped so a LOD1 mesh parented under its LOD0 twin does not leak into it.
 */
function collectGroup(root: THREE.Object3D, name: string): THREE.Mesh[] {
  const start = root.getObjectByName(name);
  if (!start) return [];
  const meshes: THREE.Mesh[] = [];
  const visit = (object: THREE.Object3D) => {
    if (object !== start && object.name.startsWith("ws_") && !object.name.startsWith(name)) return;
    if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh);
    for (const child of object.children) visit(child);
  };
  visit(start);
  return meshes;
}

function firstMaterial(mesh: THREE.Mesh): THREE.Material | undefined {
  return Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
}

export function extractGlbWorkstation(scene: THREE.Object3D): WorkstationSource {
  scene.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(scene.matrixWorld).invert();
  const lod0: WorkstationSource["lod0"] = {};
  const lod1: WorkstationSource["lod1"] = {};
  const materials: WorkstationSource["materials"] = {};
  const owned: THREE.BufferGeometry[] = [];

  const build = (name: string): THREE.BufferGeometry | undefined => {
    const meshes = collectGroup(scene, name);
    if (meshes.length === 0) return undefined;
    const parts = meshes.map((mesh) => bakeMesh(mesh, toRoot)).filter((g) => g.getAttribute("position"));
    if (parts.length === 0) return undefined;
    const geometry = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
    if (parts.length > 1) for (const part of parts) part.dispose();
    if (!geometry) return undefined;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    owned.push(geometry);
    return geometry;
  };

  for (const group of WS_GROUPS) {
    lod0[group] = build(`ws_${group}`);
    lod1[group] = build(`ws_lod1_${group}`);
  }
  for (const group of ["desk", "metal", "chair"] as const) {
    const mesh = collectGroup(scene, `ws_${group}`)[0];
    const material = mesh ? firstMaterial(mesh) : undefined;
    if (material && (material as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
      materials[group] = material;
    }
  }
  const dispose = () => {
    for (const geometry of owned) geometry.dispose();
  };
  if (!lod0.desk || !lod0.screen) {
    dispose();
    throw new Error("hq workstation.glb has no ws_desk or ws_screen mesh");
  }
  return finishSource(lod0, lod1, materials, dispose);
}

function finishSource(
  lod0: WorkstationSource["lod0"],
  lod1: WorkstationSource["lod1"],
  materials: WorkstationSource["materials"],
  dispose: () => void,
): WorkstationSource {
  const box = new THREE.Box3();
  for (const geometry of Object.values(lod0)) {
    if (!geometry) continue;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    box.union(geometry.boundingBox!);
  }
  const bounds = box.getBoundingSphere(new THREE.Sphere());
  return { lod0, lod1, materials, bounds, dispose };
}
