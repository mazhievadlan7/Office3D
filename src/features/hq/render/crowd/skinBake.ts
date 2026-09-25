import {
  AnimationMixer,
  DataTexture,
  FloatType,
  Matrix4,
  NearestFilter,
  RGBAFormat,
  type AnimationClip,
  type Bone,
  type Object3D,
  type SkinnedMesh,
} from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { HQ_CLIP_FPS } from "@/features/hq/core/config";
import { HQ_CLIP_COUNT, isLoopingClipName, resolveClipSources } from "./clipTable";

/**
 * Bakes every clip of the character into float textures so a thousand agents
 * can be animated on the GPU.
 *
 * `anim`: one row per sampled frame, three RGBA texels per bone holding the
 * bone's LOCAL transform (quaternion; position + scale.x; scale.yz), sampled
 * with an AnimationMixer on a private clone. Keeping local transforms (rather
 * than final skinning matrices) lets the palette pass crossfade two clips
 * exactly like AnimationMixer does, bone by bone down the hierarchy, so a
 * blend never shortens limbs.
 *
 * A clip with duration D and K = round(D * fps) intervals owns K + 1
 * consecutive rows, the last being the pose at D, so the shader can always
 * interpolate row r toward r + 1 without wrapping.
 *
 * `rig`: three rows of static data, four texels per bone:
 *   row 0: boneInverse * bindMatrix (columns),
 *   row 1: the fixed transform above the bone when its parent is not a
 *          skeleton bone (root-relative), identity otherwise,
 *   row 2: texel 0 = parent bone index or -1.
 */

export type HqBakedClip = {
  name: string;
  /** First row of the clip in the texture. */
  start: number;
  /** Sample intervals; the clip owns frames + 1 rows. */
  frames: number;
  duration: number;
  loop: boolean;
};

export type HqSkinBake = {
  anim: Float32Array;
  animWidth: number;
  animHeight: number;
  rig: Float32Array;
  rigWidth: number;
  boneCount: number;
  fps: number;
  clips: HqBakedClip[];
  /** The AnimationClip behind each entry of `clips`; empty for the rest-pose stand-in. */
  sources: AnimationClip[];
  /** Per HqClip code: index into `clips`. */
  codeToClip: Int8Array;
};

// Every WebGL2 implementation supports at least this texture height.
const MAX_ROWS = 4096;
export const RIG_ROWS = 3;

/** Node name of the lead's own mesh in hacker.glb (blender/hacker/lead.py). */
export const HQ_LEAD_MESH_NAME = "AM7";

/**
 * The character's skinned mesh: the body every agent wears, or with
 * `lead` the lead's own mesh ("AM7", null when the file has none). Both are
 * bound to the same skeleton and share one material.
 */
export function findSkinnedMesh(root: Object3D, lead = false): SkinnedMesh | null {
  let found: SkinnedMesh | null = null;
  root.traverse((node) => {
    if (found || !(node as SkinnedMesh).isSkinnedMesh) return;
    if ((node.name === HQ_LEAD_MESH_NAME) === lead) found = node as SkinnedMesh;
  });
  return found;
}

const cache = new WeakMap<Object3D, HqSkinBake>();

/**
 * Bakes (or returns the cached bake of) the character rooted at `root`.
 * Returns null when the file holds no skinned mesh.
 */
export function bakeCharacter(root: Object3D, animations: readonly AnimationClip[]): HqSkinBake | null {
  const cached = cache.get(root);
  if (cached) return cached;
  const mesh = findSkinnedMesh(root);
  if (!mesh) return null;

  const sources = resolveClipSources(animations.map((clip) => clip.name));
  // Only clips some code plays are baked; with no clips at all the rest pose
  // stands in as a one-interval "clip".
  const used: AnimationClip[] = [];
  const usedIndex = new Map<number, number>();
  const codeToClip = new Int8Array(HQ_CLIP_COUNT);
  for (let code = 0; code < HQ_CLIP_COUNT; code += 1) {
    const src = sources[code];
    if (src < 0) {
      codeToClip[code] = 0;
      continue;
    }
    let slot = usedIndex.get(src);
    if (slot === undefined) {
      slot = used.length;
      usedIndex.set(src, slot);
      used.push(animations[src]);
    }
    codeToClip[code] = slot;
  }

  const durations = used.length > 0 ? used.map((clip) => Math.max(clip.duration, 1 / HQ_CLIP_FPS)) : [0];
  let fps = HQ_CLIP_FPS;
  const rowsAt = (rate: number) =>
    durations.reduce((sum, d) => sum + Math.max(1, Math.round(d * rate)) + 1, 0);
  while (fps > 5 && rowsAt(fps) > MAX_ROWS) fps = Math.floor(fps * 0.75);

  const boneCount = mesh.skeleton.bones.length;
  const animHeight = rowsAt(fps);
  const animWidth = boneCount * 3;
  const anim = new Float32Array(animWidth * animHeight * 4);
  const clips: HqBakedClip[] = [];
  let row = 0;
  if (used.length === 0) {
    const frames = 1;
    sampleClip(root, null, 0, frames, fps, anim, row, boneCount);
    clips.push({ name: "Rest", start: row, frames, duration: 0, loop: true });
    row += frames + 1;
  } else {
    used.forEach((clip, i) => {
      const frames = Math.max(1, Math.round(durations[i] * fps));
      sampleClip(root, clip, durations[i], frames, fps, anim, row, boneCount);
      clips.push({ name: clip.name, start: row, frames, duration: durations[i], loop: isLoopingClipName(clip.name) });
      row += frames + 1;
    });
  }

  const rigWidth = boneCount * 4;
  const rig = bakeRig(root, boneCount, rigWidth);
  const bake: HqSkinBake = {
    anim,
    animWidth,
    animHeight,
    rig,
    rigWidth,
    boneCount,
    fps,
    clips,
    sources: used,
    codeToClip,
  };
  cache.set(root, bake);
  return bake;
}

