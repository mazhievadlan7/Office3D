import { plural, type PluralForms } from "@/lib/i18n/plural";
import { subsolarPoint } from "@/features/hq/render/map/sun";
import type { HqScreenFeed } from "./screenPaint";
import { hqWallClock } from "@/features/hq/core/hqTime";

/**
 * What the big screens say, derived from the floor feed and the real clock:
 * the news channel's headlines and ticker, the business channel's quotes,
 * local times, day and night in world cities and whether their exchanges are
 * trading. In-world text inside the 3D scene, like screenText.ts, so it is not
 * routed through the i18n dictionary. Pure: no canvas, no DOM.
 */

const AGENTS: PluralForms = ["агент", "агента", "агентов"];

export const STATUS_WORD = ["в работе", "ожидает", "ошибка"] as const;

/**
 * Kinds of operation, in HQ_ROLE_FAMILY order (core/roles.ts maps an agent's
 * role to one): not departments, everyone is an operational hacker.
 */
export const TEAM_NAMES = ["Оперативный штаб", "Разведка", "Веб и API", "Идентификация", "Облако", "Сеть", "Реверс", "Отчётность"] as const;
/** Short ticker codes, same order. */
export const TEAM_CODES = ["ШТАБ", "РАЗВ", "ВЕБ", "ИДЕН", "ОБЛК", "СЕТЬ", "РЕВС", "ОТЧТ"] as const;

/** Share of agents working, 0..1. */
export function workingShare(feed: HqScreenFeed): number {
  return feed.total > 0 ? feed.working / feed.total : 0;
}

/** The working share `seconds` ago from the per-second history (the oldest one when shorter). */
export function shareAgo(feed: HqScreenFeed, seconds: number): number {
  const h = feed.history;
  if (h.length === 0) return workingShare(feed);
  return h[Math.max(0, h.length - 1 - Math.round(seconds))];
}

/** Percentage points, signed, with a Russian decimal comma. */
export function signedPoints(delta: number, digits = 1): string {
  const v = delta * 100;
  const text = Math.abs(v).toFixed(digits).replace(".", ",");
  return `${v > 0.05 ? "+" : v < -0.05 ? "−" : "±"}${text}`;
}

export function decimal(v: number, digits = 1): string {
  return v.toFixed(digits).replace(".", ",").replace("-", "−");
}

