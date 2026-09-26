import {
  AnimationMixer,
  BufferGeometry,
  DataTexture,
  LinearFilter,
  RGBAFormat,
  type AnimationAction,
  type AnimationClip,
  type Material,
  type MeshStandardMaterial,
  type Object3D,
  type SkinnedMesh,
  type Texture,
} from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { HQ_CLIPS, type HqClipName } from "@/features/hq/core/config";
import { resolveClipSources } from "@/features/hq/render/crowd/clipTable";
import { cloneCharacterMaterial } from "@/features/hq/render/crowd/crowdMaterials";
import { findSkinnedMesh } from "@/features/hq/render/crowd/skinBake";

/**
 * The HQ character on its own, for the avatar preview.
 *
 * Same GLB, same material and the same clips the HQ plays: the crowd's hero
 * rigs are built exactly like this (a SkeletonUtils clone wearing a copy of
 * the GLB material). The HQ gives every agent that one look, so nothing here
 * reads the avatar profile.
 *
 * The preview has its own WebGL context, and a renderer subscribes to
 * `dispose` on every geometry, material and texture it uploads. Drawing the
 * cached GLTF objects the HQ shares would leave one such subscription per
 * closed preview, each pinning a dead renderer in memory. So the rig draws a
 * geometry wrapper over the cached attributes (no vertex data copied) and a
 * material whose textures are clones sharing the decoded images, and disposes
 * exactly those when it closes.
 */

/** The parts of a loaded GLTF the preview uses. */
export type PreviewCharacterSource = { scene: Object3D; animations: AnimationClip[] };

/** Clips the preview offers: the standing ones (sitting needs a chair). */
export const PREVIEW_CLIPS = ["Idle", "Talk", "Walk"] as const satisfies readonly HqClipName[];
export type PreviewClip = (typeof PREVIEW_CLIPS)[number];

// Crossfade between preview clips, seconds; a touch slower than the HQ's so
// the change reads as deliberate.
const PREVIEW_FADE = 0.4;

// What the camera must fit, in metres: the standing figure (1.84 m tall, the
// hood a little above) with room for the floor ring, and swinging arms.
export const PREVIEW_FRAME = { centerY: 0.94, halfHeight: 1.04, halfWidth: 0.62 } as const;

/**
 * Camera distance at which a standing agent fits a viewport of this aspect
 * (width / height) with a vertical field of view of `fovDeg`.
 */
export function previewCameraDistance(aspect: number, fovDeg: number): number {
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  return Math.max(PREVIEW_FRAME.halfHeight / tanV, PREVIEW_FRAME.halfWidth / (tanV * safeAspect));
}

/** A stable phase in [0, 1) per seed, so previews side by side do not breathe in lockstep. */
export function previewPhase(seed: string): number {
  // FNV-1a.
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x100000000;
}

/** A geometry that draws the same attributes as `source` without copying them. */
function shareGeometry(source: BufferGeometry): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.name = `${source.name || "hq-character"}-preview`;
  geometry.setIndex(source.index);
  for (const name of Object.keys(source.attributes)) geometry.setAttribute(name, source.attributes[name]);
  geometry.morphAttributes = source.morphAttributes;
  geometry.morphTargetsRelative = source.morphTargetsRelative;
  for (const group of source.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
  if (source.boundingBox) geometry.boundingBox = source.boundingBox.clone();
  if (source.boundingSphere) geometry.boundingSphere = source.boundingSphere.clone();
  return geometry;
}

/** A copy of the GLB material whose texture slots hold private clones (images shared). */
function privateMaterial(base: Material | Material[]): { material: MeshStandardMaterial; textures: Texture[] } {
  const material = cloneCharacterMaterial(base);
  material.name = "hq-avatar-preview";
  // One clone per original: the ORM map fills both roughness and metalness.
  const copies = new Map<Texture, Texture>();
  const slots = material as unknown as Record<string, unknown>;
  for (const key of Object.keys(slots)) {
    const value = slots[key] as Texture | null | undefined;
    if (!value || !value.isTexture) continue;
    let copy = copies.get(value);
    if (!copy) {
      copy = value.clone();
      copies.set(value, copy);
    }
    slots[key] = copy;
  }
  return { material, textures: [...copies.values()] };
}

