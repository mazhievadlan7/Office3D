"use client";

import { useEffect, useRef, useState } from "react";
import * as CesiumNS from "cesium";

export type HqGeoMinimapProps = {
  viewer: CesiumNS.Viewer | null;
};

/** Width / height of the inset in CSS pixels. */
const SIZE = 160;

/**
 * Minimap overview: a small SVG world-map in the bottom-left corner that shows
 * where the main camera is currently pointed. Pure DOM/SVG — no second Cesium
 * instance, so it costs nothing to render. The marker reads camera.heading as
 * well so the caret rotates with the view.
 *
 * The world outline is a tiny hand-drawn SVG — intentionally minimal; it's a
 * "where am I" indicator, not a basemap. Clicking the inset flies the main
 * camera to the clicked lat/lon.
 */
export function HqGeoMinimap({ viewer }: HqGeoMinimapProps) {
  const [cam, setCam] = useState<{ lat: number; lon: number; hdg: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (!viewer) return;
    const read = () => {
      const carto = CesiumNS.Cartographic.fromCartesian(viewer.camera.position);
      setCam({
        lat: CesiumNS.Math.toDegrees(carto.latitude),
        lon: CesiumNS.Math.toDegrees(carto.longitude),
        hdg: ((CesiumNS.Math.toDegrees(viewer.camera.heading) + 360) % 360),
      });
    };
    read();
    const remove = viewer.camera.changed.addEventListener(read);
    return () => {
      remove();
    };
  }, [viewer]);

  const flyToInset = (ev: React.MouseEvent<SVGSVGElement>) => {
    if (!viewer || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    // Equirectangular: x spans −180..180, y spans 90..−90.
    const lon = (x / SIZE) * 360 - 180;
    const lat = 90 - (y / SIZE) * 180;
    const altitude = Math.max(viewer.camera.positionCartographic.height, 1_000_000);
    void viewer.camera.flyTo({
      destination: CesiumNS.Cartesian3.fromDegrees(lon, lat, altitude),
      duration: 0.9,
    });
  };

  const px = cam ? ((cam.lon + 180) / 360) * SIZE : SIZE / 2;
  const py = cam ? ((90 - cam.lat) / 180) * SIZE : SIZE / 2;

  return (
    <div className="absolute left-3 bottom-56 z-10">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        width={SIZE}
        height={SIZE}
        role="img"
        aria-label="Мини-карта: позиция камеры на мире"
        onClick={flyToInset}
        className="cursor-crosshair rounded-md border border-white/15 bg-black/60 backdrop-blur-sm transition-colors hover:border-white/35"
      >
        {/* Equator and prime-meridian. */}
        <line x1={0} y1={SIZE / 2} x2={SIZE} y2={SIZE / 2} stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
        <line x1={SIZE / 2} y1={0} x2={SIZE / 2} y2={SIZE} stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
        {/* World outline — minimal, hand-sketched, enough to tell where things sit. */}
        <WorldOutline />
        {/* Camera marker: a glowing dot + heading caret. */}
        {cam ? (
          <g transform={`translate(${px}, ${py}) rotate(${cam.hdg})`}>
            <circle r={3.5} fill="#ffd24a" opacity={0.9} />
            <polygon points="0,-10 -4,-2 4,-2" fill="#ffd24a" opacity={0.85} />
            <circle r={9} fill="none" stroke="#ffd24a" strokeOpacity={0.35} strokeWidth={1} />
          </g>
        ) : null}
      </svg>
      <div className="mt-1 text-center font-mono text-[9px] text-white/40">миникарта · клик → перелёт</div>
    </div>
  );
}

/** A hand-sketched equirectangular world outline — small SVG paths, no network. */
function WorldOutline() {
  const stroke = "rgba(255,255,255,0.28)";
  const fill = "rgba(80,120,160,0.08)";
  return (
    <g fill={fill} stroke={stroke} strokeWidth={0.6}>
      {/* Africa */}
      <path d="M79 72 L87 66 L90 72 L92 86 L85 100 L82 110 L78 100 L76 86 Z" />
      {/* Europe */}
      <path d="M79 60 L92 58 L94 65 L87 68 L82 66 Z" />
      {/* Asia */}
      <path d="M93 55 L130 54 L135 66 L128 74 L108 72 L95 68 Z" />
      {/* South-east Asia */}
      <path d="M128 76 L138 78 L136 86 L128 86 Z" />
      {/* India */}
      <path d="M108 72 L112 82 L108 86 L105 76 Z" />
      {/* Australia */}
      <path d="M135 100 L148 100 L148 110 L138 112 L133 106 Z" />
      {/* North America */}
      <path d="M20 50 L48 48 L55 60 L45 70 L30 68 L18 60 Z" />
      {/* Central America */}
      <path d="M38 72 L48 72 L48 82 L42 86 L36 82 Z" />
      {/* South America */}
      <path d="M48 86 L56 88 L58 110 L50 118 L44 100 Z" />
      {/* Greenland */}
      <path d="M58 30 L68 28 L68 40 L58 42 Z" />
      {/* Antarctica strip */}
      <path d="M0 150 L160 150 L160 158 L0 158 Z" />
    </g>
  );
}
