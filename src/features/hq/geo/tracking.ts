import * as Cesium from "cesium";

/**
 * Click-to-track: a shared tracking service for the «ГЕО» view.
 *
 * One tracked target at a time (overriding any previous one). The service
 * carries three pieces of behaviour:
 *   1. Camera lock — Cesium's `viewer.trackedEntity` holds the picked entity
 *      centred as it moves (works for flights, satellites, cyclones).
 *   2. Fading trail — the last N positions, drawn as a thin polyline that
 *      alpha-ramps from head to tail. Updated on each propagation tick, capped
 *      so a long flight doesn't grow unbounded.
 *   3. Metadata — a small structured record the panel displays (kind, label,
 *      coordinates, extra fields pulled from the entity's `properties`).
 *
 * All data stays local to the browser; nothing is transmitted. The trail
 * disappears when the target is cleared; `destroy()` removes everything.
 */

export type TrackedKind =
  | "flight"
  | "satellite"
  | "iss"
  | "cyclone"
  | "earthquake"
  | "launch"
  | "camera"
  | "datacenter"
  | "dam"
  | "pin"
  | "other";

export type TrackedInfo = {
  id: string;
  kind: TrackedKind;
  title: string;
  subtitle?: string;
  /** Last known position (longitude / latitude / height-metres). */
  lon?: number;
  lat?: number;
  height?: number;
  /** Free-form extra fields the panel shows as a key/value list. */
  extras?: Record<string, string>;
};

const TRAIL_SOURCE_NAME = "hq-geo-track-trail";
const TRAIL_MAX_POINTS = 180;
/** How often (ms) we read the tracked entity's position for the trail. */
const TRAIL_TICK_MS = 500;

function inferKind(entity: Cesium.Entity, props: Record<string, unknown>): TrackedKind {
  const raw = (props.kind ?? "").toString();
  if (raw) {
    if (raw === "earthquake") return "earthquake";
    if (raw === "cyclone") return "cyclone";
    if (raw === "launch") return "launch";
    if (raw === "iss") return "iss";
    if (raw === "datacenters") return "datacenter";
    if (raw === "dams") return "dam";
    if (raw === "hq" || raw === "scope" || raw === "osint") return "pin";
  }
  const id = entity.id ?? "";
  if (id === "iss") return "iss";
  if (id.startsWith("eq-")) return "earthquake";
  if (id.startsWith("cy-")) return "cyclone";
  if (id.startsWith("lx-")) return "launch";
  if (id.startsWith("bp-")) return "pin";
  // Flights / satellites don't carry an id prefix; a persistent point with no
  // position callback is a static pin, otherwise it's a moving contact.
  return entity.position && typeof entity.position.getValue === "function" ? "flight" : "other";
}

function infoFromEntity(entity: Cesium.Entity): TrackedInfo {
  const now = Cesium.JulianDate.now();
  const propsVal = (entity.properties?.getValue(now) ?? {}) as Record<string, unknown>;
  const kind = inferKind(entity, propsVal);
  const title =
    (propsVal.name as string | undefined) ??
    (propsVal.title as string | undefined) ??
    (entity.name as string | undefined) ??
    (typeof entity.id === "string" ? entity.id : "цель");
  const subtitle =
    (propsVal.operator as string | undefined) ??
    (propsVal.place as string | undefined) ??
    (propsVal.pad as string | undefined);

  const extras: Record<string, string> = {};
  const push = (k: string, v: unknown) => {
    if (v == null) return;
    if (typeof v === "number" && Number.isFinite(v)) extras[k] = String(v);
    else if (typeof v === "string" && v.trim()) extras[k] = v;
  };
  push("Магнитуда", propsVal.magnitude);
  push("Место", propsVal.place);
  push("Оператор", propsVal.operator);
  push("Страна", propsVal.country);
  push("Мощность, МВт", propsVal.capacityMW);
  push("Пуск", propsVal.when);
  push("Через ч.", typeof propsVal.hoursFromNow === "number" ? propsVal.hoursFromNow.toFixed(1) : undefined);
  push("MMSI", propsVal.mmsi);
  if (typeof propsVal.time === "number") extras["Время"] = new Date(propsVal.time).toLocaleString("ru-RU");

  const result: TrackedInfo = { id: String(entity.id ?? ""), kind, title, subtitle, extras };
  const pos = entity.position?.getValue(now);
  if (pos) {
    const carto = Cesium.Cartographic.fromCartesian(pos);
    result.lon = Cesium.Math.toDegrees(carto.longitude);
    result.lat = Cesium.Math.toDegrees(carto.latitude);
    result.height = carto.height;
  }
  return result;
}

