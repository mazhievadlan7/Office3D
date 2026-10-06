import type { OsintEntity, OsintRelation } from "./types";

/**
 * A tiny, self-contained force-directed layout for the OSINT entity graph.
 *
 * Deliberately NOT a library: for the ~20-node recon graph a few hundred
 * iterations of Fruchterman–Reingold settle instantly, and running them ONCE
 * (in a useMemo on open) means the view renders a static SVG with zero
 * per-frame cost — no animation loop, nothing added to the hall's render.
 *
 * Deterministic: positions seed from a fixed hash of each id, so the same
 * dataset always lays out the same way (stable screenshots, no jitter on
 * re-mount).
 */

export type GraphNodePos = { id: string; x: number; y: number };

export type GraphLayout = {
  nodes: GraphNodePos[];
  /** Bounds for the SVG viewBox. */
  minX: number;
  minY: number;
  width: number;
  height: number;
};

/** A stable 0..1 pseudo-random from a string — deterministic seeding. */
function hash01(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Map to [0,1).
  return ((h >>> 0) % 100000) / 100000;
}

export type LayoutOptions = {
  /** Target layout size (points); the viewBox is fit to the result. */
  size?: number;
  iterations?: number;
};

export function layoutGraph(
  entities: readonly OsintEntity[],
  relations: readonly OsintRelation[],
  options: LayoutOptions = {},
): GraphLayout {
  const size = options.size ?? 900;
  const iterations = options.iterations ?? 320;
  const n = entities.length;

  if (n === 0) {
    return { nodes: [], minX: 0, minY: 0, width: size, height: size };
  }

  // Ideal edge length.
  const k = size / Math.sqrt(n) / 1.6;

  // Deterministic initial placement on a jittered circle.
  const pos = entities.map((entity, i) => {
    const angle = (i / n) * Math.PI * 2;
    const radius = size * 0.32 * (0.55 + hash01(entity.id) * 0.5);
    return {
      id: entity.id,
      x: Math.cos(angle) * radius + (hash01(entity.id + "x") - 0.5) * k,
      y: Math.sin(angle) * radius + (hash01(entity.id + "y") - 0.5) * k,
    };
  });
  const index = new Map(pos.map((p, i) => [p.id, i] as const));

  const edges = relations
    .map((relation) => ({ a: index.get(relation.from), b: index.get(relation.to) }))
    .filter((edge): edge is { a: number; b: number } => edge.a !== undefined && edge.b !== undefined);

  let temperature = size * 0.1;
  const cooling = temperature / (iterations + 1);
  const disp = pos.map(() => ({ x: 0, y: 0 }));

  for (let step = 0; step < iterations; step += 1) {
    for (let i = 0; i < n; i += 1) {
      disp[i].x = 0;
      disp[i].y = 0;
    }

    // Repulsion between every pair.
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) {
          // Nudge coincident nodes apart deterministically.
          dx = (hash01(pos[i].id + pos[j].id) - 0.5) * 0.1;
          dy = (hash01(pos[j].id + pos[i].id) - 0.5) * 0.1;
          dist = Math.hypot(dx, dy) || 0.01;
        }
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        disp[i].x += fx;
        disp[i].y += fy;
        disp[j].x -= fx;
        disp[j].y -= fy;
      }
    }

    // Attraction along edges.
    for (const edge of edges) {
      const dx = pos[edge.a].x - pos[edge.b].x;
      const dy = pos[edge.a].y - pos[edge.b].y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const force = (dist * dist) / k;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      disp[edge.a].x -= fx;
      disp[edge.a].y -= fy;
      disp[edge.b].x += fx;
      disp[edge.b].y += fy;
    }

    // Pull to centre so the graph stays a compact, roughly-round blob that fills
    // a near-square panel rather than stretching into a tall chain.
    for (let i = 0; i < n; i += 1) {
      disp[i].x -= pos[i].x * 0.14;
      disp[i].y -= pos[i].y * 0.14;
    }

    // Apply, capped by the current temperature.
    for (let i = 0; i < n; i += 1) {
      const d = Math.hypot(disp[i].x, disp[i].y) || 0.01;
      pos[i].x += (disp[i].x / d) * Math.min(d, temperature);
      pos[i].y += (disp[i].y / d) * Math.min(d, temperature);
    }
    temperature = Math.max(0, temperature - cooling);
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pos) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = k * 1.4;
  return {
    nodes: pos,
    minX: minX - pad,
    minY: minY - pad,
    width: maxX - minX + pad * 2,
    height: maxY - minY + pad * 2,
  };
}
