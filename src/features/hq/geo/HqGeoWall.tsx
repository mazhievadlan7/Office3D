"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { CanvasTexture, LinearFilter, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from "three";

import type { HqMapWall } from "@/features/hq/core/types";
import { GlobeView, greatCircle, loadEarth, type GlobePoint } from "@/features/hq/render/screens/screenGlobe";
import { geoController } from "./geoController";
import { seedDemoGeo } from "./geoData";
import { GEO_ARC_STYLE, GEO_KIND_STYLE } from "./geoStyle";
import type { GeoSceneData } from "./geoTypes";

/**
 * The cheap «ГЕО» preview on the hall's video wall: a slow-rotating globe with
 * our authorized-target pins and arcs, drawn in Canvas 2D (reusing the HQ's
 * existing GlobeView — about a millisecond a frame) to one texture, capped at a
 * low frame rate and mounted only while summoned. It never runs the heavy
 * CesiumJS renderer and adds no per-frame cost to the hall when it is not shown
 * (the component simply is not mounted).
 *
 * It floats as a framed panel just in front of the wall's centre, facing the
 * room, so it reads as a summoned overview rather than replacing the live wall.
 */

const GLOBE_RADIUS = 180;
/** Composition canvas, a little taller than the globe for the frame and labels. */
const CANVAS_W = 620;
const CANVAS_H = 560;
/** Capped refresh: ~18 fps is plenty for a slow globe and stays off the hall's budget. */
const FRAME_INTERVAL = 1 / 18;
/** Degrees per second the globe turns. */
const SPIN_DEG_PER_S = 4;

const GLOBE_CX = CANVAS_W / 2;
const GLOBE_CY = 250;

type Ctx = CanvasRenderingContext2D;

function roundRect(c: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  if (typeof c.roundRect === "function") c.roundRect(x, y, w, h, r);
  else {
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }
}

/** The preview's mutable render kit: the composition canvas, its 2D context, the globe renderer and the texture. */
type GeoWallKit = {
  canvas: HTMLCanvasElement | null;
  ctx: Ctx | null;
  globe: GlobeView;
  texture: CanvasTexture | null;
};

function createKit(): GeoWallKit {
  const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
  if (canvas) {
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
  }
  const ctx = canvas ? canvas.getContext("2d") : null;
  const globe = new GlobeView(GLOBE_RADIUS, 18);
  const texture = canvas ? new CanvasTexture(canvas) : null;
  if (texture) {
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
  }
  return { canvas, ctx, globe, texture };
}

export type HqGeoWallProps = {
  wall: HqMapWall;
};

export function HqGeoWall({ wall }: HqGeoWallProps) {
  // Seed the demo targets if nothing has fed the controller yet, so the preview
  // has pins on its own (the full-screen view shares the same controller).
  useEffect(() => {
    if (geoController.getScene().targets.length === 0) seedDemoGeo(geoController);
  }, []);

  const sceneRef = useRef<GeoSceneData>(geoController.getScene());
  useEffect(() => {
    sceneRef.current = geoController.getScene();
    return geoController.subscribe((scene) => {
      sceneRef.current = scene;
    });
  }, []);

  // Load the photographic Earth (shared NASA textures, a module-level singleton);
  // the globe falls back to a lit graticule sphere until (or if) it arrives.
  useEffect(() => {
    void loadEarth().catch(() => false);
  }, []);

  const meshRef = useRef<Mesh>(null);
  // The composition canvas, globe renderer and texture need per-frame mutation,
  // so they live in a ref and are built (and disposed) imperatively — never on a
  // memoised hook value, which must not be mutated under the React Compiler.
  const kitRef = useRef<GeoWallKit | null>(null);
  const accRef = useRef(0);
  const lonRef = useRef(0);
  const pointRef = useRef<GlobePoint>({ x: 0, y: 0, z: 0 });

  const aspect = CANVAS_W / CANVAS_H;
  const panelH = Math.min(wall.height * 0.62, 7.5);
  const panelW = panelH * aspect;
  const panelY = wall.y + wall.height * 0.08;
  const forward = (wall.curve || 0) + 0.35;

  // Build the mesh's geometry, material and render kit once (rebuilt only if the
  // panel size changes), and tear them down on unmount.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const kit = createKit();
    kitRef.current = kit;
    const geometry = new PlaneGeometry(panelW, panelH);
    const material = new MeshBasicMaterial({
      map: kit.texture ?? undefined,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    mesh.geometry = geometry;
    mesh.material = material;
    return () => {
      geometry.dispose();
      material.dispose();
      kit.texture?.dispose();
      kitRef.current = null;
    };
  }, [panelW, panelH]);

  useFrame((_state, delta) => {
    accRef.current += delta;
    if (accRef.current < FRAME_INTERVAL) return;
    const dt = accRef.current;
    accRef.current = 0;
    lonRef.current = (lonRef.current + SPIN_DEG_PER_S * dt) % 360;
    const current = kitRef.current;
    if (!current || !current.ctx || !current.texture) return;
    draw(current.ctx, current.globe, lonRef.current, sceneRef.current, pointRef.current);
    current.texture.needsUpdate = true;
  });

  return <mesh ref={meshRef} position={[wall.x, panelY, wall.z + forward]} />;
}

