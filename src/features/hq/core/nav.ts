// Navigation over the HQ aisle graph: a builder used by the layout, an A*
// path query and a nearest-node lookup. Queries allocate nothing: every
// graph gets one lazily built index (adjacency + scratch buffers + bucket
// grid) cached in a WeakMap, sized once.

import type { HqNavGraph } from "./types";

/** Extra cost (metres) for a turn, so paths prefer long straight runs over
 * staircases through the pod grid. Only ever adds cost, so the Euclidean
 * heuristic stays admissible. */
const TURN_PENALTY = 1.2;
/** cos(~20 deg): smaller direction changes are not counted as turns. */
const TURN_COS = 0.94;
const BUCKET_SIZE = 3;

type NavIndex = {
  count: number;
  px: Float32Array;
  pz: Float32Array;
  // CSR adjacency; per directed edge: target, length, unit direction.
  adjStart: Int32Array;
  adjNode: Int32Array;
  adjCost: Float32Array;
  adjDx: Float32Array;
  adjDz: Float32Array;
  // A* scratch, invalidated by bumping `gen` instead of clearing.
  g: Float64Array;
  parent: Int32Array;
  inDx: Float32Array;
  inDz: Float32Array;
  seen: Uint32Array;
  closed: Uint32Array;
  gen: number;
  heapNode: Int32Array;
  heapF: Float64Array;
  heapH: Float64Array;
  heapSize: number;
  // Uniform bucket grid over node positions.
  gx0: number;
  gz0: number;
  gcols: number;
  grows: number;
  cellStart: Int32Array;
  cellItems: Int32Array;
};

const indexCache = new WeakMap<HqNavGraph, NavIndex>();

export function navNodeCount(graph: HqNavGraph): number {
  return graph.positions.length >> 1;
}

export function navNodeX(graph: HqNavGraph, node: number): number {
  return graph.positions[node * 2];
}

export function navNodeZ(graph: HqNavGraph, node: number): number {
  return graph.positions[node * 2 + 1];
}

function buildIndex(graph: HqNavGraph): NavIndex {
  const count = navNodeCount(graph);
  const px = new Float32Array(count);
  const pz = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    px[i] = graph.positions[i * 2];
    pz[i] = graph.positions[i * 2 + 1];
  }
  const edgeCount = graph.edges.length >> 1;
  const degree = new Int32Array(count + 1);
  for (let e = 0; e < edgeCount; e++) {
    degree[graph.edges[e * 2]]++;
    degree[graph.edges[e * 2 + 1]]++;
  }
  const adjStart = new Int32Array(count + 1);
  for (let i = 0; i < count; i++) adjStart[i + 1] = adjStart[i] + degree[i];
  const fill = adjStart.slice(0, count);
  const directed = edgeCount * 2;
  const adjNode = new Int32Array(directed);
  const adjCost = new Float32Array(directed);
  const adjDx = new Float32Array(directed);
  const adjDz = new Float32Array(directed);
  const put = (a: number, b: number) => {
    const slot = fill[a]++;
    const dx = px[b] - px[a];
    const dz = pz[b] - pz[a];
    const len = Math.hypot(dx, dz);
    adjNode[slot] = b;
    adjCost[slot] = len;
    adjDx[slot] = len > 1e-6 ? dx / len : 0;
    adjDz[slot] = len > 1e-6 ? dz / len : 0;
  };
  for (let e = 0; e < edgeCount; e++) {
    const a = graph.edges[e * 2];
    const b = graph.edges[e * 2 + 1];
    put(a, b);
    put(b, a);
  }

  // Bucket grid.
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    if (px[i] < minX) minX = px[i];
    if (px[i] > maxX) maxX = px[i];
    if (pz[i] < minZ) minZ = pz[i];
    if (pz[i] > maxZ) maxZ = pz[i];
  }
  if (count === 0) {
    minX = minZ = maxX = maxZ = 0;
  }
  const gcols = Math.max(1, Math.ceil((maxX - minX) / BUCKET_SIZE) + 1);
  const grows = Math.max(1, Math.ceil((maxZ - minZ) / BUCKET_SIZE) + 1);
  const cellOf = (i: number) => {
    const cx = Math.min(gcols - 1, Math.floor((px[i] - minX) / BUCKET_SIZE));
    const cz = Math.min(grows - 1, Math.floor((pz[i] - minZ) / BUCKET_SIZE));
    return cz * gcols + cx;
  };
  const cellStart = new Int32Array(gcols * grows + 1);
  for (let i = 0; i < count; i++) cellStart[cellOf(i) + 1]++;
  for (let c = 0; c < gcols * grows; c++) cellStart[c + 1] += cellStart[c];
  const cellFill = cellStart.slice(0, gcols * grows);
  const cellItems = new Int32Array(count);
  for (let i = 0; i < count; i++) cellItems[cellFill[cellOf(i)]++] = i;

  const heapCap = directed + count + 1;
  return {
    count,
    px,
    pz,
    adjStart,
    adjNode,
    adjCost,
    adjDx,
    adjDz,
    g: new Float64Array(count),
    parent: new Int32Array(count),
    inDx: new Float32Array(count),
    inDz: new Float32Array(count),
    seen: new Uint32Array(count),
    closed: new Uint32Array(count),
    gen: 0,
    heapNode: new Int32Array(heapCap),
    heapF: new Float64Array(heapCap),
    heapH: new Float64Array(heapCap),
    heapSize: 0,
    gx0: minX,
    gz0: minZ,
    gcols,
    grows,
    cellStart,
    cellItems,
  };
}

