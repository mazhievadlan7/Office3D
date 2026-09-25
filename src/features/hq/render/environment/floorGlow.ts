import * as THREE from "three";
import { HQ_THEME, WORKSTATION } from "@/features/hq/core/config";
import type { HqLayout } from "@/features/hq/core/types";
import type { HqQuality } from "@/features/hq/render/scene/quality";
import { am7SignPlacement, entranceGap, segmentOnRect } from "./layoutGeometry";

// The fake floor reflection. Every bright emissive element of the room is
// painted once, top down, into a blurred canvas; the floor shader samples it
// with a few taps stretched away from the camera, which reads as glossy
// streaks under the LEDs without a planar reflector (a second scene render
// is far too expensive at a thousand desks).

export type FloorGlow = {
  texture: THREE.Texture;
  /** x0, z0 of the painted area and 1/width, 1/depth, for uv = (xz - origin) * scale. */
  rect: THREE.Vector4;
  /** Canvas pixels per metre, so the shader can pick a mip level per blur radius. */
  pixelsPerMetre: number;
};

const MAX_RESOLUTION: Record<HqQuality, number> = { high: 2048, medium: 1024, low: 512 };
const MAX_PIXELS_PER_METRE = 28;
const PAD = 1;
// Pre-blur baked into the canvas, metres; the shader adds more through mips.
const BLUR_METRES = 0.16;

export function buildFloorGlow(layout: HqLayout, quality: HqQuality): FloorGlow {
  const { bounds } = layout;
  const x0 = bounds.x0 - PAD;
  const z0 = bounds.z0 - PAD;
  const width = bounds.x1 - bounds.x0 + PAD * 2;
  const depth = bounds.z1 - bounds.z0 + PAD * 2;
  const ppm = Math.min(MAX_PIXELS_PER_METRE, MAX_RESOLUTION[quality] / Math.max(width, depth));
  const w = Math.max(4, Math.round(width * ppm));
  const h = Math.max(4, Math.round(depth * ppm));
  const rect = new THREE.Vector4(x0, z0, 1 / width, 1 / depth);

  const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
  const ctx = canvas?.getContext("2d") ?? null;
  if (!canvas || !ctx) {
    const texture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    texture.needsUpdate = true;
    return { texture, rect, pixelsPerMetre: ppm };
  }
  canvas.width = w;
  canvas.height = h;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "lighter";

  const painter = new GlowPainter(ctx, x0, z0, ppm);
  paintLayout(painter, layout);

  const blurred = blurCanvas(canvas, BLUR_METRES * ppm);
  const texture = new THREE.CanvasTexture(blurred);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Canvas row 0 is z0: keep it at v = 0 so the shader maps world z directly.
  texture.flipY = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return { texture, rect, pixelsPerMetre: ppm };
}

