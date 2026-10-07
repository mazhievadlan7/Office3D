import * as Cesium from "cesium";

/**
 * «Режиссёр» — a tiny cinematic tour recorder/player. The owner (or an agent)
 * records a sequence of camera keyframes with a title and an optional caption,
 * then plays it back as a smooth tour: the camera flies between keyframes with
 * eased durations. Pure Cesium camera manipulation — no GLSL, no third-party
 * tweens — so a tour runs in any browser the globe already runs in.
 *
 * A tour is small structured data: {name, frames: [{lat,lon,height,heading,pitch,
 * seconds,caption}]}. It serializes to JSON (download), and loads back cleanly.
 */

export type DirectorFrame = {
  lat: number;
  lon: number;
  height: number;
  heading?: number;
  pitch?: number;
  /** Seconds the camera takes to reach this frame from the previous one. */
  seconds: number;
  /** Optional caption shown while the camera travels to this frame. */
  caption?: string;
};

export type DirectorTour = {
  id: string;
  name: string;
  frames: DirectorFrame[];
  /** When the tour was recorded (UTC ms). */
  recordedAt: number;
};

const makeId = (seed: number): string => `tour_${seed.toString(36)}`;

/** Read the camera's current state as a frame. `seconds` is a sensible default. */
export function cameraToFrame(viewer: Cesium.Viewer, seconds: number, caption?: string): DirectorFrame {
  const carto = Cesium.Cartographic.fromCartesian(viewer.camera.position);
  return {
    lat: Cesium.Math.toDegrees(carto.latitude),
    lon: Cesium.Math.toDegrees(carto.longitude),
    height: carto.height,
    heading: Cesium.Math.toDegrees(viewer.camera.heading),
    pitch: Cesium.Math.toDegrees(viewer.camera.pitch),
    seconds,
    caption,
  };
}

/** Build an empty tour. */
export function newTour(name: string): DirectorTour {
  return { id: makeId(Date.now()), name: name.trim() || "Безымянный тур", frames: [], recordedAt: Date.now() };
}

/** Fly to a single frame. Returns a promise that resolves when the fly ends. */
export function flyToFrame(viewer: Cesium.Viewer, frame: DirectorFrame): Promise<void> {
  return new Promise((resolve) => {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(frame.lon, frame.lat, frame.height),
      orientation: {
        heading: Cesium.Math.toRadians(frame.heading ?? 0),
        pitch: Cesium.Math.toRadians(frame.pitch ?? -90),
        roll: 0,
      },
      duration: Math.max(0.4, Math.min(30, frame.seconds)),
      complete: resolve,
      cancel: resolve,
    });
  });
}

export type DirectorPlayHandle = {
  stop(): void;
  readonly playing: boolean;
};

/**
 * Play a tour: fly each frame in order. Returns a handle with stop(). Reports
 * progress through onFrame — the UI uses this to surface the current caption.
 */
export function playTour(
  viewer: Cesium.Viewer,
  tour: DirectorTour,
  onFrame: (index: number, frame: DirectorFrame | null) => void,
): DirectorPlayHandle {
  let cancelled = false;
  let playing = true;
  (async () => {
    for (let i = 0; i < tour.frames.length; i += 1) {
      if (cancelled) break;
      const frame = tour.frames[i];
      onFrame(i, frame);
      await flyToFrame(viewer, frame);
    }
    playing = false;
    onFrame(-1, null);
  })();
  return {
    stop() {
      cancelled = true;
      playing = false;
      // Cancelling the current fly tears down the active animation gracefully.
      viewer.camera.cancelFlight();
    },
    get playing() {
      return playing;
    },
  };
}

/** Serialize to downloadable JSON. */
export function tourToJson(tour: DirectorTour): string {
  return JSON.stringify(tour, null, 2);
}

/** Parse JSON back into a tour, with light validation. */
export function tourFromJson(raw: string): DirectorTour | null {
  try {
    const data = JSON.parse(raw) as Partial<DirectorTour>;
    if (!data || typeof data !== "object" || !Array.isArray(data.frames)) return null;
    const frames: DirectorFrame[] = [];
    for (const f of data.frames) {
      if (!f || typeof f !== "object") continue;
      const lat = Number((f as DirectorFrame).lat);
      const lon = Number((f as DirectorFrame).lon);
      const height = Number((f as DirectorFrame).height);
      const seconds = Number((f as DirectorFrame).seconds);
      if (![lat, lon, height, seconds].every(Number.isFinite)) continue;
      frames.push({
        lat,
        lon,
        height,
        heading: Number.isFinite(Number((f as DirectorFrame).heading)) ? Number((f as DirectorFrame).heading) : undefined,
        pitch: Number.isFinite(Number((f as DirectorFrame).pitch)) ? Number((f as DirectorFrame).pitch) : undefined,
        seconds,
        caption: typeof (f as DirectorFrame).caption === "string" ? (f as DirectorFrame).caption : undefined,
      });
    }
    return {
      id: typeof data.id === "string" ? data.id : makeId(Date.now()),
      name: typeof data.name === "string" ? data.name : "Импортированный тур",
      recordedAt: typeof data.recordedAt === "number" ? data.recordedAt : Date.now(),
      frames,
    };
  } catch {
    return null;
  }
}