export function getNavIndex(graph: HqNavGraph): NavIndex {
  let index = indexCache.get(graph);
  if (!index) {
    index = buildIndex(graph);
    indexCache.set(graph, index);
  }
  return index;
}

// Binary min-heap on f; ties prefer the node closer to the goal (smaller h).
// Stale entries are skipped on pop (lazy decrease-key).
function heapPush(nav: NavIndex, node: number, f: number, h: number): void {
  const { heapNode, heapF, heapH } = nav;
  let i = nav.heapSize++;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heapF[p] < f || (heapF[p] === f && heapH[p] <= h)) break;
    heapNode[i] = heapNode[p];
    heapF[i] = heapF[p];
    heapH[i] = heapH[p];
    i = p;
  }
  heapNode[i] = node;
  heapF[i] = f;
  heapH[i] = h;
}

function heapPop(nav: NavIndex): number {
  const { heapNode, heapF, heapH } = nav;
  const top = heapNode[0];
  const size = --nav.heapSize;
  if (size > 0) {
    const node = heapNode[size];
    const f = heapF[size];
    const h = heapH[size];
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      if (l >= size) break;
      const r = l + 1;
      let c = l;
      if (r < size && (heapF[r] < heapF[l] || (heapF[r] === heapF[l] && heapH[r] < heapH[l]))) c = r;
      if (heapF[c] > f || (heapF[c] === f && heapH[c] >= h)) break;
      heapNode[i] = heapNode[c];
      heapF[i] = heapF[c];
      heapH[i] = heapH[c];
      i = c;
    }
    heapNode[i] = node;
    heapF[i] = f;
    heapH[i] = h;
  }
  return top;
}

/**
 * A* from `from` to `to`. Writes the node sequence (both ends included) into
 * `out` and returns its length; returns 0 when there is no path or it does not
 * fit in `out` (a buffer of navNodeCount(graph) always fits).
 */
export function findPath(graph: HqNavGraph, from: number, to: number, out: Int32Array): number {
  const nav = getNavIndex(graph);
  const { count } = nav;
  if (from < 0 || to < 0 || from >= count || to >= count || out.length === 0) return 0;
  if (from === to) {
    out[0] = from;
    return 1;
  }
  nav.gen++;
  if (nav.gen >= 0xfffffff0) {
    nav.seen.fill(0);
    nav.closed.fill(0);
    nav.gen = 1;
  }
  const gen = nav.gen;
  const { px, pz, adjStart, adjNode, adjCost, adjDx, adjDz, g, parent, inDx, inDz, seen, closed } = nav;
  const tx = px[to];
  const tz = pz[to];
  nav.heapSize = 0;

  seen[from] = gen;
  g[from] = 0;
  parent[from] = -1;
  inDx[from] = 0;
  inDz[from] = 0;
  const h0 = Math.hypot(px[from] - tx, pz[from] - tz);
  heapPush(nav, from, h0, h0);
  let found = false;

  while (nav.heapSize > 0) {
    const u = heapPop(nav);
    if (closed[u] === gen) continue;
    closed[u] = gen;
    if (u === to) {
      found = true;
      break;
    }
    const gu = g[u];
    const idx = inDx[u];
    const idz = inDz[u];
    const hasIn = parent[u] >= 0;
    for (let e = adjStart[u], end = adjStart[u + 1]; e < end; e++) {
      const v = adjNode[e];
      if (closed[v] === gen) continue;
      let cost = adjCost[e];
      if (hasIn && idx * adjDx[e] + idz * adjDz[e] < TURN_COS) cost += TURN_PENALTY;
      const ng = gu + cost;
      if (seen[v] !== gen || ng < g[v]) {
        seen[v] = gen;
        g[v] = ng;
        parent[v] = u;
        inDx[v] = adjDx[e];
        inDz[v] = adjDz[e];
        const h = Math.hypot(px[v] - tx, pz[v] - tz);
        heapPush(nav, v, ng + h, h);
      }
    }
  }
  if (!found) return 0;

  let n = 0;
  for (let v = to; v !== -1; v = parent[v]) n++;
  if (n > out.length) return 0;
  let i = n - 1;
  for (let v = to; v !== -1; v = parent[v]) out[i--] = v;
  return n;
}