// Times and dates on the screens are the HQ's wall time (Moscow).
export function hhmm(ms: number): string {
  const d = hqWallClock(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function hhmmss(ms: number): string {
  const d = hqWallClock(ms);
  return `${hhmm(ms)}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}

const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

/** «пятница, 25 сентября» */
export function longDate(ms: number): string {
  const d = hqWallClock(ms);
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

// --- news ---------------------------------------------------------------------------------------
export type NewsStory = {
  /** The category box: СРОЧНО, ГЛАВНОЕ, ШТАБ, ОПЕРАЦИИ, ДИНАМИКА. */
  tag: string;
  title: string;
  sub: string;
  /** Breaking: the tag flashes. */
  hot: boolean;
  /** The event behind a breaking story, so the channel airs it once, at once. */
  key?: string;
};

const RECENT_MS = 90_000;

function eventTitle(name: string, status: number): string {
  if (status === 2) return `Агент ${name} сообщил об ошибке выполнения`;
  if (status === 0) return `Агент ${name} взял новую задачу`;
  return `Агент ${name} завершил задачу и ждёт следующую`;
}

/**
 * The news channel's rundown, most urgent first: fresh errors, the state of
 * the floor, the minute's trend, the busiest kind of operation, the latest moves.
 */
export function newsStories(feed: HqScreenFeed): NewsStory[] {
  const out: NewsStory[] = [];
  const { total, working, idle, error, clock } = feed;
  if (total === 0) {
    out.push({ tag: "ШТАБ", title: "Штаб ожидает подключения агентов", sub: `Прямой эфир · ${hhmm(clock)}`, hot: false });
    return out;
  }
  const pct = Math.round(workingShare(feed) * 100);
  for (const e of feed.events) {
    if (e.status !== 2 || clock - e.at > RECENT_MS || out.length >= 2) continue;
    out.push({ tag: "СРОЧНО", title: eventTitle(e.name, 2), sub: `${hhmmss(e.at)} · ошибок в штабе: ${error}`, hot: true, key: `${e.at}:${e.name}` });
  }
  out.push({
    tag: "ГЛАВНОЕ",
    title: `В штабе ${working} ${plural(working, AGENTS)} в работе из ${total}`,
    sub: `Загрузка ${pct}% · ожидают ${idle} · ошибок ${error}`,
    hot: false,
  });
  if (feed.history.length >= 20) {
    const delta = workingShare(feed) - shareAgo(feed, 60);
    const title =
      delta >= 0.02 ? `Загрузка штаба выросла до ${pct}%` : delta <= -0.02 ? `Загрузка штаба снизилась до ${pct}%` : `Загрузка штаба держится на уровне ${pct}%`;
    out.push({ tag: "ДИНАМИКА", title, sub: `${signedPoints(delta)} п.п. за последнюю минуту`, hot: false });
  }
  if (error === 0) {
    out.push({ tag: "ШТАБ", title: "Штаб работает без ошибок", sub: `Все ${total} ${plural(total, AGENTS)} на связи · ${hhmm(clock)}`, hot: false });
  } else {
    out.push({
      tag: "СРОЧНО",
      title: `${error} ${plural(error, AGENTS)} ${error === 1 ? "сообщает" : "сообщают"} об ошибке`,
      sub: `Доля ошибок ${decimal((error / total) * 100)}% · остальные работают штатно`,
      hot: true,
    });
  }
  let busiest = -1;
  let best = -1;
  feed.teams.forEach((team, i) => {
    if (team.total < 2) return;
    const share = team.working / team.total;
    if (share > best) {
      best = share;
      busiest = i;
    }
  });
  if (busiest >= 0) {
    const team = feed.teams[busiest];
    out.push({
      tag: "ОПЕРАЦИИ",
      title: `Операции «${TEAM_NAMES[busiest]}»: в работе ${Math.round(best * 100)}%`,
      sub: `${team.working} из ${team.total} ${plural(team.total, AGENTS)} в работе`,
      hot: false,
    });
  }
  let moves = 0;
  for (const e of feed.events) {
    if (e.status === 2 || moves >= 3) continue;
    moves++;
    out.push({ tag: "ШТАБ", title: eventTitle(e.name, e.status), sub: `${hhmmss(e.at)} · в работе ${working} из ${total}`, hot: false });
  }
  return out;
}

/** The news ticker's items: the floor's numbers, the latest moves, world time. */
export function newsTicker(feed: HqScreenFeed): string[] {
  const items: string[] = [];
  if (feed.total > 0) {
    items.push(`В РАБОТЕ ${feed.working}`, `ОЖИДАЮТ ${feed.idle}`, `ОШИБКИ ${feed.error}`, `ЗАГРУЗКА ${Math.round(workingShare(feed) * 100)}%`);
  } else {
    items.push("ШТАБ AM7 · ОЖИДАНИЕ ПОДКЛЮЧЕНИЯ");
  }
  for (const e of feed.events.slice(0, 6)) items.push(`${e.name}: ${STATUS_WORD[e.status] ?? "—"} (${hhmm(e.at)})`);
  for (const city of WORLD_CITIES.slice(0, 6)) items.push(`${city.name.toUpperCase()} ${cityTime(city, feed.clock).text}`);
  return items;
}

// --- world time ---------------------------------------------------------------------------------
export type WorldCity = { name: string; tz: string; lon: number; lat: number; /** Fallback UTC offset, hours. */ offset: number };

export const WORLD_CITIES: readonly WorldCity[] = [
  { name: "Москва", tz: "Europe/Moscow", lon: 37.62, lat: 55.76, offset: 3 },
  { name: "Лондон", tz: "Europe/London", lon: -0.13, lat: 51.51, offset: 0 },
  { name: "Нью-Йорк", tz: "America/New_York", lon: -74.01, lat: 40.71, offset: -5 },
  { name: "Токио", tz: "Asia/Tokyo", lon: 139.69, lat: 35.69, offset: 9 },
  { name: "Дубай", tz: "Asia/Dubai", lon: 55.27, lat: 25.2, offset: 4 },
  { name: "Сингапур", tz: "Asia/Singapore", lon: 103.82, lat: 1.35, offset: 8 },
  { name: "Сидней", tz: "Australia/Sydney", lon: 151.21, lat: -33.87, offset: 10 },
  { name: "Сан-Франциско", tz: "America/Los_Angeles", lon: -122.42, lat: 37.77, offset: -8 },
  { name: "Сан-Паулу", tz: "America/Sao_Paulo", lon: -46.63, lat: -23.55, offset: -3 },
  { name: "Франкфурт", tz: "Europe/Berlin", lon: 8.68, lat: 50.11, offset: 1 },
  { name: "Гонконг", tz: "Asia/Hong_Kong", lon: 114.17, lat: 22.32, offset: 8 },
];

export function city(name: string): WorldCity {
  return WORLD_CITIES.find((c) => c.name === name) ?? WORLD_CITIES[0];
}

export type LocalTime = { hours: number; minutes: number; /** 0 = Sunday. */ weekday: number; text: string };

const WEEKDAY_EN: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat | null>();
const localCache = new Map<string, { minute: number; time: LocalTime }>();

function formatter(tz: string): Intl.DateTimeFormat | null {
  if (!formatters.has(tz)) {
    try {
      formatters.set(tz, new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }));
    } catch {
      formatters.set(tz, null);
    }
  }
  return formatters.get(tz) ?? null;
}

/** Local time in a city (daylight saving included where Intl knows the zone), cached per minute. */
export function cityTime(c: WorldCity, ms: number): LocalTime {
  const minute = Math.floor(ms / 60000);
  const hit = localCache.get(c.tz);
  if (hit && hit.minute === minute) return hit.time;
  let hours: number;
  let minutes: number;
  let weekday: number;
  const f = formatter(c.tz);
  const parts = f?.formatToParts(new Date(ms));
  if (parts) {
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    hours = Number(get("hour")) % 24;
    minutes = Number(get("minute"));
    weekday = WEEKDAY_EN[get("weekday")] ?? 1;
  } else {
    const d = new Date(ms + c.offset * 3600000);
    hours = d.getUTCHours();
    minutes = d.getUTCMinutes();
    weekday = d.getUTCDay();
  }
  const time = { hours, minutes, weekday, text: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}` };
  localCache.set(c.tz, { minute, time });
  return time;
}

/** The Sun's elevation above a place's horizon, degrees, right now. */
export function sunElevation(lon: number, lat: number, ms: number): number {
  const s = subsolarPoint(ms);
  const d = Math.PI / 180;
  const cosZ = Math.sin(lat * d) * Math.sin(s.lat * d) + Math.cos(lat * d) * Math.cos(s.lat * d) * Math.cos((lon - s.lon) * d);
  return 90 - Math.acos(Math.max(-1, Math.min(1, cosZ))) / d;
}

export type DayPhase = "day" | "twilight" | "night";

export function dayPhase(elevation: number): DayPhase {
  return elevation > -0.833 ? "day" : elevation > -6 ? "twilight" : "night";
}

export const PHASE_WORD: Record<DayPhase, string> = { day: "день", twilight: "сумерки", night: "ночь" };

// --- exchanges ----------------------------------------------------------------------------------
export type Exchange = { code: string; city: string; /** Trading sessions, local minutes from midnight, Mon–Fri. */ sessions: ReadonlyArray<readonly [number, number]> };

const at = (h: number, m = 0) => h * 60 + m;

// Regular sessions (holidays aside).
export const EXCHANGES: readonly Exchange[] = [
  { code: "MOEX", city: "Москва", sessions: [[at(10), at(18, 40)]] },
  { code: "LSE", city: "Лондон", sessions: [[at(8), at(16, 30)]] },
  { code: "XETRA", city: "Франкфурт", sessions: [[at(9), at(17, 30)]] },
  { code: "NYSE", city: "Нью-Йорк", sessions: [[at(9, 30), at(16)]] },
  { code: "TSE", city: "Токио", sessions: [[at(9), at(11, 30)], [at(12, 30), at(15, 30)]] },
  { code: "HKEX", city: "Гонконг", sessions: [[at(9, 30), at(12)], [at(13), at(16)]] },
];

export type ExchangeState = { open: boolean; /** Minutes until it opens or closes next. */ minutes: number; local: LocalTime };

/** Whether an exchange is trading now and how long until that changes. */
export function exchangeState(ex: Exchange, ms: number): ExchangeState {
  const local = cityTime(city(ex.city), ms);
  const now = local.hours * 60 + local.minutes;
  const weekday = local.weekday;
  const trading = weekday >= 1 && weekday <= 5;
  if (trading) {
    for (const [from, to] of ex.sessions) {
      if (now >= from && now < to) return { open: true, minutes: to - now, local };
    }
  }
  // Next opening: later today, or the first session of the next weekday.
  if (trading) {
    for (const [from] of ex.sessions) if (from > now) return { open: false, minutes: from - now, local };
  }
  let days = 1;
  while (((weekday + days) % 7 === 0 || (weekday + days) % 7 === 6) && days < 7) days++;
  return { open: false, minutes: days * 1440 - now + ex.sessions[0][0], local };
}

/** «1 ч 24 мин», «45 мин», «2 дн» */
export function durationText(minutes: number): string {
  if (minutes >= 2 * 1440) return `${Math.floor(minutes / 1440)} дн`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} ч ${String(m).padStart(2, "0")} мин` : `${m} мин`;
}

// --- the business channel's index ---------------------------------------------------------------
/**
 * The HQ index: the working share in points (0..100) per second, with a
 * small, stable intraminute swing so the candles have bodies. Oldest first.
 * The swing is phased by the feed's sample count, which moves exactly with
 * the history (the clock moves between feeds and would shake the chart).
 */
export function indexSeries(feed: HqScreenFeed, seconds: number): number[] {
  const out: number[] = [];
  const h = feed.history;
  const base = feed.sample;
  const n = Math.min(seconds, Math.max(h.length, 1));
  for (let i = 0; i < n; i++) {
    const share = h.length > 0 ? h[h.length - n + i] : workingShare(feed);
    const s = base - (n - 1 - i);
    const swing = 0.22 * Math.sin(s * 0.9) + 0.14 * Math.sin(s * 2.3 + 1.7) + 0.1 * Math.sin(s * 0.21 + 0.4);
    out.push(100 * share + swing);
  }
  return out;
}

export type Candle = { open: number; high: number; low: number; close: number };

/** Groups a series into candles of `per` samples (the last one may be partial). */
export function candles(values: readonly number[], per: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < values.length; i += per) {
    const slice = values.slice(i, i + per);
    out.push({ open: slice[0], close: slice[slice.length - 1], high: Math.max(...slice), low: Math.min(...slice) });
  }
  return out;
}

/** Business ticker quotes: the index, every kind of operation in progress, the statuses. */
export function marketQuotes(feed: HqScreenFeed, index: number, change: number): Array<{ code: string; value: string; delta: number }> {
  const quotes: Array<{ code: string; value: string; delta: number }> = [{ code: "AM7X", value: decimal(index, 2), delta: change }];
  feed.teams.forEach((team, i) => {
    if (team.total === 0) return;
    quotes.push({ code: TEAM_CODES[i], value: `${Math.round((team.working / team.total) * 100)}%`, delta: team.working - team.workingAgo });
  });
  quotes.push({ code: "В РАБОТЕ", value: String(feed.working), delta: 0 }, { code: "ОШИБКИ", value: String(feed.error), delta: 0 });
  return quotes;
}