export class HqPreviewRig {
  readonly root: Object3D;
  readonly mesh: SkinnedMesh;
  private readonly geometry: BufferGeometry;
  private readonly material: MeshStandardMaterial;
  private readonly textures: Texture[];
  private readonly mixer: AnimationMixer;
  private readonly actions = new Map<PreviewClip, AnimationAction>();
  private current: AnimationAction | null = null;
  private readonly phase: number;

  private constructor(root: Object3D, mesh: SkinnedMesh, animations: readonly AnimationClip[], phase: number) {
    this.root = root;
    this.mesh = mesh;
    this.phase = phase;
    this.geometry = shareGeometry(mesh.geometry);
    const { material, textures } = privateMaterial(mesh.material);
    this.material = material;
    this.textures = textures;
    mesh.geometry = this.geometry;
    mesh.material = material;
    // Bounds of a skinned mesh follow the bind pose, not the clip.
    mesh.frustumCulled = false;
    root.traverse((node) => {
      node.raycast = () => {};
      // Only the skinned body draws; helper meshes in the file stay hidden
      // (and so never reach the renderer), as on the hero rigs.
      if ((node as SkinnedMesh).isMesh && node !== mesh) node.visible = false;
    });

    this.mixer = new AnimationMixer(root);
    const sources = resolveClipSources(animations.map((clip) => clip.name));
    for (const name of PREVIEW_CLIPS) {
      const index = sources[HQ_CLIPS.indexOf(name)];
      // A missing clip falls back like in the HQ; one clip, one action.
      if (index >= 0 && animations[index]) this.actions.set(name, this.mixer.clipAction(animations[index]));
    }
  }

  /** Builds the rig, or returns null when the file holds no skinned mesh. */
  static create(source: PreviewCharacterSource, seed: string): HqPreviewRig | null {
    if (!findSkinnedMesh(source.scene)) return null;
    const root = cloneSkinned(source.scene);
    const mesh = findSkinnedMesh(root);
    if (!mesh) return null;
    root.position.set(0, 0, 0);
    root.rotation.set(0, 0, 0);
    root.scale.setScalar(1);
    return new HqPreviewRig(root, mesh, source.animations, previewPhase(seed));
  }

  /** Plays `clip`, crossfading from the current one; the first clip starts at the seed's phase. */
  play(clip: PreviewClip): void {
    const next = this.actions.get(clip) ?? this.actions.get("Idle") ?? null;
    if (!next || next === this.current) return;
    next.reset();
    next.setEffectiveTimeScale(1);
    next.setEffectiveWeight(1);
    if (this.current) {
      next.play();
      this.current.crossFadeTo(next, PREVIEW_FADE, false);
    } else {
      next.time = this.phase * next.getClip().duration;
      next.play();
    }
    this.current = next;
  }

  update(dt: number): void {
    this.mixer.update(dt);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.root.removeFromParent();
    this.mesh.skeleton.dispose();
    this.geometry.dispose();
    this.material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.current = null;
  }
}

/**
 * A soft radial falloff (white centre to black edge, opaque) for the stage:
 * used as an alpha map, so the floor fades into the background and the blob
 * shadow has no edge. Alpha maps read the green channel.
 */
export function createRadialTexture(size = 64): DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = ((x + 0.5) / size) * 2 - 1;
      const dy = ((y + 0.5) / size) * 2 - 1;
      const f = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy));
      const v = Math.round(255 * f * f * (3 - 2 * f));
      const o = (y * size + x) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.name = "hq-avatar-preview-radial";
  texture.needsUpdate = true;
  return texture;
}
