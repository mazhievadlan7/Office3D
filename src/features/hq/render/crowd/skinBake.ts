import {
  AnimationMixer,
  DataTexture,
  type AnimationAction,
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

export function findSkinnedMesh(root: Object3D): SkinnedMesh | null {
  let found: SkinnedMesh | null = null;
  root.traverse((node) => {
    if (!found && (node as SkinnedMesh).isSkinnedMesh) found = node as SkinnedMesh;
  });
  return found;
}

const cache = new WeakMap<Object3D, HqSkinBake>();

/**
 * Bakes (or returns the cached bake of) the character rooted at `root`, all
 * at once. Returns null when the file holds no skinned mesh. The scene bakes
 * over several frames instead (startBake + HqSkinBaker.step), so loading the
 * character never stalls a frame.
 */
export function bakeCharacter(root: Object3D, animations: readonly AnimationClip[]): HqSkinBake | null {
  const baker = startBake(root, animations);
  return baker ? baker.step(Infinity) : null;
}

/** An incremental bake of `root` (already done when it is cached), or null without a skinned mesh. */
export function startBake(root: Object3D, animations: readonly AnimationClip[]): HqSkinBaker | null {
  const mesh = findSkinnedMesh(root);
  if (!mesh) return null;
  return new HqSkinBaker(root, mesh, animations);
}

/**
 * Samples the clips a few frames at a time: step(budgetMs) works until the
 * budget is spent and returns the finished bake once every row is written
 * (null until then). One private clone of the character is posed by one
 * mixer, clip after clip; a clip's action is dropped when it is done, which
 * puts the bones back in their rest pose before the next one.
 */
export class HqSkinBaker {
  private readonly root: Object3D;
  private readonly used: AnimationClip[] = [];
  private readonly durations: number[];
  private readonly frames: number[];
  private readonly fps: number;
  private readonly boneCount: number;
  private readonly anim: Float32Array;
  private readonly animHeight: number;
  private readonly codeToClip: Int8Array;
  private readonly clips: HqBakedClip[] = [];
  private rig: Float32Array | null = null;
  private clone: Object3D | null = null;
  private bones: Bone[] = [];
  private mixer: AnimationMixer | null = null;
  private action: AnimationAction | null = null;
  private clipIndex = 0;
  private frame = 0;
  private row = 0;
  private result: HqSkinBake | null;

  constructor(root: Object3D, mesh: SkinnedMesh, animations: readonly AnimationClip[]) {
    this.root = root;
    this.result = cache.get(root) ?? null;
    const sources = resolveClipSources(animations.map((clip) => clip.name));
    // Only clips some code plays are baked; with no clips at all the rest pose
    // stands in as a one-interval "clip".
    const usedIndex = new Map<number, number>();
    this.codeToClip = new Int8Array(HQ_CLIP_COUNT);
    for (let code = 0; code < HQ_CLIP_COUNT; code += 1) {
      const src = sources[code];
      if (src < 0) {
        this.codeToClip[code] = 0;
        continue;
      }
      let slot = usedIndex.get(src);
      if (slot === undefined) {
        slot = this.used.length;
        usedIndex.set(src, slot);
        this.used.push(animations[src]);
      }
      this.codeToClip[code] = slot;
    }
    this.durations = this.used.length > 0 ? this.used.map((clip) => Math.max(clip.duration, 1 / HQ_CLIP_FPS)) : [0];
    let fps = HQ_CLIP_FPS;
    const rowsAt = (rate: number) =>
      this.durations.reduce((sum, d) => sum + Math.max(1, Math.round(d * rate)) + 1, 0);
    while (fps > 5 && rowsAt(fps) > MAX_ROWS) fps = Math.floor(fps * 0.75);
    this.fps = fps;
    this.frames = this.durations.map((d) => Math.max(1, Math.round(d * fps)));
    this.boneCount = mesh.skeleton.bones.length;
    this.animHeight = rowsAt(fps);
    this.anim = this.result ? this.result.anim : new Float32Array(this.boneCount * 3 * this.animHeight * 4);
  }

  /** Share of the rows written, 0..1. */
  get progress(): number {
    return this.result ? 1 : this.row / this.animHeight;
  }

  /** Bakes for about `budgetMs`; the finished bake once done, else null. */
  step(budgetMs: number): HqSkinBake | null {
    if (this.result) return this.result;
    const t0 = performance.now();
    if (!this.rig) {
      this.rig = bakeRig(this.root, this.boneCount, this.boneCount * 4);
      const rest = restClone(this.root);
      if (!rest) return this.finish();
      this.clone = rest.clone;
      this.bones = rest.mesh.skeleton.bones;
      this.mixer = new AnimationMixer(rest.clone);
    }
    const count = this.durations.length;
    while (this.clipIndex < count) {
      const clip = this.used.length > 0 ? this.used[this.clipIndex] : null;
      const frames = this.frames[this.clipIndex];
      if (clip && this.mixer && !this.action) {
        this.action = this.mixer.clipAction(clip);
        this.action.play();
      }
      if (this.action && this.mixer) {
        this.action.time = Math.min(this.frame / this.fps, this.durations[this.clipIndex]);
        this.mixer.update(0);
      }
      this.sample(this.row + this.frame, this.frame > 0);
      this.frame += 1;
      if (this.frame > frames) {
        this.clips.push({
          name: clip ? clip.name : "Rest",
          start: this.row,
          frames,
          duration: clip ? this.durations[this.clipIndex] : 0,
          loop: clip ? isLoopingClipName(clip.name) : true,
        });
        if (this.action && this.mixer && clip) {
          // Dropping the action restores the bones it drove to their rest pose.
          this.action.stop();
          this.mixer.uncacheAction(clip);
          this.mixer.uncacheClip(clip);
        }
        this.action = null;
        this.row += frames + 1;
        this.frame = 0;
        this.clipIndex += 1;
      }
      if (performance.now() - t0 >= budgetMs) return null;
    }
    return this.finish();
  }

  private sample(row: number, continuing: boolean): void {
    const out = this.anim;
    const stride = this.boneCount * 12;
    const base = row * stride;
    const bones = this.bones;
    for (let b = 0; b < this.boneCount && b < bones.length; b += 1) {
      const { quaternion: q, position: p, scale: s } = bones[b];
      const o = base + b * 12;
      // Keep consecutive samples in the same hemisphere so the shader can nlerp.
      const flip =
        continuing &&
        q.x * out[o - stride] + q.y * out[o - stride + 1] + q.z * out[o - stride + 2] + q.w * out[o - stride + 3] < 0
          ? -1
          : 1;
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

  private finish(): HqSkinBake {
    if (this.mixer && this.clone) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.clone);
    }
    this.mixer = null;
    this.clone = null;
    this.bones = [];
    const rigWidth = this.boneCount * 4;
    const bake: HqSkinBake = {
      anim: this.anim,
      animWidth: this.boneCount * 3,
      animHeight: this.animHeight,
      rig: this.rig ?? new Float32Array(rigWidth * RIG_ROWS * 4),
      rigWidth,
      boneCount: this.boneCount,
      fps: this.fps,
      clips: this.clips,
      sources: this.used,
      codeToClip: this.codeToClip,
    };
    this.result = bake;
    cache.set(this.root, bake);
    return bake;
  }
}

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

const _rootInverse = new Matrix4();
const _m = new Matrix4();

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
