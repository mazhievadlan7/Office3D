"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import {
  getHqTimeZoneServerSnapshot,
  getHqTimeZoneSnapshot,
  subscribeHqTimeZone,
} from "@/features/hq/core/hqLocationZone";
import { t, type TranslationKey } from "@/lib/i18n";

// The clock follows the viewer's real location (hqLocationZone.ts), Moscow
// until a position is known; the screens and TVs use the same zone.

// City names for the zones people are most likely in; any other zone shows
// its IANA city (Europe/Lisbon -> Lisbon).
const ZONE_CITY: Record<string, TranslationKey> = {
  "Europe/Moscow": "hqClock.cityMoscow",
  "Europe/Kaliningrad": "hqClock.cityKaliningrad",
  "Europe/Samara": "hqClock.citySamara",
  "Europe/Volgograd": "hqClock.cityVolgograd",
  "Asia/Yekaterinburg": "hqClock.cityYekaterinburg",
  "Asia/Omsk": "hqClock.cityOmsk",
  "Asia/Novosibirsk": "hqClock.cityNovosibirsk",
  "Asia/Krasnoyarsk": "hqClock.cityKrasnoyarsk",
  "Asia/Irkutsk": "hqClock.cityIrkutsk",
  "Asia/Vladivostok": "hqClock.cityVladivostok",
  "Europe/Minsk": "hqClock.cityMinsk",
  "Europe/Kyiv": "hqClock.cityKyiv",
  "Europe/Istanbul": "hqClock.cityIstanbul",
  "Europe/Berlin": "hqClock.cityBerlin",
  "Europe/Paris": "hqClock.cityParis",
  "Europe/London": "hqClock.cityLondon",
  "Europe/Rome": "hqClock.cityRome",
  "Europe/Madrid": "hqClock.cityMadrid",
  "Asia/Dubai": "hqClock.cityDubai",
  "Asia/Almaty": "hqClock.cityAlmaty",
  "Asia/Tashkent": "hqClock.cityTashkent",
  "Asia/Tbilisi": "hqClock.cityTbilisi",
  "Asia/Baku": "hqClock.cityBaku",
  "Asia/Yerevan": "hqClock.cityYerevan",
  "America/New_York": "hqClock.cityNewYork",
  "Asia/Tokyo": "hqClock.cityTokyo",
};

function cityName(zone: string): string {
  const key = ZONE_CITY[zone];
  if (key) return t(key);
  const city = zone.split("/").pop() ?? zone;
  return city.replace(/_/g, " ");
}

type Formatters = { time: Intl.DateTimeFormat; date: Intl.DateTimeFormat; offset: Intl.DateTimeFormat };

function formatters(zone: string): Formatters {
  return {
    time: new Intl.DateTimeFormat("ru-RU", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }),
    date: new Intl.DateTimeFormat("ru-RU", { timeZone: zone, weekday: "long", day: "numeric", month: "long", year: "numeric" }),
    offset: new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" }),
  };
}

function utcOffset(format: Intl.DateTimeFormat, now: Date): string {
  const name = format.formatToParts(now).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  return name === "GMT" ? "UTC" : name.replace("GMT", "UTC");
}

function dateLine(format: Intl.DateTimeFormat, now: Date): string {
  const parts = format.formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = get("weekday");
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${get("day")} ${get("month")} ${get("year")}`;
}

const subscribeNothing = () => () => {};

/**
 * Local time where the viewer is (Moscow until the location is known), with the date and weekday.
 * Content only: the card around it belongs to whoever places it (the HQ's
 * top-right block). The server and the first client render show dashes, so
 * the server's clock and time zone never clash with the viewer's on hydration.
 */
export function HqClock({ className = "" }: { className?: string }) {
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const zone = useSyncExternalStore(subscribeHqTimeZone, getHqTimeZoneSnapshot, getHqTimeZoneServerSnapshot);
  const format = useMemo(() => formatters(zone), [zone]);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    // Tick on the second boundary so the display never lags a whole second.
    let timer = 0;
    const tick = () => {
      const current = new Date();
      setNow(current);
      timer = window.setTimeout(tick, 1000 - current.getMilliseconds() + 5);
    };
    timer = window.setTimeout(tick, 1000 - new Date().getMilliseconds() + 5);
    return () => window.clearTimeout(timer);
  }, []);

  const [hh, mm, ss] = hydrated ? format.time.format(now).split(":") : ["--", "--", "--"];
  const city = hydrated ? cityName(zone) : "";
  // Fixed line heights keep the block the same height whatever the font does,
  // so the buttons and the panel under it never shift.
  return (
    <div
      role="timer"
      aria-live="off"
      aria-label={hydrated ? t("hqClock.label", { city }) : undefined}
      className={`select-none text-right ${className}`}
    >
      <div className="flex h-3.5 items-center justify-end gap-2 font-mono text-[10px] font-semibold uppercase leading-[14px] tracking-[0.2em] text-white">
        <span className="h-1.5 w-1.5 rounded-full bg-red-500 shadow-[0_0_8px_rgba(255,42,42,0.9)]" />
        <span>{city}</span>
        <span className="text-white/65">{hydrated ? utcOffset(format.offset, now) : ""}</span>
      </div>
      <div className="mt-1 h-[26px] font-mono text-[26px] font-bold leading-none tabular-nums tracking-[0.06em] text-white [text-shadow:0_0_16px_rgba(255,26,26,0.45)]">
        {hh}
        <span className="text-red-500">:</span>
        {mm}
        <span className="text-[17px] text-white/85">
          <span className="text-red-500">:</span>
          {ss}
        </span>
      </div>
      <div className="mt-1 h-4 truncate font-mono text-[11px] leading-4 tracking-wide text-white">
        {hydrated ? dateLine(format.date, now) : "\u00a0"}
      </div>
    </div>
  );
}