/** Draws in world metres (x, z) with an optional local frame (position + rotation.y). */
class GlowPainter {
  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly x0: number,
    private readonly z0: number,
    private readonly ppm: number,
  ) {}

  /** Local frame of an object placed at (x, z) with rotation.y = rotY. */
  frame(x: number, z: number, rotY: number): void {
    const c = Math.cos(rotY);
    const s = Math.sin(rotY);
    const k = this.ppm;
    // three's rotation.y maps local (lx, lz) to (c*lx + s*lz, -s*lx + c*lz).
    this.ctx.setTransform(k * c, -k * s, k * s, k * c, k * (x - this.x0), k * (z - this.z0));
  }

  world(): void {
    const k = this.ppm;
    this.ctx.setTransform(k, 0, 0, k, -k * this.x0, -k * this.z0);
  }

  rect(ax: number, az: number, bx: number, bz: number, color: string, alpha: number): void {
    this.ctx.globalAlpha = alpha;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(Math.min(ax, bx), Math.min(az, bz), Math.abs(bx - ax), Math.abs(bz - az));
  }

  /** A band that fades from `alpha` at (a) to zero over `reach` along the normal. */
  band(ax: number, az: number, bx: number, bz: number, nx: number, nz: number, reach: number, color: string, alpha: number): void {
    const g = this.ctx.createLinearGradient(ax, az, ax + nx * reach, az + nz * reach);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(0,0,0,0)");
    this.ctx.globalAlpha = alpha;
    this.ctx.fillStyle = g;
    this.ctx.beginPath();
    this.ctx.moveTo(ax, az);
    this.ctx.lineTo(bx, bz);
    this.ctx.lineTo(bx + nx * reach, bz + nz * reach);
    this.ctx.lineTo(ax + nx * reach, az + nz * reach);
    this.ctx.closePath();
    this.ctx.fill();
  }

  line(ax: number, az: number, bx: number, bz: number, width: number, color: string, alpha: number): void {
    this.ctx.globalAlpha = alpha;
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = width;
    this.ctx.lineCap = "round";
    this.ctx.beginPath();
    this.ctx.moveTo(ax, az);
    this.ctx.lineTo(bx, bz);
    this.ctx.stroke();
  }

  disc(x: number, z: number, radius: number, color: string, alpha: number): void {
    const g = this.ctx.createRadialGradient(x, z, 0, x, z, radius);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(0,0,0,0)");
    this.ctx.globalAlpha = alpha;
    this.ctx.fillStyle = g;
    this.ctx.fillRect(x - radius, z - radius, radius * 2, radius * 2);
  }
}

function paintLayout(p: GlowPainter, layout: HqLayout): void {
  const red = HQ_THEME.accent;
  const warm = HQ_THEME.ledWarm;
  const { bounds } = layout;

  // Workstations: LED strip along the desk front and screen spill behind it.
  const ws = WORKSTATION;
  const halfW = ws.width / 2;
  for (const desk of [...layout.desks, layout.leadDesk]) {
    p.frame(desk.x, desk.z, desk.rotY);
    p.rect(-halfW, ws.deskFront - 0.02, halfW, ws.deskFront + 0.1, red, 0.32);
    p.rect(-halfW + 0.05, ws.deskFront, halfW - 0.05, ws.deskBack, red, 0.05);
    p.rect(-halfW - 0.1, ws.deskBack - 0.2, halfW + 0.1, ws.deskBack + 0.05, red, 0.08);
  }

  p.world();

  // The holographic map throws a wide band across the floor in front of it.
  const map = layout.mapWall;
  const mx0 = map.x - map.width / 2;
  const mx1 = map.x + map.width / 2;
  p.band(mx0, bounds.z0, mx1, bounds.z0, 0, 1, 2.0, red, 0.55);
  p.band(mx0 + 0.6, bounds.z0, mx1 - 0.6, bounds.z0, 0, 1, 0.8, red, 0.4);

  // Emissive lines at the foot of the tall walls and on the low curbs.
  p.band(bounds.x0, bounds.z0, bounds.x1, bounds.z0, 0, 1, 0.45, red, 0.45);
  p.band(bounds.x0, bounds.z0, bounds.x0, bounds.z1, 1, 0, 0.45, red, 0.45);
  const gap = entranceGap(layout);
  const southRuns: Array<[number, number]> =
    gap.side === "south" ? [[bounds.x0, gap.from], [gap.to, bounds.x1]] : [[bounds.x0, bounds.x1]];
  for (const [a, b] of southRuns) p.band(a, bounds.z1, b, bounds.z1, 0, -1, 0.3, red, 0.3);
  const eastRuns: Array<[number, number]> =
    gap.side === "east" ? [[bounds.z0, gap.from], [gap.to, bounds.z1]] : [[bounds.z0, bounds.z1]];
  for (const [a, b] of eastRuns) p.band(bounds.x1, a, bounds.x1, b, -1, 0, 0.3, red, 0.3);

  // Partitions carry a faint red line on the top rail; AM7's office a bright one.
  for (const seg of layout.partitions) {
    const am7 = segmentOnRect(seg, layout.am7Office);
    if (seg.kind === "wall" && !am7) continue;
    p.line(seg.ax, seg.az, seg.bx, seg.bz, am7 ? 0.35 : 0.22, red, am7 ? 0.42 : 0.12);
  }

  // The AM7 sign sits high, so its reflection lands further out.
  const sign = am7SignPlacement(layout);
  const nx = Math.sin(sign.rotY);
  const nz = Math.cos(sign.rotY);
  p.disc(sign.x + nx * 0.5, sign.z + nz * 0.5, 1.4, red, 0.75);

  for (const prop of layout.props) {
    const s = prop.scale ?? 1;
    switch (prop.kind) {
      case "server_rack":
        p.frame(prop.x, prop.z, prop.rotY);
        p.rect(-0.28 * s, 0.45 * s, 0.28 * s, 0.9 * s, red, 0.35);
        break;
      case "wall_screen":
        p.frame(prop.x, prop.z, prop.rotY);
        p.rect(-1.1 * s, 0, 1.1 * s, 0.7 * s, red, 0.3);
        break;
      case "coffee_bar":
        p.frame(prop.x, prop.z, prop.rotY);
        p.rect(-1.1 * s, 0.3 * s, 1.1 * s, 0.55 * s, red, 0.25);
        break;
      case "floor_lamp":
        p.world();
        p.disc(prop.x, prop.z, 0.9 * s, warm, 0.45);
        break;
      case "exec_desk":
        p.frame(prop.x, prop.z, prop.rotY);
        p.rect(-0.9 * s, 0.35 * s, 0.9 * s, 0.55 * s, red, 0.3);
        break;
      default:
        break;
    }
  }
  p.world();
}

