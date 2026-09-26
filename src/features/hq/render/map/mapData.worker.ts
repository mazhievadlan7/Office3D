import {
  buildGeoRaster,
  buildImageryRaster,
  type Ctx2D,
  type MapImageryKind,
  type MapRaster,
} from "./mapGeo";

/**
 * Builds the world map's textures off the main thread: rasterises the
 * countries into distance fields, and decodes and converts the NASA imagery.
 * Requests run one at a time, in order, so the peak memory stays that of the
 * largest one; the page terminates the worker once it has everything.
 *
 * Messages in:  MapDataRequest
 * Messages out: MapDataResponse (the texels' buffer is transferred, not copied)
 */

export type MapDataJob =
  | { type: "geo"; url: string; width: number }
  | { type: "imagery"; kind: MapImageryKind; url: string; maxWidth: number };
export type MapDataRequest = MapDataJob & { id: number };

export type MapDataResponse = { id: number; ok: true; raster: MapRaster } | { id: number; ok: false; error: string };

// The project compiles against the DOM lib; the worker needs only these two.
type WorkerScope = {
  postMessage(message: MapDataResponse, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<MapDataRequest>) => void) | null;
};
const scope = self as unknown as WorkerScope;

function context(width: number, height: number): Ctx2D {
  const ctx = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("HQ map: no 2D context in the worker");
  return ctx;
}

function handle(request: MapDataRequest): Promise<MapRaster> {
  if (request.type === "geo") return buildGeoRaster({ url: request.url, width: request.width, context });
  return buildImageryRaster({ url: request.url, kind: request.kind, maxWidth: request.maxWidth, context });
}

let queue: Promise<void> = Promise.resolve();

scope.onmessage = (event) => {
  const request = event.data;
  queue = queue.then(() =>
    handle(request).then(
      (raster) => scope.postMessage({ id: request.id, ok: true, raster }, [raster.data.buffer as ArrayBuffer]),
      (error: unknown) =>
        scope.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }, []),
    ),
  );
};
