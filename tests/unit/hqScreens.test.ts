import { describe, expect, it } from "vitest";
import { Vector3 } from "three";

import { HQ_CAPACITIES } from "@/features/hq/core/config";
import { generateHqLayout } from "@/features/hq/core/layout";
import { HQ_ROLE_FAMILY, HQ_ROLE_FAMILY_COUNT, hqRoleFamily } from "@/features/hq/core/roles";
import { HQ_WALL_SCREEN } from "@/features/hq/core/types";
import { mapDirection, subsolarPoint, sunDirection } from "@/features/hq/render/map/sun";
import { APP_LAYER, HQ_SCREEN_APPS, packDeskState, screenAppsGlsl } from "@/features/hq/render/screens/screenApps";
import { buildEarthLevels, greatCircle, projectGlobe } from "@/features/hq/render/screens/screenGlobe";
import { APP_PAINTERS, EMPTY_FEED, type HqScreenFeed } from "@/features/hq/render/screens/screenPaint";
import {
  EXCHANGES,
  candles,
  city,
  cityTime,
  dayPhase,
  exchangeState,
  indexSeries,
  newsStories,
  newsTicker,
  sunElevation,
} from "@/features/hq/render/screens/screenStories";
import { SCREEN_SURFACES, WALL_LAYERS, surfacePeriod } from "@/features/hq/render/screens/screenSurfaces";
import { SCREEN_VIEW_DISTANCE, anchorFacing, screenAnchors } from "@/features/hq/render/screens/screenViews";

describe("desk monitors", () => {
  it("maps roles, in English or Russian, to what their monitors show", () => {
    expect(hqRoleFamily("Builder")).toBe(HQ_ROLE_FAMILY.builder);
    expect(hqRoleFamily("Разработка")).toBe(HQ_ROLE_FAMILY.builder);
    expect(hqRoleFamily("Исследования")).toBe(HQ_ROLE_FAMILY.research);
    expect(hqRoleFamily("Аналитика")).toBe(HQ_ROLE_FAMILY.analyst);
    expect(hqRoleFamily("Данные")).toBe(HQ_ROLE_FAMILY.analyst);
    expect(hqRoleFamily("Дизайн")).toBe(HQ_ROLE_FAMILY.design);
    expect(hqRoleFamily("DevOps-инженер")).toBe(HQ_ROLE_FAMILY.devops);
    expect(hqRoleFamily("Тестирование")).toBe(HQ_ROLE_FAMILY.qa);
    expect(hqRoleFamily("Поддержка")).toBe(HQ_ROLE_FAMILY.writer);
    expect(hqRoleFamily(null)).toBe(HQ_ROLE_FAMILY.generic);
    expect(hqRoleFamily("Astronaut")).toBe(HQ_ROLE_FAMILY.generic);
  });

  it("has a painter for every app layer", () => {
    for (const app of HQ_SCREEN_APPS) expect(typeof APP_PAINTERS[app], app).toBe("function");
    expect(Object.keys(APP_PAINTERS)).toHaveLength(HQ_SCREEN_APPS.length);
  });

  it("packs a desk's status and role family into one float the shader can unpack", () => {
    const unpack = (packed: number) => {
      const family = Math.floor((packed + 1) / 8);
      return [packed - 8 * family, family];
    };
    expect(packDeskState(-1, 5)).toBe(-1);
    expect(unpack(-1)).toEqual([-1, 0]);
    for (let family = 0; family < HQ_ROLE_FAMILY_COUNT; family++) {
      for (const status of [0, 1, 2]) expect(unpack(packDeskState(status, family))).toEqual([status, family]);
    }
  });

  it("gives every family a full table of app layers for the three monitors", () => {
    const glsl = screenAppsGlsl();
    const table = /HQ_APP_TABLE\[(\d+)\] = int\[\d+\]\(([^)]*)\)/.exec(glsl);
    expect(table).not.toBeNull();
    const values = table![2].split(",").map((v) => Number(v.trim()));
    expect(values).toHaveLength(Number(table![1]));
    expect(values).toHaveLength(HQ_ROLE_FAMILY_COUNT * 3 * 4);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(HQ_SCREEN_APPS.length);
    }
    // Builders code on the centre monitor.
    const centre = values.slice((HQ_ROLE_FAMILY.builder * 3 + 1) * 4, (HQ_ROLE_FAMILY.builder * 3 + 2) * 4);
    for (const v of centre) expect([APP_LAYER.code_ts, APP_LAYER.code_py]).toContain(v);
  });
});

