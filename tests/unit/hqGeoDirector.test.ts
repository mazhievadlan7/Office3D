import { describe, expect, it } from "vitest";

import { newTour, tourFromJson, tourToJson, type DirectorTour } from "@/features/hq/geo/director";

describe("director · tour construction", () => {
  it("newTour returns a usable empty tour", () => {
    const t = newTour("Полёт над Гималаями");
    expect(t.name).toBe("Полёт над Гималаями");
    expect(t.frames).toEqual([]);
    expect(t.id).toMatch(/^tour_/);
    expect(typeof t.recordedAt).toBe("number");
  });

  it("newTour falls back to a stub name on empty input", () => {
    expect(newTour("").name).toBe("Безымянный тур");
    expect(newTour("   ").name).toBe("Безымянный тур");
  });
});

describe("director · json round-trip", () => {
  const sample: DirectorTour = {
    id: "tour_1",
    name: "Орбитальный тур",
    recordedAt: 1_720_000_000_000,
    frames: [
      { lat: 55.7558, lon: 37.6176, height: 2_000_000, heading: 10, pitch: -55, seconds: 3, caption: "Москва" },
      { lat: 28, lon: 85.5, height: 2_200_000, seconds: 4, caption: "Гималаи" },
      { lat: -33.9, lon: 151.2, height: 1_500_000, heading: 0, pitch: -90, seconds: 2.5 },
    ],
  };

  it("tourToJson + tourFromJson round-trips the structure", () => {
    const json = tourToJson(sample);
    const back = tourFromJson(json);
    expect(back).not.toBeNull();
    expect(back!.name).toBe(sample.name);
    expect(back!.frames).toHaveLength(sample.frames.length);
    expect(back!.frames[0]).toEqual(sample.frames[0]);
    expect(back!.frames[2].caption).toBeUndefined();
  });

  it("tourFromJson refuses invalid payloads with null", () => {
    expect(tourFromJson("not json at all")).toBeNull();
    // No frames field → null (we don't accept a tour without a frames array).
    expect(tourFromJson("{}")).toBeNull();
    // Explicit empty frames array is accepted.
    expect(tourFromJson('{"frames":[]}')).toEqual(expect.objectContaining({ frames: [] }));
  });

  it("tourFromJson drops a frame missing required fields", () => {
    const partial = `{"name":"X","frames":[{"lat":55,"lon":37,"height":1000,"seconds":2},{"lat":"bad","lon":37,"height":1000,"seconds":2}]}`;
    const back = tourFromJson(partial);
    expect(back?.frames).toHaveLength(1);
  });
});
