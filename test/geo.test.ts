import { describe, expect, it } from "vitest";
import { destinationPoint, haversineM, polylineLengthM } from "../src/domain/geo.js";

describe("haversine", () => {
  it("is zero for identical points and symmetric", () => {
    const a = { lat: 52.52, lon: 13.405 };
    const b = { lat: 48.137, lon: 11.575 };
    expect(haversineM(a, a)).toBe(0);
    expect(haversineM(a, b)).toBeCloseTo(haversineM(b, a), 9);
  });

  it("matches known distances", () => {
    // Berlin – Munich, approx. 504 km great-circle.
    expect(haversineM({ lat: 52.52, lon: 13.405 }, { lat: 48.137, lon: 11.575 }) / 1000).toBeCloseTo(504.4, 0);
    // One degree of latitude is ~111.19 km on the mean sphere.
    expect(haversineM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(111_195, -1);
    // Across the antimeridian.
    expect(haversineM({ lat: 0, lon: 179.5 }, { lat: 0, lon: -179.5 })).toBeCloseTo(111_195, -1);
  });

  it("destinationPoint inverts haversine", () => {
    const o = { lat: 40.7, lon: -74 };
    for (const bearing of [0, 45, 133, 270]) {
      expect(haversineM(o, destinationPoint(o, bearing, 1234.5))).toBeCloseTo(1234.5, 3);
    }
  });

  it("sums polyline legs", () => {
    const pts = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 0.01 },
      { lat: 0.01, lon: 0.01 },
    ];
    expect(polylineLengthM(pts)).toBeCloseTo(haversineM(pts[0]!, pts[1]!) + haversineM(pts[1]!, pts[2]!), 9);
    expect(polylineLengthM([])).toBe(0);
  });
});
