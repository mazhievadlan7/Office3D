import type { HqQuality } from "./quality";

/**
 * Adaptive quality for the HQ: a ladder of (quality, pixel ratio) tiers and a
 * governor that walks it from measured frame times.
 *
 * Pixel ratio is the cheap knob and goes first; the quality level (which
 * rebuilds the post chain and shadow maps) only changes when resolution alone
 * is not enough. Stepping down is quick (two slow seconds), stepping up is
 * slow and backs off every time it had to be undone, so the scene does not
 * flicker between levels.
 */

export type HqQualityTier = { quality: HqQuality; dpr: number };

const LADDER: readonly HqQualityTier[] = [
  { quality: "high", dpr: 1.5 },
  { quality: "high", dpr: 1.25 },
  { quality: "high", dpr: 1 },
  { quality: "medium", dpr: 1 },
  { quality: "medium", dpr: 0.85 },
  { quality: "low", dpr: 0.85 },
  { quality: "low", dpr: 0.75 },
];

/** The ladder for this screen: no pixel ratio above the device's own, no duplicate rungs. */
export function buildQualityTiers(deviceDpr: number): HqQualityTier[] {
  const cap = Math.max(0.75, Math.min(1.5, deviceDpr || 1));
  const tiers: HqQualityTier[] = [];
  for (const rung of LADDER) {
    const tier = { quality: rung.quality, dpr: Math.min(rung.dpr, cap) };
    const last = tiers[tiers.length - 1];
    if (last && last.quality === tier.quality && last.dpr === tier.dpr) continue;
    tiers.push(tier);
  }
  return tiers;
}

/** The best tier of a given quality, for a manual override. */
export function tierForQuality(tiers: readonly HqQualityTier[], quality: HqQuality): number {
  const index = tiers.findIndex((tier) => tier.quality === quality);
  return index < 0 ? 0 : index;
}

const WINDOW_SECONDS = 1;
// The first seconds compile shaders and upload textures; do not judge them.
const START_WARMUP_SECONDS = 2.5;
const WARMUP_SECONDS = 1;
// A frame this long is a stall (tab switch, shader compile), not a frame rate.
const STALL_SECONDS = 0.5;
const DECLINE_FPS = 45;
const PANIC_FPS = 24;
const INCLINE_FPS = 57;
const MAX_FLIPFLOPS = 4;
const FORGIVE_WINDOWS = 60;

export class HqQualityGovernor {
  tier: number;
  private readonly tierCount: number;
  private windowTime = 0;
  private windowFrames = 0;
  private warmup = START_WARMUP_SECONDS;
  private slowWindows = 0;
  private fastWindows = 0;
  private inclineWindows = 6;
  private flipflops = 0;
  private lastMove: "up" | "down" | null = null;

  constructor(tierCount: number, startTier = 0) {
    this.tierCount = tierCount;
    this.tier = Math.max(0, Math.min(tierCount - 1, startTier));
  }

  /** Jumps to a tier (a manual choice) and restarts measuring from there. */
  pin(tier: number): void {
    this.tier = Math.max(0, Math.min(this.tierCount - 1, tier));
    this.lastMove = null;
    this.reset();
  }

  /** Restart measuring, e.g. after the scene was rebuilt or the tab came back. */
  reset(): void {
    this.windowTime = 0;
    this.windowFrames = 0;
    this.warmup = WARMUP_SECONDS;
    this.slowWindows = 0;
    this.fastWindows = 0;
  }

  /** Feeds one frame; returns the new tier when it changes, otherwise -1. */
  sample(dt: number): number {
    if (!(dt > 0) || dt > STALL_SECONDS) return -1;
    if (this.warmup > 0) {
      this.warmup -= dt;
      return -1;
    }
    this.windowTime += dt;
    this.windowFrames += 1;
    if (this.windowTime < WINDOW_SECONDS) return -1;
    const fps = this.windowFrames / this.windowTime;
    this.windowTime = 0;
    this.windowFrames = 0;

    if (fps < DECLINE_FPS) {
      this.fastWindows = 0;
      this.slowWindows += 1;
      if ((this.slowWindows >= 2 || fps < PANIC_FPS) && this.tier < this.tierCount - 1) {
        if (this.lastMove === "up") {
          // The last step up did not hold: wait twice as long before the next.
          this.flipflops += 1;
          this.inclineWindows = Math.min(48, this.inclineWindows * 2);
        }
        // Far below target: skip a rung rather than crawl for many seconds.
        const step = fps < PANIC_FPS ? 2 : 1;
        return this.move(Math.min(this.tierCount - 1, this.tier + step), "down");
      }
      return -1;
    }
    this.slowWindows = 0;
    if (fps >= INCLINE_FPS) {
      this.fastWindows += 1;
      // A long fast stretch means earlier slow spells were passing (a busy or
      // background tab, a load), so the upgrade lock and back-off are forgiven.
      if (this.fastWindows >= FORGIVE_WINDOWS && (this.flipflops > 0 || this.inclineWindows > 6)) {
        this.flipflops = 0;
        this.inclineWindows = 6;
      }
      if (
        this.fastWindows >= this.inclineWindows &&
        this.tier > 0 &&
        this.flipflops < MAX_FLIPFLOPS
      ) {
        return this.move(this.tier - 1, "up");
      }
    } else {
      this.fastWindows = 0;
    }
    return -1;
  }

  private move(next: number, direction: "up" | "down"): number {
    this.tier = next;
    this.lastMove = direction;
    this.reset();
    return next;
  }
}
