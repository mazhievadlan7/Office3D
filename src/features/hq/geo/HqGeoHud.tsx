"use client";

import { useEffect, useState } from "react";
import * as CesiumNS from "cesium";

export type HqGeoHudProps = {
  viewer: CesiumNS.Viewer | null;
  /** Count of currently plotted entities, broken down for the sidebar. */
  counts: {
    flights: number;
    sats: number;
    quakes: number;
    launches: number;
  };
  trackedTitle?: string | null;
};

/**
 * «Военный HUD» — a lightweight tactical overlay drawn as DOM over the globe:
 *   · corner reticles + a cross-hair at the centre of the viewport
 *   · a top-left telemetry block with the camera's lat / lon / altitude and
 *     heading
 *   · a right-side contact tally (how many flights / sats / quakes / launches
 *     are currently plotted)
 *   · the tracked-target callsign in the top-centre
 *
 * All DOM, no WebGL cost; the viewer only drives the readouts. The HUD never
 * blocks pointer events (pointer-events-none on the frame), so clicks go
 * through to Cesium.
 */
export function HqGeoHud({ viewer, counts, trackedTitle }: HqGeoHudProps) {
  const [cam, setCam] = useState<{ lat: number; lon: number; alt: number; hdg: number } | null>(null);

  // Follow the camera: subscribe to Cesium's camera.changed event (fires on move + zoom + rotate).
  useEffect(() => {
    if (!viewer) return;
    const camera = viewer.camera;
    const read = () => {
      const carto = CesiumNS.Cartographic.fromCartesian(camera.position);
      setCam({
        lat: CesiumNS.Math.toDegrees(carto.latitude),
        lon: CesiumNS.Math.toDegrees(carto.longitude),
        alt: carto.height,
        hdg: ((CesiumNS.Math.toDegrees(camera.heading) + 360) % 360),
      });
    };
    read();
    const removeListener = camera.changed.addEventListener(read);
    return () => {
      removeListener();
    };
  }, [viewer]);

  const altKm = cam ? cam.alt / 1000 : 0;

  return (
    <div className="pointer-events-none absolute inset-0 z-[5] font-mono text-[10px] uppercase tracking-[0.14em] text-emerald-300/80">
      {/* Corner reticles. */}
      <CornerBrackets />

      {/* Centre crosshair. */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="h-6 w-6">
          <div className="absolute left-1/2 top-0 h-6 w-px -translate-x-1/2 bg-emerald-300/60" />
          <div className="absolute left-0 top-1/2 h-px w-6 -translate-y-1/2 bg-emerald-300/60" />
          <div className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-emerald-300/70" />
        </div>
      </div>

      {/* Top-left: camera telemetry. */}
      {cam ? (
        <div className="absolute left-3 bottom-24 rounded border border-emerald-400/25 bg-black/30 px-2 py-1.5 backdrop-blur-sm">
          <div>φ {cam.lat.toFixed(4)}°</div>
          <div>λ {cam.lon.toFixed(4)}°</div>
          <div>alt {altKm < 100 ? `${altKm.toFixed(1)} км` : `${Math.round(altKm)} км`}</div>
          <div>hdg {Math.round(cam.hdg).toString().padStart(3, "0")}°</div>
        </div>
      ) : null}

      {/* Right side: contact tally. */}
      <div className="absolute right-3 bottom-24 rounded border border-emerald-400/25 bg-black/30 px-2 py-1.5 text-right backdrop-blur-sm">
        <div>ВС · {counts.flights}</div>
        <div>SAT · {counts.sats}</div>
        <div>EQ · {counts.quakes}</div>
        <div>LX · {counts.launches}</div>
      </div>

      {/* Top centre: tracked title. */}
      {trackedTitle ? (
        <div className="absolute left-1/2 top-14 -translate-x-1/2 rounded border border-amber-500/40 bg-black/40 px-2.5 py-1 text-amber-200 backdrop-blur-sm">
          LOCK · {trackedTitle}
        </div>
      ) : null}
    </div>
  );
}

function CornerBrackets() {
  const base = "pointer-events-none absolute h-6 w-6 border-emerald-400/40";
  return (
    <>
      <div className={`${base} left-10 top-14 border-l border-t`} />
      <div className={`${base} right-10 top-14 border-r border-t`} />
      <div className={`${base} left-10 bottom-24 border-l border-b`} />
      <div className={`${base} right-10 bottom-24 border-r border-b`} />
    </>
  );
}
