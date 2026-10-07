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

export type LiveLayerId =
  | "flights"
  | "satellites"
  | "weather"
  | "vessels"
  | "fires"
  | "cameras"
  | "earthquakes"
  | "cyclones"
  | "launches"
  | "datacenters"
  | "dams"
  | "volcanoes"
  | "cctv"
  | "iss";

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
  { id: "earthquakes", label: "Землетрясения", source: "USGS", needsKey: false },
  { id: "cyclones", label: "Циклоны", source: "NHC NOAA", needsKey: false },
  { id: "launches", label: "Пуски ракет", source: "SpaceX API", needsKey: false },
  { id: "datacenters", label: "Дата-центры", source: "Bundled", needsKey: false },
  { id: "dams", label: "Плотины", source: "Bundled", needsKey: false },
  { id: "volcanoes", label: "Вулканы", source: "Bundled", needsKey: false },
  { id: "cctv", label: "Городские камеры", source: "Bundled", needsKey: false },
  { id: "iss", label: "МКС", source: "wheretheiss.at", needsKey: false },
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
    case "earthquakes":
      return startEarthquakes(viewer, onError);
    case "cyclones":
      return startCyclones(viewer, onError);
    case "launches":
      return startLaunches(viewer, onError);
    case "datacenters":
      return startBundledPins(viewer, onError, {
        url: "/geo/datacenters.json",
        sourceName: "hq-geo-datacenters",
        color: Cesium.Color.fromCssColorString("#9b7bff"),
        pixelSize: 7,
        label: (it: BundledItem) => `${it.name} · ${it.operator ?? it.country}`,
      });
    case "dams":
      return startBundledPins(viewer, onError, {
        url: "/geo/dams.json",
        sourceName: "hq-geo-dams",
        color: Cesium.Color.fromCssColorString("#4bd1ff"),
        pixelSize: 6,
        label: (it: BundledItem) => `${it.name} · ${it.capacityMW ? `${it.capacityMW} МВт` : it.country}`,
      });
    case "volcanoes":
      return startBundledPins(viewer, onError, {
        url: "/geo/volcanoes.json",
        sourceName: "hq-geo-volcanoes",
        color: Cesium.Color.fromCssColorString("#ff5a3a"),
        pixelSize: 6,
        label: (it: BundledItem) => `${it.name}${it.capacityMW ? "" : ""}`,
      });
    case "cctv":
      return startBundledPins(viewer, onError, {
        url: "/geo/cameras-public.json",
        sourceName: "hq-geo-cctv",
        color: Cesium.Color.fromCssColorString("#5affe6"),
        pixelSize: 5,
        label: (it: BundledItem) => `${it.name}`,
      });
    case "iss":
      return startIss(viewer, onError);
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

// --- Earthquakes (USGS past day, M2.5+, keyless, via proxy) ------------------

const USGS_URL = "/api/geo/live?source=earthquakes";
const EQ_INTERVAL_MS = 5 * 60 * 1_000;
const MAX_QUAKES = 400;

type UsgsQuake = {
  properties: { mag: number; place: string; time: number; title?: string };
  geometry: { coordinates: [number, number, number] };
  id: string;
};
type UsgsFeed = { features?: UsgsQuake[] };

function quakeColor(mag: number): Cesium.Color {
  if (mag >= 6) return Cesium.Color.fromCssColorString("#ff3b3b");
  if (mag >= 5) return Cesium.Color.fromCssColorString("#ff8a3a");
  if (mag >= 4) return Cesium.Color.fromCssColorString("#ffd24a");
  return Cesium.Color.fromCssColorString("#8ad6ff");
}

