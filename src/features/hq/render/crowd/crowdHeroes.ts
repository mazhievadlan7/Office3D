import {
  AnimationClip,
  AnimationMixer,
  Euler,
  Group,
  Quaternion,
  Vector3,
  type AnimationAction,
  type Bone,
  type Material,
  type Object3D,
  type SkinnedMesh,
} from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { HqAgentFrame } from "@/features/hq/core/types";
import { HQ_CLIP_COUNT, HQ_LEAD_SCALE } from "./clipTable";
import { findSkinnedMesh, type HqSkinBake } from "./skinBake";
import { StableSlots, type HqAgentLookup } from "./stableSlots";

/**
 * Tier 2: real SkinnedMesh rigs for the few agents nearest the camera (plus
 * the selected, hovered and lead agents). The AnimationMixer is driven exactly
 * by the simulation (action times and weights set from the frame, then
 * `mixer.update(0)`), so a rig and its instanced twin show the same pose;
 * the rig then adds a procedural head/neck look-at and casts a real shadow.
 */

const MAX_YAW = (70 * Math.PI) / 180;
const MAX_PITCH = (35 * Math.PI) / 180;
const NECK_SHARE = 0.4;
const GAZE_RATE = 9;
const WEIGHT_RATE = 5;

type HeroRig = {
  object: Object3D;
  mesh: SkinnedMesh;
  mixer: AnimationMixer;
  /** One action per baked clip (HqSkinBake.clips order); only the one or two in use are playing. */
  actions: AnimationAction[];
  /** Second actions of the same clips, made when a clip crossfades into itself (a held gesture let go). */
  twins: Array<AnimationAction | null>;
  onA: AnimationAction | null;
  onB: AnimationAction | null;
  neck: Bone | null;
  head: Bone | null;
  neckRest: Quaternion;
  headRest: Quaternion;
  gaze: Quaternion;
  gazeWeight: number;
};

function findBone(root: Object3D, name: string): Bone | null {
  let found: Bone | null = null;
  const suffix = `:${name}`;
  root.traverse((node) => {
    if (found || !(node as Bone).isBone) return;
    if (node.name === name || node.name.endsWith(suffix)) found = node as Bone;
  });
  return found;
}

const _p = new Vector3();
const _s = new Vector3();
const _q = new Quaternion();
const _qa = new Quaternion();
const _qb = new Quaternion();
const _qn = new Quaternion();
const _qh = new Quaternion();
const _qw = new Quaternion();
const _root = new Quaternion();
const _target = new Quaternion();
const _fwd = new Vector3();
const _dir = new Vector3();
const _euler = new Euler(0, 0, 0, "YXZ");
const _up = new Vector3(0, 1, 0);
const _z = new Vector3(0, 0, 1);

function wrapTime(t: number, duration: number, loop: boolean): number {
  if (!(duration > 0) || !Number.isFinite(t)) return 0;
  if (loop) return t - Math.floor(t / duration) * duration;
  return t < 0 ? 0 : t > duration ? duration : t;
}

export class HqCrowdHeroes {
  readonly root = new Group();
  readonly slots: StableSlots;
  /** World height of each slot's head bone, for nameplates. */
  readonly headY: Float32Array;
  private readonly rigs: HeroRig[] = [];
  private readonly bake: HqSkinBake;
  /** Head-local vector that points forward in the rest pose. */
  private readonly headForward = new Vector3(0, 0, 1);

  private readonly scene: Object3D;
  private readonly material: Material;
  /** The same tracks under another clip, so one rig can play a clip against itself. */
  private readonly twinClips: AnimationClip[];
  private capacity: number;

  /**
   * `eager` builds every rig now; otherwise grow() adds them a few at a time
   * (the scene spreads a character load over frames).
   */
  constructor(
    scene: Object3D,
    bake: HqSkinBake,
    // AM7 wears the same material as everyone (see crowdMaterials.ts).
    materials: { normal: Material },
    size: number,
    eager = true,
  ) {
    this.root.name = "hq-crowd-heroes";
    this.bake = bake;
    this.scene = scene;
    this.material = materials.normal;
    this.capacity = size;
    this.slots = new StableSlots(size);
    this.headY = new Float32Array(size);
    this.twinClips = bake.sources.map((clip) => new AnimationClip(`${clip.name}~twin`, clip.duration, clip.tracks));
    if (eager) this.grow(Infinity);
  }

  /** Whether every rig is built. */
  get ready(): boolean {
    return this.rigs.length >= this.capacity;
  }

  /** Builds rigs for about `budgetMs`; true once all are built. */
  grow(budgetMs: number): boolean {
    const t0 = performance.now();
    while (this.rigs.length < this.capacity) {
      if (!this.addRig()) {
        this.capacity = this.rigs.length;
        break;
      }
      if (performance.now() - t0 >= budgetMs) break;
    }
    return this.ready;
  }

