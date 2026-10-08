"use client";

import { Compass, Globe2, MoveDiagonal, Pin, RotateCcw } from "lucide-react";
import * as CesiumNS from "cesium";

import { HQ_HUD_GLASS, hqHudButtonClass } from "@/features/hq/hud/hudStyle";

export type HqGeoCameraControlsProps = {
  viewer: CesiumNS.Viewer | null;
  /** Called when "Reset" fires, so the host can clear its own state (tracked target, scene caption, …). */
  onReset?: () => void;
};

/**
 * Compact camera-control strip for ГЕО:
 *   - Home: reset to a full-globe equator view (and clear host state).
 *   - North-up: snap heading to 0°.
 *   - Top-down: snap pitch to −90°.
 *   - 35° oblique: snap pitch to −35° while keeping heading.
 *   - Rotate +45°: step the heading right.
 *
 * All actions use the running viewer directly — no state in this component.
 * Pure DOM, no WebGL cost.
 */
export function HqGeoCameraControls({ viewer, onReset }: HqGeoCameraControlsProps) {
  const flyRel = (dHeadingDeg: number, pitchDeg?: number) => {
    if (!viewer) return;
    const camera = viewer.camera;
    const carto = CesiumNS.Cartographic.fromCartesian(camera.position);
    const heading = ((CesiumNS.Math.toDegrees(camera.heading) + dHeadingDeg + 540) % 360) - 180;
    const pitch = pitchDeg ?? CesiumNS.Math.toDegrees(camera.pitch);
    void camera.flyTo({
      destination: CesiumNS.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height),
      orientation: {
        heading: CesiumNS.Math.toRadians(heading),
        pitch: CesiumNS.Math.toRadians(pitch),
        roll: 0,
      },
      duration: 0.6,
    });
  };

  const home = () => {
    if (!viewer) return;
    void viewer.camera.flyTo({
      destination: CesiumNS.Cartesian3.fromDegrees(20, 25, 20_000_000),
      orientation: {
        heading: 0,
        pitch: CesiumNS.Math.toRadians(-90),
        roll: 0,
      },
      duration: 1.4,
    });
    onReset?.();
  };

  const base = `h-8 w-8 items-center justify-center flex ${hqHudButtonClass(false)}`;
  return (
    <div className={`absolute right-3 top-16 z-10 flex items-center gap-1 p-1 ${HQ_HUD_GLASS}`}>
      <button type="button" onClick={home} className={base} title="Домой — весь глобус, север вверх">
        <Globe2 className="h-3.5 w-3.5" />
      </button>
      <button type="button" onClick={() => flyRel(0 - 0, undefined)} className={base} title="Север вверх (heading 0°)">
        <Compass className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => {
          if (!viewer) return;
          const carto = CesiumNS.Cartographic.fromCartesian(viewer.camera.position);
          void viewer.camera.flyTo({
            destination: CesiumNS.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height),
            orientation: {
              heading: 0,
              pitch: CesiumNS.Math.toRadians(-90),
              roll: 0,
            },
            duration: 0.6,
          });
        }}
        className={base}
        title="Прямо вниз (top-down, pitch −90°)"
      >
        <Pin className="h-3.5 w-3.5" />
      </button>
      <button type="button" onClick={() => flyRel(0, -35)} className={base} title="Косой вид (pitch −35°)">
        <MoveDiagonal className="h-3.5 w-3.5" />
      </button>
      <button type="button" onClick={() => flyRel(45)} className={base} title="Повернуть вправо на 45°">
        <RotateCcw className="h-3.5 w-3.5 -scale-x-100" />
      </button>
    </div>
  );
}
