import type { Vector3 } from "three";

/**
 * Where the Sun is overhead right now, for the map's real-time day and night.
 *
 * Directions use the map's own convention (mapShaders.ts, hqMapDir): for a
 * longitude/latitude, x = cos(lat) cos(lon), y = sin(lat), z = cos(lat) sin(lon).
 */

const DEG = Math.PI / 180;

/** The subsolar point (degrees) at a moment, accurate to a fraction of a degree. */
export function subsolarPoint(ms: number): { lon: number; lat: number } {
  const days = ms / 86400000 - 10957.5; // days since J2000.0
  const g = ((357.529 + 0.98560028 * days) % 360) * DEG;
  const q = (280.459 + 0.98564736 * days) % 360;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const e = (23.439 - 0.00000036 * days) * DEG;
  const decl = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / DEG;
  const eqTimeMin = 4 * (q - ra - 360 * Math.round((q - ra) / 360));
  const utcMin = (((ms % 86400000) + 86400000) % 86400000) / 60000;
  const lon = 180 - (utcMin + eqTimeMin) / 4;
  return { lon: ((lon + 540) % 360) - 180, lat: decl / DEG };
}

/** Unit vector for a longitude/latitude in degrees, in the map's convention. */
export function mapDirection(lonDeg: number, latDeg: number, out: Vector3): Vector3 {
  const lon = lonDeg * DEG;
  const lat = latDeg * DEG;
  return out.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
}

/** The direction to the Sun at a moment. */
export function sunDirection(ms: number, out: Vector3): Vector3 {
  const { lon, lat } = subsolarPoint(ms);
  return mapDirection(lon, lat, out);
}
