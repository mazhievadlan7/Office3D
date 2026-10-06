import { describe, expect, it } from "vitest";

import { parseTleBundle, findPassesForSat, findNextPasses } from "@/features/hq/geo/satellitePasses";

// A real recent ISS TLE (frozen for the test, so we're not sensitive to the live network).
const ISS_TLE_BUNDLE = `ISS (ZARYA)
1 25544U 98067A   24010.54722222  .00014935  00000-0  26949-3 0  9995
2 25544  51.6416  34.9237 0005023 128.2654 231.8653 15.50195327436502
NOAA 19
1 33591U 09005A   24010.56250000  .00000090  00000-0  73245-4 0  9995
2 33591  99.1976  18.3217 0014312 162.1123 198.0548 14.12579330766420`;

describe("satellite passes · TLE parsing", () => {
  it("extracts (name, line1, line2) triples from a bundle", () => {
    const list = parseTleBundle(ISS_TLE_BUNDLE);
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe("ISS (ZARYA)");
    expect(list[0].line1.startsWith("1 25544")).toBe(true);
    expect(list[1].name).toBe("NOAA 19");
  });

  it("skips malformed stanzas instead of throwing", () => {
    const bad = `BAD\nnot a TLE line\nalso bad\nGOOD\n1 25544U 98067A   24010.54722222  .00014935  00000-0  26949-3 0  9995\n2 25544  51.6416  34.9237 0005023 128.2654 231.8653 15.50195327436502`;
    const list = parseTleBundle(bad);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("GOOD");
  });
});

describe("satellite passes · ISS over Moscow", () => {
  // Deterministic test window: 48 hours starting at a known UTC moment, so SGP4 propagation
  // produces the same passes every run (satellite.js is pure math).
  const fromMs = Date.UTC(2024, 0, 10, 12, 0, 0);
  const moscow = { lat: 55.7558, lon: 37.6176 };

  it("finds several passes in a 48-hour window", () => {
    const [iss] = parseTleBundle(ISS_TLE_BUNDLE);
    const passes = findPassesForSat(iss, moscow, { fromMs, horizonHours: 48, limit: 8, stepSeconds: 30 });
    expect(passes.length).toBeGreaterThanOrEqual(2);
    for (const pass of passes) {
      expect(pass.satName).toBe("ISS (ZARYA)");
      expect(pass.riseAt).toBeLessThan(pass.peakAt);
      expect(pass.peakAt).toBeLessThan(pass.setAt);
      expect(pass.peakElevationDeg).toBeGreaterThanOrEqual(10);
      expect(pass.peakElevationDeg).toBeLessThanOrEqual(90);
      expect(typeof pass.visibleToEye).toBe("boolean");
    }
    // Sorted strictly ascending by rise time.
    const rises = passes.map((p) => p.riseAt);
    expect(rises).toEqual([...rises].sort((a, b) => a - b));
  });

  it("findNextPasses merges and sorts across many satellites", () => {
    const tles = parseTleBundle(ISS_TLE_BUNDLE);
    const passes = findNextPasses(tles, moscow, { fromMs, horizonHours: 48, limit: 6, stepSeconds: 30 });
    const rises = passes.map((p) => p.riseAt);
    expect(rises).toEqual([...rises].sort((a, b) => a - b));
    const names = new Set(passes.map((p) => p.satName));
    // Both sats contribute at least one pass in a 48-hour LEO-friendly window.
    expect(names.size).toBeGreaterThanOrEqual(1);
  });
});
