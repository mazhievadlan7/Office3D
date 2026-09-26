"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import type { HqMapWall } from "@/features/hq/core/types";
import { MapDataLoader, browserLoadEnvironment, planMapLoad, whenIdle } from "@/features/hq/render/map/mapData";
import type { MapImageryKind } from "@/features/hq/render/map/mapGeo";
import { MAP_HOTSPOT_COUNT, fitMap, type MapFit } from "@/features/hq/render/map/mapProjection";
import { DEFAULT_MAP_ACTIVITY, MapRig, type MapFrameInput } from "@/features/hq/render/map/mapRig";
import type { HqQuality } from "@/features/hq/render/scene/quality";
import { MAP_PANEL_ASPECT, type HqScreenHub } from "@/features/hq/render/screens/screenHub";
import { createScreenTextureMaterial } from "@/features/hq/render/screens/screenMaterial";

export type HqWorldMapProps = {
  wall: HqMapWall;
  quality: HqQuality;
  /** Share of working agents, 0..1; drives the markers' and the glass's energy. */
  activity?: MutableRefObject<number>;
  /** Paints the live data panels beside the map; without it the glass draws glyph panels. */
  screens?: HqScreenHub | null;
};

// Layer depths in display-local metres (the wall face is z = 0).
const BEZEL_DEPTH = 0.07;
const PANEL_Z = 0.035;
const EARTH_Z = PANEL_Z + 0.003;
const OVERLAY_Z = PANEL_Z + 0.004;
const SIDE_Z = PANEL_Z + 0.003;
const HALO_Z = 0.012;
const FLOOR_LIFT = 0.012;

const noRaycast = () => null;

/**
 * The giant world map on the north wall: a realistic Earth (real coastlines
 * and borders, relief, ocean depth and the night side's city lights, in the
 * HQ's red on black) under the real-time Sun, small live markers on the
 * busy cities, a glowing frame and a red spill onto the wall and floor. No
 * flying arcs or glowing orbs over it: they read as clutter on a realistic map.
 * Until its data loads it shows the dark glass, frame and graticule.
 */
export function HqWorldMap({ wall, quality, activity, screens = null }: HqWorldMapProps) {
  const fit = useMemo(() => fitMap(wall.width, wall.height), [wall.width, wall.height]);
  const floorY = -wall.y;
  const boundsRadius = Math.hypot(fit.outerW, fit.outerH) / 2 + 1.5;

  const rig = useMemo(() => new MapRig(), []);
  useEffect(() => () => rig.dispose(), [rig]);
  useMapData(rig);

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

  const hotspotGeometry = useMemo(() => createHotspotGeometry(boundsRadius), [boundsRadius]);
  useEffect(() => () => hotspotGeometry.dispose(), [hotspotGeometry]);

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
        activity: level,
        hud: !sideMaterials,
        clockMs: Date.now(),
      };
      frameInput.current = input;
    }
    input.fit = fit;
    input.floorSize = display.floorSize;
    input.quality = quality;
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
      <mesh geometry={display.earth} material={rig.earth} position={[0, 0, EARTH_Z]} raycast={noRaycast} />
      {sideMaterials && sides ? (
        <>
          <mesh geometry={sides.geometry} material={sideMaterials.left} position={[sides.leftX, 0, SIDE_Z]} raycast={noRaycast} />
          <mesh geometry={sides.geometry} material={sideMaterials.right} position={[sides.rightX, 0, SIDE_Z]} raycast={noRaycast} />
        </>
      ) : null}
      <mesh geometry={hotspotGeometry} material={rig.hotspots} position={[0, 0, OVERLAY_Z]} raycast={noRaycast} />
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
 * Loads the map's data once the scene is up: the coastlines and borders
 * first, then the NASA imagery if it is there. Everything heavy happens in a
 * worker; the rig attaches each texture on its own frame.
 */
function useMapData(rig: MapRig): void {
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    const caps = gl.capabilities;
    const loader = new MapDataLoader(planMapLoad(browserLoadEnvironment(caps.maxTextureSize)));
    let alive = true;
    const dev = process.env.NODE_ENV !== "production";
    const cancelStart = whenIdle(() => {
      if (!alive) return;
      rig.setAnisotropy(caps.getMaxAnisotropy());
      loader.geo().then(
        (raster) => {
          if (alive) rig.setRaster("geo", raster);
        },
        (error: unknown) => {
          // The dark glass, frame and graticule stay up as the fallback.
          if (alive && dev) console.warn("[hq] world map data failed to load", error);
        },
      );
      const imagery = (kind: MapImageryKind) =>
        loader.imagery(kind).then(
          (raster) => {
            if (alive) rig.setRaster(kind, raster);
          },
          (error: unknown) => {
            // Optional: without it the map keeps the look built from the vector data.
            if (alive && dev) console.info(`[hq] world map ${kind} imagery not used:`, error);
          },
        );
      imagery("day");
      imagery("night");
    });
    return () => {
      alive = false;
      cancelStart();
      loader.dispose();
    };
  }, [gl, rig]);
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

type DisplayGeometry = {
  panel: THREE.PlaneGeometry;
  /** The Earth's surface over the land rectangle, in display-local metres (uv 0..1 west-east, south-north). */
  earth: THREE.PlaneGeometry;
  bezel: THREE.ExtrudeGeometry;
  halo: THREE.PlaneGeometry;
  floor: THREE.PlaneGeometry;
  floorSize: THREE.Vector2;
  dispose(): void;
};

function createDisplayGeometry(fit: MapFit, floorY: number): DisplayGeometry {
  const panel = new THREE.PlaneGeometry(fit.panelW, fit.panelH);
  const earth = new THREE.PlaneGeometry(fit.mapX1 - fit.mapX0, fit.mapY1 - fit.mapY0);
  earth.translate((fit.mapX0 + fit.mapX1) / 2, (fit.mapY0 + fit.mapY1) / 2, 0);

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
    earth,
    bezel,
    halo,
    floor,
    floorSize,
    dispose() {
      panel.dispose();
      earth.dispose();
      bezel.dispose();
      halo.dispose();
      floor.dispose();
    },
  };
}

const QUAD_POSITIONS = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
const QUAD_INDEX = [0, 1, 2, 0, 2, 3];

function createHotspotGeometry(boundsRadius: number): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(QUAD_POSITIONS, 3));
  geometry.setIndex(QUAD_INDEX);
  // Instances spread over the display, far beyond the unit quad.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), boundsRadius);
  const index = new Float32Array(MAP_HOTSPOT_COUNT);
  for (let i = 0; i < MAP_HOTSPOT_COUNT; i++) index[i] = i;
  geometry.setAttribute("aIndex", new THREE.InstancedBufferAttribute(index, 1));
  geometry.instanceCount = MAP_HOTSPOT_COUNT;
  return geometry;
}
