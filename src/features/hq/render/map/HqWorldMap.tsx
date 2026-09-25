"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import * as THREE from "three";
import type { HqMapWall } from "@/features/hq/core/types";
import { HqGlobe } from "@/features/hq/render/map/HqGlobe";
import { loadLandMask, type LandMask } from "@/features/hq/render/map/landMask";
import { MAP_DOT_COLUMNS, fitMap, type MapFit } from "@/features/hq/render/map/mapProjection";
import { DEFAULT_MAP_ACTIVITY, MapRig, type MapFrameInput } from "@/features/hq/render/map/mapRig";
import type { HqQuality } from "@/features/hq/render/scene/quality";
import { MAP_PANEL_ASPECT, type HqScreenHub } from "@/features/hq/render/screens/screenHub";

export type HqWorldMapProps = {
  wall: HqMapWall;
  quality: HqQuality;
  /** Share of working agents, 0..1; drives arc count and speed and overall energy. */
  activity?: MutableRefObject<number>;
  /** Paints the data panels either side of the globe; without it the glass draws glyph panels. */
  screens?: HqScreenHub | null;
};

// Layer depths in display-local metres (the wall face is z = 0).
const BEZEL_DEPTH = 0.07;
const PANEL_Z = 0.035;
const SIDE_Z = PANEL_Z + 0.004;
const HALO_Z = 0.012;
const FLOOR_LIFT = 0.012;
/** The backdrop behind the globe, as a multiple of the globe's diameter. */
const BACKDROP_SCALE = 2.2;

const noRaycast = () => null;

/**
 * The map wall on the north side of the hall: a long dark glass display with a
 * glowing frame, a holographic Earth floating in front of its centre (HqGlobe)
 * and two live data panels either side of it, the left one on the floor's
 * activity and the right one on the network and compute, plus a red spill
 * onto the wall and floor.
 */
export function HqWorldMap({ wall, quality, activity, screens = null }: HqWorldMapProps) {
  const fit = useMemo(
    () => fitMap(wall.width, wall.height, MAP_DOT_COLUMNS[quality]),
    [wall.width, wall.height, quality],
  );
  const floorY = -wall.y;
  // The glass's map rectangle becomes the backdrop behind the globe: its
  // graticule, ruler ticks and scan line frame the Earth.
  const backdrop = useMemo<MapFit>(() => {
    const half = Math.min(fit.panelW * 0.2, wall.globe.radius * BACKDROP_SCALE);
    return { ...fit, mapX0: -half, mapX1: half };
  }, [fit, wall.globe.radius]);
  const sides = useMemo(() => sidePanels(backdrop), [backdrop]);
  useEffect(() => () => sides?.geometry.dispose(), [sides]);

  const mask = useLandMask();

  const rig = useMemo(() => new MapRig(), []);
  useEffect(() => () => rig.dispose(), [rig]);

  const display = useMemo(() => createDisplayGeometry(fit, floorY), [fit, floorY]);
  useEffect(() => () => display.dispose(), [display]);

  const sideMaterials = useMemo(() => {
    if (!screens) return null;
    const make = (map: THREE.Texture) => {
      const material = new THREE.MeshBasicMaterial({ map, toneMapped: false });
      material.color.setScalar(1.9);
      return material;
    };
    return { left: make(screens.mapLeft), right: make(screens.mapRight) };
  }, [screens]);
  useEffect(
    () => () => {
      sideMaterials?.left.dispose();
      sideMaterials?.right.dispose();
    },
    [sideMaterials],
  );

  // Nothing here re-renders per frame: the rig writes uniforms. The input
  // object is reused so the frame loop allocates nothing.
  const frameInput = useRef<MapFrameInput | null>(null);
  useFrame((_state, delta) => {
    const raw = activity ? activity.current : DEFAULT_MAP_ACTIVITY;
    const level = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
    let input = frameInput.current;
    if (!input) {
      input = { fit: backdrop, floorSize: display.floorSize, quality, activity: level, hud: !screens };
      frameInput.current = input;
    }
    input.fit = backdrop;
    input.floorSize = display.floorSize;
    input.quality = quality;
    input.activity = level;
    input.hud = !screens;
    rig.frame(delta, input);
  });

  return (
    <>
      <group position={[wall.x, wall.y, wall.z]}>
        <mesh geometry={display.halo} material={rig.halo} position={[0, 0, HALO_Z]} raycast={noRaycast} />
        <mesh geometry={display.bezel} material={rig.bezel} raycast={noRaycast} />
        <mesh geometry={display.panel} material={rig.panel} position={[0, 0, PANEL_Z]} raycast={noRaycast} />
        {sideMaterials && sides ? (
          <>
            <mesh geometry={sides.geometry} material={sideMaterials.left} position={[sides.leftX, 0, SIDE_Z]} raycast={noRaycast} />
            <mesh geometry={sides.geometry} material={sideMaterials.right} position={[sides.rightX, 0, SIDE_Z]} raycast={noRaycast} />
          </>
        ) : null}
        <mesh
          geometry={display.floor}
          material={rig.floor}
          position={[0, floorY + FLOOR_LIFT, display.floorSize.y / 2]}
          rotation={[-Math.PI / 2, 0, 0]}
          raycast={noRaycast}
        />
      </group>
      <HqGlobe globe={wall.globe} mask={mask} quality={quality} activity={activity} />
    </>
  );
}

