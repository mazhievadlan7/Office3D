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
    if (raw === "datacenters") return "datacenter";
    if (raw === "dams") return "dam";
    if (raw === "hq" || raw === "scope" || raw === "osint") return "pin";
  }
  const id = entity.id ?? "";
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
    }, TRAIL_TICK_MS);
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
    viewer.trackedEntity = undefined;
    onChange(null);
    viewer.scene.requestRender();
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

  return { pick, track, clear, destroy };
}
