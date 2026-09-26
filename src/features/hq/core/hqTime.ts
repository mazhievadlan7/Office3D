/**
 * The HQ's time zone: where the viewer actually is (hqLocationZone.ts finds
 * it from the device's location), Moscow until that is known. The HUD clock,
 * the screens and the TVs all read it from here, on the main thread and in
 * the screens worker (the hub passes the zone along with the screen feed).
 */
export const HQ_DEFAULT_TIME_ZONE = "Europe/Moscow";

const HOUR_MS = 3_600_000;

const makeFormat = (timeZone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });

let zone = HQ_DEFAULT_TIME_ZONE;
let partsFormat = makeFormat(zone);
// Offsets only change on the hour (at a DST switch), so one lookup per hour
// is exact and keeps the painters' per-frame calls allocation-free.
let cachedHour = Number.NaN;
let cachedOffset = 0;

/** Whether this engine knows the IANA zone. */
export function isValidTimeZone(candidate: string): boolean {
  if (!candidate) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return true;
  } catch {
    return false;
  }
}

/** The HQ's current IANA time zone. */
export function hqTimeZone(): string {
  return zone;
}

/** Switches the HQ's zone; unknown zones are ignored. Returns whether it changed. */
export function setHqTimeZone(next: string): boolean {
  if (next === zone || !isValidTimeZone(next)) return false;
  zone = next;
  partsFormat = makeFormat(next);
  cachedHour = Number.NaN;
  return true;
}

/** Minutes the HQ's wall clock is ahead of UTC at `ms` (Moscow: 180). */
export function hqUtcOffsetMinutes(ms: number): number {
  const hour = Math.floor(ms / HOUR_MS);
  if (hour === cachedHour) return cachedOffset;
  const parts = partsFormat.formatToParts(ms);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const wallAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  cachedOffset = Math.round((wallAsUtc - Math.floor(ms / 1000) * 1000) / 60_000);
  cachedHour = hour;
  return cachedOffset;
}

/**
 * A Date whose UTC fields read the HQ's wall time: use getUTCHours(),
 * getUTCDay() and so on, never the local getters.
 */
export function hqWallClock(ms: number): Date {
  return new Date(ms + hqUtcOffsetMinutes(ms) * 60_000);
}

/** «UTC+3» for the HQ's zone at `ms`. */
export function hqUtcOffsetLabel(ms: number): string {
  const offset = hqUtcOffsetMinutes(ms);
  const abs = Math.abs(offset);
  const minutes = abs % 60 ? `:${String(abs % 60).padStart(2, "0")}` : "";
  return `UTC${offset >= 0 ? "+" : "−"}${Math.floor(abs / 60)}${minutes}`;
}
