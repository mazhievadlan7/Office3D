"use client";

import { useEffect, useRef, useState } from "react";
import * as CesiumNS from "cesium";

export type DetectionBox = {
  id: string;
  label: string;
  kind: "flight" | "satellite" | "iss" | "earthquake" | "cyclone" | "launch" | "scope" | "datacenter" | "dam" | "other";
  x: number;
  y: number;
};

export type HqGeoDetectionProps = {
  viewer: CesiumNS.Viewer | null;
};

/**
 * «Детектор» — a screen-space overlay that draws a small bounding box + ID label
 * around every visible contact (flight / satellite / cyclone / launch / scope
 * pin / datacenter / dam / earthquake). Pure DOM over the canvas, so there is
 * zero WebGL cost; coordinates are computed from the entity's world position
 * through viewer.scene.cartesianToCanvasCoordinates once a frame via Cesium's
 * post-render event. Entities behind the horizon are skipped (null projection).
 */
export function HqGeoDetection({ viewer }: HqGeoDetectionProps) {
  const [boxes, setBoxes] = useState<DetectionBox[]>([]);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<number>(0);

  useEffect(() => {
    if (!viewer) return;
    // Throttle: 10 Hz is plenty for a visible overlay; Cesium post-renders at
    // 60 Hz on a drag but we don't need every frame.
    const PERIOD_MS = 100;

    const read = () => {
      if (!viewer || viewer.isDestroyed()) return;
      const now = performance.now();
      if (now - lastRef.current < PERIOD_MS) return;
      lastRef.current = now;

      const scene = viewer.scene;
      const next: DetectionBox[] = [];
      const t = CesiumNS.JulianDate.now();
      // Cull against the canvas rect.
      const canvas = scene.canvas as HTMLCanvasElement;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;

      // Which data-source names to project; the pool is small so a per-frame scan is cheap.
      const SOURCES: Array<{ name: string; kind: DetectionBox["kind"]; cap: number }> = [
        { name: "hq-geo-targets", kind: "scope", cap: 64 },
        { name: "hq-geo-launches", kind: "launch", cap: 32 },
        { name: "hq-geo-cyclones", kind: "cyclone", cap: 32 },
        { name: "hq-geo-earthquakes", kind: "earthquake", cap: 48 },
        { name: "hq-geo-datacenters", kind: "datacenter", cap: 64 },
        { name: "hq-geo-dams", kind: "dam", cap: 64 },
        { name: "hq-geo-iss", kind: "iss", cap: 2 },
        // Flights are hundreds of pins — avoid per-frame projection for all of them;
        // detection boxes are visual noise there. The HUD tally already counts them.
      ];

      for (const src of SOURCES) {
        const ds = viewer.dataSources.getByName(src.name)[0];
        if (!ds) continue;
        let drawn = 0;
        for (const entity of ds.entities.values) {
          if (drawn >= src.cap) break;
          const pos = entity.position?.getValue(t);
          if (!pos) continue;
          const canvasPos = scene.cartesianToCanvasCoordinates(pos);
          if (!canvasPos) continue;
          if (canvasPos.x < 0 || canvasPos.y < 0 || canvasPos.x > w || canvasPos.y > h) continue;
          // Horizon test: compare the entity's angle from the camera; a dot <= 0
          // against the camera's view direction means it is behind us.
          const toEnt = CesiumNS.Cartesian3.subtract(pos, scene.camera.position, new CesiumNS.Cartesian3());
          const dot = CesiumNS.Cartesian3.dot(CesiumNS.Cartesian3.normalize(toEnt, toEnt), scene.camera.direction);
          if (dot <= 0) continue;
          const label = entityLabel(entity, t);
          next.push({
            id: String(entity.id ?? `${src.name}-${drawn}`),
            kind: src.kind,
            label,
            x: canvasPos.x,
            y: canvasPos.y,
          });
          drawn += 1;
        }
      }
      setBoxes(next);
    };

    const remove = viewer.scene.postRender.addEventListener(read);
    const loop = () => {
      read();
      rafRef.current = window.requestAnimationFrame(loop);
    };
    rafRef.current = window.requestAnimationFrame(loop);

    return () => {
      remove();
      if (rafRef.current != null) window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [viewer]);

  if (!boxes.length) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-[4]">
      {boxes.map((b) => (
        <div
          key={b.id}
          className={`absolute -translate-x-1/2 -translate-y-1/2 font-mono text-[9px] uppercase tracking-[0.08em] ${tone(b.kind)}`}
          style={{ left: `${b.x}px`, top: `${b.y}px` }}
        >
          <div className="relative h-5 w-5">
            <span className="absolute left-0 top-0 h-1.5 w-1.5 border-l border-t" />
            <span className="absolute right-0 top-0 h-1.5 w-1.5 border-r border-t" />
            <span className="absolute left-0 bottom-0 h-1.5 w-1.5 border-l border-b" />
            <span className="absolute right-0 bottom-0 h-1.5 w-1.5 border-r border-b" />
          </div>
          <div className="mt-0.5 whitespace-nowrap text-center">{b.label}</div>
        </div>
      ))}
    </div>
  );
}

function tone(kind: DetectionBox["kind"]): string {
  switch (kind) {
    case "launch":
      return "text-orange-200 border-orange-300/70";
    case "cyclone":
      return "text-cyan-200 border-cyan-300/70";
    case "earthquake":
      return "text-yellow-200 border-yellow-300/70";
    case "iss":
      return "text-pink-200 border-pink-300/70";
    case "datacenter":
      return "text-violet-200 border-violet-300/70";
    case "dam":
      return "text-sky-200 border-sky-300/70";
    case "scope":
      return "text-red-200 border-red-300/80";
    default:
      return "text-emerald-200 border-emerald-300/70";
  }
}

function entityLabel(entity: CesiumNS.Entity, t: CesiumNS.JulianDate): string {
  const props = (entity.properties?.getValue(t) ?? {}) as Record<string, unknown>;
  const raw =
    (props.name as string | undefined) ??
    (props.title as string | undefined) ??
    (entity.name as string | undefined) ??
    "";
  const short = raw.replace(/[·|].*/, "").trim().slice(0, 24);
  return short || (typeof entity.id === "string" ? entity.id.slice(0, 10) : "");
}
