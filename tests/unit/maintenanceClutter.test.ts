// @vitest-environment node
import { describe, expect, it } from "vitest";

const { FULL_BYTES, FULL_ITEMS, clutterLevel, fullBytesFor, summarizeClutter } = await import(
  "../../server/maintenance/clutter.js"
);

const MiB = 1024 * 1024;

describe("maintenance clutter level", () => {
  it("is 0 when nothing is reclaimable", () => {
    expect(clutterLevel({ bytes: 0, items: 0 }, FULL_BYTES.dev)).toBe(0);
    expect(summarizeClutter([], true).level).toBe(0);
  });

  it("clamps to 1 and ignores junk", () => {
    expect(clutterLevel({ bytes: 10 * FULL_BYTES.dev, items: 0 }, FULL_BYTES.dev)).toBe(1);
    expect(clutterLevel({ bytes: 0, items: 99_999 }, FULL_BYTES.dev)).toBe(1);
    expect(clutterLevel({ bytes: -5, items: Number.NaN }, FULL_BYTES.dev)).toBe(0);
  });

  it("takes the larger of the byte and item ratios", () => {
    expect(clutterLevel({ bytes: 32 * MiB, items: 0 }, FULL_BYTES.dev)).toBe(0.5);
    expect(clutterLevel({ bytes: 32 * MiB, items: 1200 }, FULL_BYTES.dev)).toBe(0.8);
    expect(FULL_ITEMS).toBe(1500);
  });

  it("grows monotonically", () => {
    let previous = -1;
    for (let bytes = 0; bytes <= 80 * MiB; bytes += 4 * MiB) {
      const level = clutterLevel({ bytes, items: bytes / MiB }, FULL_BYTES.dev);
      expect(level).toBeGreaterThanOrEqual(previous);
      previous = level;
    }
    expect(previous).toBe(1);
  });

  it("fills four times faster in production", () => {
    expect(fullBytesFor(true)).toBe(64 * MiB);
    expect(fullBytesFor(false)).toBe(16 * MiB);
    const byTarget = [
      { id: "voice-temp", bytes: 8 * MiB, items: 1 },
      { id: "orphan-tmp", bytes: 0, items: 2 },
    ];
    expect(summarizeClutter(byTarget, true).level).toBe(0.125);
    const production = summarizeClutter(byTarget, false);
    expect(production).toEqual({
      level: 0.5,
      reclaimableBytes: 8 * MiB,
      reclaimableItems: 3,
      fullAtBytes: 16 * MiB,
      byTarget,
    });
  });
});
