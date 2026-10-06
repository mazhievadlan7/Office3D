/**
 * The HQ «ГЕО» geo-view data layer — a clean, typed seam between the globe
 * surfaces (the full-screen CesiumJS view and the cheap video-wall preview) and
 * whatever feeds them points.
 *
 * LAWFUL FRAMING (load-bearing, not a disclaimer). Every point and arc shown on
 * the globe represents an AUTHORIZED engagement target or open public data:
 *   - the owner's own products and infrastructure,
 *   - a public bug-bounty program within its published scope,
 *   - a client asset under a signed contract with verified ownership,
 *   - or an open-source / public-data point (OSINT within an engagement).
 * The geo-view is a scope-gated presentation layer. It plots nothing on its own
 * and does no mass profiling; it only draws what the scope-enforced backend (or,
 * for now, the demo seed) hands it. See TZ §0, §4.2.
 */

/** What an authorized point on the globe is, for its colour and label. */
export type GeoTargetKind =
  /** The owner's own asset / infrastructure (Phase 1 scope). */
  | "asset"
  /** A bug-bounty program's in-scope asset. */
  | "bounty"
  /** A contracted client's asset (verified ownership). */
  | "client"
  /** An open-public-data / OSINT point within an engagement. */
  | "osint"
  /** The HQ itself — the operations centre the arcs radiate from. */
  | "hq";

/** A place on the Earth, degrees. Longitude −180..180, latitude −90..90. */
export type GeoPoint = {
  lat: number;
  lon: number;
  /** Optional label, shown when this point is drawn as a pin. */
  label?: string;
};

/** An authorized target pin. */
export type GeoTarget = GeoPoint & {
  /** Stable id, for updates and arc endpoints. Generated when omitted. */
  id: string;
  label: string;
  kind: GeoTargetKind;
  /** Free-form note (engagement, scope id), shown in the full-screen view. */
  note?: string;
};

export type GeoArcKind =
  /** An active authorized engagement link (HQ → target). */
  | "engagement"
  /** A recon / observation link. */
  | "recon"
  /** A link between two targets (e.g. attack-path edge, in scope). */
  | "lateral";

/** A connection arc between two points. */
export type GeoArc = {
  id: string;
  from: GeoPoint;
  to: GeoPoint;
  kind: GeoArcKind;
  label?: string;
};

/** A point an arc endpoint may be given as: a literal place, or a target id. */
export type GeoEndpoint = GeoPoint | string;

/** A request to fly the full-screen camera somewhere. */
export type GeoFlyTo = {
  lat: number;
  lon: number;
  /** Camera height above the point, metres. A sensible default is used when omitted. */
  height?: number;
  id: number;
};

/** A snapshot both surfaces read. */
export type GeoSceneData = {
  targets: readonly GeoTarget[];
  arcs: readonly GeoArc[];
};

/**
 * The geo data API, fed by the demo seed now and the OSINT/scope backend later.
 * Both the full-screen globe and the wall preview read the same controller, so
 * a target added once shows on both.
 */
export type GeoController = {
  addTarget(target: Omit<GeoTarget, "id"> & { id?: string }): GeoTarget;
  setTargets(targets: ReadonlyArray<Omit<GeoTarget, "id"> & { id?: string }>): void;
  addArc(from: GeoEndpoint, to: GeoEndpoint, kind?: GeoArcKind, label?: string): GeoArc | null;
  setArcs(arcs: ReadonlyArray<{ from: GeoEndpoint; to: GeoEndpoint; kind?: GeoArcKind; label?: string; id?: string }>): void;
  clear(): void;
  flyTo(lat: number, lon: number, height?: number): void;
  getScene(): GeoSceneData;
  /** The latest fly-to request, for a surface that mounts after it was issued. */
  getPendingFlyTo(): GeoFlyTo | null;
  /** Subscribe to scene changes; returns an unsubscribe. */
  subscribe(listener: (scene: GeoSceneData) => void): () => void;
  /** Subscribe to fly-to requests; returns an unsubscribe. */
  onFlyTo(listener: (fly: GeoFlyTo) => void): () => void;
};