function startEarthquakes(viewer: Cesium.Viewer, onError: (message: string) => void): LiveLayerHandle {
  const source = new Cesium.CustomDataSource("hq-geo-earthquakes");
  void viewer.dataSources.add(source);
  let alive = true;

  const tick = async (): Promise<void> => {
    try {
      const response = await fetch(USGS_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`USGS ${response.status}`);
      const data = (await response.json()) as UsgsFeed;
      if (!alive) return;
      source.entities.removeAll();
      const features = (data.features ?? []).slice(0, MAX_QUAKES);
      for (const feature of features) {
        const [lon, lat, depth] = feature.geometry.coordinates;
        const mag = feature.properties.mag ?? 0;
        source.entities.add({
          id: `eq-${feature.id}`,
          position: Cesium.Cartesian3.fromDegrees(lon, lat, -depth * 1_000),
          point: {
            pixelSize: Math.max(4, Math.min(22, 4 + mag * 2.5)),
            color: quakeColor(mag).withAlpha(0.75),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.5),
            outlineWidth: 1,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          properties: {
            kind: "earthquake",
            magnitude: mag,
            place: feature.properties.place,
            time: feature.properties.time,
          },
        });
      }
      viewer.scene.requestRender();
    } catch (error) {
      if (alive) onError(message(error));
    }
  };

  const poller = makePoller(tick, EQ_INTERVAL_MS);
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

// --- Cyclones (NHC active KML, keyless, via proxy) ---------------------------

const NHC_URL = "/api/geo/live?source=cyclones-atlantic";
const CYCLONE_INTERVAL_MS = 10 * 60 * 1_000;

function startCyclones(viewer: Cesium.Viewer, onError: (message: string) => void): LiveLayerHandle {
  const source = new Cesium.CustomDataSource("hq-geo-cyclones");
  void viewer.dataSources.add(source);
  let alive = true;

  // Match the eye position (longitude, latitude) carried in <coordinates>.
  const COORD_RE = /<coordinates>\s*([-\d.]+)\s*,\s*([-\d.]+)/gi;
  // Match the short label on the storm's track.
  const NAME_RE = /<name>([^<]{1,80})<\/name>/i;

  const tick = async (): Promise<void> => {
    try {
      const response = await fetch(NHC_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`NHC ${response.status}`);
      const kml = await response.text();
      if (!alive) return;
      source.entities.removeAll();
      // The NHC "nhc_active.kml" is a NetworkLink wrapper; it still carries the per-storm
      // names and coordinates for the browser to show as markers until we parse the sub-KMLs.
      const nameMatch = kml.match(NAME_RE);
      const storms: Array<{ lon: number; lat: number }> = [];
      for (const match of kml.matchAll(COORD_RE)) {
        const lon = Number.parseFloat(match[1]);
        const lat = Number.parseFloat(match[2]);
        if (Number.isFinite(lon) && Number.isFinite(lat)) storms.push({ lon, lat });
      }
      const label = nameMatch?.[1]?.trim() ?? "Active cyclones";
      storms.slice(0, 32).forEach((s, i) => {
        source.entities.add({
          id: `cy-${i}`,
          position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 0),
          point: {
            pixelSize: 10,
            color: Cesium.Color.fromCssColorString("#54f0c8").withAlpha(0.85),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.5),
            outlineWidth: 1,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: label,
            font: "10px monospace",
            pixelOffset: new Cesium.Cartesian2(10, -10),
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            showBackground: true,
            backgroundColor: Cesium.Color.BLACK.withAlpha(0.5),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          properties: { kind: "cyclone", name: label },
        });
      });
      viewer.scene.requestRender();
    } catch (error) {
      if (alive) onError(message(error));
    }
  };

  const poller = makePoller(tick, CYCLONE_INTERVAL_MS);
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

// --- Rocket launches (SpaceX upcoming, keyless, via proxy) -------------------

const LAUNCHES_URL = "/api/geo/live?source=rocket-launches";
const LAUNCHES_INTERVAL_MS = 15 * 60 * 1_000;

type LlLaunch = {
  id: string;
  name: string;
  net: string;
  pad?: {
    latitude?: string | number | null;
    longitude?: string | number | null;
    name?: string | null;
    location?: { name?: string | null; country_code?: string | null };
  };
  mission?: { orbit?: { abbrev?: string | null; name?: string | null } };
};
type LlResponse = { results?: LlLaunch[] };

/** Default launch azimuth (deg clockwise from north) for an orbit class. */
function azimuthForOrbit(abbrev: string | null | undefined, padLat: number): number {
  const a = (abbrev ?? "").toUpperCase();
  if (a.includes("SSO") || a.includes("POLAR")) return 196; // south-south-west
  if (a.includes("GEO") || a.includes("GTO")) return 95; // east, slight south for GTO
  if (a.includes("ISS")) return padLat >= 0 ? 45 : 135; // Russian/US ISS corridor
  return 95; // generic prograde east
}

/** A parabolic trajectory sample set from (lat/lon) along `azDeg` for `rangeKm`,
 *  peaking at `apogeeKm`. Returns Cesium Cartesian3 positions along the arc. */
function trajectoryArc(
  lat: number,
  lon: number,
  azDeg: number,
  rangeKm: number,
  apogeeKm: number,
  samples = 48,
): Cesium.Cartesian3[] {
  const positions: Cesium.Cartesian3[] = [];
  const earthRadiusKm = 6378.137;
  const azRad = (azDeg * Math.PI) / 180;
  const sinAz = Math.sin(azRad);
  const cosAz = Math.cos(azRad);
  const latRad = (lat * Math.PI) / 180;
  const cosLat = Math.cos(latRad);
  for (let i = 0; i <= samples; i += 1) {
    const f = i / samples; // 0..1
    const distKm = f * rangeKm;
    // Approximate dlat/dlon from an initial-course great-circle step; good enough
    // for a visualization arc up to ~2000 km.
    const dLatDeg = ((distKm / earthRadiusKm) * (180 / Math.PI)) * cosAz;
    const dLonDeg = ((distKm / earthRadiusKm) * (180 / Math.PI)) * sinAz / Math.max(0.01, cosLat);
    // Classic parabolic altitude profile, zero at both ends.
    const h = 4 * apogeeKm * f * (1 - f);
    positions.push(Cesium.Cartesian3.fromDegrees(lon + dLonDeg, lat + dLatDeg, h * 1000));
  }
  return positions;
}

function startLaunches(viewer: Cesium.Viewer, onError: (message: string) => void): LiveLayerHandle {
  const source = new Cesium.CustomDataSource("hq-geo-launches");
  void viewer.dataSources.add(source);
  let alive = true;

  const tick = async (): Promise<void> => {
    try {
      const response = await fetch(LAUNCHES_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`Launch Library ${response.status}`);
      const data = (await response.json()) as LlResponse;
      if (!alive) return;
      source.entities.removeAll();
      const now = Date.now();
      const launches = (data.results ?? []).slice(0, 24);
      // Draw a visual trajectory arc only for the next few launches, so a busy pad
      // list doesn't clutter the globe. The pad-pin itself still shows for all.
      const ARC_LIMIT = 6;
      let arcsDrawn = 0;
      for (const launch of launches) {
        const lat = Number(launch.pad?.latitude);
        const lon = Number(launch.pad?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const padName = `${launch.pad?.name ?? ""}${launch.pad?.location?.name ? `, ${launch.pad?.location?.name}` : ""}`.trim();
        const t = new Date(launch.net).getTime();
        const whenHours = Number.isFinite(t) ? (t - now) / 3_600_000 : 0;
        // Trajectory arc (approximate — azimuth from orbit class, 400 km apogee, 1500 km range).
        if (arcsDrawn < ARC_LIMIT) {
          const az = azimuthForOrbit(launch.mission?.orbit?.abbrev, lat);
          const positions = trajectoryArc(lat, lon, az, 1500, 400, 48);
          source.entities.add({
            id: `lx-arc-${launch.id}`,
            polyline: {
              positions,
              width: 2,
              material: new Cesium.PolylineGlowMaterialProperty({
                color: Cesium.Color.fromCssColorString("#ff8a3a").withAlpha(0.85),
                glowPower: 0.25,
                taperPower: 0.4,
              }),
              arcType: Cesium.ArcType.NONE,
            },
          });
          arcsDrawn += 1;
        }
        source.entities.add({
          id: `lx-${launch.id}`,
          position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
          point: {
            pixelSize: 9,
            color: Cesium.Color.fromCssColorString("#ff8a3a").withAlpha(0.9),
            outlineColor: Cesium.Color.WHITE.withAlpha(0.8),
            outlineWidth: 1,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: `${launch.name} · ${padName || "launch pad"}`,
            font: "10px monospace",
            pixelOffset: new Cesium.Cartesian2(10, -10),
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            showBackground: true,
            backgroundColor: Cesium.Color.BLACK.withAlpha(0.55),
            scaleByDistance: new Cesium.NearFarScalar(2.0e6, 1.0, 2.0e7, 0.0),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          properties: {
            kind: "launch",
            name: launch.name,
            pad: padName,
            when: launch.net,
            hoursFromNow: whenHours,
          },
        });
      }
      viewer.scene.requestRender();
    } catch (error) {
      if (alive) onError(message(error));
    }
  };

  const poller = makePoller(tick, LAUNCHES_INTERVAL_MS);
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

// --- ISS live position (wheretheiss.at, keyless, via proxy) ------------------

const ISS_URL = "/api/geo/live?source=iss";
const ISS_INTERVAL_MS = 5_000;

type IssPos = { latitude?: number; longitude?: number; altitude?: number; velocity?: number };

function startIss(viewer: Cesium.Viewer, onError: (message: string) => void): LiveLayerHandle {
  const source = new Cesium.CustomDataSource("hq-geo-iss");
  void viewer.dataSources.add(source);
  const pos = new Cesium.ConstantPositionProperty(Cesium.Cartesian3.fromDegrees(0, 0, 0));
  let alive = true;
  let entity: Cesium.Entity | null = null;

  const ensureEntity = () => {
    if (entity) return;
    entity = source.entities.add({
      id: "iss",
      position: pos,
      point: {
        pixelSize: 9,
        color: Cesium.Color.fromCssColorString("#ff4a9c").withAlpha(0.95),
        outlineColor: Cesium.Color.WHITE.withAlpha(0.9),
        outlineWidth: 1.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: "МКС (ISS)",
        font: "10px monospace",
        pixelOffset: new Cesium.Cartesian2(10, -10),
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        showBackground: true,
        backgroundColor: Cesium.Color.BLACK.withAlpha(0.55),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      properties: { kind: "iss", name: "International Space Station" },
    });
  };

  const tick = async (): Promise<void> => {
    try {
      const response = await fetch(ISS_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`ISS ${response.status}`);
      const data = (await response.json()) as IssPos;
      if (!alive) return;
      const { latitude, longitude, altitude, velocity } = data;
      if (typeof latitude !== "number" || typeof longitude !== "number") return;
      ensureEntity();
      pos.setValue(Cesium.Cartesian3.fromDegrees(longitude, latitude, (altitude ?? 420) * 1_000));
      if (entity) {
        entity.properties = new Cesium.PropertyBag({
          kind: "iss",
          name: "International Space Station",
          altitudeKm: altitude,
          velocityKmh: velocity,
          lat: latitude,
          lon: longitude,
        });
      }
      viewer.scene.requestRender();
    } catch (error) {
      if (alive) onError(message(error));
    }
  };

  const poller = makePoller(tick, ISS_INTERVAL_MS);
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

// --- Bundled static catalogues (datacenters, dams) --------------------------

type BundledItem = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  country?: string;
  operator?: string;
  capacityMW?: number;
};
type BundledSet = { items?: BundledItem[] };

function startBundledPins(
  viewer: Cesium.Viewer,
  onError: (message: string) => void,
  opts: {
    url: string;
    sourceName: string;
    color: Cesium.Color;
    pixelSize: number;
    label: (item: BundledItem) => string;
  },
): LiveLayerHandle {
  const source = new Cesium.CustomDataSource(opts.sourceName);
  void viewer.dataSources.add(source);
  let alive = true;

  (async () => {
    try {
      const response = await fetch(opts.url, { cache: "force-cache" });
      if (!response.ok) throw new Error(`${opts.url} ${response.status}`);
      const data = (await response.json()) as BundledSet;
      if (!alive) return;
      for (const item of data.items ?? []) {
        source.entities.add({
          id: `bp-${item.id}`,
          position: Cesium.Cartesian3.fromDegrees(item.lon, item.lat, 0),
          point: {
            pixelSize: opts.pixelSize,
            color: opts.color.withAlpha(0.85),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.5),
            outlineWidth: 1,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: opts.label(item),
            font: "10px monospace",
            pixelOffset: new Cesium.Cartesian2(8, -8),
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            showBackground: true,
            backgroundColor: Cesium.Color.BLACK.withAlpha(0.55),
            scaleByDistance: new Cesium.NearFarScalar(1.5e6, 1.0, 2.0e7, 0.0),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          properties: { kind: opts.sourceName.replace("hq-geo-", ""), ...item },
        });
      }
      viewer.scene.requestRender();
    } catch (error) {
      if (alive) onError(message(error));
    }
  })();

  return {
    setPaused() {
      // Static catalogues have nothing to pause.
    },
    destroy() {
      alive = false;
      viewer.dataSources.remove(source, true);
    },
  };
}
