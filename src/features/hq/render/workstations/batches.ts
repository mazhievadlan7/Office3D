import * as THREE from "three";
import type { HqDesk } from "@/features/hq/core/types";
import type { HqQuality } from "@/features/hq/render/scene/quality";
import { packDeskState } from "@/features/hq/render/screens/screenApps";
import { WS_GROUPS, type WorkstationSource, type WsGroup } from "./geometry";
import { WS_TIME_WRAP, type WorkstationMaterials } from "./materials";

/** Desks per culling chunk: small enough to cull, large enough to keep draw calls low. */
export const WS_CHUNK_SIZE = 64;

/**
 * Splits desks into spatially compact chunks of at most `maxPerChunk` by
 * recursive median cuts along the longer side. Deterministic for a layout.
 */
export function chunkDesks(
  desks: readonly { x: number; z: number }[],
  maxPerChunk: number = WS_CHUNK_SIZE,
): number[][] {
  const out: number[][] = [];
  const split = (list: number[]) => {
    if (list.length === 0) return;
    if (list.length <= maxPerChunk) {
      out.push(list);
      return;
    }
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const i of list) {
      const d = desks[i];
      if (d.x < x0) x0 = d.x;
      if (d.x > x1) x1 = d.x;
      if (d.z < z0) z0 = d.z;
      if (d.z > z1) z1 = d.z;
    }
    const byX = x1 - x0 >= z1 - z0;
    const sorted = list.slice().sort((a, b) => {
      const delta = byX ? desks[a].x - desks[b].x : desks[a].z - desks[b].z;
      return delta !== 0 ? delta : a - b;
    });
    // Cut so both halves hold a whole number of near-full chunks.
    const parts = Math.ceil(sorted.length / maxPerChunk);
    const cut = Math.round((sorted.length * Math.floor(parts / 2)) / parts);
    split(sorted.slice(0, cut));
    split(sorted.slice(cut));
  };
  split(desks.map((_, i) => i));
  return out;
}

