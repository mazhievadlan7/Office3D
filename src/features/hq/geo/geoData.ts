import type { GeoController, GeoTarget } from "./geoTypes";

/**
 * Demo seed for the «ГЕО» view: a handful of EXAMPLE authorized-engagement pins
 * and the arcs between them, so the globe has something to show before the OSINT
 * / scope backend is wired in. Everything here is illustrative open data — a few
 * well-known city coordinates standing in for the owner's own assets, a public
 * bug-bounty scope and open-data points. No real target is implied.
 *
 * To drive the view for real later, replace this seed with a feed from the
 * scope-enforced backend through the same geoController API (addTarget /
 * setTargets / addArc). This file is the only place with hard-coded places.
 */

/** The operations centre the engagement arcs radiate from. */
export const HQ_ANCHOR = { lat: 55.751, lon: 37.618, label: "ШТАБ" } as const;

const DEMO_TARGETS: ReadonlyArray<Omit<GeoTarget, "id">> = [
  { ...HQ_ANCHOR, kind: "hq", note: "Операционный центр" },
  { lat: 52.52, lon: 13.405, label: "Актив · edge-01", kind: "asset", note: "Свой периметр · Phase 1" },
  { lat: 48.8566, lon: 2.3522, label: "Актив · api-eu", kind: "asset", note: "Свой периметр · Phase 1" },
  { lat: 37.7749, lon: -122.4194, label: "Bug bounty · web", kind: "bounty", note: "Публичная программа · в рамках scope" },
  { lat: 1.3521, lon: 103.8198, label: "Клиент · по договору", kind: "client", note: "Подтверждённое владение" },
  { lat: 51.5074, lon: -0.1278, label: "OSINT · открытые данные", kind: "osint", note: "Открытый источник" },
  { lat: -23.5505, lon: -46.6333, label: "OSINT · открытые данные", kind: "osint", note: "Открытый источник" },
];

/**
 * Loads the demo seed into a controller: the pins, then engagement arcs from the
 * HQ to each non-HQ target (recon arcs to the OSINT points). Returns the HQ
 * target so a caller can fly to it. Safe to call once per view mount.
 */
export function seedDemoGeo(controller: GeoController): void {
  controller.setTargets(DEMO_TARGETS);
  const scene = controller.getScene();
  const hq = scene.targets.find((target) => target.kind === "hq");
  if (!hq) return;
  controller.setArcs(
    scene.targets
      .filter((target) => target.id !== hq.id)
      .map((target) => ({
        from: hq.id,
        to: target.id,
        kind: target.kind === "osint" ? ("recon" as const) : ("engagement" as const),
        label: target.label,
      })),
  );
}
