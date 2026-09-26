import { HQ_DEFAULT_TIME_ZONE, hqTimeZone, isValidTimeZone, setHqTimeZone } from "@/features/hq/core/hqTime";

/**
 * Follows the viewer's real location for the HQ's time zone. The device's own
 * zone setting is not trusted (it is often set by hand and wrong); instead the
 * browser's position is turned into an IANA zone locally, with the offline
 * @photostructure/tz-lookup table: the coordinates never leave the browser.
 * Until a position arrives the last zone found is used, Moscow before that;
 * if the viewer denies location access, that zone simply stays.
 */

const STORAGE_KEY = "office3d.hqTimeZone";
/** Re-check the position this often, so the clock follows a trip. */
const RECHECK_MS = 15 * 60_000;
const POSITION_OPTIONS: PositionOptions = { enableHighAccuracy: false, maximumAge: 10 * 60_000, timeout: 30_000 };

const listeners = new Set<() => void>();
let users = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function remembered(): string | null {
  try {
    const zone = window.localStorage.getItem(STORAGE_KEY);
    return zone && isValidTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

function apply(zone: string): void {
  if (!setHqTimeZone(zone)) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, zone);
  } catch {
    // Private mode or blocked storage: the zone just isn't remembered.
  }
  for (const listener of listeners) listener();
}

/** The zone for a position; null when the lookup fails. */
export async function zoneAt(latitude: number, longitude: number): Promise<string | null> {
  try {
    const mod = await import("@photostructure/tz-lookup");
    const lookup = (mod as { default?: (lat: number, lon: number) => string }).default ?? (mod as unknown as (lat: number, lon: number) => string);
    const zone = lookup(latitude, longitude);
    return isValidTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

function locate(): void {
  if (typeof navigator === "undefined" || !navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      void zoneAt(position.coords.latitude, position.coords.longitude).then((zone) => {
        if (zone) apply(zone);
      });
    },
    () => {
      // Denied or unavailable: keep the last known zone.
    },
    POSITION_OPTIONS,
  );
}

/** For useSyncExternalStore: starts following the location while anyone listens. */
export function subscribeHqTimeZone(listener: () => void): () => void {
  listeners.add(listener);
  users += 1;
  if (users === 1) {
    apply(remembered() ?? HQ_DEFAULT_TIME_ZONE);
    locate();
    timer = setInterval(locate, RECHECK_MS);
  }
  return () => {
    listeners.delete(listener);
    users -= 1;
    if (users === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export const getHqTimeZoneSnapshot = (): string => hqTimeZone();
export const getHqTimeZoneServerSnapshot = (): string => HQ_DEFAULT_TIME_ZONE;