/** Gaussian-ish blur: the canvas filter where supported, a box blur otherwise (older Safari). */
function blurCanvas(source: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext("2d");
  if (!ctx) return source;
  const r = Math.max(1, radius);
  if (typeof ctx.filter === "string") {
    ctx.filter = `blur(${r.toFixed(2)}px)`;
    ctx.drawImage(source, 0, 0);
    ctx.filter = "none";
    return out;
  }
  ctx.drawImage(source, 0, 0);
  const image = ctx.getImageData(0, 0, out.width, out.height);
  const box = Math.max(1, Math.round(r * 0.9));
  // Three box passes approximate a Gaussian.
  for (let pass = 0; pass < 3; pass++) {
    boxBlur(image.data, out.width, out.height, box, true);
    boxBlur(image.data, out.width, out.height, box, false);
  }
  ctx.putImageData(image, 0, 0);
  return out;
}

/** Running-sum box blur over the RGB channels, one axis at a time. */
function boxBlur(data: Uint8ClampedArray, w: number, h: number, r: number, horizontal: boolean): void {
  const lines = horizontal ? h : w;
  const length = horizontal ? w : h;
  const stride = horizontal ? 4 : w * 4;
  const scratch = new Float32Array(length * 3);
  const norm = 1 / (r * 2 + 1);
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * w * 4 : line * 4;
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += data[base + clampIndex(i, length) * stride + c];
      for (let i = 0; i < length; i++) {
        scratch[i * 3 + c] = sum * norm;
        sum += data[base + clampIndex(i + r + 1, length) * stride + c];
        sum -= data[base + clampIndex(i - r, length) * stride + c];
      }
    }
    for (let i = 0; i < length; i++) {
      const o = base + i * stride;
      data[o] = scratch[i * 3];
      data[o + 1] = scratch[i * 3 + 1];
      data[o + 2] = scratch[i * 3 + 2];
    }
  }
}

function clampIndex(i: number, length: number): number {
  return i < 0 ? 0 : i >= length ? length - 1 : i;
}
