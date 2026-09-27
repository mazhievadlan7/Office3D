import {
  Color,
  Frustum,
  Group,
  Matrix4,
  Sphere,
  type AnimationClip,
  type Camera,
  type InstancedMesh,
  type Material,
  type Object3D,
  type WebGLRenderer,
} from "three";
import { HQ_THEME } from "@/features/hq/core/config";
import { HQ_PLACE } from "@/features/hq/core/types";
import type { HqAgentFrame, HqAgentInput } from "@/features/hq/core/types";
import type { HqQuality } from "@/features/hq/render/scene/quality";
import { HQ_LEAD_SCALE, isSeatedClip } from "./clipTable";
import { HqCrowdDecals, RING_HOVER, RING_SELECTED, RING_STATUS } from "./crowdDecals";
import { HqCrowdHeroes } from "./crowdHeroes";
import { HqCapsuleCrowd, HqSkinnedCrowd } from "./crowdInstances";
import { HqCrowdLabels } from "./crowdLabels";
import { createHeroMaterials } from "./crowdMaterials";
import { bakeCharacter, findSkinnedMesh, type HqSkinBake } from "./skinBake";
import { pickHeroes } from "./stableSlots";

/**
 * Owns every GPU object of the crowd and poses it once per frame from the
 * simulation's struct-of-arrays output. Nothing here allocates per frame:
 * scratch arrays grow only when the agent count does.
 */

/** What the runtime needs from HqSimulation (kept structural for tests). */
export type HqCrowdSim = {
  readonly frame: HqAgentFrame;
  indexOf(id: string): number;
};

/** The parts of a loaded GLTF the crowd uses. */
export type HqCharacterSource = { scene: Object3D; animations: AnimationClip[] };

const HERO_COUNT: Record<HqQuality, number> = { high: 24, medium: 12, low: 4 };
const MAX_HEROES = 24;
// Bounding sphere of one agent for culling, centred at chest height.
const CULL_RADIUS = 1.25;
const CULL_CENTER_Y = 0.9;
// Standing and seated head-bone heights, used when no rig measures them.
const HEAD_STANDING = 1.56;
const HEAD_SEATED = 1.18;

const _statusColors = [
  new Color(HQ_THEME.statusWorking),
  new Color(HQ_THEME.statusIdle),
  new Color(HQ_THEME.statusError),
];
const _selected = new Color(HQ_THEME.statusSelected);
const _hover = new Color(HQ_THEME.accentSoft);
// A warm amber ring marks a hacker who is on the cyber-range from their desk,
// so the drill is visible across the floor, not only on hover.
const _cyber = new Color(0xffb020);

type Character = {
  source: HqCharacterSource;
  bake: HqSkinBake;
  crowd: HqSkinnedCrowd;
  heroes: HqCrowdHeroes;
  heroMaterials: { normal: Material; lead: Material };
};

export class HqCrowdRuntime {
  readonly root = new Group();
  private readonly decals: HqCrowdDecals;
  private readonly capsules: HqCapsuleCrowd;
  private readonly labels: HqCrowdLabels;
  private character: Character | null = null;
  private quality: HqQuality = "high";

  private readonly frustum = new Frustum();
  private readonly viewProj = new Matrix4();
  private readonly sphere = new Sphere();
  private capacity = 0;
  private visible = new Uint8Array(0);
  private dist2 = new Float32Array(0);
  private heroSlot = new Int32Array(0);
  private readonly want = new Int32Array(MAX_HEROES + 3);
  private readonly score = new Float32Array(MAX_HEROES + 3);
  private readonly forced = new Int32Array(3);
  /** Agents that get a nameplate: only the one under the pointer. */
  private readonly labelWant = new Int32Array(1);
  private frame: HqAgentFrame | null = null;
  /** Bound once so the label pass can ask for head heights without a closure per frame. */
  private readonly headY = (i: number): number => {
    const slot = this.heroSlot[i];
    if (this.character && slot >= 0) return this.character.heroes.headY[slot];
    const f = this.frame;
    if (!f) return HEAD_STANDING;
    return f.y[i] + (isSeatedClip(f.clip[i]) ? HEAD_SEATED : HEAD_STANDING) * (f.lead[i] === 1 ? HQ_LEAD_SCALE : 1);
  };