describe("the map's real-time day and night", () => {
  it("turns longitude/latitude into the shader's unit vectors", () => {
    expect(mapDirection(0, 0, new Vector3()).distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-9);
    expect(mapDirection(0, 90, new Vector3()).distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-9);
    expect(mapDirection(90, 0, new Vector3()).distanceTo(new Vector3(0, 0, 1))).toBeLessThan(1e-9);
  });

  it("lights Moscow at noon and darkens it at midnight", () => {
    const moscow = mapDirection(37.62, 55.76, new Vector3());
    // 12:00 in Moscow is 09:00 UTC; midnight there is 21:00 UTC.
    expect(moscow.dot(sunDirection(Date.UTC(2026, 8, 25, 9, 0), new Vector3()))).toBeGreaterThan(0.4);
    expect(moscow.dot(sunDirection(Date.UTC(2026, 8, 25, 21, 0), new Vector3()))).toBeLessThan(-0.4);
  });

  it("puts the Sun where it really is", () => {
    const solstice = subsolarPoint(Date.UTC(2026, 5, 21, 12, 0));
    expect(solstice.lat).toBeCloseTo(23.44, 0);
    expect(Math.abs(solstice.lon)).toBeLessThan(1.5);
    const equinox = subsolarPoint(Date.UTC(2026, 2, 20, 18, 0));
    expect(Math.abs(equinox.lat)).toBeLessThan(0.6);
    // 18:00 UTC: the Sun is overhead near 90 degrees west.
    expect(equinox.lon).toBeGreaterThan(-93);
    expect(equinox.lon).toBeLessThan(-87);
    const december = subsolarPoint(Date.UTC(2026, 11, 21, 0, 0));
    expect(december.lat).toBeCloseTo(-23.44, 0);
    expect(Math.abs(Math.abs(december.lon) - 180)).toBeLessThan(2.5);
  });
});

describe("wall screens", () => {
  it("puts the news on the first lounge TV and business on the second", () => {
    const layout = generateHqLayout(300);
    const office = layout.am7Office;
    const inOffice = (p: { x: number; z: number }) => p.x >= office.x0 && p.x <= office.x1 && p.z >= office.z0 && p.z <= office.z1;
    const lounge = layout.props.filter((p) => p.kind === "wall_screen" && !inOffice(p));
    expect(lounge.map((p) => p.screen).slice(0, 2)).toEqual([HQ_WALL_SCREEN.news, HQ_WALL_SCREEN.markets]);
  });

  for (const capacity of HQ_CAPACITIES) {
    it(`shows AM7's report in his office and different channels in the lounge (${capacity})`, () => {
      const layout = generateHqLayout(capacity);
      const screens = layout.props.filter((p) => p.kind === "wall_screen");
      const office = layout.am7Office;
      const inOffice = screens.filter((p) => p.x >= office.x0 && p.x <= office.x1 && p.z >= office.z0 && p.z <= office.z1);
      expect(inOffice).toHaveLength(1);
      expect(inOffice[0].screen).toBe(HQ_WALL_SCREEN.exec);
      const lounge = screens.filter((p) => !inOffice.includes(p));
      expect(lounge.length).toBeGreaterThanOrEqual(capacity === 100 ? 1 : 2);
      for (const p of lounge) expect(p.screen).not.toBe(HQ_WALL_SCREEN.exec);
      // Neighbours differ.
      for (let i = 1; i < lounge.length; i++) expect(lounge[i].screen).not.toBe(lounge[i - 1].screen);
    });
  }
});

// --- the big screens' content -------------------------------------------------------------------
const NOW = Date.UTC(2026, 8, 25, 18, 36, 15); // a Friday: 21:36 in Moscow, 14:36 in New York

function feedOf(over: Partial<HqScreenFeed> = {}): HqScreenFeed {
  return {
    ...EMPTY_FEED,
    clock: NOW,
    total: 300,
    working: 211,
    idle: 83,
    error: 6,
    names: ["Nova", "Vex"],
    history: Array.from({ length: 120 }, (_, i) => (i < 60 ? 0.6 : 0.7)),
    teams: [
      { total: 10, working: 5, error: 0, workingAgo: 5 },
      { total: 0, working: 0, error: 0, workingAgo: 0 },
      { total: 40, working: 36, error: 1, workingAgo: 30 },
    ],
    ...over,
  };
}

