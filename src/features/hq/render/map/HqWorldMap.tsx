"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import type { HqMapWall } from "@/features/hq/core/types";
import { MapDataLoader, browserLoadEnvironment, planMapLoad, whenIdle } from "@/features/hq/render/map/mapData";
import type { MapImageryKind } from "@/features/hq/render/map/mapGeo";
import { MAP_LAYER_Z, createDisplayGeometry, createWingGeometry } from "@/features/hq/render/map/mapGeometry";
import { MAP_HOTSPOT_COUNT, fitMap } from "@/features/hq/render/map/mapProjection";
import { DEFAULT_MAP_ACTIVITY, MapRig, type MapFrameInput } from "@/features/hq/render/map/mapRig";
import { mapBriefing, mapWings, type MapWingSource, type MapWingTile } from "@/features/hq/render/map/mapWings";
import type { HqQuality } from "@/features/hq/render/scene/quality";
import type { HqScreenHub } from "@/features/hq/render/screens/screenHub";
import { createScreenTextureMaterial } from "@/features/hq/render/screens/screenMaterial";

export type HqWorldMapProps = {
  wall: HqMapWall;
  quality: HqQuality;
  /** Share of working agents, 0..1; drives the markers' and the glass's energy. */
  activity?: MutableRefObject<number>;
  /**
   * Paints the live data panels on the wings, and a briefing when there is
   * one (HqScreenHub.setBriefing); without it the glass draws glyph panels.
   */
  screens?: HqScreenHub | null;
};

const MOSAIC_SOURCES: readonly MapWingSource[] = ["left", "right", "apps"];
const BRIEFING_SOURCES: readonly MapWingSource[] = ["left", "right"];
/**
 * The wings' panels stay well under bloom: two dozen of them glowing white
 * would wash the wall out. The map and the glowing frame carry the light.
 */
const WING_GAIN = 1.35;
/** The briefing's goal is the one line meant to stand out: just at the bloom's edge. */
const BANNER_GAIN = 1.5;

type TileMesh = { source: MapWingSource; geometry: THREE.BufferGeometry };

/** The tiles merged into one bent geometry per texture they sample. */
function tileMeshes(tiles: readonly MapWingTile[], sources: readonly MapWingSource[], k: number, z?: number): TileMesh[] {
  const parts: TileMesh[] = [];
  for (const source of sources) {
    const geometry = createWingGeometry(tiles, source, k, z);
    if (geometry) parts.push({ source, geometry });
  }
  return parts;
}

const noRaycast = () => null;

/**
 * The colossal video wall on the north wall: a concave display whose middle
 * touches the wall and whose ends come forward (HqMapWall.curve), set in a
 * matte case that fills the space behind it down to the floor. In the middle
 * a realistic Earth at night (real coastlines and borders, graphite land with
 * warm orange city lights) under the real-time Sun, with red live markers on
 * the busy cities and glowing arcs between them, pulses running along; on
 * the wings a wall of live data panels in red and amber (mapWings.ts); a
 * glowing frame, the case's LED line and a red spill onto the floor. Until
 * its data loads it shows the dark glass, frame and graticule.
 *
 * During a briefing the wings show the task and the plan whole and a banner
 * across the top of the map the goal (mapBriefing). The switch follows what
 * the screen hub has painted, never a half-painted mix, and flips visibility
 * only: no React render, no new program.
 *
 * Every layer is bent onto the arc once, on the CPU (mapGeometry.ts); only
 * the markers, placed per frame in their shader, bend there. About ten draw
 * calls in all.
 */
