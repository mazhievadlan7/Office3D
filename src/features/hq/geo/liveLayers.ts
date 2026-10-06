import * as Cesium from "cesium";

/**
 * OPTIONAL live public-data layers for the «ГЕО» view. All OFF by default: they
 * fetch from the public internet (egress), which the scope-safe default view
 * must not do. Each is a clean on/off unit behind one interface, so the OSINT
 * backend can add ships (AISStream), satellites (Celestrak) and more through the
 * same seam later. Only one keyless layer is wired for now — live flights from
 * OpenSky — to prove the pattern; the rest are declared as planned.
 *
 * Nothing here runs unless the operator explicitly turns a layer on.
 */

export type LiveLayerId = "flights" | "ships" | "satellites";

export type LiveLayerDef = {
  id: LiveLayerId;
  label: string;
  /** The public source, for the UI's "needs egress" note. */
  source: string;
  /** False while a layer is declared but not yet wired. */
  implemented: boolean;
};

export const LIVE_LAYERS: readonly LiveLayerDef[] = [
  { id: "flights", label: "Рейсы", source: "OpenSky", implemented: true },
  { id: "ships", label: "Суда", source: "AISStream", implemented: false },
  { id: "satellites", label: "Спутники", source: "Celestrak", implemented: false },
];

/** A running layer: how to refresh it and how to tear it down. */
export type LiveLayerHandle = {
  refresh(): Promise<void>;
  destroy(): void;
};

const OPENSKY_URL = "https://opensky-network.org/api/states/all";
/** Cap plotted aircraft so a busy sky never floods the globe. */
const MAX_FLIGHTS = 400;

/**
 * Plots live aircraft positions from OpenSky's keyless public endpoint as small
 * points in their own data source. Resilient: a failed/blocked fetch leaves the
 * layer empty and reports via onError rather than throwing.
 */
export function startFlightsLayer(
  viewer: Cesium.Viewer,
  onError: (message: string) => void,
): LiveLayerHandle {
  const source = new Cesium.CustomDataSource("hq-geo-flights");
  viewer.dataSources.add(source);
  const color = Cesium.Color.fromCssColorString("#ffd24a");
  let alive = true;

  const refresh = async (): Promise<void> => {
    if (!alive) return;
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
        source.entities.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat, typeof alt === "number" ? alt : 0),
          point: {
            pixelSize: 3,
            color,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
        plotted += 1;
      }
      viewer.scene.requestRender();
    } catch (error) {
      if (alive) onError(error instanceof Error ? error.message : String(error));
    }
  };

  void refresh();

  return {
    refresh,
    destroy() {
      alive = false;
      viewer.dataSources.remove(source, true);
    },
  };
}