  private addRig(): boolean {
    const object = cloneSkinned(this.scene);
    const mesh = findSkinnedMesh(object);
    if (!mesh) return false;
    object.visible = false;
    object.position.set(0, 0, 0);
    object.rotation.set(0, 0, 0);
    object.traverse((node) => {
      node.raycast = () => {};
      // Only the skinned body draws; any helper meshes in the file stay hidden.
      if ((node as SkinnedMesh).isMesh && node !== mesh) node.visible = false;
    });
    mesh.material = this.material;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Bounds of a skinned mesh follow the bind pose; the slot is only used
    // for agents already known to be on screen.
    mesh.frustumCulled = false;
    const mixer = new AnimationMixer(object);
    // Actions are made up front but only the one or two a pose needs play,
    // so the mixer evaluates two clips per rig whatever the clip count.
    const actions: AnimationAction[] = [];
    for (const clip of this.bake.sources) actions.push(mixer.clipAction(clip));
    const neck = findBone(object, "Neck");
    const head = findBone(object, "Head");
    if (this.rigs.length === 0 && head) {
      object.updateMatrixWorld(true);
      head.matrixWorld.decompose(_p, _q, _s);
      this.headForward.copy(_z).applyQuaternion(_q.invert());
    }
    this.rigs.push({
      object,
      mesh,
      mixer,
      actions,
      twins: new Array<AnimationAction | null>(actions.length).fill(null),
      onA: null,
      onB: null,
      neck,
      head,
      neckRest: neck ? neck.quaternion.clone() : new Quaternion(),
      headRest: head ? head.quaternion.clone() : new Quaternion(),
      gaze: new Quaternion(),
      gazeWeight: 0,
    });
    this.root.add(object);
    return true;
  }

  get size(): number {
    return this.rigs.length;
  }

  /**
   * Assigns rigs to `want` (at most `limit`) and poses them from the frame.
   * `slotOfAgent` receives the rig slot of every agent (or -1) so the crowd
   * can skip the agents drawn here.
   */
  update(
    frame: HqAgentFrame,
    want: Int32Array,
    wantCount: number,
    limit: number,
    lookup: HqAgentLookup,
    dt: number,
    slotOfAgent: Int32Array,
  ): void {
    this.slots.sync(want, wantCount, Math.min(limit, this.rigs.length), frame.ids, frame.count, lookup, slotOfAgent);
    const gazeEase = 1 - Math.exp(-dt * GAZE_RATE);
    const weightEase = 1 - Math.exp(-dt * WEIGHT_RATE);
    for (let s = 0; s < this.rigs.length; s += 1) {
      const rig = this.rigs[s];
      const i = this.slots.agentIndex[s];
      if (i < 0) {
        rig.object.visible = false;
        continue;
      }
      rig.object.visible = true;
      const lead = frame.lead[i] === 1;
      const facing = frame.facing[i];
      rig.object.position.set(frame.x[i], frame.y[i], frame.z[i]);
      rig.object.rotation.set(0, facing, 0);
      rig.object.scale.setScalar(lead ? HQ_LEAD_SCALE : 1);
      this.pose(rig, frame, i);
      this.headY[s] = this.lookAt(rig, frame, i, facing, this.slots.fresh[s] === 1, gazeEase, weightEase);
    }
  }

  private pose(rig: HeroRig, frame: HqAgentFrame, i: number): void {
    // Unanimated neck/head channels must not accumulate the look-at offset.
    if (rig.neck) rig.neck.quaternion.copy(rig.neckRest);
    if (rig.head) rig.head.quaternion.copy(rig.headRest);
    const actions = rig.actions;
    if (actions.length === 0) return;
    const codeA = frame.clip[i] < HQ_CLIP_COUNT ? frame.clip[i] : 0;
    const codeB = frame.prevClip[i] < HQ_CLIP_COUNT ? frame.prevClip[i] : 0;
    const a = this.bake.codeToClip[codeA];
    const b = this.bake.codeToClip[codeB];
    const clipA = this.bake.clips[a];
    const blend = frame.blend[i];
    const wA = blend > 1 ? 1 : blend < 0 ? 0 : blend;
    const actionA = actions[a];
    const tA = wrapTime(frame.clipTime[i], clipA.duration, clipA.loop);
    let actionB: AnimationAction | null = null;
    let tB = 0;
    if (wA < 0.999) {
      const clipB = this.bake.clips[b];
      tB = wrapTime(frame.prevClipTime[i], clipB.duration, clipB.loop);
      if (b !== a) actionB = actions[b];
      else if (Math.abs(tB - tA) > 1e-3) actionB = rig.twins[a] ??= rig.mixer.clipAction(this.twinClips[a]);
    }
    // Only these one or two play; whatever played before stops.
    const onA = rig.onA;
    const onB = rig.onB;
    if (onA && onA !== actionA && onA !== actionB) onA.stop();
    if (onB && onB !== actionA && onB !== actionB) onB.stop();
    if (actionA !== onA && actionA !== onB) actionA.play();
    if (actionB && actionB !== onA && actionB !== onB) actionB.play();
    rig.onA = actionA;
    rig.onB = actionB;
    actionA.time = tA;
    actionA.weight = actionB ? wA : 1;
    if (actionB) {
      actionB.time = tB;
      actionB.weight = 1 - wA;
    }
    rig.mixer.update(0);
  }

