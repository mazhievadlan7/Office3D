import { geoController } from "../geo/geoController";
import { HQ_ANCHOR } from "../geo/geoData";
import type { OsintController, OsintDataset } from "./types";

/**
 * The one framework-free OSINT controller the «РАЗВЕДКА» view reads. It holds
 * the current dataset, notifies subscribers on change, and projects the dataset's
 * geolocated entities onto the SHARED geoController so the God's-Eye globe and
 * the view are one source of truth — a geo entity surfaced in recon becomes a
 * pin and an arc on the globe without a second copy of the data.
 *
 * Vanilla on purpose: the demo seed populates it now; the scope-enforced
 * Execution Plane will call the same setData() later. Nothing here executes a
 * tool — it only moves already-collected, scope-tagged results around.
 */

/** HQ anchor as a globe target id, so osint arcs share one origin pin. */
const HQ_TARGET_ID = "osint:hq";

class HqOsintController implements OsintController {
  private data: OsintDataset | null = null;
  /** The dataset last projected onto the globe, so re-mounts don't duplicate arcs. */
  private projected: OsintDataset | null = null;
  private readonly listeners = new Set<(data: OsintDataset | null) => void>();

  setData(data: OsintDataset): void {
    this.data = data;
    for (const listener of this.listeners) listener(data);
    this.projectGeo(data);
  }

  getData(): OsintDataset | null {
    return this.data;
  }

  subscribe(listener: (data: OsintDataset | null) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  flyToEntity(entityId: string): boolean {
    const entity = this.data?.entities.find((candidate) => candidate.id === entityId);
    if (!entity?.geo) return false;
    geoController.flyTo(entity.geo.lat, entity.geo.lon);
    return true;
  }

  /**
   * Feeds the shared globe. Every entity with a geolocation becomes a target,
   * with an arc from the HQ anchor (an engagement arc for owned assets, a recon
   * arc for open OSINT points). Guarded by object identity, so loading the same
   * dataset twice (a view re-mount) never stacks duplicate arcs; a genuinely new
   * dataset re-seeds from the anchor outward.
   */
  private projectGeo(data: OsintDataset): void {
    if (this.projected === data) return;
    this.projected = data;

    const geoEntities = data.entities.filter((entity) => entity.geo !== undefined);
    if (geoEntities.length === 0) return;

    geoController.addTarget({
      id: HQ_TARGET_ID,
      lat: HQ_ANCHOR.lat,
      lon: HQ_ANCHOR.lon,
      label: HQ_ANCHOR.label,
      kind: "hq",
      note: "Операционный центр",
    });

    for (const entity of geoEntities) {
      const geo = entity.geo;
      if (!geo) continue;
      const targetId = `osint:${entity.id}`;
      const asset = entity.scopeClass === "asset";
      geoController.addTarget({
        id: targetId,
        lat: geo.lat,
        lon: geo.lon,
        label: geo.place ? `${entity.label} · ${geo.place}` : entity.label,
        kind: asset ? "asset" : "osint",
        note: entity.note,
      });
      geoController.addArc(HQ_TARGET_ID, targetId, asset ? "engagement" : "recon", entity.label);
    }
  }
}

/** The one OSINT controller shared by the view (and, later, the backend). */
export const osintController: OsintController = new HqOsintController();