export function HqWorldMap({ wall, quality, activity, screens = null }: HqWorldMapProps) {
  const fit = useMemo(() => fitMap(wall.width, wall.height, wall.curve), [wall.width, wall.height, wall.curve]);
  const floorY = -wall.y;
  const boundsRadius = Math.hypot(fit.outerW, fit.outerH) / 2 + 1.5;

  const rig = useMemo(() => new MapRig(), []);
  useEffect(() => () => rig.dispose(), [rig]);
  useMapData(rig);

  const display = useMemo(() => createDisplayGeometry(fit, floorY), [fit, floorY]);
  useEffect(() => () => display.dispose(), [display]);

  // The wings' panels (the tiled cards, and the briefing's whole panels and
  // banner): one merged, bent geometry per texture they sample.
  const wings = useMemo(() => {
    const layout = mapWings(fit);
    const briefing = mapBriefing(fit);
    if (!layout || !briefing) return null;
    return {
      mosaic: tileMeshes(layout.tiles, MOSAIC_SOURCES, fit.arcK),
      briefing: tileMeshes(briefing, BRIEFING_SOURCES, fit.arcK),
      banner: tileMeshes(briefing, ["banner"], fit.arcK, MAP_LAYER_Z.banner),
    };
  }, [fit]);
  useEffect(
    () => () => {
      if (wings) for (const part of [...wings.mosaic, ...wings.briefing, ...wings.banner]) part.geometry.dispose();
    },
    [wings],
  );
  const wingMaterials = useMemo(() => {
    if (!screens) return null;
    // The mosaic runs in the wall's red-to-amber; the briefing's banner keeps its own colours.
    const make = (map: THREE.Texture, name: string, gain = WING_GAIN, warm = true) =>
      createScreenTextureMaterial(map, gain, name, undefined, warm);
    const materials: Record<MapWingSource, THREE.MeshBasicMaterial> = {
      left: make(screens.mapLeft, "hq-map-wing-left"),
      right: make(screens.mapRight, "hq-map-wing-right"),
      apps: make(screens.monitors, "hq-map-wing-apps"),
      banner: make(screens.mapBanner, "hq-map-banner", BANNER_GAIN, false),
    };
    return materials;
  }, [screens]);
  useEffect(
    () => () => {
      if (wingMaterials) for (const material of Object.values(wingMaterials)) material.dispose();
    },
    [wingMaterials],
  );
  // Which of them show: flipped per frame from what the hub has painted.
  const mosaicRef = useRef<THREE.Group>(null);
  const briefingRef = useRef<THREE.Group>(null);
  const bannerRef = useRef<THREE.Group>(null);

  const hotspotGeometry = useMemo(() => createHotspotGeometry(boundsRadius), [boundsRadius]);
  useEffect(() => () => hotspotGeometry.dispose(), [hotspotGeometry]);

  // Nothing here re-renders per frame: the rig writes uniforms and attributes.
  // The input object is reused so the frame loop allocates nothing.
  const frameInput = useRef<MapFrameInput | null>(null);
  useFrame((state, delta) => {
    // A map layer that arrived streams to the GPU a strip per frame.
    rig.upload(state.gl);
    const raw = activity ? activity.current : DEFAULT_MAP_ACTIVITY;
    const level = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
    let input = frameInput.current;
    if (!input) {
      input = {
        fit,
        floorSize: display.floorSize,
        floorY,
        quality,
        activity: level,
        hud: true,
        briefing: false,
        clockMs: Date.now(),
      };
      frameInput.current = input;
    }
    const onWings = screens?.briefingOnWings ?? false;
    if (mosaicRef.current) mosaicRef.current.visible = !onWings;
    if (briefingRef.current) briefingRef.current.visible = onWings;
    if (bannerRef.current) bannerRef.current.visible = screens?.briefingBanner ?? false;
    input.fit = fit;
    input.floorSize = display.floorSize;
    input.floorY = floorY;
    input.quality = quality;
    input.activity = level;
    input.hud = !wingMaterials || !wings || wings.mosaic.length === 0;
    input.briefing = onWings;
    input.clockMs = Date.now();
    rig.frame(delta, input);
  });

  return (
    <group position={[wall.x, wall.y, wall.z]}>
      <mesh geometry={display.body} material={rig.body} raycast={noRaycast} />
      <mesh geometry={display.halo} material={rig.halo} raycast={noRaycast} />
      <mesh geometry={display.bezel} material={rig.bezel} raycast={noRaycast} />
      <mesh geometry={display.panel} material={rig.panel} raycast={noRaycast} />
      <mesh geometry={display.earth} material={rig.earth} raycast={noRaycast} />
      {wingMaterials && wings ? (
        <>
          <group ref={mosaicRef}>
            {wings.mosaic.map(({ source, geometry }) => (
              <mesh key={source} geometry={geometry} material={wingMaterials[source]} raycast={noRaycast} />
            ))}
          </group>
          <group ref={briefingRef}>
            {wings.briefing.map(({ source, geometry }) => (
              <mesh key={source} geometry={geometry} material={wingMaterials[source]} raycast={noRaycast} />
            ))}
          </group>
          <group ref={bannerRef}>
            {wings.banner.map(({ source, geometry }) => (
              <mesh key={source} geometry={geometry} material={wingMaterials[source]} raycast={noRaycast} />
            ))}
          </group>
        </>
      ) : null}
      <mesh geometry={hotspotGeometry} material={rig.hotspots} position={[0, 0, MAP_LAYER_Z.overlay]} raycast={noRaycast} />
      <mesh geometry={display.floor} material={rig.floor} raycast={noRaycast} />
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
