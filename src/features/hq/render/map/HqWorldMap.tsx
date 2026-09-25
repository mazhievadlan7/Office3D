"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import * as THREE from "three";
import type { HqMapWall } from "@/features/hq/core/types";
import { extractLandDots, loadLandMask, type LandDots, type LandMask } from "@/features/hq/render/map/landMask";
import { ARC_SEGMENTS, ARC_SLOTS, ArcScheduler, createArcBuffers } from "@/features/hq/render/map/mapArcs";
import { MAP_DOT_COLUMNS, MAP_HOTSPOT_COUNT, fitMap, type MapFit } from "@/features/hq/render/map/mapProjection";
import { DEFAULT_MAP_ACTIVITY, HOTSPOT_UV, MapRig, type MapFrameInput } from "@/features/hq/render/map/mapRig";
import type { HqQuality } from "@/features/hq/render/scene/quality";
import { MAP_PANEL_ASPECT, type HqScreenHub } from "@/features/hq/render/screens/screenHub";
import { createScreenTextureMaterial } from "@/features/hq/render/screens/screenMaterial";

export type HqWorldMapProps = {
  wall: HqMapWall;
  quality: HqQuality;
  /** Share of working agents, 0..1; drives arc count and speed and overall energy. */
  activity?: MutableRefObject<number>;
  /** Paints the live data panels beside the map; without it the glass draws glyph panels. */
  screens?: HqScreenHub | null;
};

// Layer depths in display-local metres (the wall face is z = 0).
const BEZEL_DEPTH = 0.07;
const PANEL_Z = 0.035;
const DOTS_Z = PANEL_Z + 0.004;
const SIDE_Z = PANEL_Z + 0.003;
const HALO_Z = 0.012;
const FLOOR_LIFT = 0.012;

const noRaycast = () => null;

/**
 * The giant holographic world map on the north wall: dark glass behind a
 * dot-matrix of the continents, pulsing city hotspots, travelling arcs, a
 * glowing frame and a red spill onto the wall and floor. Until the land data
 * loads it shows the frame and graticule alone.
 */
export function HqWorldMap({ wall, quality, activity, screens = null }: HqWorldMapProps) {
  const fit = useMemo(
    () => fitMap(wall.width, wall.height, MAP_DOT_COLUMNS[quality]),
    [wall.width, wall.height, quality],
  );
  const floorY = -wall.y;
  const boundsRadius = Math.hypot(fit.outerW, fit.outerH) / 2 + 1.5;

  const mask = useLandMask();
  const dots = useMemo(() => (mask ? extractLandDots(mask, fit.cols, fit.rows) : null), [mask, fit.cols, fit.rows]);

  const rig = useMemo(() => new MapRig(), []);
  useEffect(() => () => rig.dispose(), [rig]);

  const display = useMemo(() => createDisplayGeometry(fit, floorY), [fit, floorY]);
  useEffect(() => () => display.dispose(), [display]);

  // The live data panels either side of the map (screen hub canvases).
  const sides = useMemo(() => sidePanels(fit), [fit]);
  useEffect(() => () => sides?.geometry.dispose(), [sides]);
  const sideMaterials = useMemo(() => {
    if (!screens) return null;
    const make = (map: THREE.Texture) => createScreenTextureMaterial(map, 1.9, "hq-map-panel");
    return { left: make(screens.mapLeft), right: make(screens.mapRight) };
  }, [screens]);
  useEffect(
    () => () => {
      sideMaterials?.left.dispose();
      sideMaterials?.right.dispose();
    },
    [sideMaterials],
  );

  const dotGeometry = useMemo(() => createDotGeometry(dots, boundsRadius), [dots, boundsRadius]);
  useEffect(() => () => dotGeometry.dispose(), [dotGeometry]);

  const hotspotGeometry = useMemo(() => createHotspotGeometry(boundsRadius), [boundsRadius]);
  useEffect(() => () => hotspotGeometry.dispose(), [hotspotGeometry]);

  const arcs = useMemo(
    () => createArcBuffers(ARC_SEGMENTS[quality], ARC_SLOTS[quality], boundsRadius),
    [quality, boundsRadius],
  );
  useEffect(() => () => arcs.geometry.dispose(), [arcs]);
  const scheduler = useMemo(() => new ArcScheduler(HOTSPOT_UV, ARC_SLOTS[quality]), [quality]);

  // Nothing here re-renders per frame: the rig writes uniforms and attributes.
  // The input object is reused so the frame loop allocates nothing.
  const frameInput = useRef<MapFrameInput | null>(null);
  useFrame((_state, delta) => {
    const raw = activity ? activity.current : DEFAULT_MAP_ACTIVITY;
    const level = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
    let input = frameInput.current;
    if (!input) {
      input = {
        fit,
        floorSize: display.floorSize,
        quality,
        landReady: false,
        arcs,
        scheduler,
        activity: level,
        hud: !sideMaterials,
        clockMs: Date.now(),
      };
      frameInput.current = input;
    }
    input.fit = fit;
    input.floorSize = display.floorSize;
    input.quality = quality;
    input.landReady = dots !== null;
    input.arcs = arcs;
    input.scheduler = scheduler;
    input.activity = level;
    input.hud = !sideMaterials || !sides;
    input.clockMs = Date.now();
    rig.frame(delta, input);
  });

  return (
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
      {/* Always mounted (empty until the land loads) so programs compile up front. */}
      <mesh geometry={dotGeometry} material={rig.dots} position={[0, 0, DOTS_Z]} raycast={noRaycast} />
      <mesh geometry={hotspotGeometry} material={rig.hotspots} position={[0, 0, DOTS_Z]} raycast={noRaycast} />
      <mesh geometry={arcs.geometry} material={rig.arcs} position={[0, 0, DOTS_Z]} raycast={noRaycast} />
      <mesh
        geometry={display.floor}
        material={rig.floor}
        position={[0, floorY + FLOOR_LIFT, display.floorSize.y / 2]}
        rotation={[-Math.PI / 2, 0, 0]}
        raycast={noRaycast}
      />
    </group>
  );
}

