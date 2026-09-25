/**
 * Keeps a small pool of slots (hero rigs, nameplates) assigned to agents
 * without churn: an agent that is still wanted keeps the slot it already has,
 * newcomers take free slots, and everything else is released. Agents are
 * tracked by id so a reordered agent list does not swap rigs between people.
 * Allocation-free per frame once the scratch arrays are big enough.
 */
export type HqAgentLookup = { indexOf(id: string): number };

// Squared-distance factor for current heroes (about 15 % closer).
const HERO_HYSTERESIS = 0.72;

export class StableSlots {
  readonly size: number;
  /** Agent id held by each slot, or null when free. */
  readonly agentId: (string | null)[];
  /** Agent index (into the frame arrays) for each slot, -1 when free. */
  readonly agentIndex: Int32Array;
  /** 1 on the frame a slot received a different agent. */
  readonly fresh: Uint8Array;
  private mark = new Uint8Array(0);

  constructor(size: number) {
    this.size = size;
    this.agentId = new Array<string | null>(size).fill(null);
    this.agentIndex = new Int32Array(size).fill(-1);
    this.fresh = new Uint8Array(size);
  }

  /**
   * `want` lists agent indices in priority order (unique). Only the first
   * `limit` slots are used. `slotOfAgent` (length >= count) receives the slot
   * of every agent, or -1.
   */
  sync(
    want: Int32Array,
    wantCount: number,
    limit: number,
    ids: readonly string[],
    count: number,
    lookup: HqAgentLookup,
    slotOfAgent: Int32Array,
  ): void {
    if (this.mark.length < count) this.mark = new Uint8Array(Math.max(count, this.mark.length * 2));
    const mark = this.mark;
    const cap = Math.min(limit, this.size);
    for (let k = 0; k < wantCount; k += 1) {
      const idx = want[k];
      if (idx >= 0 && idx < count) mark[idx] = 1;
    }
    slotOfAgent.fill(-1, 0, count);

    // Keep agents that are still wanted where they are.
    for (let s = 0; s < this.size; s += 1) {
      this.fresh[s] = 0;
      const id = this.agentId[s];
      if (id === null) continue;
      let idx = this.agentIndex[s];
      if (idx < 0 || idx >= count || ids[idx] !== id) {
        idx = lookup.indexOf(id);
        this.agentIndex[s] = idx;
      }
      if (s >= cap || idx < 0 || idx >= count || mark[idx] !== 1) {
        this.agentId[s] = null;
        this.agentIndex[s] = -1;
        continue;
      }
      mark[idx] = 2;
      slotOfAgent[idx] = s;
    }

    // Newcomers take the lowest free slots.
    let free = 0;
    for (let k = 0; k < wantCount; k += 1) {
      const idx = want[k];
      if (idx < 0 || idx >= count || mark[idx] !== 1) continue;
      while (free < cap && this.agentId[free] !== null) free += 1;
      if (free >= cap) break;
      this.agentId[free] = ids[idx];
      this.agentIndex[free] = idx;
      this.fresh[free] = 1;
      slotOfAgent[idx] = free;
      mark[idx] = 2;
    }

    for (let k = 0; k < wantCount; k += 1) {
      const idx = want[k];
      if (idx >= 0 && idx < count) mark[idx] = 0;
    }
  }

  clear(): void {
    this.agentId.fill(null);
    this.agentIndex.fill(-1);
    this.fresh.fill(0);
  }
}

/**
 * Picks who gets a hero rig: the forced agents (selected, hovered, AM7) when
 * visible, then the nearest visible agents up to `max` in total. Agents that
 * are heroes already get a distance bonus so the set does not flicker when
 * the camera drifts across a boundary. Writes unique indices to `out` and
 * returns how many. `score` is scratch with the same length as `out`.
 */
export function pickHeroes(
  count: number,
  visible: Uint8Array,
  dist2: Float32Array,
  wasHero: Int32Array,
  forced: Int32Array,
  forcedCount: number,
  max: number,
  out: Int32Array,
  score: Float32Array,
): number {
  const limit = Math.min(out.length, Math.max(max, 0));
  let n = 0;
  for (let k = 0; k < forcedCount && n < out.length; k += 1) {
    const idx = forced[k];
    if (idx < 0 || idx >= count || visible[idx] === 0) continue;
    let dup = false;
    for (let j = 0; j < n; j += 1) if (out[j] === idx) dup = true;
    if (!dup) out[n++] = idx;
  }
  const base = n;
  const room = limit - base;
  if (room <= 0) return n;
  let m = 0;
  for (let i = 0; i < count; i += 1) {
    if (visible[i] === 0) continue;
    let isForced = false;
    for (let j = 0; j < base; j += 1) if (out[j] === i) isForced = true;
    if (isForced) continue;
    const s = wasHero[i] >= 0 ? dist2[i] * HERO_HYSTERESIS : dist2[i];
    if (m === room && s >= score[base + m - 1]) continue;
    let j = m < room ? base + m++ : base + m - 1;
    while (j > base && score[j - 1] > s) {
      out[j] = out[j - 1];
      score[j] = score[j - 1];
      j -= 1;
    }
    out[j] = i;
    score[j] = s;
  }
  return base + m;
}