/** Nearest node to (x, z), or -1 for an empty graph. */
export function nearestNode(graph: HqNavGraph, x: number, z: number): number {
  const nav = getNavIndex(graph);
  if (nav.count === 0) return -1;
  const { gx0, gz0, gcols, grows, cellStart, cellItems, px, pz } = nav;
  const cx = Math.max(0, Math.min(gcols - 1, Math.floor((x - gx0) / BUCKET_SIZE)));
  const cz = Math.max(0, Math.min(grows - 1, Math.floor((z - gz0) / BUCKET_SIZE)));
  let best = -1;
  let bestD = Infinity;
  const maxR = Math.max(gcols, grows);
  for (let r = 0; r <= maxR; r++) {
    const x0 = cx - r;
    const x1 = cx + r;
    const z0 = cz - r;
    const z1 = cz + r;
    for (let gz = z0; gz <= z1; gz++) {
      if (gz < 0 || gz >= grows) continue;
      const edgeRow = gz === z0 || gz === z1;
      for (let gx = x0; gx <= x1; gx++) {
        if (gx < 0 || gx >= gcols) continue;
        if (!edgeRow && gx !== x0 && gx !== x1) continue;
        const cell = gz * gcols + gx;
        for (let k = cellStart[cell], end = cellStart[cell + 1]; k < end; k++) {
          const n = cellItems[k];
          const dx = px[n] - x;
          const dz = pz[n] - z;
          const d = dx * dx + dz * dz;
          if (d < bestD || (d === bestD && n < best)) {
            bestD = d;
            best = n;
          }
        }
      }
    }
    if (best >= 0) {
      // Everything outside the searched block is at least this far away.
      const bx0 = gx0 + x0 * BUCKET_SIZE;
      const bx1 = gx0 + (x1 + 1) * BUCKET_SIZE;
      const bz0 = gz0 + z0 * BUCKET_SIZE;
      const bz1 = gz0 + (z1 + 1) * BUCKET_SIZE;
      const inside = x >= bx0 && x <= bx1 && z >= bz0 && z <= bz1;
      const margin = inside ? Math.min(x - bx0, bx1 - x, z - bz0, bz1 - z) : 0;
      if (margin * margin >= bestD) break;
    }
    if (x0 <= 0 && z0 <= 0 && x1 >= gcols - 1 && z1 >= grows - 1) break;
  }
  return best;
}

/**
 * Collects nodes and undirected edges while a layout is generated. Nodes at
 * the same position (to the centimetre) are merged, so aisle lines that cross
 * share their intersection node.
 */
const MAX_EDGE_LENGTH = 3;

export class HqNavBuilder {
  private readonly xs: number[] = [];
  private readonly zs: number[] = [];
  private readonly byKey = new Map<string, number>();
  private readonly edgeKeys = new Set<number>();
  private readonly edgeList: number[] = [];

  get nodeCount(): number {
    return this.xs.length;
  }

  /** Existing node at (x, z) to the centimetre, or -1. */
  find(x: number, z: number): number {
    return this.byKey.get(`${Math.round(x * 100)}:${Math.round(z * 100)}`) ?? -1;
  }

  node(x: number, z: number): number {
    const key = `${Math.round(x * 100)}:${Math.round(z * 100)}`;
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;
    const id = this.xs.length;
    this.xs.push(x);
    this.zs.push(z);
    this.byKey.set(key, id);
    return id;
  }

  x(node: number): number {
    return this.xs[node];
  }

  z(node: number): number {
    return this.zs[node];
  }

  link(a: number, b: number): void {
    if (a === b) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo * 1048576 + hi;
    if (this.edgeKeys.has(key)) return;
    this.edgeKeys.add(key);
    this.edgeList.push(lo, hi);
  }

  /** Links consecutive nodes. */
  chain(nodes: readonly number[]): void {
    for (let i = 1; i < nodes.length; i++) this.link(nodes[i - 1], nodes[i]);
  }

  build(): HqNavGraph {
    // Long straight links (doors, lounge, spawn) get intermediate nodes, so
    // walkers re-steer and avoid each other every few metres. New nodes go at
    // the end, so node ids already handed out (desks, spots) stay valid.
    const xs = this.xs.slice();
    const zs = this.zs.slice();
    const edges: number[] = [];
    for (let i = 0; i < this.edgeList.length; i += 2) {
      const a = this.edgeList[i];
      const b = this.edgeList[i + 1];
      const length = Math.hypot(xs[b] - xs[a], zs[b] - zs[a]);
      const parts = Math.ceil(length / MAX_EDGE_LENGTH);
      let prev = a;
      for (let k = 1; k < parts; k++) {
        const t = k / parts;
        xs.push(xs[a] + (xs[b] - xs[a]) * t);
        zs.push(zs[a] + (zs[b] - zs[a]) * t);
        edges.push(prev, xs.length - 1);
        prev = xs.length - 1;
      }
      edges.push(prev, b);
    }
    const positions = new Float32Array(xs.length * 2);
    for (let i = 0; i < xs.length; i++) {
      positions[i * 2] = xs[i];
      positions[i * 2 + 1] = zs[i];
    }
    return { positions, edges: Uint32Array.from(edges) };
  }
}