/**
 * The two data panels in the letterbox space beside the land: as large as the
 * space between the frame and the map allows at the canvases' aspect.
 */
function sidePanels(fit: MapFit): { geometry: THREE.PlaneGeometry; leftX: number; rightX: number } | null {
  const margin = fit.frameInset * 1.6;
  const outer = fit.panelW / 2 - fit.frameInset - margin;
  const inner = fit.mapX1 + margin;
  const width = outer - inner;
  const height = fit.mapY1 - fit.mapY0;
  if (width < 0.8 || height < 0.5) return null;
  let w = width;
  let h = w / MAP_PANEL_ASPECT;
  if (h > height) {
    h = height;
    w = h * MAP_PANEL_ASPECT;
  }
  const centre = (outer + inner) / 2;
  // The hub's textures keep their top row at v = 0; a plane has v = 1 at the top.
  const geometry = new THREE.PlaneGeometry(w, h);
  const uv = geometry.getAttribute("uv");
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  return { geometry, leftX: -centre, rightX: centre };
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
        // The frame and graticule stay up as the fallback.
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

const QUAD_POSITIONS = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
const QUAD_INDEX = [0, 1, 2, 0, 2, 3];

function createQuadInstances(boundsRadius: number): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(QUAD_POSITIONS, 3));
  geometry.setIndex(QUAD_INDEX);
  // Instances spread over the display, far beyond the unit quad.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), boundsRadius);
  return geometry;
}

/** One quad per land dot; empty (zero instances) while the land is loading. */
function createDotGeometry(dots: LandDots | null, boundsRadius: number): THREE.InstancedBufferGeometry {
  const geometry = createQuadInstances(boundsRadius);
  const data = dots && dots.count > 0 ? dots.data : new Float32Array(4);
  geometry.setAttribute("aDot", new THREE.InstancedBufferAttribute(data, 4));
  geometry.instanceCount = dots ? dots.count : 0;
  return geometry;
}

function createHotspotGeometry(boundsRadius: number): THREE.InstancedBufferGeometry {
  const geometry = createQuadInstances(boundsRadius);
  const index = new Float32Array(MAP_HOTSPOT_COUNT);
  for (let i = 0; i < MAP_HOTSPOT_COUNT; i++) index[i] = i;
  geometry.setAttribute("aIndex", new THREE.InstancedBufferAttribute(index, 1));
  geometry.instanceCount = MAP_HOTSPOT_COUNT;
  return geometry;
}
