import { HQ_CAPACITIES, HQ_DEFAULT_CAPACITY, type HqCapacity } from "../core/config";
import type { HqQualityMode } from "../render/scene/HqAdaptiveQuality";

/**
 * Per-browser HQ preferences. The HQ is client-only (loaded with ssr: false),
 * so these are read straight into initial state without a hydration dance.
 * Every access is guarded: private mode and blocked storage just fall back.
 */

const CAPACITY_KEY = "office3d-hq-capacity";
const QUALITY_KEY = "office3d-hq-quality";
const QUALITY_MODES: readonly HqQualityMode[] = ["auto", "high", "medium", "low"];

const readItem = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeItem = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not persisted; the choice still holds for this session.
  }
};

export function readHqCapacity(): HqCapacity {
  const stored = Number(readItem(CAPACITY_KEY));
  return (HQ_CAPACITIES as readonly number[]).includes(stored) ? (stored as HqCapacity) : HQ_DEFAULT_CAPACITY;
}

export function writeHqCapacity(capacity: HqCapacity): void {
  writeItem(CAPACITY_KEY, String(capacity));
}

export function readHqQualityMode(): HqQualityMode {
  const stored = readItem(QUALITY_KEY);
  return QUALITY_MODES.find((mode) => mode === stored) ?? "auto";
}

export function writeHqQualityMode(mode: HqQualityMode): void {
  writeItem(QUALITY_KEY, mode);
}

/** The next mode for the quality button: auto → high → medium → low → auto. */
export function nextHqQualityMode(mode: HqQualityMode): HqQualityMode {
  return QUALITY_MODES[(QUALITY_MODES.indexOf(mode) + 1) % QUALITY_MODES.length];
}
