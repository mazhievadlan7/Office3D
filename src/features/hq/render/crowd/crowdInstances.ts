import {
  BufferGeometry,
  CapsuleGeometry,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  MeshStandardMaterial,
  SphereGeometry,
  type BufferAttribute,
  type DataTexture,
  type Material,
  type WebGLRenderer,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { HQ_THEME } from "@/features/hq/core/config";
import type { HqAgentFrame } from "@/features/hq/core/types";
import { HQ_LEAD_SCALE } from "./clipTable";
import { createCrowdMaterial, type HqCrowdUniforms } from "./crowdMaterials";
import { HqPalettePass } from "./crowdPalette";
import { bakeRow, createBakeTextures, type HqSkinBake } from "./skinBake";

/**
 * Tier 1: every agent that is on screen and not drawn by a hero rig, in one
 * instanced draw. The instance matrix comes from x, y, z and facing; the two
 * baked-animation rows and the crossfade weight go to the palette pass
 * (crowdPalette.ts), which the vertex shader reads by gl_InstanceID. Buffers
 * grow in powers of two and only the used range is uploaded each frame.
 */

function nextSize(n: number): number {
  return Math.max(64, 1 << Math.ceil(Math.log2(Math.max(n, 1))));
}

/** Writes a Y-rotation + uniform scale + translation matrix (column-major). */
function writeMatrix(m: Float32Array, o: number, x: number, y: number, z: number, facing: number, sx: number, sy: number): void {
  const c = Math.cos(facing);
  const s = Math.sin(facing);
  m[o] = c * sx;
  m[o + 1] = 0;
  m[o + 2] = -s * sx;
  m[o + 3] = 0;
  m[o + 4] = 0;
  m[o + 5] = sy;
  m[o + 6] = 0;
  m[o + 7] = 0;
  m[o + 8] = s * sx;
  m[o + 9] = 0;
  m[o + 10] = c * sx;
  m[o + 11] = 0;
  m[o + 12] = x;
  m[o + 13] = y;
  m[o + 14] = z;
  m[o + 15] = 1;
}

function uploadRange(attribute: BufferAttribute, count: number): void {
  attribute.clearUpdateRanges();
  if (count > 0) {
    attribute.addUpdateRange(0, count * attribute.itemSize);
    attribute.needsUpdate = true;
  }
}

export class HqSkinnedCrowd {
  mesh: InstancedMesh;
  private readonly geometry: BufferGeometry;
  private readonly material: Material;
  private readonly uniforms: HqCrowdUniforms = { hqPalette: { value: null } };
  private readonly anim: DataTexture;
  private readonly rig: DataTexture;
  private pass: HqPalettePass;
  private capacity: number;
  private count = 0;

  constructor(
    source: BufferGeometry,
    baseMaterial: Material | Material[],
    private readonly bake: HqSkinBake,
    agents: number,
    private readonly floatTargets: boolean,
  ) {
    // A private copy of the body so nothing here touches the cached GLTF
    // geometry that the hero rigs share.
    this.geometry = new BufferGeometry();
    this.geometry.setIndex(source.index ? source.index.clone() : null);
    for (const name of ["position", "normal", "uv", "skinIndex", "skinWeight"]) {
      const attribute = source.getAttribute(name);
      if (attribute) this.geometry.setAttribute(name, attribute.clone());
    }
    const textures = createBakeTextures(bake);
    this.anim = textures.anim;
    this.rig = textures.rig;
    this.material = createCrowdMaterial(baseMaterial, this.uniforms);
    this.capacity = nextSize(agents);
    this.pass = this.buildPass();
    this.mesh = this.build();
  }

  private buildPass(): HqPalettePass {
    const pass = new HqPalettePass(this.anim, this.rig, this.bake.boneCount, this.capacity, this.floatTargets);
    this.uniforms.hqPalette.value = pass.palette;
    return pass;
  }

  private build(): InstancedMesh {
    const mesh = new InstancedMesh(this.geometry, this.material, this.capacity);
    mesh.name = "hq-crowd-instanced";
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.raycast = () => {};
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  /** Returns the replaced mesh when the buffers had to grow (caller swaps it in the scene). */
  ensure(agents: number): InstancedMesh | null {
    if (agents <= this.capacity) return null;
    const old = this.mesh;
    this.capacity = nextSize(agents);
    this.pass.dispose();
    this.pass = this.buildPass();
    this.mesh = this.build();
    this.mesh.receiveShadow = old.receiveShadow;
    old.dispose();
    return old;
  }

  begin(): void {
    this.count = 0;
  }

  push(frame: HqAgentFrame, i: number): void {
    if (this.count >= this.capacity) return;
    const k = this.count++;
    const lead = frame.lead[i] === 1;
    const scale = lead ? HQ_LEAD_SCALE : 1;
    writeMatrix(this.mesh.instanceMatrix.array as Float32Array, k * 16, frame.x[i], frame.y[i], frame.z[i], frame.facing[i], scale, scale);
    const blend = frame.blend[i];
    const w = blend > 1 ? 1 : blend < 0 ? 0 : blend;
    const rowA = bakeRow(this.bake, frame.clip[i], frame.clipTime[i]);
    const rowB = w >= 0.999 ? rowA : bakeRow(this.bake, frame.prevClip[i], frame.prevClipTime[i]);
    this.pass.setInstance(k, rowA, rowB, w, lead ? 1 : 0);
  }

  /** Uploads the instances and renders their bone palette (before the scene draws). */
  end(renderer: WebGLRenderer): void {
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
    uploadRange(this.mesh.instanceMatrix, this.count);
    this.pass.render(renderer, this.count);
  }

  dispose(): void {
    this.mesh.dispose();
    this.pass.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.anim.dispose();
    this.rig.dispose();
  }
}

/**
 * Stand-in while the character GLB loads or when it is missing: dark capsule
 * figures with a faint red glow, same transforms, shorter when seated.
 */
export class HqCapsuleCrowd {
  mesh: InstancedMesh;
  private readonly geometry: BufferGeometry;
  private readonly material: MeshStandardMaterial;
  private capacity: number;
  private count = 0;

  constructor(agents: number) {
    const body = new CapsuleGeometry(0.21, 0.92, 4, 12);
    body.translate(0, 0.21 + 0.46 + 0.02, 0);
    const head = new SphereGeometry(0.13, 16, 10);
    head.translate(0, 1.58, 0);
    const merged = mergeGeometries([body, head], false);
    body.dispose();
    head.dispose();
    this.geometry = merged ?? new CapsuleGeometry(0.22, 1.2, 4, 12).translate(0, 0.82, 0);
    this.material = new MeshStandardMaterial({
      color: HQ_THEME.metal,
      roughness: 0.55,
      metalness: 0.25,
      emissive: new Color(HQ_THEME.accentDeep),
      emissiveIntensity: 0.35,
    });
    this.material.name = "hq-crowd-capsule";
    this.capacity = nextSize(agents);
    this.mesh = this.build();
  }

  private build(): InstancedMesh {
    const mesh = new InstancedMesh(this.geometry, this.material, this.capacity);
    mesh.name = "hq-crowd-capsules";
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  ensure(agents: number): InstancedMesh | null {
    if (agents <= this.capacity) return null;
    const old = this.mesh;
    this.capacity = nextSize(agents);
    this.mesh = this.build();
    this.mesh.visible = old.visible;
    old.dispose();
    return old;
  }

  begin(): void {
    this.count = 0;
  }

  push(frame: HqAgentFrame, i: number, seated: boolean): void {
    if (this.count >= this.capacity) return;
    const k = this.count++;
    const scale = frame.lead[i] === 1 ? HQ_LEAD_SCALE : 1;
    writeMatrix(
      this.mesh.instanceMatrix.array as Float32Array,
      k * 16,
      frame.x[i],
      frame.y[i],
      frame.z[i],
      frame.facing[i],
      scale,
      seated ? scale * 0.74 : scale,
    );
  }

  end(): void {
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
    uploadRange(this.mesh.instanceMatrix, this.count);
  }

  hide(): void {
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
