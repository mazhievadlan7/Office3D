import { afterEach, describe, expect, it } from "vitest";

import { zoneAt } from "@/features/hq/core/hqLocationZone";
import {
  HQ_DEFAULT_TIME_ZONE,
  hqTimeZone,
  hqUtcOffsetLabel,
  hqUtcOffsetMinutes,
  hqWallClock,
  setHqTimeZone,
} from "@/features/hq/core/hqTime";
import { clockText } from "@/features/hq/render/screens/screenPaint";
import { hhmm, longDate } from "@/features/hq/render/screens/screenStories";

describe("the HQ's time", () => {
  // 23:30:15 UTC on a Friday is already Saturday in Moscow.
  const ms = Date.UTC(2026, 8, 25, 23, 30, 15);

  afterEach(() => {
    setHqTimeZone(HQ_DEFAULT_TIME_ZONE);
  });

  it("is Moscow time until the location is known, whatever the device's zone", () => {
    expect(hqTimeZone()).toBe("Europe/Moscow");
    expect(hqUtcOffsetMinutes(ms)).toBe(180);
    expect(hqUtcOffsetLabel(ms)).toBe("UTC+3");
    const wall = hqWallClock(ms);
    expect([wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds()]).toEqual([2, 30, 15]);
    expect(wall.getUTCDay()).toBe(6);
  });

  it("is what the screens show", () => {
    expect(clockText(ms)).toBe("02:30:15");
    expect(hhmm(ms)).toBe("02:30");
    expect(longDate(ms)).toBe("суббота, 26 сентября");
  });

  it("follows a new zone at once and ignores unknown ones", () => {
    expect(setHqTimeZone("America/New_York")).toBe(true);
    expect(hqUtcOffsetLabel(ms)).toBe("UTC−4");
    expect(clockText(ms)).toBe("19:30:15");
    expect(setHqTimeZone("Not/A_Zone")).toBe(false);
    expect(hqTimeZone()).toBe("America/New_York");
  });

  it("finds the zone of a position offline", async () => {
    expect(await zoneAt(55.7558, 37.6173)).toBe("Europe/Moscow");
    expect(await zoneAt(52.52, 13.405)).toBe("Europe/Berlin");
    expect(await zoneAt(43.2389, 76.8897)).toMatch(/^Asia\/(Almaty|Qostanay)$/);
  });
});