/**
 * The two data panels: as large as the space between the frame and the
 * backdrop allows at the canvases' aspect, centred in it.
 */
function sidePanels(fit: MapFit): { geometry: THREE.PlaneGeometry; leftX: number; rightX: number } | null {
  const margin = fit.frameInset * 2.2;
  const outer = fit.panelW / 2 - fit.frameInset - margin;
  const inner = fit.mapX1 + margin;
  const width = outer - inner;
  const height = fit.panelH - 2 * (fit.frameInset + margin);
  if (width < 0.8 || height < 0.5) return null;
  let w = width;
  let h = w / MAP_PANEL_ASPECT;
  if (h > height) {
    h = height;
    w = h * MAP_PANEL_ASPECT;
  }
  const centre = (outer + inner) / 2;
  return { geometry: new THREE.PlaneGeometry(w, h), leftX: -centre, rightX: centre };
}

function useLandMask(): LandMask | null {
  const [mask, setMask] = useState<LandMask | null>(null);
  useEffect(() => {
    let alive = true;
    loadLandMask().then(
      (loaded) => {
        if (alive) setMask(loaded);
      },
      (error: unknown) => {
        // The globe keeps its oceans, graticule and atmosphere as the fallback.
        if (process.env.NODE_ENV !== "production") console.warn("[hq] world map land data failed to load", error);
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  return mask;
}

type DisplayGeometry = {
  panel: THREE.PlaneGeometry;
  bezel: THREE.ExtrudeGeometry;
  halo: THREE.PlaneGeometry;
  floor: THREE.PlaneGeometry;
  floorSize: THREE.Vector2;
  dispose(): void;
};

function createDisplayGeometry(fit: MapFit, floorY: number): DisplayGeometry {
  const panel = new THREE.PlaneGeometry(fit.panelW, fit.panelH);

  // Bezel: the outer rectangle with the glass cut out, standing off the wall.
  const ow = fit.outerW / 2;
  const oh = fit.outerH / 2;
  const iw = fit.panelW / 2;
  const ih = fit.panelH / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-ow, -oh);
  shape.lineTo(ow, -oh);
  shape.lineTo(ow, oh);
  shape.lineTo(-ow, oh);
  shape.closePath();
  const hole = new THREE.Path();
  hole.moveTo(-iw, -ih);
  hole.lineTo(-iw, ih);
  hole.lineTo(iw, ih);
  hole.lineTo(iw, -ih);
  hole.closePath();
  shape.holes.push(hole);
  const bezel = new THREE.ExtrudeGeometry(shape, { depth: BEZEL_DEPTH, bevelEnabled: false, curveSegments: 1 });

  // Halo on the wall from the floor to just above the display. vLocal in the
  // shader is display-local because the plane is translated, not the mesh.
  // Kept low above the display so it never glows past the top of the wall.
  const top = oh + 0.6;
  const bottom = Math.min(floorY, -oh - 0.5);
  const halo = new THREE.PlaneGeometry(fit.outerW + 4, top - bottom);
  halo.translate(0, (top + bottom) / 2, 0);

  const floorSize = new THREE.Vector2(fit.outerW * 1.15, THREE.MathUtils.clamp(fit.outerH * 0.9, 3, 6));
  const floor = new THREE.PlaneGeometry(floorSize.x, floorSize.y);

  return {
    panel,
    bezel,
    halo,
    floor,
    floorSize,
    dispose() {
      panel.dispose();
      bezel.dispose();
      halo.dispose();
      floor.dispose();
    },
  };
}
