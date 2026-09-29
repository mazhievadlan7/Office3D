import { describe, expect, it } from "vitest";

import { HQ_CLIP_FPS, HQ_CLIP_INFO, HQ_CLIPS } from "@/features/hq/core/config";

/**
 * The crowd bakes every clip into one float texture, one row per sampled
 * frame plus one per clip (render/crowd/skinBake.ts). WebGL2 guarantees 4096
 * rows; past that the bake quietly lowers the clips' frame rate and fingers
 * start to swim when typing. Keep a margin: at most 3800 rows at full rate.
 */
const ROW_BUDGET = 3800;

describe("clip texture budget", () => {
  it("fits every clip at the full frame rate with a margin under 4096 rows", () => {
    let rows = 0;
    for (const name of HQ_CLIPS) {
      const frames = Math.max(1, Math.round(HQ_CLIP_INFO[name].duration * HQ_CLIP_FPS));
      rows += frames + 1;
    }
    expect(rows).toBeLessThanOrEqual(ROW_BUDGET);
  });

  it("authors every clip on whole frames at 30 fps", () => {
    for (const name of HQ_CLIPS) {
      const frames = HQ_CLIP_INFO[name].duration * HQ_CLIP_FPS;
      expect(Math.abs(frames - Math.round(frames)), name).toBeLessThan(1e-6);
    }
  });
});