/** Paints one frame of the preview: frame, header, globe, pins, arcs, footer. */
function draw(ctx: Ctx, globe: GlobeView, lon: number, scene: GeoSceneData, out: GlobePoint): void {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  // Glass panel + red frame.
  roundRect(ctx, 6, 6, CANVAS_W - 12, CANVAS_H - 12, 18);
  const bg = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
  bg.addColorStop(0, "rgba(16,9,10,0.94)");
  bg.addColorStop(1, "rgba(7,5,6,0.96)");
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255,60,52,0.4)";
  ctx.stroke();

  // Header.
  ctx.fillStyle = "#ff2a2a";
  ctx.beginPath();
  ctx.arc(34, 40, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = '600 22px "Bahnschrift", "Segoe UI", sans-serif';
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("ГЕО · ОБЗОР ЦЕЛЕЙ", 50, 40);
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = '600 11px "Segoe UI", sans-serif';
  ctx.fillText("АВТОРИЗОВАННЫЕ ЦЕЛИ · ОТКРЫТЫЕ ДАННЫЕ", 50, 62);

  // Globe.
  const globeCanvas = globe.render(lon, Date.now());
  if (globeCanvas) {
    ctx.drawImage(globeCanvas as CanvasImageSource, GLOBE_CX - globe.size / 2, GLOBE_CY - globe.size / 2);
  }

  // Arcs (great circles), only the visible side.
  for (const arc of scene.arcs) {
    const pts = greatCircle(arc.from.lon, arc.from.lat, arc.to.lon, arc.to.lat, 48);
    ctx.strokeStyle = GEO_ARC_STYLE[arc.kind].color;
    ctx.lineWidth = 1.6;
    ctx.globalAlpha = 0.85;
    let drawing = false;
    ctx.beginPath();
    for (const [plon, plat] of pts) {
      globe.project(plon, plat, lon, out);
      if (out.z <= 0.02) {
        drawing = false;
        continue;
      }
      const x = GLOBE_CX + out.x;
      const y = GLOBE_CY + out.y;
      if (!drawing) {
        ctx.moveTo(x, y);
        drawing = true;
      } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Pins.
  for (const target of scene.targets) {
    globe.project(target.lon, target.lat, lon, out);
    if (out.z <= 0.02) continue;
    const x = GLOBE_CX + out.x;
    const y = GLOBE_CY + out.y;
    const color = GEO_KIND_STYLE[target.kind].color;
    const r = target.kind === "hq" ? 5 : 3.5;
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.25;
    ctx.arc(x, y, r * 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(6,8,12,0.85)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  // Footer / attribution.
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.font = '600 10px "Segoe UI", sans-serif';
  ctx.fillText("CesiumJS (Apache-2.0) · gods-eye-view (MIT)", 24, CANVAS_H - 24);
}

export default HqGeoWall;