/** Stable 0..1 per desk index (varies screen content between neighbours). */
export function deskSeed(index: number): number {
  let h = Math.imul(index + 1, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca77);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

const UNSEEN = -2;

/**
 * Last status seen per desk and when it changed. Owned above the batches so a
 * rebuilt batch set (the GLB replacing the procedural desks) keeps the screens
 * as they were instead of booting them again.
 */
export class DeskStatusCache {
  /** packDeskState of each desk (status and role family). */
  readonly status: Int16Array;
  readonly changedAt: Float32Array;

  constructor(count: number) {
    this.status = new Int16Array(count).fill(UNSEEN);
    this.changedAt = new Float32Array(count);
  }
}

// LOD0 detail (keyboard keys, chair casters) stops reading below this many
// pixels per metre; a 1.6 m desk is then about 30 px wide.
const LOD0_MIN_PX_PER_METRE: Record<HqQuality, number> = { high: 20, medium: 26, low: 34 };
// Desks drawn (and shadowed) at LOD0 at most, nearest chunks first.
const LOD0_DESK_BUDGET: Record<HqQuality, number> = { high: 320, medium: 192, low: 96 };
const LOD_HYSTERESIS = 1.3;
// Stagger of the first power-on so the floor boots in a ripple, not a blink.
const BOOT_STAGGER = 1.4;

type Chunk = {
  count: number;
  sphere: THREE.Sphere;
  lod0: THREE.Group;
  lod1: THREE.Group;
  level: 0 | 1;
  state: Float32Array;
  stateAttribute: THREE.InstancedBufferAttribute;
  dirty: boolean;
};

const noRaycast = () => {};

/**
 * The workstation GLB ships a glossy black desk (roughness 0.16) and polished
 * metal. Under the high key light those mirrored a white hotspot that the bloom
 * spread over the desk, and since the near desks switch to the full-detail LOD
 * it followed the camera around the hall. Force a matte, non-reflective finish
 * on the model's own materials (in place, so it is idempotent across remounts).
 */
function matte(
  material: THREE.Material | undefined,
  roughness: number,
  metalness: number,
): THREE.Material | undefined {
  const std = material as THREE.MeshStandardMaterial | undefined;
  if (!std || !std.isMeshStandardMaterial) return material;
  std.roughness = Math.max(std.roughness, roughness);
  std.roughnessMap = null;
  std.metalness = Math.min(std.metalness, metalness);
  std.envMapIntensity = Math.min(std.envMapIntensity, 0.2);
  const physical = std as THREE.MeshPhysicalMaterial;
  if (physical.isMeshPhysicalMaterial) {
    physical.clearcoat = 0;
    physical.sheen = 0;
  }
  std.needsUpdate = true;
  return std;
}
const cameraPosition = new THREE.Vector3();
const viewProjection = new THREE.Matrix4();
const frustum = new THREE.Frustum();

/**
 * All workstations as instanced batches: per chunk and LOD, one InstancedMesh
 * per material group. Screens and LEDs read desk status from a per-instance
 * attribute that is re-uploaded only for chunks where a status changed.
 */
export class WorkstationBatchSet {
  readonly root = new THREE.Group();
  private readonly chunks: Chunk[] = [];
  private readonly deskChunk: Int32Array;
  private readonly deskSlot: Int32Array;
  private readonly seeds: Float32Array;
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private order: Int32Array = new Int32Array(0);
  private scores: Float32Array = new Float32Array(0);
  private lod0MinPixels = LOD0_MIN_PX_PER_METRE.high;
  private lod0Budget = LOD0_DESK_BUDGET.high;

  constructor(
    desks: readonly HqDesk[],
    source: WorkstationSource,
    materials: WorkstationMaterials,
    private readonly cache: DeskStatusCache,
  ) {
    this.root.name = "hq-workstations";
    this.deskChunk = new Int32Array(desks.length);
    this.deskSlot = new Int32Array(desks.length);
    this.seeds = new Float32Array(desks.length);
    for (let i = 0; i < desks.length; i += 1) this.seeds[i] = deskSeed(i);

    const lit: Record<WsGroup, THREE.Material> = {
      desk: matte(source.materials.desk, 0.95, 0.05) ?? materials.desk,
      metal: matte(source.materials.metal, 0.7, 0.35) ?? materials.metal,
      chair: matte(source.materials.chair, 0.85, 0.05) ?? materials.chair,
      screen: materials.screen,
      led: materials.led,
      glass: materials.glass,
    };
    const matrix = new THREE.Matrix4();
    const local = source.bounds.center;

    chunkDesks(desks).forEach((list, chunkIndex) => {
      const count = list.length;
      const matrices = new THREE.InstancedBufferAttribute(new Float32Array(count * 16), 16);
      const seeds = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
      const state = new Float32Array(count * 2);
      const stateAttribute = new THREE.InstancedBufferAttribute(state, 2);
      stateAttribute.setUsage(THREE.DynamicDrawUsage);

      // Bounding sphere around every desk's bounds, in world space.
      const centre = new THREE.Vector3();
      const deskCentres: THREE.Vector3[] = [];
      list.forEach((deskIndex, slot) => {
        const desk = desks[deskIndex];
        this.deskChunk[deskIndex] = chunkIndex;
        this.deskSlot[deskIndex] = slot;
        matrix.makeRotationY(desk.rotY).setPosition(desk.x, 0, desk.z);
        matrix.toArray(matrices.array, slot * 16);
        seeds.setX(slot, this.seeds[deskIndex]);
        const cached = cache.status[deskIndex];
        state[slot * 2] = cached === UNSEEN ? -1 : cached;
        state[slot * 2 + 1] = cache.changedAt[deskIndex];
        const c = new THREE.Vector3(local.x, local.y, local.z).applyMatrix4(matrix);
        deskCentres.push(c);
        centre.add(c);
      });
      centre.divideScalar(count);
      let radius = 0;
      for (const c of deskCentres) radius = Math.max(radius, c.distanceTo(centre));
      const sphere = new THREE.Sphere(centre, radius + source.bounds.radius);

      const buildLevel = (level: 0 | 1) => {
        const group = new THREE.Group();
        group.name = `hq-ws-chunk${chunkIndex}-lod${level}`;
        for (const name of WS_GROUPS) {
          const base = (level === 1 ? source.lod1[name] : undefined) ?? source.lod0[name];
          if (!base) continue;
          let geometry = base;
          if (name === "screen" || name === "led") {
            // Own copy per chunk so the instanced status data rides along.
            geometry = base.clone();
            geometry.setAttribute("aState", stateAttribute);
            if (name === "screen") geometry.setAttribute("aSeed", seeds);
            this.geometries.push(geometry);
          }
          const mesh = new THREE.InstancedMesh(geometry, lit[name], count);
          mesh.name = `hq-ws-${name}`;
          mesh.instanceMatrix = matrices;
          mesh.boundingSphere = sphere;
          mesh.castShadow = level === 0 && (name === "desk" || name === "chair");
          mesh.receiveShadow = true;
          mesh.matrixAutoUpdate = false;
          mesh.raycast = noRaycast;
          // Glass draws after the opaque batches around it.
          if (name === "glass") mesh.renderOrder = 1;
          group.add(mesh);
          this.meshes.push(mesh);
        }
        return group;
      };
      const lod0 = buildLevel(0);
      const lod1 = buildLevel(1);
      lod1.visible = false;
      this.root.add(lod0, lod1);
      this.chunks.push({ count, sphere, lod0, lod1, level: 0, state, stateAttribute, dirty: false });
    });
    this.order = new Int32Array(this.chunks.length);
    this.scores = new Float32Array(this.chunks.length);
  }

  setQuality(quality: HqQuality) {
    this.lod0MinPixels = LOD0_MIN_PX_PER_METRE[quality];
    this.lod0Budget = LOD0_DESK_BUDGET[quality];
  }

  /** Per frame: sync desk status (and role) into the instance data and pick each chunk's LOD. */
  update(
    camera: THREE.Camera,
    viewportHeight: number,
    seconds: number,
    deskStatus: Int8Array | null,
    deskRole: Uint8Array | null = null,
  ) {
    const now = seconds % WS_TIME_WRAP;
    const { status, changedAt } = this.cache;
    const count = Math.min(this.deskChunk.length, status.length);
    for (let i = 0; i < count; i += 1) {
      const next = packDeskState(
        deskStatus && i < deskStatus.length ? deskStatus[i] : -1,
        deskRole && i < deskRole.length ? deskRole[i] : 0,
      );
      const previous = status[i];
      if (next === previous) continue;
      status[i] = next;
      changedAt[i] = previous === UNSEEN ? (now + this.seeds[i] * BOOT_STAGGER) % WS_TIME_WRAP : now;
      const chunk = this.chunks[this.deskChunk[i]];
      const slot = this.deskSlot[i] * 2;
      chunk.state[slot] = next;
      chunk.state[slot + 1] = changedAt[i];
      chunk.dirty = true;
    }

    for (const chunk of this.chunks) {
      if (!chunk.dirty) continue;
      chunk.stateAttribute.needsUpdate = true;
      chunk.dirty = false;
    }
    this.pickLevels(camera, viewportHeight);
  }

  /**
   * LOD0 goes to the chunks that look biggest on screen, while they are big
   * enough for the detail to show and the desk budget lasts; the rest draw
   * LOD1. Chunks already at LOD0 get a bonus in both tests so a chunk near a
   * boundary does not flicker while the camera moves.
   */
  private pickLevels(camera: THREE.Camera, viewportHeight: number) {
    cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProjection);
    const perspective = (camera as THREE.PerspectiveCamera).isPerspectiveCamera
      ? (camera as THREE.PerspectiveCamera)
      : null;
    const orthographic = (camera as THREE.OrthographicCamera).isOrthographicCamera
      ? (camera as THREE.OrthographicCamera)
      : null;
    const pixelsAtOneMetre = perspective
      ? (viewportHeight * perspective.zoom) / (2 * Math.tan(THREE.MathUtils.degToRad(perspective.fov) / 2))
      : 0;
    const orthoPixels = orthographic
      ? (viewportHeight * orthographic.zoom) / Math.max(orthographic.top - orthographic.bottom, 1e-6)
      : 0;

    const { chunks, order, scores } = this;
    for (let c = 0; c < chunks.length; c += 1) {
      const chunk = chunks[c];
      let pixelsPerMetre = 0;
      if (frustum.intersectsSphere(chunk.sphere)) {
        if (perspective) {
          const distance = Math.max(0.5, cameraPosition.distanceTo(chunk.sphere.center) - chunk.sphere.radius);
          pixelsPerMetre = pixelsAtOneMetre / distance;
        } else if (orthographic) {
          pixelsPerMetre = orthoPixels;
        }
      }
      scores[c] = chunk.level === 0 ? pixelsPerMetre * LOD_HYSTERESIS : pixelsPerMetre;
      // Insertion sort by score, highest first (16 chunks at most; no allocation).
      let k = c;
      while (k > 0 && scores[order[k - 1]] < scores[c]) {
        order[k] = order[k - 1];
        k -= 1;
      }
      order[k] = c;
    }

    let budget = this.lod0Budget;
    for (let k = 0; k < chunks.length; k += 1) {
      const chunk = chunks[order[k]];
      const wantsDetail = scores[order[k]] >= this.lod0MinPixels * LOD_HYSTERESIS;
      const level = wantsDetail && chunk.count <= budget ? 0 : 1;
      if (level === 0) budget -= chunk.count;
      if (level !== chunk.level) {
        chunk.level = level;
        chunk.lod0.visible = level === 0;
        chunk.lod1.visible = level === 1;
      }
    }
  }

  /** Frees GPU memory; three re-uploads if the set is shown again (React dev remounts). */
  dispose() {
    for (const mesh of this.meshes) mesh.dispose();
    for (const geometry of this.geometries) geometry.dispose();
  }
}
