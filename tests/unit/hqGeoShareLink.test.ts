import { describe, expect, it } from "vitest";

import {
  buildShareHref,
  parseGeoState,
  readShareFromHash,
  serializeGeoState,
  type GeoShareState,
} from "@/features/hq/geo/shareLink";

describe("geo share-link serialization", () => {
  const sample: GeoShareState = {
    cam: { lat: 55.7558, lon: 37.6176, height: 1_200_000, heading: 92.3, pitch: -45.1 },
    basemap: "esri",
    style: "nvg",
    hud: true,
    passes: { lat: 48.8566, lon: 2.3522 },
    track: { lat: 25.0, lon: -80.0, title: "ISS (ZARYA)" },
  };

  it("round-trips every field within tolerance", () => {
    const encoded = serializeGeoState(sample);
    const decoded = parseGeoState(encoded);
    expect(decoded.basemap).toBe("esri");
    expect(decoded.style).toBe("nvg");
    expect(decoded.hud).toBe(true);
    expect(decoded.cam?.lat).toBeCloseTo(sample.cam!.lat, 3);
    expect(decoded.cam?.lon).toBeCloseTo(sample.cam!.lon, 3);
    expect(decoded.cam?.height).toBeCloseTo(sample.cam!.height, -3);
    expect(decoded.cam?.heading).toBeCloseTo(sample.cam!.heading!, 1);
    expect(decoded.cam?.pitch).toBeCloseTo(sample.cam!.pitch!, 1);
    expect(decoded.passes?.lat).toBeCloseTo(sample.passes!.lat, 3);
    expect(decoded.passes?.lon).toBeCloseTo(sample.passes!.lon, 3);
    expect(decoded.track?.lat).toBeCloseTo(sample.track!.lat, 3);
    expect(decoded.track?.lon).toBeCloseTo(sample.track!.lon, 3);
    expect(decoded.track?.title).toBe("ISS (ZARYA)");
  });

  it("buildShareHref produces a parseable hash", () => {
    const href = buildShareHref("https://example.com", "/office", sample);
    expect(href).toContain("#g=");
    const parsed = readShareFromHash(href.slice(href.indexOf("#")));
    expect(parsed.basemap).toBe("esri");
    expect(parsed.cam?.lat).toBeCloseTo(sample.cam!.lat, 3);
  });

  it("tolerates a malformed hash by ignoring unknown chunks", () => {
    const parsed = parseGeoState("c=bogus,data.b=esri.z=whatever");
    expect(parsed.basemap).toBe("esri");
  });

  it("readShareFromHash returns an empty state on a bare pathname", () => {
    expect(readShareFromHash("")).toEqual({});
    expect(readShareFromHash("#other=1")).toEqual({});
  });

  it("encodes title text containing `.` or `=` without losing information", () => {
    const state: GeoShareState = { track: { lat: 0, lon: 0, title: "edge: foo.bar=baz" } };
    const back = parseGeoState(serializeGeoState(state));
    expect(back.track?.title).toBe("edge: foo.bar=baz");
  });
});
