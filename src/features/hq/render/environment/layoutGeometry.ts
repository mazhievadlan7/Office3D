import type { HqDeck, HqLayout, HqRect, HqSegment } from "@/features/hq/core/types";
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

/** True when both ends of the segment lie on the rim of AM7's round island. */
export function segmentOnDeck(seg: HqSegment, deck: HqDeck): boolean {
  const onRim = (x: number, z: number) => Math.abs(Math.hypot(x - deck.x, z - deck.z) - deck.radius) < EDGE_EPS;
  return deck.radius > 0 && onRim(seg.ax, seg.az) && onRim(seg.bx, seg.bz);
}

/** AM7's partitions, drawn with the bright line: the glass balustrade round the island. */
export function isAm7Partition(seg: HqSegment, layout: HqLayout): boolean {
  return segmentOnDeck(seg, layout.deck);
}

export type SignPlacement = {
  x: number;
  y: number;
  z: number;
  /** rotation.y so the sign's +Z faces away from AM7's island. */
  rotY: number;
};

/** Offset of the sign's face out from the balustrade's glass. */
const SIGN_OUT = 0.04;

/**
 * Where an "AM7" sign reads from the default camera, which looks from the
 * south / south-east: on the south face of the island's balustrade (the side
 * facing the rows), low on the glass so it never stands in AM7's way, facing
 * +Z. Falls back to the front of the bounding square when there is no
 * balustrade.
 */
export function am7SignPlacement(layout: HqLayout): SignPlacement {
  const { deck } = layout;
  const rim = layout.partitions.filter((s) => segmentOnDeck(s, deck));
  const height = rim.reduce((acc, s) => Math.max(acc, s.height), 0);
  if (height > 0) {
    return { x: deck.x, y: height * 0.55, z: deck.z + deck.radius + SIGN_OUT, rotY: 0 };
  }
  const r = layout.am7Office;
  return { x: (r.x0 + r.x1) / 2, y: 0.6, z: r.z1 + SIGN_OUT, rotY: 0 };
}

export function clamp(v: number, lo: number, hi: number): number {
  return lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));
}