describe("the news channel's rundown", () => {
  it("waits for agents when the floor is empty", () => {
    const stories = newsStories({ ...EMPTY_FEED, clock: NOW });
    expect(stories).toHaveLength(1);
    expect(stories[0].title).toMatch(/ожидает подключения/);
  });

  it("leads with a fresh error, then the state of the floor, in proper Russian", () => {
    const stories = newsStories(feedOf({ events: [{ at: NOW - 5000, name: "Vex", status: 2 }] }));
    expect(stories[0]).toMatchObject({ tag: "СРОЧНО", hot: true });
    expect(stories[0].title).toContain("Vex");
    expect(stories.find((s) => s.tag === "ГЛАВНОЕ")?.title).toBe("В штабе 211 агентов в работе из 300");
    expect(newsStories(feedOf({ working: 21 })).find((s) => s.tag === "ГЛАВНОЕ")?.title).toBe("В штабе 21 агент в работе из 300");
    // The minute's trend, from the per-second history.
    expect(stories.find((s) => s.tag === "ДИНАМИКА")?.title).toMatch(/выросла/);
    // The busiest staffed department.
    expect(stories.find((s) => s.tag === "ОТДЕЛЫ")?.title).toContain("Разработка");
    // Old errors are not breaking news any more.
    expect(newsStories(feedOf({ events: [{ at: NOW - 600_000, name: "Vex", status: 2 }] }))[0].tag).not.toBe("СРОЧНО");
  });

  it("keys a breaking story by its event, so the channel airs it once", () => {
    const event = { at: NOW - 5000, name: "Vex", status: 2 };
    const first = newsStories(feedOf({ events: [event] }))[0];
    // The error count moving on does not make it a new story.
    expect(newsStories(feedOf({ events: [event], error: 7 }))[0].key).toBe(first.key);
    expect(newsStories(feedOf({ events: [{ ...event, at: NOW - 1000 }] }))[0].key).not.toBe(first.key);
    expect(newsStories(feedOf()).some((s) => s.key !== undefined)).toBe(false);
  });

  it("reports a floor without errors as such", () => {
    const stories = newsStories(feedOf({ error: 0 }));
    expect(stories.some((s) => s.title === "Штаб работает без ошибок")).toBe(true);
    expect(stories.some((s) => s.hot)).toBe(false);
  });

  it("fills the ticker with the floor's numbers, the latest moves and world time", () => {
    const items = newsTicker(feedOf({ events: [{ at: NOW - 2000, name: "Nova", status: 0 }] }));
    expect(items.slice(0, 4)).toEqual(["В РАБОТЕ 211", "ОЖИДАЮТ 83", "ОШИБКИ 6", "ЗАГРУЗКА 70%"]);
    expect(items.some((i) => i.startsWith("Nova: в работе"))).toBe(true);
    expect(items).toContain("МОСКВА 21:36");
  });
});

describe("world time and exchanges", () => {
  it("knows local times, daylight saving included", () => {
    expect(cityTime(city("Москва"), NOW).text).toBe("21:36");
    expect(cityTime(city("Нью-Йорк"), NOW).text).toBe("14:36"); // EDT, UTC-4
    expect(cityTime(city("Токио"), NOW)).toMatchObject({ text: "03:36", weekday: 6 });
  });

  it("puts day and night where the Sun really is", () => {
    const ny = city("Нью-Йорк");
    const tokyo = city("Токио");
    expect(dayPhase(sunElevation(ny.lon, ny.lat, NOW))).toBe("day");
    expect(dayPhase(sunElevation(tokyo.lon, tokyo.lat, NOW))).toBe("night");
  });

  it("opens and closes exchanges on their real schedules", () => {
    const byCode = (code: string) => EXCHANGES.find((e) => e.code === code)!;
    // Friday 14:36 in New York: open, closing at 16:00.
    expect(exchangeState(byCode("NYSE"), NOW)).toMatchObject({ open: true, minutes: 84 });
    // Friday 21:36 in Moscow: closed until Monday 10:00.
    expect(exchangeState(byCode("MOEX"), NOW)).toMatchObject({ open: false, minutes: 3 * 1440 - (21 * 60 + 36) + 600 });
    // Tokyo's lunch break: closed at 12:00 local, reopening at 12:30.
    const lunch = Date.UTC(2026, 8, 24, 3, 0); // Thursday 12:00 JST
    expect(exchangeState(byCode("TSE"), lunch)).toMatchObject({ open: false, minutes: 30 });
  });
});

