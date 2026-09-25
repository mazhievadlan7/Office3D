import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { HqProp, HqPropKind } from "@/features/hq/core/types";
import { noRaycast } from "../glsl";
import { GLOW } from "../palette";
import { fallbackParts } from "./propFallbacks";
import { patchBlink, type FallbackRole, type PropUniforms } from "./propMaterials";

// Turns props.glb (or the procedural stand-ins) into one InstancedMesh per
// (prop kind, material): each kind's child meshes are baked into the kind's
// local frame and merged by material, then drawn once for every placement.
//
// props.glb contract (blender/hq/props.py): one empty per HqPropKind named
// exactly like the kind (Blender ".001" suffixes tolerated) with one mesh per
// material below it; origin on the floor, front facing +Z. The "screen"
// material becomes the animated dashboard, "emissive_red" LEDs blink on
// server racks and server pillars (per-LED phase in their UVs), emissive
// materials are pushed into bloom range.

export type PropMaterialSet = {
  screen: THREE.Material;
  /** AM7's curved monitor ("screen_exec" in props.glb); `screen` when absent. */
  execScreen?: THREE.Material;
  /** True when `screen` reads the per-instance aPanel channel (HqProp.screen). */
  screenChannels?: boolean;
  fallback: Record<FallbackRole, THREE.Material>;
};

export type PropBatchGroup = {
  root: THREE.Group;
  /** Geometries and materials this group created and must dispose. */
  owned: { geometries: THREE.BufferGeometry[]; materials: THREE.Material[] };
};

type Part = { material: THREE.Material; geometries: THREE.BufferGeometry[] };

const KIND_NAMES: ReadonlySet<string> = new Set<HqPropKind>([
  "planter_tall",
  "planter_low",
  "server_rack",
  "server_pillar",
  "data_monolith",
  "dark_plant",
  "sofa",
  "lounge_chair",
  "coffee_table",
  "coffee_bar",
  "meeting_table",
  "meeting_chair",
  "exec_desk",
  "exec_chair",
  "exec_shelf",
  "wall_screen",
  "floor_lamp",
]);

// Kinds whose "emissive_red" LEDs blink (the same shader path for all).
const BLINKING: ReadonlySet<HqPropKind> = new Set<HqPropKind>(["server_rack", "server_pillar"]);

// Kinds whose red lights glow at a set level instead of the bloom floor: the
// server pillars stand among the desks, so their strips and LEDs sit at about
// the brightness of the monitors around them, all in one tone.
const GLOW_LEVEL: Partial<Record<HqPropKind, number>> = { server_pillar: 1.4 };

// Kinds too flat or wall-mounted to be worth a shadow pass.
const NO_SHADOW: ReadonlySet<HqPropKind> = new Set<HqPropKind>(["wall_screen", "coffee_table"]);

function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[\s-]+/g, "_").replace(/[._]\d{3}$/, "");
}

/** Finds the root node of every prop kind in the GLB scene. */
export function findKindRoots(scene: THREE.Object3D): Map<HqPropKind, THREE.Object3D> {
  const roots = new Map<HqPropKind, THREE.Object3D>();
  scene.traverse((node) => {
    const name = normaliseName(node.name);
    if (KIND_NAMES.has(name) && !roots.has(name as HqPropKind)) roots.set(name as HqPropKind, node);
  });
  return roots;
}

function materialRole(material: THREE.Material): "screen" | "led" | "emissive" | "plain" {
  const name = material.name.toLowerCase();
  if (name.includes("screen") || name.includes("display")) return "screen";
  if (name.includes("emissive_red") || /(^|[^a-z])led/.test(name)) return "led";
  if (name.includes("emissive")) return "emissive";
  return "plain";
}

/** A kind's meshes in the kind root's frame, split by material. */
function glbParts(
  root: THREE.Object3D,
  kind: HqPropKind,
  materials: PropMaterialSet,
  uniforms: PropUniforms,
  glowCache: Map<string, THREE.Material>,
  owned: PropBatchGroup["owned"],
): Part[] {
  root.updateWorldMatrix(true, true);
  const toRoot = root.matrixWorld.clone().invert();
  const byMaterial = new Map<THREE.Material, Part>();
  const rel = new THREE.Matrix4();

  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
    rel.multiplyMatrices(toRoot, mesh.matrixWorld);
    const source = mesh.geometry;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = Array.isArray(mesh.material) && source.groups.length > 0 ? source.groups : [null];
    for (const group of groups) {
      const original = list[group?.materialIndex ?? 0] ?? list[0];
      if (!original) continue;
      const geometry = (group ? subGeometry(source, group) : source.clone()).applyMatrix4(rel);
      const role = materialRole(original);
      let material: THREE.Material = original;
      if (role === "screen") {
        material = original.name.toLowerCase().includes("exec") ? (materials.execScreen ?? materials.screen) : materials.screen;
      } else if (role === "led" || role === "emissive") {
        const blink = role === "led" && BLINKING.has(kind);
        const level = GLOW_LEVEL[kind];
        const key = `${original.uuid}:${blink ? "blink" : "steady"}:${level ?? "floor"}`;
        let glow = glowCache.get(key);
        if (!glow) {
          glow = original.clone();
          boostEmissive(glow, level);
          if (blink) patchBlink(glow, uniforms);
          glowCache.set(key, glow);
          owned.materials.push(glow);
        }
        material = glow;
      }
      const part = byMaterial.get(material) ?? { material, geometries: [] };
      part.geometries.push(geometry);
      byMaterial.set(material, part);
    }
  });
  return [...byMaterial.values()];
}

