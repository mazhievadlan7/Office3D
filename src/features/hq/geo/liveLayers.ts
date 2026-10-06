import * as Cesium from "cesium";
import * as satellite from "satellite.js";

/**
 * Live public-data layers for the «ГЕО» view. Each layer is a clean on/off unit
 * behind one handle interface, so the full-screen globe (and later the OSINT /
 * ops backend) can turn each on and off, pause it when the tab is hidden, and
 * tear it down on close through the same seam.
 *
 * SCOPE & LAWFULNESS. Everything here is OPEN PUBLIC data, view-only: live
 * aircraft (OpenSky), satellites (CelesTrak TLE), precipitation radar
 * (RainViewer), vessels (AISStream), wildfires (NASA FIRMS) and public webcams
 * (Windy). No layer plots anything about an engagement target; they are a live
 * backdrop the owner and operators watch. Egress goes ONLY to the public
 * endpoints named below.
 *
 * PERFORMANCE. Nothing here runs unless a layer is turned on. Every layer polls
 * on a throttled timer (or a single push socket), caps how many entities it
 * plots, pauses when the view is hidden, and calls scene.requestRender() only
 * when something changed — so Cesium's requestRenderMode keeps the GPU idle
 * between updates and the layers add no cost while the globe is closed (the view
 * unmounts and destroy() runs).
 */

export type LiveLayerId = "flights" | "satellites" | "weather" | "vessels" | "fires" | "cameras";

export type LiveLayerDef = {
  id: LiveLayerId;
  label: string;
  /** The public source, for the UI's "needs egress" note. */
  source: string;
  /** True when the source needs a free API key (gated behind an env var). */
  needsKey: boolean;
  /** The env var that supplies the key, when needsKey. */
  keyEnv?: string;
};

export const LIVE_LAYERS: readonly LiveLayerDef[] = [
  { id: "flights", label: "Рейсы", source: "OpenSky", needsKey: false },
  { id: "satellites", label: "Спутники", source: "CelesTrak", needsKey: false },
  { id: "weather", label: "Погода", source: "RainViewer", needsKey: false },
  { id: "vessels", label: "Суда", source: "AISStream", needsKey: true, keyEnv: "NEXT_PUBLIC_AISSTREAM_KEY" },
  { id: "fires", label: "Пожары", source: "NASA FIRMS", needsKey: true, keyEnv: "NEXT_PUBLIC_NASA_FIRMS_KEY" },
  { id: "cameras", label: "Камеры", source: "Windy", needsKey: true, keyEnv: "NEXT_PUBLIC_WINDY_WEBCAMS_KEY" },
];

/** Keys for the key-gated layers, read from NEXT_PUBLIC_* at build time. */
const LIVE_KEYS: Record<"vessels" | "fires" | "cameras", string> = {
  vessels: (process.env.NEXT_PUBLIC_AISSTREAM_KEY ?? "").trim(),
  fires: (process.env.NEXT_PUBLIC_NASA_FIRMS_KEY ?? "").trim(),
  cameras: (process.env.NEXT_PUBLIC_WINDY_WEBCAMS_KEY ?? "").trim(),
};

/** True when a layer can run now (keyless, or its key is configured). */
export function layerAvailable(id: LiveLayerId): boolean {
  if (id === "vessels" || id === "fires" || id === "cameras") return LIVE_KEYS[id].length > 0;
  return true;
}

/** A running layer: how to pause/resume it and how to tear it down. */
export type LiveLayerHandle = {
  /** Pause (stop polling / close socket) when the view is hidden; resume on return. */
  setPaused(paused: boolean): void;
  destroy(): void;
};

