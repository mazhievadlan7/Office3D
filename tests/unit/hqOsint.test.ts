import { describe, expect, it } from "vitest";

import { geoController } from "@/features/hq/geo/geoController";
import { osintController } from "@/features/hq/osint/osintController";
import { DEMO_OSINT } from "@/features/hq/osint/demoData";
import { layoutGraph } from "@/features/hq/osint/graphLayout";
import { OSINT_TOOLS } from "@/features/hq/osint/tools";

describe("osintController", () => {
  it("serves data and notifies subscribers on setData", () => {
    const seen: Array<string | null> = [];
    const unsubscribe = osintController.subscribe((data) => seen.push(data?.engagement.id ?? null));
    osintController.setData(DEMO_OSINT);
    unsubscribe();

    expect(osintController.getData()).toBe(DEMO_OSINT);
    expect(seen).toContain("ENG-OSINT-DEMO");
  });

  it("projects geolocated entities onto the shared globe, once per dataset", () => {
    osintController.setData(DEMO_OSINT);
    const afterFirst = geoController.getScene();
    const geoEntities = DEMO_OSINT.entities.filter((entity) => entity.geo !== undefined);

    // One HQ anchor + one target per geolocated entity; one arc per entity.
    expect(afterFirst.targets.length).toBe(geoEntities.length + 1);
    expect(afterFirst.arcs.length).toBe(geoEntities.length);
    expect(afterFirst.targets.some((target) => target.kind === "hq")).toBe(true);

    // Re-applying the SAME dataset must not stack duplicate pins/arcs.
    osintController.setData(DEMO_OSINT);
    const afterSecond = geoController.getScene();
    expect(afterSecond.targets.length).toBe(afterFirst.targets.length);
    expect(afterSecond.arcs.length).toBe(afterFirst.arcs.length);
  });

  it("flies the globe only to entities that have a geolocation", () => {
    osintController.setData(DEMO_OSINT);
    expect(osintController.flyToEntity("host-10")).toBe(true);
    expect(osintController.flyToEntity("dom-example")).toBe(false);
    expect(osintController.flyToEntity("does-not-exist")).toBe(false);
  });
});

describe("demo dataset integrity", () => {
  it("references only entities and tools that exist", () => {
    const entityIds = new Set(DEMO_OSINT.entities.map((entity) => entity.id));
    const toolIds = new Set(OSINT_TOOLS.map((tool) => tool.id));

    for (const relation of DEMO_OSINT.relations) {
      expect(entityIds.has(relation.from)).toBe(true);
      expect(entityIds.has(relation.to)).toBe(true);
    }
    for (const finding of DEMO_OSINT.findings) {
      expect(toolIds.has(finding.sourceToolId)).toBe(true);
      if (finding.entityId) expect(entityIds.has(finding.entityId)).toBe(true);
    }
  });
});

describe("graphLayout", () => {
  it("places every entity and is deterministic for the same input", () => {
    const a = layoutGraph(DEMO_OSINT.entities, DEMO_OSINT.relations);
    const b = layoutGraph(DEMO_OSINT.entities, DEMO_OSINT.relations);

    expect(a.nodes.length).toBe(DEMO_OSINT.entities.length);
    expect(a.width).toBeGreaterThan(0);
    expect(a.height).toBeGreaterThan(0);
    for (const node of a.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
    // Deterministic: same seed, same positions.
    expect(b.nodes).toEqual(a.nodes);
  });

  it("handles an empty graph", () => {
    const empty = layoutGraph([], []);
    expect(empty.nodes).toEqual([]);
    expect(empty.width).toBeGreaterThan(0);
  });
});
