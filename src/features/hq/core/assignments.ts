// Persisted desk assignments (agent id -> desk index), one map per namespace
// and hall capacity. Storage may be missing or blocked (private mode, SSR),
// so every access is guarded and falls back to "nothing saved".

import type { HqCapacity } from "./config";

const KEY_PREFIX = "office3d-hq-desks:v1";

export function hqAssignmentsKey(namespace: string, capacity: HqCapacity): string {
  return `${KEY_PREFIX}:${namespace}:${capacity}`;
}

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Keeps only entries that point at a real desk of this capacity, one agent per desk. */
export function sanitizeHqAssignments(value: unknown, capacity: HqCapacity): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const used = new Set<number>();
  for (const [id, desk] of Object.entries(value as Record<string, unknown>)) {
    if (!id || typeof desk !== "number" || !Number.isInteger(desk) || desk < 0 || desk >= capacity) continue;
    if (used.has(desk)) continue;
    used.add(desk);
    out[id] = desk;
  }
  return out;
}

export function loadHqAssignments(namespace: string, capacity: HqCapacity): Record<string, number> {
  const store = storage();
  if (!store) return {};
  try {
    const raw = store.getItem(hqAssignmentsKey(namespace, capacity));
    return raw ? sanitizeHqAssignments(JSON.parse(raw), capacity) : {};
  } catch {
    return {};
  }
}

export function saveHqAssignments(
  namespace: string,
  capacity: HqCapacity,
  assignments: Record<string, number>,
): void {
  const store = storage();
  if (!store) return;
  try {
    const clean = sanitizeHqAssignments(assignments, capacity);
    const key = hqAssignmentsKey(namespace, capacity);
    if (Object.keys(clean).length === 0) store.removeItem(key);
    else store.setItem(key, JSON.stringify(clean));
  } catch {
    // Quota or access errors: the next session just re-assigns desks.
  }
}
