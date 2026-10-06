import { NextResponse } from "next/server";

/**
 * Server-side proxy for the «ГЕО» live public-data layers (owner 2026-10-07).
 *
 * Why: some of the public open-data endpoints (OpenSky in particular) do not
 * send a wildcard CORS header, so a browser cannot fetch them cross-origin.
 * This route forwards the request from our own origin, which both lifts the
 * CORS block and keeps the egress declared and inspectable (TZ §4.2): the
 * allowlist here is the SINGLE place where the «ГЕО» view reaches the public
 * internet. No request body is forwarded, no cookies, no auth headers.
 *
 * Only the layers that genuinely need a proxy go through this route; keyed
 * services (AISStream, FIRMS, Windy) talk to their providers directly from the
 * browser with the free NEXT_PUBLIC_* key, as they are designed for.
 */

export const runtime = "nodejs";

type ProxyTarget = {
  /** Short label for logs. */
  id: string;
  /** Full URL to fetch. */
  url: string;
  /** Content-Type to echo back to the browser (open-data sources are honest, but we pin it). */
  contentType: string;
  /** How long we cache this response (seconds) at the edge; also caps our own refetch. */
  maxAge: number;
  /** Per-source upstream timeout; falls back to FETCH_TIMEOUT_MS when unset. */
  timeoutMs?: number;
};

/** Allowlist. Adding here is the only way the «ГЕО» view opens a new egress. */
const TARGETS: Record<string, ProxyTarget> = {
  // Live aircraft positions (OpenSky Network, keyless). Browser-blocked by CORS, needs proxy.
  flights: {
    id: "flights",
    url: "https://opensky-network.org/api/states/all",
    contentType: "application/json; charset=utf-8",
    maxAge: 15,
  },
  // Starlink TLE set (CelesTrak, keyless). Serves `*` CORS directly, but a proxy keeps
  // one request path for the UI and lets us swap TLE groups later without touching the client.
  "satellites-starlink": {
    id: "satellites-starlink",
    url: "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle",
    contentType: "text/plain; charset=utf-8",
    maxAge: 3600,
  },
  // Visible satellites group (CelesTrak). Smaller + brighter — a kinder default.
  "satellites-visual": {
    id: "satellites-visual",
    url: "https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle",
    contentType: "text/plain; charset=utf-8",
    maxAge: 3600,
  },
  // RainViewer public JSON catalogue of radar frames. Direct CORS works, but proxied here
  // for the same reasons as the TLE: single egress path, inspectable.
  "weather-index": {
    id: "weather-index",
    url: "https://api.rainviewer.com/public/weather-maps.json",
    contentType: "application/json; charset=utf-8",
    maxAge: 60,
  },
  // USGS past-day earthquakes (M2.5+), keyless, free. GeoJSON feed, CORS `*`.
  earthquakes: {
    id: "earthquakes",
    url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson",
    contentType: "application/geo+json; charset=utf-8",
    maxAge: 120,
  },
  // NHC active Atlantic tropical cyclones, keyless. KML of positions + forecast cones.
  "cyclones-atlantic": {
    id: "cyclones-atlantic",
    url: "https://www.nhc.noaa.gov/gis/kml/nhc_active.kml",
    contentType: "application/vnd.google-earth.kml+xml; charset=utf-8",
    maxAge: 600,
  },
  // Upcoming rocket launches worldwide (The Space Devs Launch Library 2, free tier,
  // slow public endpoint — the server-side fetch gets a longer timeout than the default).
  // Carries pad.latitude / pad.longitude on each result; no second lookup needed.
  "rocket-launches": {
    id: "rocket-launches",
    url: "https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=20",
    contentType: "application/json; charset=utf-8",
    maxAge: 1800,
    timeoutMs: 20_000,
  },
  // Note: datacenters and dams are bundled as static JSON under public/geo/ instead of a
  // remote feed — they are reference catalogues, not live telemetry, and shipping them with
  // the app avoids one more egress and one more trust decision.
};

const FETCH_TIMEOUT_MS = 8_000;

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      // Do not forward cookies / auth; this is an outbound anonymous read.
      headers: { "User-Agent": "office3d-geo-proxy/1.0 (+local)" },
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const name = url.searchParams.get("source");
  if (!name || !Object.prototype.hasOwnProperty.call(TARGETS, name)) {
    return NextResponse.json(
      { error: "Неизвестный источник. Разрешены только слои из allowlist /api/geo/live." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const target = TARGETS[name];
  try {
    const upstream = await fetchWithTimeout(target.url, target.timeoutMs ?? FETCH_TIMEOUT_MS);
    if (!upstream.ok) {
      return NextResponse.json(
        { error: `Источник ответил ${upstream.status}`, source: target.id },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": target.contentType,
        "Cache-Control": `public, max-age=${target.maxAge}, stale-while-revalidate=${Math.max(target.maxAge, 30)}`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: `Не удалось получить данные: ${message}`, source: target.id },
      { status: 504, headers: { "Cache-Control": "no-store" } },
    );
  }
}
