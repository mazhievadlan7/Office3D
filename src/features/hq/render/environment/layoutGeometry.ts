import type { HqLayout, HqRect, HqSegment } from "@/features/hq/core/types";
import { ENTRANCE_WIDTH } from "./palette";

// Pure helpers that derive environment placement from the layout. Kept free
// of three.js objects so the glow canvas, the room shell and the sign agree.

export type EntranceGap = { side: "south" | "east"; from: number; to: number };

/** The entrance is cut into whichever low curb (south or east) the spawn point is nearest. */
export function entranceGap(layout: HqLayout): EntranceGap {
  const { bounds, spawn } = layout;
  const toSouth = Math.abs(bounds.z1 - spawn.z);
  const toEast = Math.abs(bounds.x1 - spawn.x);
  const half = ENTRANCE_WIDTH / 2;
  if (toSouth <= toEast) {
    const c = clamp(spawn.x, bounds.x0 + half + 0.4, bounds.x1 - half - 0.4);
    return { side: "south", from: c - half, to: c + half };
  }
  const c = clamp(spawn.z, bounds.z0 + half + 0.4, bounds.z1 - half - 0.4);
  return { side: "east", from: c - half, to: c + half };
}

const EDGE_EPS = 0.08;

/** True when the segment lies along the rectangle's outline. */
export function segmentOnRect(seg: HqSegment, r: HqRect): boolean {
  const onX = (x: number) => Math.abs(x - r.x0) < EDGE_EPS || Math.abs(x - r.x1) < EDGE_EPS;
  const onZ = (z: number) => Math.abs(z - r.z0) < EDGE_EPS || Math.abs(z - r.z1) < EDGE_EPS;
  const inX = (x: number) => x > r.x0 - EDGE_EPS && x < r.x1 + EDGE_EPS;
  const inZ = (z: number) => z > r.z0 - EDGE_EPS && z < r.z1 + EDGE_EPS;
  const vertical = Math.abs(seg.ax - seg.bx) < EDGE_EPS && onX(seg.ax) && inZ(seg.az) && inZ(seg.bz);
  const horizontal = Math.abs(seg.az - seg.bz) < EDGE_EPS && onZ(seg.az) && inX(seg.ax) && inX(seg.bx);
  return vertical || horizontal;
}

export type SignPlacement = {
  x: number;
  y: number;
  z: number;
  /** rotation.y so the sign's +Z faces away from the office. */
  rotY: number;
};

/**
 * The AM7 sign sits above the office front the camera sees: the south or the
 * east side (the camera looks from +x,+z), whichever has the door (else more
 * glass), centred on that side's glass front.
 */
export function am7SignPlacement(layout: HqLayout): SignPlacement {
  const r = layout.am7Office;
  const { bounds } = layout;
  const segs = layout.partitions.filter((s) => segmentOnRect(s, r));
  const sides: Array<{ name: "south" | "east"; open: boolean; along: (s: HqSegment) => boolean }> = [
    {
      name: "south",
      open: r.z1 < bounds.z1 - 0.5,
      along: (s) => Math.abs(s.az - r.z1) < EDGE_EPS && Math.abs(s.bz - r.z1) < EDGE_EPS,
    },
    {
      name: "east",
      open: r.x1 < bounds.x1 - 0.5,
      along: (s) => Math.abs(s.ax - r.x1) < EDGE_EPS && Math.abs(s.bx - r.x1) < EDGE_EPS,
    },
  ];
  // Prefer a side with a door, then the side with the most glass.
  let best: { name: "south" | "east"; segs: HqSegment[]; score: number } | null = null;
  for (const side of sides) {
    if (!side.open) continue;
    const on = segs.filter(side.along);
    const length = on.reduce((acc, s) => acc + Math.hypot(s.bx - s.ax, s.bz - s.az), 0);
    const score = length + (on.some((s) => s.kind === "glass-door") ? 100 : 0);
    if (!best || score > best.score) best = { name: side.name, segs: on, score };
  }
  const sideName = best?.name ?? "south";
  const onSide = best?.segs ?? [];
  const height = onSide.reduce((acc, s) => Math.max(acc, s.height), 0) || 2.6;
  const y = height + 0.55;
  const out = 0.04;
  // Centred on that side's glass front: hugging the door reads as an accident.
  const centre = (pick: (s: HqSegment) => [number, number], lo: number, hi: number) => {
    if (onSide.length === 0) return (lo + hi) / 2;
    let a = Infinity;
    let b = -Infinity;
    for (const s of onSide) {
      const [p, q] = pick(s);
      a = Math.min(a, p, q);
      b = Math.max(b, p, q);
    }
    return (a + b) / 2;
  };
  if (sideName === "south") {
    return { x: centre((s) => [s.ax, s.bx], r.x0, r.x1), y, z: r.z1 + out, rotY: 0 };
  }
  return { x: r.x1 + out, y, z: centre((s) => [s.az, s.bz], r.z0, r.z1), rotY: Math.PI / 2 };
}

export function clamp(v: number, lo: number, hi: number): number {
  return lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));
}