describe("the business channel's index", () => {
  it("tracks the working share in points and groups it into candles", () => {
    const values = indexSeries(feedOf(), 60);
    expect(values).toHaveLength(60);
    for (const v of values) expect(Math.abs(v - 70)).toBeLessThan(0.6);
    const bars = candles(values, 6);
    expect(bars).toHaveLength(10);
    for (const b of bars) {
      expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
      expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
    }
    // Without history it still has a price.
    expect(indexSeries(feedOf({ history: [] }), 60)).toHaveLength(1);
  });

  it("holds its chart still between feeds and scrolls it by one sample per feed", () => {
    const history = Array.from({ length: 90 }, (_, i) => 0.6 + 0.1 * Math.sin(i / 7));
    const now = indexSeries(feedOf({ history, sample: 500 }), 60);
    // The clock ticks on between feeds (the worker paints with the wall clock): same chart.
    expect(indexSeries(feedOf({ history, sample: 500, clock: NOW + 700 }), 60)).toEqual(now);
    // The next feed brings one more sample: everything moves one step left.
    const next = indexSeries(feedOf({ history: [...history.slice(1), 0.65], sample: 501 }), 60);
    for (let i = 0; i < 59; i++) expect(next[i]).toBeCloseTo(now[i + 1], 9);
  });
});

describe("the Earth on the screens", () => {
  it("projects with north up and east to the right", () => {
    const centre = projectGlobe(40, 0, 40, 0, 1, 100);
    expect(centre.x).toBeCloseTo(0, 6);
    expect(centre.y).toBeCloseTo(0, 6);
    expect(centre.z).toBeCloseTo(1, 6);
    expect(projectGlobe(70, 0, 40, 0, 1, 100).x).toBeGreaterThan(0);
    expect(projectGlobe(40, 30, 40, 0, 1, 100).y).toBeLessThan(0);
    expect(projectGlobe(220, 0, 40, 0, 1, 100).z).toBeCloseTo(-1, 6);
  });

  it("follows great circles between cities", () => {
    const route = greatCircle(0, 0, 90, 0, 4);
    expect(route).toHaveLength(5);
    expect(route[2][0]).toBeCloseTo(45, 6);
    expect(route[2][1]).toBeCloseTo(0, 6);
  });

  it("tells sea from land in the day map and builds smaller levels", () => {
    const w = 512;
    const h = 256;
    const day = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) day.set(i % w < w / 2 ? [10, 30, 90, 255] : [120, 110, 80, 255], i * 4);
    const levels = buildEarthLevels(day, null, w, h);
    expect(levels.map((l) => l.w)).toEqual([512, 256]);
    expect(levels[0].water[0]).toBe(1);
    expect(levels[0].water[w - 1]).toBe(0);
    expect(levels[0].day[w - 1]).toBeGreaterThan(levels[0].day[0]);
    expect(levels[0].night.every((v) => v === 0)).toBe(true);
  });
});

describe("repainting the big screens only while they are seen", () => {
  it("anchors every wall screen and AM7's monitor to what it shows", () => {
    const layout = generateHqLayout(300);
    const anchors = screenAnchors(layout.props);
    expect(anchors.get("execWall")).toHaveLength(1);
    expect(anchors.get("news")?.length).toBeGreaterThanOrEqual(1);
    expect(anchors.get("markets")?.length).toBeGreaterThanOrEqual(1);
    expect(anchors.get("exec")).toHaveLength(1);
    const tv = anchors.get("news")![0];
    const at = (d: number) => [tv.x + tv.nx! * d, 1.6, tv.z + tv.nz! * d] as const;
    // In front of the screen and close: facing; behind the wall or far away: not.
    expect(anchorFacing(tv, ...at(4))).toBe(true);
    expect(anchorFacing(tv, ...at(-4))).toBe(false);
    expect(anchorFacing(tv, ...at(SCREEN_VIEW_DISTANCE + 5))).toBe(false);
  });

  it("gives every wall channel a view and slows it down only when out of view", () => {
    const walls = SCREEN_SURFACES.filter((s) => s.target.kind === "layer" && s.target.set === "walls");
    expect(walls).toHaveLength(WALL_LAYERS);
    for (const s of walls) {
      expect(s.view).toBeDefined();
      expect(surfacePeriod(s, true)).toBe(s.period);
      expect(surfacePeriod(s, false)).toBeGreaterThan(s.period);
    }
    // The news runs at a broadcast-like rate while watched.
    expect(walls[HQ_WALL_SCREEN.news].period).toBeLessThanOrEqual(1 / 15);
    // The map panels have no view to track and always repaint at their rate.
    for (const s of SCREEN_SURFACES.filter((x) => x.target.kind === "single" && x.target.id !== "exec")) {
      expect(surfacePeriod(s, false)).toBe(s.period);
    }
  });
});
