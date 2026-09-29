// @vitest-environment node
import { describe, expect, it } from "vitest";

const { RING_SIZE, createMemoryMonitor, memoryLevel } = await import("../../server/maintenance/memory.js");

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const heapLimit = 4 * GiB;

describe("maintenance memory levels", () => {
  it("uses the dev thresholds", () => {
    expect(memoryLevel({ rss: 1.5 * GiB, heapUsed: GiB, heapLimit }, true)).toEqual({ level: "ok", recommendation: null });
    expect(memoryLevel({ rss: 2.5 * GiB, heapUsed: GiB, heapLimit }, true)).toEqual({ level: "elevated", recommendation: null });
    expect(memoryLevel({ rss: 3.2 * GiB, heapUsed: GiB, heapLimit }, true)).toEqual({
      level: "high",
      recommendation: "restart-dev-server",
    });
    // The heap near its limit is high whatever the rss.
    expect(memoryLevel({ rss: GiB, heapUsed: 0.85 * heapLimit, heapLimit }, true)).toEqual({
      level: "high",
      recommendation: "restart-dev-server",
    });
  });

  it("uses the production thresholds", () => {
    expect(memoryLevel({ rss: 500 * MiB, heapUsed: 100 * MiB, heapLimit }, false).level).toBe("ok");
    expect(memoryLevel({ rss: 1 * GiB, heapUsed: 100 * MiB, heapLimit }, false).level).toBe("elevated");
    expect(memoryLevel({ rss: 1.6 * GiB, heapUsed: 100 * MiB, heapLimit }, false)).toEqual({
      level: "high",
      recommendation: "possible-leak",
    });
  });
});

describe("maintenance memory monitor", () => {
  const monitorWith = (dev: boolean, rssAt: (t: number) => number) => {
    let t = 1_000_000;
    const monitor = createMemoryMonitor({
      dev,
      now: () => t,
      read: () => ({ rss: rssAt(t), heapUsed: 100 * MiB, heapLimit, external: 1, arrayBuffers: 2 }),
    });
    return {
      monitor,
      advance: (ms: number) => {
        t += ms;
      },
    };
  };

  it("fits the trend in MB per hour", () => {
    // +10 MiB a minute = +600 MB/h.
    const { monitor, advance } = monitorWith(true, (t) => GiB + ((t - 1_000_000) / 60_000) * 10 * MiB);
    let last = monitor.sample();
    for (let i = 0; i < 30; i += 1) {
      advance(60_000);
      last = monitor.sample();
    }
    expect(last.trendMbPerHour).toBeCloseTo(600, 0);
    expect(last).toMatchObject({ heapUsed: 100 * MiB, heapLimit, external: 1, arrayBuffers: 2, level: "ok" });
  });

  it("reports no trend from too few samples or too short a span", () => {
    const { monitor, advance } = monitorWith(false, (t) => t * 1000);
    monitor.sample();
    advance(60_000);
    expect(monitor.sample().trendMbPerHour).toBe(0);
    for (let i = 0; i < 5; i += 1) {
      advance(1000);
      monitor.sample();
    }
    expect(monitor.current().trendMbPerHour).toBe(0);
  });

  it("is flat for flat memory and keeps a ring of a day", () => {
    const { monitor, advance } = monitorWith(true, () => GiB);
    for (let i = 0; i < RING_SIZE + 50; i += 1) {
      monitor.sample();
      advance(60_000);
    }
    expect(monitor.size).toBe(RING_SIZE);
    expect(monitor.current().trendMbPerHour).toBe(0);
  });

  it("recommends a restart in dev when high", () => {
    const { monitor } = monitorWith(true, () => 3.5 * GiB);
    expect(monitor.sample()).toMatchObject({ level: "high", recommendation: "restart-dev-server" });
  });
});
