import { describe, expect, it } from "vitest";

import { generateHqLayout } from "@/features/hq/core/layout";
import { buildIntroPath, HQ_INTRO_SECONDS, introCurveParam, sampleIntro } from "@/features/hq/render/scene/cameraIntro";
import { homePose } from "@/features/hq/render/scene/cameraMath";
import { Vector3 } from "three";

describe("the opening fly-through", () => {
  const layout = generateHqLayout(300);
  const path = buildIntroPath(layout, homePose(layout, 16 / 9));

  it("gives every leg between two shots a time weight", () => {
    expect(path.legWeights).toHaveLength(path.positions.points.length - 1);
    expect(path.targets.points).toHaveLength(path.positions.points.length);
    expect(path.duration).toBe(HQ_INTRO_SECONDS);
  });

  it("maps time onto the curves monotonically, from the first shot to the last", () => {
    expect(introCurveParam(path.legWeights, 0)).toBe(0);
    expect(introCurveParam(path.legWeights, 1)).toBeCloseTo(1, 9);
    let last = -1;
    for (let i = 0; i <= 200; i++) {
      const u = introCurveParam(path.legWeights, i / 200);
      expect(u).toBeGreaterThanOrEqual(last);
      last = u;
    }
    // A leg twice as heavy takes twice the time.
    expect(introCurveParam([1, 2], 1 / 3)).toBeCloseTo(0.5, 9);
  });

  it("pans behind AM7 between the island and the video wall, looking into the hall", () => {
    const office = layout.am7Office;
    const position = new Vector3();
    const target = new Vector3();
    let behind = 0;
    let seenEast = false;
    let seenWest = false;
    for (let s = 0; s <= HQ_INTRO_SECONDS; s += 0.1) {
      sampleIntro(path, s, position, target);
      const inStrip = position.z < office.z0 && position.z > layout.bounds.z0 + layout.mapWall.curve;
      if (inStrip && position.y > 6 && target.z > office.z1) {
        behind += 0.1;
        if (position.x > (office.x0 + office.x1) / 2 + 5) seenEast = true;
        if (position.x < (office.x0 + office.x1) / 2 - 5) seenWest = true;
      }
    }
    // Several seconds behind AM7, travelling from one side to the other.
    expect(behind).toBeGreaterThan(4);
    expect(seenEast && seenWest).toBe(true);
  });
});