/** A picked public webcam, surfaced to the view for a DOM thumbnail panel. */
export type GeoCameraInfo = {
  title: string;
  place: string;
  preview: string;
  detail?: string;
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A throttled poll: ticks immediately on start, then every intervalMs. */
type Poller = { start(): void; stop(): void };
function makePoller(tick: () => void | Promise<void>, intervalMs: number): Poller {
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    start() {
      if (timer !== null) return;
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

// --- Flights (OpenSky, keyless, via our own geo proxy) ----------------------

// OpenSky's public endpoint sets `Access-Control-Allow-Origin: https://opensky-network.org`
// (not `*`), so a browser cannot fetch it directly cross-origin. We route through our own
// Next route, which also keeps the egress single-point / inspectable (TZ §4.2).
const OPENSKY_URL = "/api/geo/live?source=flights";
const FLIGHTS_INTERVAL_MS = 20_000;
const MAX_FLIGHTS = 500;

/** Altitude-graded palette, reused so each refresh allocates no colours. */
const FLIGHT_COLORS = [
  Cesium.Color.fromCssColorString("#ff8a3a"),
  Cesium.Color.fromCssColorString("#ffd24a"),
  Cesium.Color.fromCssColorString("#9effa0"),
  Cesium.Color.fromCssColorString("#4ab8ff"),
];
function flightColor(altMeters: number): Cesium.Color {
  if (altMeters < 2_000) return FLIGHT_COLORS[0];
  if (altMeters < 6_000) return FLIGHT_COLORS[1];
  if (altMeters < 10_000) return FLIGHT_COLORS[2];
  return FLIGHT_COLORS[3];
}

function startFlights(viewer: Cesium.Viewer, onError: (message: string) => void): LiveLayerHandle {
  const source = new Cesium.CustomDataSource("hq-geo-flights");
  void viewer.dataSources.add(source);
  let alive = true;

  const tick = async (): Promise<void> => {
    try {
      const response = await fetch(OPENSKY_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`OpenSky ${response.status}`);
      const data = (await response.json()) as { states?: unknown[] };
      if (!alive) return;
      source.entities.removeAll();
      const states = Array.isArray(data.states) ? data.states : [];
      let plotted = 0;
      for (const raw of states) {
        if (plotted >= MAX_FLIGHTS) break;
        const state = raw as unknown[];
        const lon = state[5];
        const lat = state[6];
        const alt = state[7] ?? state[13];
        if (typeof lon !== "number" || typeof lat !== "number") continue;
        const altMeters = typeof alt === "number" ? alt : 0;
        source.entities.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat, altMeters),
          point: {
            pixelSize: 4,
            color: flightColor(altMeters),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
        plotted += 1;
      }
      viewer.scene.requestRender();
    } catch (error) {
      if (alive) onError(message(error));
    }
  };

  const poller = makePoller(tick, FLIGHTS_INTERVAL_MS);
  poller.start();
  return {
    setPaused(paused) {
      if (paused) poller.stop();
      else poller.start();
    },
    destroy() {
      alive = false;
      poller.stop();
      viewer.dataSources.remove(source, true);
    },
  };
}

// --- Satellites (CelesTrak TLE + satellite.js SGP4, keyless, via proxy) -----

// CelesTrak serves CORS `*` directly, but we still route through our own geo proxy to keep
// one egress path and let the server-side allowlist decide which TLE group is loaded.
const TLE_URL = "/api/geo/live?source=satellites-visual";
const SAT_PROP_INTERVAL_MS = 1_500;
const SAT_TLE_INTERVAL_MS = 3 * 60 * 60 * 1_000;
const MAX_SATS = 220;
const SAT_COLOR = Cesium.Color.fromCssColorString("#8ad6ff");

type SatEntry = { rec: satellite.SatRec; pos: Cesium.ConstantPositionProperty };

function startSatellites(viewer: Cesium.Viewer, onError: (message: string) => void): LiveLayerHandle {
  const source = new Cesium.CustomDataSource("hq-geo-satellites");
  void viewer.dataSources.add(source);
  let alive = true;
  let sats: SatEntry[] = [];

  const build = (tle: string): void => {
    source.entities.removeAll();
    sats = [];
    const lines = tle.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (let i = 0; i + 2 < lines.length && sats.length < MAX_SATS; i += 3) {
      const l1 = lines[i + 1];
      const l2 = lines[i + 2];
      if (!l1.startsWith("1 ") || !l2.startsWith("2 ")) continue;
      let rec: satellite.SatRec;
      try {
        rec = satellite.twoline2satrec(l1, l2);
      } catch {
        continue;
      }
      const pos = new Cesium.ConstantPositionProperty(Cesium.Cartesian3.fromDegrees(0, 0, 0));
      source.entities.add({
        position: pos,
        point: { pixelSize: 3, color: SAT_COLOR, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      });
      sats.push({ rec, pos });
    }
  };

  const propagate = (): void => {
    if (!alive || sats.length === 0) return;
    const now = new Date();
    const gmst = satellite.gstime(now);
    for (const sat of sats) {
      const pv = satellite.propagate(sat.rec, now);
      if (!pv || typeof pv.position === "boolean") continue;
      const geo = satellite.eciToGeodetic(pv.position, gmst);
      sat.pos.setValue(
        Cesium.Cartesian3.fromDegrees(
          satellite.degreesLong(geo.longitude),
          satellite.degreesLat(geo.latitude),
          geo.height * 1_000,
        ),
      );
    }
    viewer.scene.requestRender();
  };

  const loadTle = async (): Promise<void> => {
    try {
      const response = await fetch(TLE_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`CelesTrak ${response.status}`);
      const tle = await response.text();
      if (!alive) return;
      build(tle);
      propagate();
    } catch (error) {
      if (alive) onError(message(error));
    }
  };

  const tlePoller = makePoller(loadTle, SAT_TLE_INTERVAL_MS);
  const propPoller = makePoller(propagate, SAT_PROP_INTERVAL_MS);
  tlePoller.start();
  propPoller.start();
  return {
    setPaused(paused) {
      if (paused) {
        propPoller.stop();
        tlePoller.stop();
      } else {
        tlePoller.start();
        propPoller.start();
      }
    },
    destroy() {
      alive = false;
      propPoller.stop();
      tlePoller.stop();
      viewer.dataSources.remove(source, true);
    },
  };
}

// --- Weather (RainViewer precipitation radar, keyless imagery) --------------

// RainViewer serves CORS `*`, but the catalog goes through our proxy for a single egress path.
// The actual tile PNGs are still loaded by Cesium directly from `data.host` (an image CDN).
const RAINVIEWER_INDEX = "/api/geo/live?source=weather-index";
const WEATHER_INTERVAL_MS = 4 * 60 * 1_000;

type RainViewerFrame = { path: string };
type RainViewerIndex = { host?: string; radar?: { past?: RainViewerFrame[]; nowcast?: RainViewerFrame[] } };

function startWeather(viewer: Cesium.Viewer, onError: (message: string) => void): LiveLayerHandle {
  let alive = true;
  let layer: Cesium.ImageryLayer | null = null;

  const tick = async (): Promise<void> => {
    try {
      const response = await fetch(RAINVIEWER_INDEX, { cache: "no-store" });
      if (!response.ok) throw new Error(`RainViewer ${response.status}`);
      const data = (await response.json()) as RainViewerIndex;
      if (!alive) return;
      const frames = [...(data.radar?.past ?? []), ...(data.radar?.nowcast ?? [])];
      const latest = frames[frames.length - 1];
      if (!latest) return;
      const host = data.host ?? "https://tilecache.rainviewer.com";
      // color 4 = "Weather Channel"; options {smooth}_{snow} = 1_1.
      const provider = new Cesium.UrlTemplateImageryProvider({
        url: `${host}${latest.path}/256/{z}/{x}/{y}/4/1_1.png`,
        maximumLevel: 10,
        credit: new Cesium.Credit("RainViewer", true),
      });
      const next = viewer.imageryLayers.addImageryProvider(provider);
      next.alpha = 0.72;
      const previous = layer;
      layer = next;
      if (previous) viewer.imageryLayers.remove(previous, true);
      viewer.scene.requestRender();
    } catch (error) {
      if (alive) onError(message(error));
    }
  };

  const poller = makePoller(tick, WEATHER_INTERVAL_MS);
  poller.start();
  return {
    setPaused(paused) {
      if (paused) poller.stop();
      else poller.start();
    },
    destroy() {
      alive = false;
      poller.stop();
      if (layer) viewer.imageryLayers.remove(layer, true);
    },
  };
}

// --- Vessels (AISStream push socket, free key) ------------------------------

const AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream";
const MAX_VESSELS = 1_200;
const VESSEL_COLOR = Cesium.Color.fromCssColorString("#54f0c8");
const VESSEL_RENDER_INTERVAL_MS = 1_000;

type AisMessage = {
  MessageType?: string;
  MetaData?: { MMSI?: number };
  Message?: { PositionReport?: { Latitude?: number; Longitude?: number } };
};

function startVessels(viewer: Cesium.Viewer, onError: (message: string) => void, key: string): LiveLayerHandle {
  const source = new Cesium.CustomDataSource("hq-geo-vessels");
  void viewer.dataSources.add(source);
  const byMmsi = new Map<number, Cesium.ConstantPositionProperty>();
  let alive = true;
  let socket: WebSocket | null = null;
  let dirty = false;

  const connect = (): void => {
    try {
      socket = new WebSocket(AISSTREAM_URL);
    } catch (error) {
      onError(message(error));
      return;
    }
    socket.onopen = () => {
      socket?.send(
        JSON.stringify({ APIKey: key, BoundingBoxes: [[[-90, -180], [90, 180]]], FilterMessageTypes: ["PositionReport"] }),
      );
    };
    socket.onerror = () => {
      if (alive) onError("AISStream");
    };
    socket.onmessage = (event: MessageEvent) => {
      if (!alive || typeof event.data !== "string") return;
      let parsed: AisMessage;
      try {
        parsed = JSON.parse(event.data) as AisMessage;
      } catch {
        return;
      }
      if (parsed.MessageType !== "PositionReport") return;
      const report = parsed.Message?.PositionReport;
      const mmsi = parsed.MetaData?.MMSI;
      if (!report || typeof report.Latitude !== "number" || typeof report.Longitude !== "number" || typeof mmsi !== "number") {
        return;
      }
      const cart = Cesium.Cartesian3.fromDegrees(report.Longitude, report.Latitude);
      const existing = byMmsi.get(mmsi);
      if (existing) {
        existing.setValue(cart);
      } else {
        if (byMmsi.size >= MAX_VESSELS) return;
        const pos = new Cesium.ConstantPositionProperty(cart);
        source.entities.add({
          position: pos,
          point: { pixelSize: 3, color: VESSEL_COLOR, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        });
        byMmsi.set(mmsi, pos);
      }
      dirty = true;
    };
  };

  // Batch renders: AIS is a firehose, so repaint at most once a second.
  const renderPoller = makePoller(() => {
    if (!dirty) return;
    dirty = false;
    viewer.scene.requestRender();
  }, VESSEL_RENDER_INTERVAL_MS);

  connect();
  renderPoller.start();
  return {
    setPaused(paused) {
      if (paused) {
        renderPoller.stop();
        socket?.close();
        socket = null;
      } else {
        renderPoller.start();
        if (!socket) connect();
      }
    },
    destroy() {
      alive = false;
      renderPoller.stop();
      socket?.close();
      socket = null;
      viewer.dataSources.remove(source, true);
    },
  };
}

// --- Fires (NASA FIRMS VIIRS active-fire CSV, free key) ---------------------

const FIRMS_INTERVAL_MS = 15 * 60 * 1_000;
const MAX_FIRES = 3_000;
const FIRE_COLOR = Cesium.Color.fromCssColorString("#ff5a24");

function startFires(viewer: Cesium.Viewer, onError: (message: string) => void, key: string): LiveLayerHandle {
  const source = new Cesium.CustomDataSource("hq-geo-fires");
  void viewer.dataSources.add(source);
  let alive = true;

  const tick = async (): Promise<void> => {
    try {
      const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_SNPP_NRT/world/1`;
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`FIRMS ${response.status}`);
      const csv = await response.text();
      if (!alive) return;
      const rows = csv.split(/\r?\n/);
      const header = rows[0]?.split(",") ?? [];
      const latIndex = header.indexOf("latitude");
      const lonIndex = header.indexOf("longitude");
      if (latIndex < 0 || lonIndex < 0) throw new Error("FIRMS: формат CSV");
      source.entities.removeAll();
      let plotted = 0;
      for (let i = 1; i < rows.length && plotted < MAX_FIRES; i += 1) {
        const cells = rows[i].split(",");
        const lat = Number(cells[latIndex]);
        const lon = Number(cells[lonIndex]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        source.entities.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat),
          point: { pixelSize: 4, color: FIRE_COLOR, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        });
        plotted += 1;
      }
      viewer.scene.requestRender();
    } catch (error) {
      if (alive) onError(message(error));
    }
  };

  const poller = makePoller(tick, FIRMS_INTERVAL_MS);
  poller.start();
  return {
    setPaused(paused) {
      if (paused) poller.stop();
      else poller.start();
    },
    destroy() {
      alive = false;
      poller.stop();
      viewer.dataSources.remove(source, true);
    },
  };
}

// --- Cameras (Windy public webcams, free key) -------------------------------

const WINDY_URL = "https://api.windy.com/webcams/api/v3/webcams?limit=50&include=location,images";
const CAMERAS_INTERVAL_MS = 5 * 60 * 1_000;
const MAX_CAMERAS = 60;
const CAMERA_COLOR = Cesium.Color.fromCssColorString("#4ab8ff");

type WindyWebcam = {
  webcamId?: number;
  title?: string;
  location?: { latitude?: number; longitude?: number; city?: string; country?: string };
  images?: { current?: { preview?: string } };
};

/** The cameras layer tags each entity so the view can surface its thumbnail. */
export const GEO_CAMERA_PROPERTY = "hqGeoCamera";

function startCameras(viewer: Cesium.Viewer, onError: (message: string) => void, key: string): LiveLayerHandle {
  const source = new Cesium.CustomDataSource("hq-geo-cameras");
  void viewer.dataSources.add(source);
  let alive = true;

  const tick = async (): Promise<void> => {
    try {
      const response = await fetch(WINDY_URL, { headers: { "x-windy-api-key": key }, cache: "no-store" });
      if (!response.ok) throw new Error(`Windy ${response.status}`);
      const data = (await response.json()) as { webcams?: WindyWebcam[] };
      if (!alive) return;
      source.entities.removeAll();
      const webcams = Array.isArray(data.webcams) ? data.webcams.slice(0, MAX_CAMERAS) : [];
      for (const cam of webcams) {
        const lat = cam.location?.latitude;
        const lon = cam.location?.longitude;
        const preview = cam.images?.current?.preview;
        if (typeof lat !== "number" || typeof lon !== "number" || !preview) continue;
        const place = [cam.location?.city, cam.location?.country].filter(Boolean).join(", ");
        const info: GeoCameraInfo = {
          title: cam.title ?? (place || "Webcam"),
          place,
          preview,
          detail: cam.webcamId ? `https://www.windy.com/webcams/${cam.webcamId}` : undefined,
        };
        const entity = source.entities.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat),
          point: {
            pixelSize: 6,
            color: CAMERA_COLOR,
            outlineColor: Cesium.Color.fromCssColorString("#06080c").withAlpha(0.85),
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
        entity.properties = new Cesium.PropertyBag({ [GEO_CAMERA_PROPERTY]: info });
      }
      viewer.scene.requestRender();
    } catch (error) {
      if (alive) onError(message(error));
    }
  };

  const poller = makePoller(tick, CAMERAS_INTERVAL_MS);
  poller.start();
  return {
    setPaused(paused) {
      if (paused) poller.stop();
      else poller.start();
    },
    destroy() {
      alive = false;
      poller.stop();
      viewer.dataSources.remove(source, true);
    },
  };
}

/**
 * Starts a live layer by id, reading any needed key from the environment.
 * Returns null when a key-gated layer has no key configured (the caller shows a
 * "needs key" notice instead).
 */
export function startLiveLayer(
  id: LiveLayerId,
  viewer: Cesium.Viewer,
  onError: (message: string) => void,
): LiveLayerHandle | null {
  switch (id) {
    case "flights":
      return startFlights(viewer, onError);
    case "satellites":
      return startSatellites(viewer, onError);
    case "weather":
      return startWeather(viewer, onError);
    case "vessels":
      return LIVE_KEYS.vessels ? startVessels(viewer, onError, LIVE_KEYS.vessels) : null;
    case "fires":
      return LIVE_KEYS.fires ? startFires(viewer, onError, LIVE_KEYS.fires) : null;
    case "cameras":
      return LIVE_KEYS.cameras ? startCameras(viewer, onError, LIVE_KEYS.cameras) : null;
    default:
      return null;
  }
}
