import * as satellite from "satellite.js";

/**
 * Satellite passes over a chosen ground point.
 *
 * Given a TLE set (loaded on the globe for the live Satellites layer) and an
 * observer's latitude / longitude, compute the next visible passes: a pass is a
 * continuous interval during which the satellite is above the observer's
 * horizon. For each pass we return the rise / peak / set time, maximum
 * elevation and (approximately) whether it is observable in daylight terms —
 * the pass is "visible" when the satellite is sunlit while the observer is in
 * local twilight / night, which is the practical rule naked-eye observers use.
 *
 * Pure, side-effect-free computation. All times are UTC epoch ms.
 */

export type SatPass = {
  satName: string;
  satId: string;
  riseAt: number;
  peakAt: number;
  setAt: number;
  /** Max elevation above the horizon during the pass, in degrees. */
  peakElevationDeg: number;
  /** True when the satellite is sunlit while the observer is in dark enough twilight. */
  visibleToEye: boolean;
};

export type Tle = { name: string; line1: string; line2: string };

/** Parse a CelesTrak-style TLE block into (name, line1, line2) triples. */
export function parseTleBundle(bundle: string): Tle[] {
  const lines = bundle.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: Tle[] = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = lines[i];
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (!l1.startsWith("1 ") || !l2.startsWith("2 ")) continue;
    out.push({ name, line1: l1, line2: l2 });
  }
  return out;
}

/** Build a SatRec from a TLE triple, swallowing malformed entries. */
function toSatRec(tle: Tle): satellite.SatRec | null {
  try {
    return satellite.twoline2satrec(tle.line1, tle.line2);
  } catch {
    return null;
  }
}

/** Elevation (deg) of a satellite as seen from an observer, at a given time. */
function elevationDeg(rec: satellite.SatRec, obs: satellite.GeodeticLocation, when: Date): number | null {
  const pv = satellite.propagate(rec, when);
  if (!pv || typeof pv.position === "boolean") return null;
  const gmst = satellite.gstime(when);
  const ecf = satellite.eciToEcf(pv.position, gmst);
  const look = satellite.ecfToLookAngles(obs, ecf);
  return (look.elevation * 180) / Math.PI;
}

/** Rough daytime check at an observer location — a cheap sun-altitude test. */
function observerIsDark(lat: number, lon: number, when: Date): boolean {
  // Approximate solar position using the time-of-year + hour angle. Good enough
  // for a "visible to the naked eye" filter on a satellite pass.
  const dayOfYear = Math.floor((when.getTime() - Date.UTC(when.getUTCFullYear(), 0, 1)) / 86_400_000);
  const decl = 23.44 * Math.sin((2 * Math.PI * (dayOfYear - 80)) / 365);
  const hour = when.getUTCHours() + when.getUTCMinutes() / 60 + lon / 15;
  const hourAngle = (hour - 12) * 15;
  const latRad = (lat * Math.PI) / 180;
  const declRad = (decl * Math.PI) / 180;
  const haRad = (hourAngle * Math.PI) / 180;
  const sunAlt = Math.asin(Math.sin(latRad) * Math.sin(declRad) + Math.cos(latRad) * Math.cos(declRad) * Math.cos(haRad));
  const sunAltDeg = (sunAlt * 180) / Math.PI;
  // Observer is dark enough for a sunlit sat to stand out when the sun is below -6°.
  return sunAltDeg < -6;
}

