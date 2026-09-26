import { HQ_MAP_DAY_URL, HQ_MAP_NIGHT_URL, HQ_WORLD_COUNTRIES_URL } from "@/features/hq/core/config";
import type { MapDataJob, MapDataRequest, MapDataResponse } from "@/features/hq/render/map/mapData.worker";
import {
  GEO_FALLBACK_WIDTH,
  GEO_WIDTH,
  IMAGERY_MAX_WIDTH,
  buildGeoRaster,
  type Ctx2D,
  type MapImageryKind,
  type MapRaster,
} from "@/features/hq/render/map/mapGeo";

export type MapLoadEnvironment = {
  /** `Worker` exists on this page. */
  workers: boolean;
  /** `OffscreenCanvas` exists (the worker draws on one). */
  offscreenCanvas: boolean;
  maxTextureSize: number;
};

export type MapLoadPlan = {
  useWorker: boolean;
  /** Width of the vector data texture. */
  geoWidth: number;
  /** Whether to try the NASA imagery at all. */
  imagery: boolean;
  imageryMaxWidth: number;
};

/**
 * Where and how big the map's textures are built. Decoding the NASA images
 * and reading their pixels back would stall the main thread for a good part
 * of a second, so without a worker the map keeps the look it builds from the
 * vector data alone, and builds that at half the width.
 */
export function planMapLoad(env: MapLoadEnvironment): MapLoadPlan {
  const useWorker = env.workers && env.offscreenCanvas;
  const maxSize = Math.max(1, Math.floor(env.maxTextureSize));
  return {
    useWorker,
    geoWidth: Math.min(useWorker ? GEO_WIDTH : GEO_FALLBACK_WIDTH, maxSize),
    imagery: useWorker,
    imageryMaxWidth: Math.min(IMAGERY_MAX_WIDTH, maxSize),
  };
}

export function browserLoadEnvironment(maxTextureSize: number): MapLoadEnvironment {
  return {
    workers: typeof Worker !== "undefined",
    offscreenCanvas: typeof OffscreenCanvas !== "undefined",
    maxTextureSize,
  };
}

type Pending = { resolve: (raster: MapRaster) => void; reject: (error: Error) => void };

/**
 * Loads one mounted map's textures through a worker that is terminated as
 * soon as the last request settles (or the map unmounts), so the memory it
 * built them with goes too. Requests run in order: the vector data, then the
 * day imagery, then the night imagery. Imagery is optional; a missing file
 * rejects and the map keeps its procedural look.
 */
export class MapDataLoader {
  private worker: Worker | null = null;
  private workerBroken = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private disposed = false;

  constructor(readonly plan: MapLoadPlan) {}

  geo(): Promise<MapRaster> {
    const url = absoluteUrl(HQ_WORLD_COUNTRIES_URL);
    const onMainThread = () =>
      buildGeoRaster({
        url,
        width: Math.min(GEO_FALLBACK_WIDTH, this.plan.geoWidth),
        context: mainThreadContext,
        pause: nextTask,
      });
    if (!this.plan.useWorker) return onMainThread();
    return this.request({ type: "geo", url, width: this.plan.geoWidth }).catch((error: unknown) => {
      // The worker could not do it (no 2D context there, a blocked script…):
      // build it here instead, smaller and in steps.
      if (this.disposed) throw error;
      return onMainThread();
    });
  }

  imagery(kind: MapImageryKind): Promise<MapRaster> {
    if (!this.plan.imagery) return Promise.reject(new Error("HQ map: imagery needs a worker"));
    const url = absoluteUrl(kind === "day" ? HQ_MAP_DAY_URL : HQ_MAP_NIGHT_URL);
    return this.request({ type: "imagery", kind, url, maxWidth: this.plan.imageryMaxWidth });
  }

  dispose(): void {
    this.disposed = true;
    this.rejectAll(new Error("HQ map: loading cancelled"));
  }

  private request(job: MapDataJob): Promise<MapRaster> {
    if (this.disposed) return Promise.reject(new Error("HQ map: loading cancelled"));
    const worker = this.ensureWorker();
    if (!worker) return Promise.reject(new Error("HQ map: the map worker is unavailable"));
    const id = this.nextId++;
    return new Promise<MapRaster>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const request: MapDataRequest = { ...job, id };
      worker.postMessage(request);
    });
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (this.workerBroken) return null;
    try {
      const worker = new Worker(new URL("./mapData.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<MapDataResponse>) => this.settle(event.data);
      worker.onerror = (event) => {
        event.preventDefault();
        this.workerBroken = true;
        this.rejectAll(new Error("HQ map: the map worker failed"));
      };
      this.worker = worker;
      return worker;
    } catch {
      this.workerBroken = true;
      return null;
    }
  }

  private settle(response: MapDataResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    // Everything has arrived: free the worker and everything it built with.
    if (this.pending.size === 0) this.stopWorker();
    if (response.ok) pending.resolve(response.raster);
    else pending.reject(new Error(response.error));
  }

  private rejectAll(error: Error): void {
    this.stopWorker();
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(error);
  }

  private stopWorker(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}

/** Runs `task` once the page is idle (the scene's first frames come first); returns a cancel. */
export function whenIdle(task: () => void, timeoutMs = 1200): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(task, { timeout: timeoutMs });
    return () => cancelIdleCallback(handle);
  }
  const handle = setTimeout(task, 250);
  return () => clearTimeout(handle);
}

function absoluteUrl(url: string): string {
  return new URL(url, window.location.href).href;
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function mainThreadContext(width: number, height: number): Ctx2D {
  if (typeof OffscreenCanvas !== "undefined") {
    const ctx = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
    if (ctx) return ctx;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("HQ map: 2D canvas is unavailable");
  return ctx;
}