export type TrackHandle = {
  pick(pos: Cesium.Cartesian2): TrackedInfo | null;
  track(entity: Cesium.Entity): TrackedInfo;
  /** Cockpit mode: camera rides the entity, low altitude, looks forward along its motion. */
  cockpit(on: boolean): void;
  isCockpit(): boolean;
  clear(): void;
  destroy(): void;
};

export function createTracker(
  viewer: Cesium.Viewer,
  onChange: (info: TrackedInfo | null) => void,
): TrackHandle {
  const trail = new Cesium.CustomDataSource(TRAIL_SOURCE_NAME);
  void viewer.dataSources.add(trail);
  const positions: Cesium.Cartesian3[] = [];
  let entity: Cesium.Entity | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  let cockpitOn = false;
  let cockpitLast: Cesium.Cartesian3 | null = null;

  const clearTrail = () => {
    positions.length = 0;
    trail.entities.removeAll();
  };

  const paintTrail = () => {
    trail.entities.removeAll();
    if (positions.length < 2) return;
    // One polyline for the trail: a solid white glow softened by alpha, so the
    // tail reads as a fading streak against the globe.
    trail.entities.add({
      polyline: {
        positions: positions.slice(),
        width: 2.2,
        material: new Cesium.PolylineGlowMaterialProperty({
          color: Cesium.Color.WHITE.withAlpha(0.75),
          glowPower: 0.22,
          taperPower: 0.6,
        }),
        clampToGround: false,
        arcType: Cesium.ArcType.NONE,
      },
    });
  };

  const stopTick = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const startTick = () => {
    stopTick();
    timer = setInterval(() => {
      if (!entity) return;
      const now = Cesium.JulianDate.now();
      const pos = entity.position?.getValue(now);
      if (!pos) return;
      const last = positions[positions.length - 1];
      if (!last || Cesium.Cartesian3.distance(last, pos) > 50) {
        positions.push(pos.clone());
        if (positions.length > TRAIL_MAX_POINTS) positions.shift();
        paintTrail();
        viewer.scene.requestRender();
        onChange(infoFromEntity(entity));
      }
      if (cockpitOn) applyCockpit(pos);
    }, TRAIL_TICK_MS);
  };

  /**
   * Cockpit camera: sits ~150 m behind the entity, points along the motion
   * vector derived from the trail. If the trail is too short, falls back to a
   * downward tilt. Called on every tick while cockpit mode is on.
   */
  const applyCockpit = (pos: Cesium.Cartesian3) => {
    const prev = cockpitLast ?? positions[positions.length - 2] ?? pos;
    cockpitLast = pos.clone();
    // Heading from the last two positions in local-east-north-up frame.
    const carto = Cesium.Cartographic.fromCartesian(pos);
    const prevCarto = Cesium.Cartographic.fromCartesian(prev);
    const dLon = carto.longitude - prevCarto.longitude;
    const dLat = carto.latitude - prevCarto.latitude;
    const heading = Math.atan2(dLon, dLat); // radians, 0 = north
    const altMetres = Math.max(50, carto.height); // never underground
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, altMetres + 60),
      orientation: {
        heading,
        pitch: Cesium.Math.toRadians(-12),
        roll: 0,
      },
    });
    viewer.scene.requestRender();
  };

  const track = (next: Cesium.Entity): TrackedInfo => {
    entity = next;
    clearTrail();
    const now = Cesium.JulianDate.now();
    const pos = next.position?.getValue(now);
    if (pos) {
      positions.push(pos.clone());
      paintTrail();
    }
    viewer.trackedEntity = next;
    startTick();
    const info = infoFromEntity(next);
    onChange(info);
    return info;
  };

  const clear = () => {
    entity = null;
    stopTick();
    clearTrail();
    cockpitOn = false;
    cockpitLast = null;
    viewer.trackedEntity = undefined;
    onChange(null);
    viewer.scene.requestRender();
  };

  const cockpit = (on: boolean) => {
    cockpitOn = on;
    if (!on) {
      // Return to the generic trackedEntity view.
      cockpitLast = null;
      if (entity) viewer.trackedEntity = entity;
      return;
    }
    // Entering cockpit — Cesium's trackedEntity centres the pin, which fights with
    // our manual setView; release it so our camera moves win.
    viewer.trackedEntity = undefined;
    if (entity) {
      const now = Cesium.JulianDate.now();
      const pos = entity.position?.getValue(now);
      if (pos) applyCockpit(pos);
    }
  };

  const pick = (pos: Cesium.Cartesian2): TrackedInfo | null => {
    const picked = viewer.scene.pick(pos);
    const next = picked?.id as Cesium.Entity | undefined;
    if (!next) return null;
    return track(next);
  };

  const destroy = () => {
    clear();
    viewer.dataSources.remove(trail, true);
  };

  const isCockpit = () => cockpitOn;

  return { pick, track, cockpit, isCockpit, clear, destroy };
}
