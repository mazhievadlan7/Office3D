import { describe, expect, it } from "vitest";
import { Vector3 } from "three";

import { HQ_CAPACITIES } from "@/features/hq/core/config";
import { generateHqLayout } from "@/features/hq/core/layout";
import { HQ_ROLE_FAMILY, HQ_ROLE_FAMILY_COUNT, hqRoleFamily } from "@/features/hq/core/roles";
import { HQ_WALL_SCREEN } from "@/features/hq/core/types";
import { globeDirection, subsolarPoint } from "@/features/hq/render/map/globeShaders";
import { APP_LAYER, HQ_SCREEN_APPS, packDeskState, screenAppsGlsl } from "@/features/hq/render/screens/screenApps";
import { APP_PAINTERS } from "@/features/hq/render/screens/screenPaint";

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

describe("the globe", () => {
  it("places longitude/latitude like three's SphereGeometry UVs", () => {
    expect(globeDirection(0, 0).distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-9);
    expect(globeDirection(0, 90).distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-9);
    expect(globeDirection(90, 0).distanceTo(new Vector3(0, 0, -1))).toBeLessThan(1e-9);
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

  it("floats the globe in front of the map wall's centre, clear of the watchers", () => {
    const layout = generateHqLayout(300);
    const { globe } = layout.mapWall;
    expect(globe.x).toBeCloseTo(layout.mapWall.x);
    expect(globe.z - globe.radius).toBeGreaterThan(layout.mapWall.z + 0.1);
    for (const spot of layout.socialSpots.filter((s) => s.kind === "map")) {
      const d = Math.hypot(spot.x - globe.x, spot.z - globe.z);
      expect(d, `map spot at ${spot.x},${spot.z}`).toBeGreaterThan(globe.radius + 0.9);
    }
  });
});