  /** Procedural gaze on top of the clip; returns the head bone's world height. */
  private lookAt(
    rig: HeroRig,
    frame: HqAgentFrame,
    i: number,
    facing: number,
    fresh: boolean,
    gazeEase: number,
    weightEase: number,
  ): number {
    const { head, neck } = rig;
    if (!head) return frame.y[i] + 1.56;
    head.updateWorldMatrix(true, false);
    const e = head.matrixWorld.elements;
    const hx = e[12];
    const hy = e[13];
    const hz = e[14];

    // Target direction in the body frame (facing removed), clamped.
    const cf = Math.cos(facing);
    const sf = Math.sin(facing);
    const dx = frame.lookX[i] - hx;
    const dy = frame.lookY[i] - hy;
    const dz = frame.lookZ[i] - hz;
    const lx = dx * cf - dz * sf;
    const lz = dx * sf + dz * cf;
    const flat = Math.sqrt(lx * lx + lz * lz);
    let want = frame.lookWeight[i];
    if (!(want > 0) || flat + Math.abs(dy) < 1e-4) {
      want = 0;
      _target.copy(rig.gaze);
    } else {
      const yaw = Math.max(-MAX_YAW, Math.min(MAX_YAW, Math.atan2(lx, lz)));
      const pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, Math.atan2(dy, flat)));
      _euler.set(-pitch, yaw, 0, "YXZ");
      _target.setFromEuler(_euler);
    }
    if (fresh) {
      // The instanced twin had no look-at: start from the clip and ease in.
      rig.gaze.copy(_target);
      rig.gazeWeight = 0;
    } else {
      rig.gaze.slerp(_target, gazeEase);
    }
    rig.gazeWeight += ((want > 1 ? 1 : want) - rig.gazeWeight) * weightEase;
    if (rig.gazeWeight < 0.004) return hy;

    // Current head forward, in the body frame.
    head.matrixWorld.decompose(_p, _q, _s);
    _fwd.copy(this.headForward).applyQuaternion(_q);
    const fx = _fwd.x * cf - _fwd.z * sf;
    const fz = _fwd.x * sf + _fwd.z * cf;
    _fwd.set(fx, _fwd.y, fz).normalize();
    _dir.copy(_z).applyQuaternion(rig.gaze);
    // Body-frame correction, weighted, then taken to world space.
    _qa.setFromUnitVectors(_fwd, _dir);
    _qb.identity().slerp(_qa, rig.gazeWeight);
    _root.setFromAxisAngle(_up, facing);
    _qw.copy(_root).multiply(_qb).multiply(_q.copy(_root).invert());

    const neckShare = neck ? NECK_SHARE : 0;
    _qn.identity().slerp(_qw, neckShare);
    _qh.identity().slerp(_qw, 1 - neckShare);
    if (neck && neck.parent) {
      // Rotate the neck about its own origin by _qn in world space.
      neck.parent.matrixWorld.decompose(_p, _q, _s);
      _qa.copy(_q).invert().multiply(_qn).multiply(_q);
      neck.quaternion.premultiply(_qa);
      neck.matrixWorld.decompose(_p, _q, _s);
      _q.premultiply(_qn);
    } else if (head.parent) {
      head.parent.matrixWorld.decompose(_p, _q, _s);
    }
    // _q is now the head parent's world rotation after the neck turn.
    _qa.copy(_q).invert().multiply(_qh).multiply(_q);
    head.quaternion.premultiply(_qa);
    return hy;
  }

  hide(): void {
    this.slots.clear();
    for (const rig of this.rigs) rig.object.visible = false;
  }

  dispose(): void {
    for (const rig of this.rigs) {
      rig.mixer.stopAllAction();
      rig.mixer.uncacheRoot(rig.object);
      rig.mesh.skeleton.dispose();
    }
    this.root.clear();
    this.rigs.length = 0;
  }
}