/**
 * Bloom only catches linear values above 1; make sure LEDs and lamps get there,
 * or set them to `level` exactly when the kind asks for a fixed glow.
 */
function boostEmissive(material: THREE.Material, level?: number): void {
  const m = material as THREE.MeshStandardMaterial;
  if (m.emissive && m.emissive.getHex() !== 0) {
    m.emissiveIntensity = level ?? Math.max(m.emissiveIntensity ?? 1, GLOW.emissiveFloor);
  }
  m.toneMapped = false;
}

function subGeometry(source: THREE.BufferGeometry, group: { start: number; count: number }): THREE.BufferGeometry {
  const flat = source.index ? source.toNonIndexed() : source.clone();
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(flat.attributes)) {
    const a = attr as THREE.BufferAttribute;
    const size = a.itemSize;
    const array = a.array.slice(group.start * size, (group.start + group.count) * size);
    out.setAttribute(name, new THREE.BufferAttribute(array, size, a.normalized));
  }
  flat.dispose();
  return out;
}

/** Makes a set of geometries mergeable: same attributes, same indexing. */
function harmonise(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry[] {
  for (const g of geometries) {
    if (!g.getAttribute("normal")) g.computeVertexNormals();
    g.morphAttributes = {};
  }
  const common = Object.keys(geometries[0].attributes).filter((name) =>
    geometries.every((g) => g.getAttribute(name) !== undefined),
  );
  const indexed = geometries.every((g) => g.index !== null);
  return geometries.map((g) => {
    for (const name of Object.keys(g.attributes)) if (!common.includes(name)) g.deleteAttribute(name);
    if (indexed || !g.index) return g;
    const flat = g.toNonIndexed();
    g.dispose();
    return flat;
  });
}

function mergeParts(part: Part): THREE.BufferGeometry[] {
  const ready = harmonise(part.geometries);
  const merged = ready.length === 1 ? ready[0] : mergeGeometries(ready, false);
  if (!merged) return ready; // Incompatible attribute types: draw them separately.
  if (merged !== ready[0]) for (const g of ready) g.dispose();
  return [merged];
}

/** Builds the instanced props for a layout from the GLB scene, or from stand-ins when it is null. */
export function buildPropBatches(
  props: HqProp[],
  scene: THREE.Object3D | null,
  materials: PropMaterialSet,
  uniforms: PropUniforms,
): PropBatchGroup {
  const owned: PropBatchGroup["owned"] = { geometries: [], materials: [] };
  const root = new THREE.Group();
  root.name = "hq-props";

  const byKind = new Map<HqPropKind, HqProp[]>();
  for (const prop of props) {
    const list = byKind.get(prop.kind) ?? [];
    list.push(prop);
    byKind.set(prop.kind, list);
  }

  const roots = scene ? findKindRoots(scene) : new Map<HqPropKind, THREE.Object3D>();
  const glowCache = new Map<string, THREE.Material>();
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  for (const [kind, placements] of byKind) {
    const kindRoot = roots.get(kind);
    const parts: Part[] = kindRoot
      ? glbParts(kindRoot, kind, materials, uniforms, glowCache, owned)
      : fallbackParts(kind).map(({ role, geometries }) => ({ material: materials.fallback[role], geometries }));

    for (const part of parts) {
      if (part.geometries.length === 0) continue;
      for (const geometry of mergeParts(part)) {
        geometry.computeBoundingSphere();
        owned.geometries.push(geometry);
        if (materials.screenChannels && part.material === materials.screen) {
          const channels = new Float32Array(placements.length);
          placements.forEach((p, i) => (channels[i] = p.screen ?? 0));
          geometry.setAttribute("aPanel", new THREE.InstancedBufferAttribute(channels, 1));
        }
        const mesh = new THREE.InstancedMesh(geometry, part.material, placements.length);
        mesh.name = `hq-prop-${kind}`;
        placements.forEach((p, i) => {
          position.set(p.x, 0, p.z);
          rotation.setFromAxisAngle(up, p.rotY);
          const s = p.scale ?? 1;
          scale.set(s, s, s);
          mesh.setMatrixAt(i, matrix.compose(position, rotation, scale));
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.raycast = noRaycast;
        mesh.receiveShadow = true;
        mesh.userData.hqShadowCaster = !NO_SHADOW.has(kind);
        root.add(mesh);
      }
    }
  }
  return { root, owned };
}

/** Shadow casting only on high; the depth pass for hundreds of props is not free. */
export function applyPropShadows(group: PropBatchGroup, castShadows: boolean): void {
  for (const child of group.root.children) {
    child.castShadow = castShadows && child.userData.hqShadowCaster === true;
  }
}

export function disposePropBatches(group: PropBatchGroup): void {
  for (const child of group.root.children) (child as THREE.InstancedMesh).dispose?.();
  for (const g of group.owned.geometries) g.dispose();
  for (const m of group.owned.materials) m.dispose();
}
