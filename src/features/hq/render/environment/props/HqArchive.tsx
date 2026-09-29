"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { HqArchiveStation, HqArchiveView, HqProp, HqPropKind } from "@/features/hq/core/types";
import type { HqQuality } from "@/features/hq/render/scene/quality";
import { noRaycast } from "../glsl";
import { boxesToGeometry } from "../roomShell";
import { applyPropShadows, buildPropBatches, disposePropBatches, type PropBatchGroup, type PropMaterialSet } from "./propBatches";
import type { PropUniforms } from "./propMaterials";

// The archive station by the entrance (HqLayout.archive), drawn from the
// props.glb archive_* kinds (or their stand-ins) and driven every frame by the
// sim's archive view: the docking bay with its LED fill gauge, the cart
// following the sim (x, z, rotY) with its load tiers, handle light and tablet,
// the intake chute on the apron whose slot glows and shutter rolls up while
// the load goes in, and a glow on the entrance posts while the cart passes.
// Every group moves through the rig below; a frame allocates nothing.

/**
 * Lit red in linear light. Kept deep and capped: AgX turns a saturated red
 * pushed far above 1 into salmon, so the LEDs stay just into bloom range.
 */
const LED_RED = new THREE.Color(1, 0.022, 0.01);
const LIT = 1.5;
const DIM = 0.28;
/** The chute slot's glow at rest and while the load goes in. */
const SLOT_REST = 0.3;
const SLOT_HOT = 1.7;
/** The entrance posts' extra glow while the cart passes (added over the curb line). */
const GATE_GLOW = 2.6;
/** A new load tier drops onto the parked cart from this high, in this long. */
const DROP_SECONDS = 0.35;
const DROP_HEIGHT = 0.12;
/**
 * Unload: tiers leave top first, each over UNLOAD_SPAN of the handover
 * (view.unload 0..1), the first at UNLOAD_START. All four are gone before the
 * sim's handover event (2.9 / 3.6 of it), when the level drops to 0.
 */
const UNLOAD_START = 0.06;
const UNLOAD_SPAN = 0.18;
/** The arc's height over the straight line from the deck to the slot. */
const ARC_LIFT = 0.22;
/** Where a tier disappears: the slot's mouth (floor + half its height), this far inside the cabinet. */
const SLOT_Y = 0.73;
const SLOT_INSET = 0.14;
/** Scale a tier shrinks to as it enters the 0.45 x 0.21 m slot. */
const SLOT_SHRINK = 0.42;
/** The shutter rolls up about the slot top (archive_chute_shutter), down to this fraction. */
const SHUTTER_PIVOT_Y = 0.84;
const SHUTTER_OPEN = 0.08;
/** Bay LED 4 blinks at full: on for BLINK_ON of every BLINK_PERIOD seconds. */
const BLINK_PERIOD = 1.1;
const BLINK_ON = 0.68;
/** The entrance posts (render/environment/roomShell.ts): 6 cm square, 1.1 m tall, just outside each jamb. */
const POST = { size: 0.06, height: 1.1, grow: 0.006 } as const;

/** The tablet's canvas (the display quad is 0.154 x 0.09 m). */
const TABLET = { w: 256, h: 150 } as const;
const TABLET_COLORS = { bg: "#070506", dim: "#8a2016", hot: "#ff3322", cellOff: "#2a0906" } as const;

const TIER_KINDS: readonly HqPropKind[] = ["archive_load_1", "archive_load_2", "archive_load_3", "archive_load_4"];
const LED_KINDS: readonly HqPropKind[] = ["archive_bay_led_1", "archive_bay_led_2", "archive_bay_led_3", "archive_bay_led_4"];

type Props = {
  archive: HqArchiveStation;
  scene: THREE.Object3D | null;
  materials: PropMaterialSet;
  uniforms: PropUniforms;
  quality: HqQuality;
  /** Read every frame: the sim's archive view, or null (then the cart stands empty in its bay). */
  view: () => Readonly<HqArchiveView> | null;
  /**
   * Read every frame: the bytes the cart's load stands for, or null when
   * unknown (the run's freed bytes from `taken` until it is parked). The
   * tablet shows it; while null it shows the load tier.
   */
  bytes?: () => number | null;
};