  constructor() {
    this.root.name = "hq-crowd";
    this.decals = new HqCrowdDecals(256);
    this.capsules = new HqCapsuleCrowd(256);
    this.labels = new HqCrowdLabels(MAX_HEROES);
    this.root.add(this.decals.blobs, this.decals.rings, this.capsules.mesh, this.labels.root);
  }

  /** Whether `source` is what the crowd currently draws with. */
  hasCharacter(source: HqCharacterSource | null): boolean {
    return (this.character?.source ?? null) === source;
  }

  /**
   * Switches between the GLB character and the capsule stand-in. Baking is
   * synchronous (tens of ms, cached per GLTF) and happens once per load.
   */
  setCharacter(source: HqCharacterSource | null, renderer: WebGLRenderer): void {
    if (this.hasCharacter(source)) return;
    this.dropCharacter();
    if (!source) return;
    const bake = bakeCharacter(source.scene, source.animations);
    const mesh = findSkinnedMesh(source.scene);
    if (!bake || !mesh) {
      console.warn("HQ character has no skinned mesh; drawing stand-in figures.");
      return;
    }
    // Half floats still hold the palette to about a millimetre at room scale.
    const floatTargets = renderer.extensions.has("EXT_color_buffer_float");
    const crowd = new HqSkinnedCrowd(mesh.geometry, mesh.material, bake, this.capacity, floatTargets);
    crowd.mesh.receiveShadow = this.quality === "high";
    const heroMaterials = createHeroMaterials(mesh.material);
    const heroes = new HqCrowdHeroes(source.scene, bake, heroMaterials, MAX_HEROES);
    this.character = { source, bake, crowd, heroes, heroMaterials };
    this.root.add(crowd.mesh, heroes.root);
    this.capsules.hide();
  }

  private dropCharacter(): void {
    const c = this.character;
    if (!c) return;
    this.character = null;
    this.root.remove(c.crowd.mesh, c.heroes.root);
    c.crowd.dispose();
    c.heroes.dispose();
    c.heroMaterials.normal.dispose();
    c.heroMaterials.lead.dispose();
    this.heroSlot.fill(-1);
  }

  setQuality(quality: HqQuality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    // Changing receiveShadow recompiles once; it is not touched per frame.
    if (this.character) this.character.crowd.mesh.receiveShadow = quality === "high";
  }

  private ensure(count: number): void {
    if (count <= this.capacity) return;
    const size = Math.max(64, 1 << Math.ceil(Math.log2(count)));
    this.capacity = size;
    this.visible = new Uint8Array(size);
    this.dist2 = new Float32Array(size);
    const heroSlot = new Int32Array(size).fill(-1);
    heroSlot.set(this.heroSlot.subarray(0, Math.min(this.heroSlot.length, size)));
    this.heroSlot = heroSlot;
    this.decals.ensure(size);
    this.swap(this.capsules.ensure(size), this.capsules.mesh);
    if (this.character) this.swap(this.character.crowd.ensure(size), this.character.crowd.mesh);
  }

  private swap(old: InstancedMesh | null, next: InstancedMesh): void {
    if (!old) return;
    this.root.remove(old);
    this.root.add(next);
  }

  hide(renderer: WebGLRenderer): void {
    this.capsules.hide();
    this.decals.begin();
    this.decals.end(0);
    this.labels.hide();
    if (this.character) {
      this.character.crowd.begin();
      this.character.crowd.end(renderer);
      this.character.heroes.hide();
    }
  }

