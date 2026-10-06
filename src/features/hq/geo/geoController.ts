import type {
  GeoArc,
  GeoArcKind,
  GeoController,
  GeoEndpoint,
  GeoFlyTo,
  GeoPoint,
  GeoSceneData,
  GeoTarget,
} from "./geoTypes";

/**
 * A single, framework-free controller both globe surfaces share. It holds the
 * current targets and arcs, serves fly-to requests, and notifies subscribers on
 * every change. Vanilla on purpose: the CesiumJS view (imperative) and the R3F
 * wall preview (per-frame) read it the same way, and so will the voice command
 * and the OSINT backend later.
 */

let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${(seq += 1).toString(36)}`;

function clampLat(lat: number): number {
  return lat < -90 ? -90 : lat > 90 ? 90 : lat;
}

function wrapLon(lon: number): number {
  let l = ((lon + 180) % 360 + 360) % 360 - 180;
  if (l === -180) l = 180;
  return l;
}

class HqGeoController implements GeoController {
  private targets: GeoTarget[] = [];
  private arcs: GeoArc[] = [];
  private scene: GeoSceneData = { targets: [], arcs: [] };
  private pendingFlyTo: GeoFlyTo | null = null;
  private flyId = 0;
  private readonly sceneListeners = new Set<(scene: GeoSceneData) => void>();
  private readonly flyListeners = new Set<(fly: GeoFlyTo) => void>();

  private commit(): void {
    this.scene = { targets: this.targets.slice(), arcs: this.arcs.slice() };
    for (const listener of this.sceneListeners) listener(this.scene);
  }

  private resolve(endpoint: GeoEndpoint): GeoPoint | null {
    if (typeof endpoint === "string") {
      const target = this.targets.find((candidate) => candidate.id === endpoint);
      return target ? { lat: target.lat, lon: target.lon, label: target.label } : null;
    }
    return { lat: clampLat(endpoint.lat), lon: wrapLon(endpoint.lon), label: endpoint.label };
  }

  addTarget(target: Omit<GeoTarget, "id"> & { id?: string }): GeoTarget {
    const resolved: GeoTarget = {
      ...target,
      id: target.id ?? nextId("tgt"),
      lat: clampLat(target.lat),
      lon: wrapLon(target.lon),
    };
    const existing = this.targets.findIndex((candidate) => candidate.id === resolved.id);
    if (existing >= 0) this.targets[existing] = resolved;
    else this.targets.push(resolved);
    this.commit();
    return resolved;
  }

  setTargets(targets: ReadonlyArray<Omit<GeoTarget, "id"> & { id?: string }>): void {
    this.targets = targets.map((target) => ({
      ...target,
      id: target.id ?? nextId("tgt"),
      lat: clampLat(target.lat),
      lon: wrapLon(target.lon),
    }));
    this.commit();
  }

  addArc(from: GeoEndpoint, to: GeoEndpoint, kind: GeoArcKind = "engagement", label?: string): GeoArc | null {
    const a = this.resolve(from);
    const b = this.resolve(to);
    if (!a || !b) return null;
    const arc: GeoArc = { id: nextId("arc"), from: a, to: b, kind, label };
    this.arcs.push(arc);
    this.commit();
    return arc;
  }

  setArcs(
    arcs: ReadonlyArray<{ from: GeoEndpoint; to: GeoEndpoint; kind?: GeoArcKind; label?: string; id?: string }>,
  ): void {
    const resolved: GeoArc[] = [];
    for (const arc of arcs) {
      const a = this.resolve(arc.from);
      const b = this.resolve(arc.to);
      if (!a || !b) continue;
      resolved.push({ id: arc.id ?? nextId("arc"), from: a, to: b, kind: arc.kind ?? "engagement", label: arc.label });
    }
    this.arcs = resolved;
    this.commit();
  }

  clear(): void {
    this.targets = [];
    this.arcs = [];
    this.commit();
  }

  flyTo(lat: number, lon: number, height?: number): void {
    this.pendingFlyTo = { lat: clampLat(lat), lon: wrapLon(lon), height, id: (this.flyId += 1) };
    for (const listener of this.flyListeners) listener(this.pendingFlyTo);
  }

  getScene(): GeoSceneData {
    return this.scene;
  }

  getPendingFlyTo(): GeoFlyTo | null {
    return this.pendingFlyTo;
  }

  subscribe(listener: (scene: GeoSceneData) => void): () => void {
    this.sceneListeners.add(listener);
    return () => {
      this.sceneListeners.delete(listener);
    };
  }

  onFlyTo(listener: (fly: GeoFlyTo) => void): () => void {
    this.flyListeners.add(listener);
    return () => {
      this.flyListeners.delete(listener);
    };
  }
}

/** The one controller shared by every geo surface in this tab. */
export const geoController: GeoController = new HqGeoController();