/** The archive station, redrawn from the sim's archive view every frame. */
export function HqArchive({ archive, scene, materials, uniforms, quality, view, bytes }: Props) {
  const rig = useMemo(() => new ArchiveRig(archive, scene, materials, uniforms), [archive, scene, materials, uniforms]);
  useEffect(() => () => rig.dispose(), [rig]);
  useEffect(() => rig.setShadows(quality === "high"), [rig, quality]);
  useFrame((state, delta) => {
    rig.update(view(), Math.min(delta, 0.1), state.clock.elapsedTime, bytes ? bytes() : null);
  });
  return <primitive object={rig.root} />;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const easeOut = (t: number) => 1 - (1 - t) * (1 - t) * (1 - t);
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

type Tier = {
  group: THREE.Group;
  /** Centre of the tier's bounds in the cart's frame. */
  cx: number;
  cy: number;
  cz: number;
  present: boolean;
  /** Seconds since it appeared (drop-in), DROP_SECONDS once settled. */
  drop: number;
};

type TabletMode = 0 | 1 | 2;

/** Sets a lit part's level: emissive for lit materials, colour for unlit ones. */
function setGlow(material: THREE.Material, level: number): void {
  const standard = material as THREE.MeshStandardMaterial;
  if (standard.isMeshStandardMaterial) {
    standard.emissive.copy(LED_RED);
    standard.emissiveIntensity = level;
    return;
  }
  const basic = material as THREE.MeshBasicMaterial;
  if (basic.isMeshBasicMaterial) basic.color.copy(LED_RED).multiplyScalar(level);
}

/**
 * Caps the glow materials a batch cloned from props.glb (propBatches pushes
 * every emissive to 5): lit parts deep red at LIT, the unlit "_dim" windows at DIM.
 */
function capBatchGlow(batch: PropBatchGroup): void {
  for (const m of batch.owned.materials) {
    const standard = m as THREE.MeshStandardMaterial;
    if (standard.isMeshStandardMaterial) standard.color.setRGB(0.01, 0.002, 0.002);
    setGlow(m, m.name.toLowerCase().includes("dim") ? DIM : LIT);
  }
}

function tabletBytes(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  const mib = bytes / 1048576;
  if (mib < 0.95) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (mib < 9.95) return `${mib.toFixed(1)} MB`;
  if (mib < 999.5) return `${Math.round(mib)} MB`;
  return `${(mib / 1024).toFixed(1)} GB`;
}

/** Everything the station draws, and its per-frame driver (exported for tests). */
export class ArchiveRig {
  readonly root = new THREE.Group();
  private readonly batches: PropBatchGroup[] = [];
  /** Batches that cast shadows on high quality (not the LEDs, the light strip or the slot glow). */
  private readonly shadowed: PropBatchGroup[] = [];
  private readonly ownMaterials: THREE.Material[] = [];
  private readonly ownGeometries: THREE.BufferGeometry[] = [];
  private readonly cart = new THREE.Group();
  private readonly lit: THREE.Object3D;
  private readonly leds: THREE.Object3D[];
  private readonly shutter = new THREE.Group();
  private readonly slotMaterials: THREE.Material[] = [];
  private readonly tiers: Tier[];
  private readonly gate: THREE.Mesh;
  private readonly gateMaterial: THREE.MeshBasicMaterial;
  private readonly parkedView: HqArchiveView;
  // The slot mouth in world space (tiers fly there during the handover).
  private readonly slotX: number;
  private readonly slotZ: number;

  private readonly tablet: THREE.CanvasTexture | null = null;
  private readonly tabletCtx: CanvasRenderingContext2D | null = null;
  private tabletMode = -1;
  private tabletLevel = -1;
  private tabletCode = -2;

  private first = true;
  /** The level last drawn outside the handover (a jump of more than one tier is a reload, not a new load). */
  private lastLevel = 0;
  private inHandover = false;
  private handLevel = 0;
  /** The load went into the chute this run (the tablet then shows what was freed). */
  private handed = false;
  // The slot in the cart's frame, fixed for the handover.
  private slotLx = 0;
  private slotLy = SLOT_Y;
  private slotLz = 0;
  private slotLevel = -1;
  private shutterOpen = -1;
  private gateLevel = -1;

  constructor(station: HqArchiveStation, scene: THREE.Object3D | null, materials: PropMaterialSet, uniforms: PropUniforms) {
    this.root.name = "hq-archive";

    // Own materials: the tablet's canvas, and deep red LEDs for the stand-ins
    // (the shared stand-in LED materials are pushed far into bloom).
    const tabletMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    tabletMaterial.name = "hq-archive-tablet";
    const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
    const ctx = canvas?.getContext("2d") ?? null;
    if (canvas && ctx) {
      canvas.width = TABLET.w;
      canvas.height = TABLET.h;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      // props.glb display UVs have v = 0 at the top, like the canvas rows.
      texture.flipY = false;
      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearFilter;
      this.tablet = texture;
      this.tabletCtx = ctx;
      tabletMaterial.map = texture;
    } else {
      tabletMaterial.color.set(TABLET_COLORS.bg);
    }
    const ledLit = new THREE.MeshBasicMaterial({ toneMapped: false });
    ledLit.name = "hq-archive-led";
    setGlow(ledLit, LIT);
    const slotLit = new THREE.MeshBasicMaterial({ toneMapped: false });
    slotLit.name = "hq-archive-slot";
    setGlow(slotLit, SLOT_REST);
    this.ownMaterials.push(tabletMaterial, ledLit, slotLit);

    const withFallback = (led: THREE.Material): PropMaterialSet => ({
      screen: tabletMaterial,
      screenChannels: false,
      fallback: { ...materials.fallback, led, ledStatic: led, screen: tabletMaterial },
    });
    const set = withFallback(ledLit);
    const build = (props: HqProp[], materialSet = set, shadows = true): PropBatchGroup => {
      const batch = buildPropBatches(props, scene, materialSet, uniforms);
      capBatchGlow(batch);
      this.batches.push(batch);
      if (shadows) this.shadowed.push(batch);
      return batch;
    };
    const at = (kind: HqPropKind, pose: { x: number; z: number; rotY: number }): HqProp => ({ kind, x: pose.x, z: pose.z, rotY: pose.rotY });
    const origin = { x: 0, z: 0, rotY: 0 };

    // Bay and chute, static.
    this.root.add(build([at("archive_bay", station.bay), at("archive_chute", station.chute)]).root);
    this.leds = LED_KINDS.map((kind) => {
      const led = build([at(kind, station.bay)], set, false).root;
      led.visible = false;
      this.root.add(led);
      return led;
    });
    // The slot glow on its own materials, so it can be driven alone.
    const slot = build([at("archive_chute_slot", station.chute)], withFallback(slotLit), false);
    for (const child of slot.root.children) {
      const m = (child as THREE.Mesh).material as THREE.Material;
      if ((slot.owned.materials.includes(m) || m === slotLit) && !this.slotMaterials.includes(m)) this.slotMaterials.push(m);
    }
    for (const m of this.slotMaterials) setGlow(m, SLOT_REST);
    this.root.add(slot.root);
    // The shutter, rolled up about the slot top.
    const shutterMount = new THREE.Group();
    shutterMount.position.set(station.chute.x, 0, station.chute.z);
    shutterMount.rotation.y = station.chute.rotY;
    this.shutter.position.y = SHUTTER_PIVOT_Y;
    const shutterBody = build([at("archive_chute_shutter", origin)]).root;
    shutterBody.position.y = -SHUTTER_PIVOT_Y;
    this.shutter.add(shutterBody);
    shutterMount.add(this.shutter);
    this.root.add(shutterMount);

    // The cart and everything riding on it, in the cart's frame.
    this.cart.name = "hq-archive-cart";
    this.cart.add(build([at("archive_cart", origin)]).root);
    this.lit = build([at("archive_cart_lit", origin)], set, false).root;
    this.lit.visible = false;
    this.cart.add(this.lit);
    const bounds = new THREE.Box3();
    this.tiers = TIER_KINDS.map((kind) => {
      const batch = build([at(kind, origin)]);
      const group = new THREE.Group();
      group.visible = false;
      group.add(batch.root);
      this.cart.add(group);
      bounds.makeEmpty();
      for (const child of batch.root.children) {
        const g = (child as THREE.Mesh).geometry;
        g.computeBoundingBox();
        if (g.boundingBox) bounds.union(g.boundingBox);
      }
      const empty = bounds.isEmpty();
      return {
        group,
        cx: empty ? 0 : (bounds.min.x + bounds.max.x) / 2,
        cy: empty ? 0.3 : (bounds.min.y + bounds.max.y) / 2,
        cz: empty ? 0 : (bounds.min.z + bounds.max.z) / 2,
        present: false,
        drop: DROP_SECONDS,
      };
    });
    this.root.add(this.cart);

    // The glow over the entrance posts, added on top of the shared curb line.
    const { from, to } = station.gate;
    const s = POST.size;
    const e = POST.grow;
    const gateGeometry = boxesToGeometry([
      [from.x - s - e, 0, from.z - s / 2 - e, from.x + e, POST.height + e, from.z + s / 2 + e],
      [to.x - e, 0, to.z - s / 2 - e, to.x + s + e, POST.height + e, to.z + s / 2 + e],
    ]);
    this.ownGeometries.push(gateGeometry);
    this.gateMaterial = new THREE.MeshBasicMaterial({
      toneMapped: false,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.gateMaterial.name = "hq-archive-gate";
    this.ownMaterials.push(this.gateMaterial);
    this.gate = new THREE.Mesh(gateGeometry, this.gateMaterial);
    this.gate.name = "hq-archive-gate";
    this.gate.visible = false;
    this.gate.raycast = noRaycast;
    this.root.add(this.gate);

    const fx = Math.sin(station.chute.rotY);
    const fz = Math.cos(station.chute.rotY);
    this.slotX = station.chute.slot.x - fx * SLOT_INSET;
    this.slotZ = station.chute.slot.z - fz * SLOT_INSET;
    this.parkedView = {
      x: station.cart.x,
      z: station.cart.z,
      rotY: station.cart.rotY,
      level: 0,
      unload: 0,
      gate: 0,
      chute: 0,
      phase: "parked",
      pusherId: null,
    };
    this.placeCart(this.parkedView);
  }

  setShadows(on: boolean): void {
    for (const batch of this.shadowed) applyPropShadows(batch, on);
  }

  dispose(): void {
    for (const batch of this.batches) disposePropBatches(batch);
    for (const m of this.ownMaterials) m.dispose();
    for (const g of this.ownGeometries) g.dispose();
    this.tablet?.dispose();
  }

  private placeCart(v: Readonly<HqArchiveView>): void {
    this.cart.position.set(v.x, 0, v.z);
    this.cart.rotation.y = v.rotY;
  }

  update(view: Readonly<HqArchiveView> | null, dt: number, time: number, bytes: number | null): void {
    const v = view ?? this.parkedView;
    this.placeCart(v);
    const phase = v.phase;
    const handover = phase === "handover";

    if (handover && !this.inHandover) {
      let shown = 0;
      for (let i = 0; i < 4; i++) if (this.tiers[i].present) shown++;
      this.handLevel = Math.max(shown, v.level);
      // The slot in the cart's frame (the cart stands still for the handover).
      const dx = this.slotX - v.x;
      const dz = this.slotZ - v.z;
      const c = Math.cos(v.rotY);
      const s = Math.sin(v.rotY);
      this.slotLx = dx * c - dz * s;
      this.slotLy = SLOT_Y;
      this.slotLz = dx * s + dz * c;
    }
    this.inHandover = handover;
    if (phase === "parked" || phase === "fetch" || phase === "push-out") this.handed = false;
    else if (phase === "push-back" || (handover && v.level === 0)) this.handed = true;

    // Tiers that are simply there (the first frame, or the host's first fill
    // after the page opened, which sets several at once) do not drop in.
    const instant = this.first || v.level - this.lastLevel > 1;
    if (!handover) this.lastLevel = v.level;
    let shown = 0;
    for (let i = 0; i < 4; i++) {
      const tier = this.tiers[i];
      const k = i + 1;
      const group = tier.group;
      if (handover) {
        tier.present = k <= v.level;
        tier.drop = DROP_SECONDS;
        if (k > this.handLevel) {
          group.visible = false;
          continue;
        }
        const start = UNLOAD_START + (this.handLevel - k) * UNLOAD_SPAN;
        const t = (v.unload - start) / UNLOAD_SPAN;
        if (t >= 1) {
          group.visible = false;
          tier.present = false;
          continue;
        }
        shown++;
        group.visible = true;
        if (t <= 0) {
          group.position.set(0, 0, 0);
          group.scale.setScalar(1);
          continue;
        }
        // An eased arc from the deck into the slot, shrinking into its mouth.
        const e = smooth(t);
        const lift = ARC_LIFT * 4 * t * (1 - t);
        const sc = 1 - (1 - SLOT_SHRINK) * smooth(clamp01((t - 0.45) / 0.55));
        group.scale.setScalar(sc);
        group.position.set(
          tier.cx + (this.slotLx - tier.cx) * e - sc * tier.cx,
          tier.cy + (this.slotLy - tier.cy) * e + lift - sc * tier.cy,
          tier.cz + (this.slotLz - tier.cz) * e - sc * tier.cz,
        );
        continue;
      }
      const want = k <= v.level;
      if (want && !tier.present) {
        tier.present = true;
        // No drop-in for what is already loaded when the HQ opens.
        tier.drop = instant ? DROP_SECONDS : 0;
      } else if (!want) {
        tier.present = false;
      }
      group.visible = tier.present;
      if (!tier.present) continue;
      shown++;
      group.scale.setScalar(1);
      if (tier.drop < DROP_SECONDS) {
        tier.drop = Math.min(DROP_SECONDS, tier.drop + dt);
        group.position.set(0, DROP_HEIGHT * (1 - easeOut(tier.drop / DROP_SECONDS)), 0);
      } else {
        group.position.set(0, 0, 0);
      }
    }
    this.first = false;

    // Handle light: on while the cart carries something or rolls.
    this.lit.visible = shown > 0 || phase === "push-out" || phase === "push-back" || handover;

    // Bay gauge: the parked cart's load; LED 4 blinks at full.
    const gauge = phase === "parked" ? v.level : 0;
    const blinkOn = time % BLINK_PERIOD < BLINK_ON;
    for (let i = 0; i < 4; i++) this.leds[i].visible = i + 1 <= gauge && (i < 3 || blinkOn);

    // Chute: slot glow and shutter follow view.chute.
    const chute = clamp01(v.chute);
    const slot = SLOT_REST + (SLOT_HOT - SLOT_REST) * chute;
    if (slot !== this.slotLevel) {
      this.slotLevel = slot;
      for (const m of this.slotMaterials) setGlow(m, slot);
    }
    if (chute !== this.shutterOpen) {
      this.shutterOpen = chute;
      this.shutter.scale.y = 1 - (1 - SHUTTER_OPEN) * smooth(chute);
    }

    // Entrance posts.
    const gate = clamp01(v.gate);
    if (gate !== this.gateLevel) {
      this.gateLevel = gate;
      this.gate.visible = gate > 0.005;
      this.gateMaterial.color.copy(LED_RED).multiplyScalar(GATE_GLOW * gate);
    }

    this.updateTablet(v, bytes);
  }

  /** Redraws the tablet's canvas only when what it shows changes. */
  private updateTablet(v: Readonly<HqArchiveView>, bytes: number | null): void {
    const ctx = this.tabletCtx;
    if (!ctx || !this.tablet) return;
    const level = this.handed ? 0 : v.level;
    // 0: the load (ARCHIVE, its size), 1: after the handover (FREED, the size), 2: loaded, size unknown.
    const mode: TabletMode = this.handed ? 1 : bytes === null && level > 0 ? 2 : 0;
    const code = bytes === null ? -1 : Math.round(bytes / 1024);
    if (mode === this.tabletMode && level === this.tabletLevel && code === this.tabletCode) return;
    this.tabletMode = mode;
    this.tabletLevel = level;
    this.tabletCode = code;

    const { w, h } = TABLET;
    ctx.fillStyle = TABLET_COLORS.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.textBaseline = "middle";
    ctx.font = "bold 17px ui-monospace, Menlo, Consolas, monospace";
    ctx.fillStyle = TABLET_COLORS.dim;
    ctx.textAlign = "left";
    ctx.fillText(mode === 1 ? "FREED" : "ARCHIVE", 16, 22);
    ctx.textAlign = "right";
    ctx.fillText(mode === 2 ? "LOAD" : `${level}/4`, w - 16, 22);

    const value = mode === 2 ? `${level}/4` : bytes === null ? (mode === 1 ? "OUT" : "0 MB") : tabletBytes(bytes);
    ctx.fillStyle = TABLET_COLORS.hot;
    ctx.textAlign = "center";
    ctx.font = `bold ${value.length > 7 ? 38 : 46}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.fillText(value, w / 2, 76);

    const cell = 50;
    const gap = 6;
    const x0 = (w - (cell * 4 + gap * 3)) / 2;
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i < level ? TABLET_COLORS.hot : TABLET_COLORS.cellOff;
      ctx.fillRect(x0 + i * (cell + gap), 118, cell, 12);
    }
    this.tablet.needsUpdate = true;
  }
}