  update(
    renderer: WebGLRenderer,
    sim: HqCrowdSim | null,
    agents: readonly HqAgentInput[],
    hoveredId: string | null,
    selectedId: string | null,
    camera: Camera,
    viewportHeight: number,
    dt: number,
    time: number,
  ): void {
    if (!sim || sim.frame.count === 0) {
      this.hide(renderer);
      return;
    }
    const f = sim.frame;
    const n = f.count;
    this.frame = f;
    this.ensure(n);

    // 1. Visibility and camera distance.
    camera.updateMatrixWorld();
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProj, camera.coordinateSystem, camera.reversedDepth);
    const cam = camera.matrixWorld.elements;
    const cx = cam[12];
    const cy = cam[13];
    const cz = cam[14];
    const visible = this.visible;
    const dist2 = this.dist2;
    const sphere = this.sphere;
    sphere.radius = CULL_RADIUS;
    let lead = -1;
    for (let i = 0; i < n; i += 1) {
      const x = f.x[i];
      const y = f.y[i] + CULL_CENTER_Y;
      const z = f.z[i];
      sphere.center.set(x, y, z);
      visible[i] = this.frustum.intersectsSphere(sphere) ? 1 : 0;
      const dx = x - cx;
      const dy = y - cy;
      const dz = z - cz;
      dist2[i] = dx * dx + dy * dy + dz * dz;
      if (lead < 0 && f.lead[i] === 1) lead = i;
    }
    const selected = selectedId ? sim.indexOf(selectedId) : -1;
    const hovered = hoveredId ? sim.indexOf(hoveredId) : -1;
    this.forced[0] = selected;
    this.forced[1] = hovered;
    this.forced[2] = lead;

    // 2. Who is a hero (also who gets a nameplate).
    const wantCount = pickHeroes(n, visible, dist2, this.heroSlot, this.forced, 3, HERO_COUNT[this.quality], this.want, this.score);

    const character = this.character;
    if (character) {
      character.heroes.update(f, this.want, wantCount, HERO_COUNT[this.quality], sim, dt, this.heroSlot);
      // 3. Everyone else on screen: one instanced draw.
      const crowd = character.crowd;
      crowd.begin();
      for (let i = 0; i < n; i += 1) {
        if (visible[i] === 1 && this.heroSlot[i] < 0) crowd.push(f, i);
      }
      crowd.end(renderer);
    } else {
      this.heroSlot.fill(-1, 0, n);
      const capsules = this.capsules;
      capsules.begin();
      for (let i = 0; i < n; i += 1) {
        if (visible[i] === 1) capsules.push(f, i, isSeatedClip(f.clip[i]));
      }
      capsules.end();
    }

    // 4. Floor decals: blob shadows, status rings (high), hover and selection.
    const decals = this.decals;
    const statusRings = this.quality === "high";
    decals.begin();
    for (let i = 0; i < n; i += 1) {
      if (visible[i] === 0) continue;
      const y = f.y[i] + 0.012;
      decals.pushBlob(f.x[i], y, f.z[i], isSeatedClip(f.clip[i]) ? 0.52 : 0.44);
      if (statusRings && i !== selected && i !== hovered) {
        decals.pushRing(f.x[i], y + 0.002, f.z[i], 0.5, _statusColors[f.status[i]] ?? _statusColors[1], 0.06, RING_STATUS, 0);
      }
      // On the cyber-range from the desk: an amber pulse so the drill shows
      // across the floor (every quality tier), not only on hover.
      if (f.place[i] === HQ_PLACE.cyberrange && i !== selected && i !== hovered) {
        decals.pushRing(f.x[i], y + 0.004, f.z[i], 0.58, _cyber, 0.75, RING_HOVER, 0);
      }
    }
    if (hovered >= 0 && hovered !== selected && visible[hovered] === 1) {
      decals.pushRing(f.x[hovered], f.y[hovered] + 0.016, f.z[hovered], 0.62, _hover, 1.1, RING_HOVER, 0);
    }
    if (selected >= 0 && visible[selected] === 1) {
      decals.pushRing(f.x[selected], f.y[selected] + 0.018, f.z[selected], 0.7, _selected, 1.6, RING_SELECTED, 0);
    }
    decals.end(time);

    // 5. Nameplate: only the agent under the pointer — a name lights up on
    // hover, never on camera proximity, and the selection is shown by the
    // floor ring instead of a lingering label.
    let labelCount = 0;
    if (hovered >= 0 && visible[hovered] === 1) this.labelWant[labelCount++] = hovered;
    this.labels.update(f, this.labelWant, labelCount, sim, agents, visible, this.headY, selected, hovered, camera, viewportHeight, dt);
  }

  dispose(): void {
    this.dropCharacter();
    this.decals.dispose();
    this.capsules.dispose();
    this.labels.dispose();
    this.root.clear();
  }
}
