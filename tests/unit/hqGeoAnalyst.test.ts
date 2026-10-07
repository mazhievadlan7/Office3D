import { describe, expect, it } from "vitest";
import * as Cesium from "cesium";

import { askAnalyst } from "@/features/hq/geo/analyst";

/**
 * These tests build a bare Cesium viewer-like shim with just the data-sources
 * API the analyst touches. No WebGL, no DOM — we only need getByName() returning
 * a CustomDataSource whose entities are populated with position + properties.
 */

function makeEntity(id: string, lat: number, lon: number, props: Record<string, unknown>): Cesium.Entity {
  return new Cesium.Entity({
    id,
    position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
    properties: props,
  });
}

function makeFakeViewer(sources: Record<string, Cesium.Entity[]>): Cesium.Viewer {
  // Minimal shim: only dataSources.getByName + isDestroyed are needed by the analyst.
  const dataSources = {
    getByName(name: string) {
      const list = sources[name];
      if (!list) return [];
      const ds = new Cesium.CustomDataSource(name);
      for (const entity of list) ds.entities.add(entity);
      return [ds];
    },
  };
  return {
    dataSources,
    isDestroyed: () => false,
  } as unknown as Cesium.Viewer;
}

describe("analyst · counts and nouns", () => {
  it("answers «сколько рейсов»", () => {
    const viewer = makeFakeViewer({
      "hq-geo-flights": [makeEntity("f1", 10, 20, {}), makeEntity("f2", 30, 40, {})],
    });
    const a = askAnalyst(viewer, "сколько рейсов");
    expect(a.text).toContain("2");
    expect(a.hits).toHaveLength(2);
  });

  it("hints when the question doesn't match any noun", () => {
    const viewer = makeFakeViewer({});
    const a = askAnalyst(viewer, "что происходит");
    expect(a.text).toMatch(/Не узнал/);
    expect(a.hits).toEqual([]);
  });

  it("empty input returns the usage hint without crashing", () => {
    const viewer = makeFakeViewer({});
    const a = askAnalyst(viewer, "");
    expect(a.text).toMatch(/например/);
  });
});

describe("analyst · comparison filters", () => {
  it("counts earthquakes stronger than 5", () => {
    const viewer = makeFakeViewer({
      "hq-geo-earthquakes": [
        makeEntity("eq1", 10, 20, { magnitude: 3.2 }),
        makeEntity("eq2", 10, 20, { magnitude: 5.4 }),
        makeEntity("eq3", 10, 20, { magnitude: 6.1 }),
      ],
    });
    const a = askAnalyst(viewer, "землетрясения сильнее 5");
    expect(a.text).toContain("2");
    expect(a.hits.map((h) => h.id).sort()).toEqual(["eq2", "eq3"]);
  });

  it("counts dams larger than 5000 МВт", () => {
    const viewer = makeFakeViewer({
      "hq-geo-dams": [
        makeEntity("d1", 0, 0, { capacityMW: 2080 }),
        makeEntity("d2", 0, 0, { capacityMW: 14000 }),
        makeEntity("d3", 0, 0, { capacityMW: 22500 }),
      ],
    });
    const a = askAnalyst(viewer, "плотины мощнее 5000 МВт");
    expect(a.text).toContain("2");
    expect(a.hits.map((h) => h.id).sort()).toEqual(["d2", "d3"]);
  });
});

describe("analyst · nearest-from-place", () => {
  it("picks the closest satellite from Moscow", () => {
    const viewer = makeFakeViewer({
      "hq-geo-satellites": [
        makeEntity("far", -33.9, 151.2, { name: "SYDNEY-SAT" }), // Sydney, far from Moscow
        makeEntity("near", 55.8, 37.6, { name: "NEAR-SAT" }), // Right over Moscow
        makeEntity("mid", 48.9, 2.35, { name: "PARIS-SAT" }), // Paris
      ],
    });
    const a = askAnalyst(viewer, "ближайший спутник от Москвы");
    expect(a.hits[0].title).toBe("NEAR-SAT");
    expect(a.text).toContain("NEAR-SAT");
    expect(a.hits[0].valueUnit).toBe("км");
  });
});