/** Approximate sunlit test on the satellite itself (not in Earth's shadow). */
function satelliteIsSunlit(rec: satellite.SatRec, when: Date): boolean {
  const pv = satellite.propagate(rec, when);
  if (!pv || typeof pv.position === "boolean") return false;
  // The sun direction at `when`, in ECI, using the solar hour-angle approximation.
  const d = (when.getTime() - Date.UTC(2000, 0, 1, 12)) / 86_400_000; // days since J2000
  const g = (357.529 + 0.98560028 * d) % 360;
  const q = (280.459 + 0.98564736 * d) % 360;
  const L = (q + 1.915 * Math.sin((g * Math.PI) / 180)) % 360;
  const sinL = Math.sin((L * Math.PI) / 180);
  const cosL = Math.cos((L * Math.PI) / 180);
  const sunEci = { x: cosL, y: 0.9175 * sinL, z: 0.3978 * sinL };
  const pos = pv.position;
  const r = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z);
  const sunDot = (pos.x * sunEci.x + pos.y * sunEci.y + pos.z * sunEci.z) / r;
  // Satellite is in Earth's shadow when the dot product is negative and the perpendicular
  // distance from the sun-earth line is less than Earth's radius (6378 km).
  if (sunDot >= 0) return true;
  const perp = Math.sqrt(r * r - sunDot * sunDot * r * r);
  return perp > 6378;
}

/**
 * Find the next `limit` passes of a single satellite over an observer in the
 * window [now, now + horizonHours]. Returns passes with peak elevation above
 * `minElevationDeg` (default 10°).
 */
export function findPassesForSat(
  tle: Tle,
  observer: { lat: number; lon: number; heightMeters?: number },
  options: { fromMs?: number; horizonHours?: number; limit?: number; stepSeconds?: number; minElevationDeg?: number } = {},
): SatPass[] {
  const rec = toSatRec(tle);
  if (!rec) return [];
  const fromMs = options.fromMs ?? Date.now();
  const horizonHours = Math.max(1, Math.min(72, options.horizonHours ?? 24));
  const limit = Math.max(1, Math.min(20, options.limit ?? 5));
  const stepSeconds = Math.max(10, Math.min(120, options.stepSeconds ?? 30));
  const minElevationDeg = options.minElevationDeg ?? 10;

  const obs: satellite.GeodeticLocation = {
    latitude: (observer.lat * Math.PI) / 180,
    longitude: (observer.lon * Math.PI) / 180,
    height: (observer.heightMeters ?? 0) / 1000,
  };

  const endMs = fromMs + horizonHours * 3_600_000;
  const stepMs = stepSeconds * 1000;
  const passes: SatPass[] = [];

  let inPass = false;
  let riseAt = 0;
  let peakAt = 0;
  let peakEl = -90;

  for (let t = fromMs; t <= endMs; t += stepMs) {
    const when = new Date(t);
    const el = elevationDeg(rec, obs, when);
    if (el === null) continue;
    if (el > 0) {
      if (!inPass) {
        inPass = true;
        riseAt = t;
        peakAt = t;
        peakEl = el;
      } else if (el > peakEl) {
        peakAt = t;
        peakEl = el;
      }
    } else if (inPass) {
      // Just set.
      inPass = false;
      if (peakEl >= minElevationDeg) {
        const peakWhen = new Date(peakAt);
        const peakLat = observer.lat;
        const peakLon = observer.lon;
        const visibleToEye = observerIsDark(peakLat, peakLon, peakWhen) && satelliteIsSunlit(rec, peakWhen);
        passes.push({
          satName: tle.name,
          satId: tle.line1.slice(2, 7).trim(),
          riseAt,
          peakAt,
          setAt: t,
          peakElevationDeg: Math.round(peakEl * 10) / 10,
          visibleToEye,
        });
        if (passes.length >= limit) break;
      }
    }
  }

  return passes;
}

/**
 * Find the next passes across many satellites, sorted by rise time. Used when
 * the observer wants to know "what rises next over my point".
 */
export function findNextPasses(
  tles: Tle[],
  observer: { lat: number; lon: number },
  options: Parameters<typeof findPassesForSat>[2] = {},
): SatPass[] {
  const all: SatPass[] = [];
  const perSatLimit = Math.max(1, Math.min(5, options.limit ?? 2));
  for (const tle of tles) {
    all.push(...findPassesForSat(tle, observer, { ...options, limit: perSatLimit }));
  }
  all.sort((a, b) => a.riseAt - b.riseAt);
  return all.slice(0, options.limit ?? 10);
}