const _rootInverse = new Matrix4();
const _m = new Matrix4();

/** A private clone at the origin, so sampling never disturbs the cached GLTF scene. */
function restClone(root: Object3D): { clone: Object3D; mesh: SkinnedMesh } | null {
  const clone = cloneSkinned(root);
  clone.position.set(0, 0, 0);
  clone.quaternion.identity();
  clone.scale.set(1, 1, 1);
  clone.updateMatrixWorld(true);
  const mesh = findSkinnedMesh(clone);
  return mesh ? { clone, mesh } : null;
}

function sampleClip(
  root: Object3D,
  clip: AnimationClip | null,
  duration: number,
  frames: number,
  fps: number,
  out: Float32Array,
  startRow: number,
  boneCount: number,
): void {
  const rest = restClone(root);
  if (!rest) return;
  const { clone, mesh } = rest;
  const bones = mesh.skeleton.bones;
  const mixer = clip ? new AnimationMixer(clone) : null;
  const action = mixer && clip ? mixer.clipAction(clip) : null;
  action?.play();
  const stride = boneCount * 12;
  for (let k = 0; k <= frames; k += 1) {
    if (mixer && action) {
      action.time = Math.min(k / fps, duration);
      mixer.update(0);
    }
    const base = (startRow + k) * stride;
    for (let b = 0; b < boneCount; b += 1) {
      const { quaternion: q, position: p, scale: s } = bones[b];
      const o = base + b * 12;
      // Keep consecutive samples in the same hemisphere so the shader can nlerp.
      const flip = k > 0 && q.x * out[o - stride] + q.y * out[o - stride + 1] + q.z * out[o - stride + 2] + q.w * out[o - stride + 3] < 0 ? -1 : 1;
      out[o] = q.x * flip;
      out[o + 1] = q.y * flip;
      out[o + 2] = q.z * flip;
      out[o + 3] = q.w * flip;
      out[o + 4] = p.x;
      out[o + 5] = p.y;
      out[o + 6] = p.z;
      out[o + 7] = s.x;
      out[o + 8] = s.y;
      out[o + 9] = s.z;
    }
  }
  if (mixer) {
    mixer.stopAllAction();
    mixer.uncacheRoot(clone);
  }
}

function bakeRig(root: Object3D, boneCount: number, width: number): Float32Array {
  const rig = new Float32Array(width * RIG_ROWS * 4);
  const rest = restClone(root);
  if (!rest) return rig;
  const { clone, mesh } = rest;
  const { bones, boneInverses } = mesh.skeleton;
  _rootInverse.copy(clone.matrixWorld).invert();
  const rowStride = width * 4;
  for (let b = 0; b < boneCount; b += 1) {
    _m.multiplyMatrices(boneInverses[b], mesh.bindMatrix);
    _m.toArray(rig, b * 16);
    const parent = bones[b].parent;
    const parentIndex = parent ? bones.indexOf(parent as Bone) : -1;
    if (parentIndex >= 0 || !parent) _m.identity();
    else _m.multiplyMatrices(_rootInverse, parent.matrixWorld);
    _m.toArray(rig, rowStride + b * 16);
    rig[rowStride * 2 + b * 16] = parentIndex;
  }
  return rig;
}

function floatTexture(data: Float32Array, width: number, height: number, name: string): DataTexture {
  const texture = new DataTexture(data, width, height, RGBAFormat, FloatType);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  texture.name = name;
  return texture;
}

/** Fresh GPU textures over the (cached) bake data. */
export function createBakeTextures(bake: HqSkinBake): { anim: DataTexture; rig: DataTexture } {
  return {
    anim: floatTexture(bake.anim, bake.animWidth, bake.animHeight, "hq-crowd-anim"),
    rig: floatTexture(bake.rig, bake.rigWidth, RIG_ROWS, "hq-crowd-rig"),
  };
}

/**
 * Float texture row for clip `code` at `seconds`: integer part is the row,
 * fraction is the blend toward the next row. Loops wrap, one-shots clamp.
 */
export function bakeRow(bake: HqSkinBake, code: number, seconds: number): number {
  const clip = bake.clips[bake.codeToClip[code < HQ_CLIP_COUNT ? code : 0]];
  let f = Number.isFinite(seconds) ? seconds * bake.fps : 0;
  if (clip.loop) {
    f -= Math.floor(f / clip.frames) * clip.frames;
    // Float rounding can land exactly on `frames`; row start+frames+1 does not exist.
    if (f >= clip.frames) f = 0;
  } else {
    f = f < 0 ? 0 : f > clip.frames - 0.001 ? clip.frames - 0.001 : f;
  }
  return clip.start + f;
}
