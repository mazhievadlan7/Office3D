import { MONO, SANS, type Ctx2D, type Painter } from "./screenPaint";

/**
 * The broadcast graphics kit for the HQ's big displays (the lounge TVs, AM7's
 * office screens, the map wall's side panels): our black / red / white
 * palette, display type and the pieces a real channel or control room is
 * built from — glass cards, glowing charts, live bugs, a vignette. The desk
 * monitors keep their own terminal look (screenPaint.ts INK).
 */

export const TV = {
  red: "#e3141c",
  redHot: "#ff2a2a",
  redSoft: "#ff5a52",
  redDeep: "#8a0b10",
  redBorder: "rgba(255, 60, 52, 0.28)",
  white: "#ffffff",
  white80: "rgba(255, 255, 255, 0.82)",
  white65: "rgba(255, 255, 255, 0.65)",
  white45: "rgba(255, 255, 255, 0.45)",
  white25: "rgba(255, 255, 255, 0.25)",
  white06: "rgba(255, 255, 255, 0.06)",
} as const;

/** Condensed display type for headlines and big numbers (Bahnschrift ships with Windows). */
export const DISPLAY = `"Bahnschrift", "DIN Alternate", "Roboto Condensed", "Arial Narrow", "Segoe UI", sans-serif`;
export { MONO, SANS };

// --- cached gradients ---------------------------------------------------------------------
// Gradients are bound to absolute coordinates, so a painter that draws the
// same layout every frame asks for the same keys and gets them back.
const gradients = new WeakMap<Ctx2D, Map<string, CanvasGradient>>();

export function cachedGradient(c: Ctx2D, key: string, make: () => CanvasGradient): CanvasGradient {
  let map = gradients.get(c);
  if (!map) {
    map = new Map();
    gradients.set(c, map);
  }
  let g = map.get(key);
  if (!g) {
    g = make();
    // Painters with moving gradients would grow this without end.
    if (map.size > 512) map.clear();
    map.set(key, g);
  }
  return g;
}

export function linear(c: Ctx2D, x0: number, y0: number, x1: number, y1: number, stops: ReadonlyArray<readonly [number, string]>): CanvasGradient {
  return cachedGradient(c, `l${x0},${y0},${x1},${y1}|${stops.join(";")}`, () => {
    const g = c.createLinearGradient(x0, y0, x1, y1);
    for (const [at, color] of stops) g.addColorStop(at, color);
    return g;
  });
}

export function radial(c: Ctx2D, x: number, y: number, r0: number, r1: number, stops: ReadonlyArray<readonly [number, string]>): CanvasGradient {
  return cachedGradient(c, `r${x},${y},${r0},${r1}|${stops.join(";")}`, () => {
    const g = c.createRadialGradient(x, y, r0, x, y, r1);
    for (const [at, color] of stops) g.addColorStop(at, color);
    return g;
  });
}

// --- shapes ----------------------------------------------------------------------------------
/** Adds a rounded rectangle to the current path. */
export function roundRectPath(c: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (typeof c.roundRect === "function") {
    c.roundRect(x, y, w, h, rr);
    return;
  }
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

export function fillRound(c: Ctx2D, x: number, y: number, w: number, h: number, r: number, fill: string | CanvasGradient): void {
  c.beginPath();
  roundRectPath(c, x, y, w, h, r);
  c.fillStyle = fill;
  c.fill();
}

export function strokeRound(c: Ctx2D, x: number, y: number, w: number, h: number, r: number, stroke: string, width = 1): void {
  c.beginPath();
  roundRectPath(c, x + 0.5, y + 0.5, w - 1, h - 1, r);
  c.strokeStyle = stroke;
  c.lineWidth = width;
  c.stroke();
}

export type CardStyle = {
  /** A red bar down the left edge. */
  accent?: boolean;
  radius?: number;
  /** 0..1: how opaque the glass is. */
  opacity?: number;
};

/**
 * A smoked-glass card: a faint top-lit gradient, a hairline red edge and a
 * thin highlight along the top, like a pane catching the room's light.
 */
export function glassCard(p: Painter, x: number, y: number, w: number, h: number, style: CardStyle = {}): void {
  const c = p.ctx;
  const r = style.radius ?? 8;
  const a = style.opacity ?? 0.9;
  fillRound(
    c,
    x,
    y,
    w,
    h,
    r,
    linear(c, 0, y, 0, y + h, [
      [0, `rgba(30, 11, 13, ${a})`],
      [0.45, `rgba(16, 7, 8, ${a})`],
      [1, `rgba(9, 4, 5, ${a})`],
    ]),
  );
  strokeRound(c, x, y, w, h, r, TV.redBorder);
  c.fillStyle = "rgba(255, 255, 255, 0.07)";
  c.fillRect(x + r, y + 1, w - 2 * r, 1);
  if (style.accent) {
    c.fillStyle = TV.red;
    c.fillRect(x, y + r, 3, h - 2 * r);
  }
}

// --- type --------------------------------------------------------------------------------------
type Spaced = Ctx2D & { letterSpacing?: string };

/** Text with letter spacing (a no-op where canvas has none). */
export function spaced(p: Painter, str: string, x: number, y: number, color: string, spacing: number, align: CanvasTextAlign = "left"): number {
  const c = p.ctx as Spaced;
  const had = c.letterSpacing;
  if (had !== undefined) c.letterSpacing = `${spacing}px`;
  const width = p.text(str, x, y, color, align);
  if (had !== undefined) c.letterSpacing = had;
  return width + (had !== undefined ? spacing * str.length : 0);
}

/** A small caps label: mono, uppercase, tracked out. */
export function label(p: Painter, str: string, x: number, y: number, color: string = TV.white45, size = 11, align: CanvasTextAlign = "left"): number {
  p.setFont(size, 600, MONO);
  return spaced(p, str.toUpperCase(), x, y, color, size * 0.16, align);
}

/** Trims a string with an ellipsis until it fits maxWidth at the current font. */
export function fit(c: Ctx2D, str: string, maxWidth: number): string {
  if (c.measureText(str).width <= maxWidth) return str;
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c.measureText(`${str.slice(0, mid)}…`).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${str.slice(0, lo).trimEnd()}…`;
}

/** A filled up or down triangle, the way tickers mark a change. */
export function arrow(c: Ctx2D, up: boolean, x: number, y: number, size: number, color: string): void {
  c.fillStyle = color;
  c.beginPath();
  if (up) {
    c.moveTo(x, y - size);
    c.lineTo(x + size, y);
    c.lineTo(x - size, y);
  } else {
    c.moveTo(x - size, y - size);
    c.lineTo(x + size, y - size);
    c.lineTo(x, y);
  }
  c.closePath();
  c.fill();
}

export function dot(c: Ctx2D, x: number, y: number, r: number, color: string): void {
  c.fillStyle = color;
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();
}

/** A pulsing live dot with a soft halo, 0.8 s period. */
export function liveDot(c: Ctx2D, x: number, y: number, r: number, t: number): void {
  const k = 0.5 + 0.5 * Math.sin(t * Math.PI * 2.5);
  c.globalAlpha = 0.18 + 0.22 * k;
  dot(c, x, y, r * (1.8 + 0.6 * k), TV.redHot);
  c.globalAlpha = 1;
  dot(c, x, y, r, k > 0.25 ? TV.redHot : TV.red);
}

// --- charts ----------------------------------------------------------------------------------
function tracePath(c: Ctx2D, values: ArrayLike<number>, x: number, y: number, w: number, h: number, count: number): void {
  const n = values.length;
  const step = w / Math.max(1, n - 1);
  const py = (i: number) => y + h - h * clamp01(values[i]);
  c.moveTo(x, py(0));
  // Midpoint quadratic smoothing: soft corners, no overshoot.
  for (let i = 1; i < count; i++) {
    const x0 = x + (i - 1) * step;
    const x1 = x + i * step;
    const y0 = py(i - 1);
    const y1 = py(i);
    if (i === count - 1) c.quadraticCurveTo(x0, y0, x1, y1);
    else c.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
}

export type AreaStyle = {
  color?: string;
  /** Draw only the first share (0..1) of the line: a reveal. */
  reveal?: number;
  grid?: number;
  /** A glowing dot at the newest value. */
  head?: boolean;
  t?: number;
  lineWidth?: number;
};

/** A smooth area chart of values (0..1): gradient fill, a glowing line and a live head. */
export function areaChart(p: Painter, values: ArrayLike<number>, x: number, y: number, w: number, h: number, style: AreaStyle = {}): void {
  const c = p.ctx;
  const n = values.length;
  const color = style.color ?? TV.redHot;
  const grid = style.grid ?? 4;
  c.strokeStyle = TV.white06;
  c.lineWidth = 1;
  c.beginPath();
  for (let k = 0; k <= grid; k++) {
    const gy = Math.round(y + (h * k) / grid) + 0.5;
    c.moveTo(x, gy);
    c.lineTo(x + w, gy);
  }
  c.stroke();
  if (n < 2) return;
  const reveal = clamp01(style.reveal ?? 1);
  const count = Math.max(2, Math.ceil(n * reveal));
  const step = w / (n - 1);
  const lastX = x + (count - 1) * step;
  c.save();
  c.beginPath();
  tracePath(c, values, x, y, w, h, count);
  c.lineTo(lastX, y + h);
  c.lineTo(x, y + h);
  c.closePath();
  c.fillStyle = linear(c, 0, y, 0, y + h, [
    [0, "rgba(255, 42, 42, 0.42)"],
    [0.55, "rgba(200, 16, 22, 0.14)"],
    [1, "rgba(120, 8, 12, 0)"],
  ]);
  c.fill();
  c.beginPath();
  tracePath(c, values, x, y, w, h, count);
  c.lineJoin = "round";
  c.lineCap = "round";
  c.strokeStyle = "rgba(255, 60, 50, 0.22)";
  c.lineWidth = (style.lineWidth ?? 2.2) * 3.2;
  c.stroke();
  c.strokeStyle = color;
  c.lineWidth = style.lineWidth ?? 2.2;
  c.stroke();
  c.restore();
  if (style.head !== false) {
    const hy = y + h - h * clamp01(values[count - 1]);
    const pulse = 0.5 + 0.5 * Math.sin((style.t ?? 0) * 4);
    c.globalAlpha = 0.25 * (1 - pulse);
    dot(c, lastX, hy, 5 + 9 * pulse, TV.redHot);
    c.globalAlpha = 1;
    dot(c, lastX, hy, 4, TV.white);
  }
}

/** A thin sparkline without grid or fill. */
export function sparkline(p: Painter, values: ArrayLike<number>, x: number, y: number, w: number, h: number, color: string = TV.redHot, width = 1.6): void {
  const c = p.ctx;
  if (values.length < 2) return;
  c.beginPath();
  tracePath(c, values, x, y, w, h, values.length);
  c.lineJoin = "round";
  c.strokeStyle = color;
  c.lineWidth = width;
  c.stroke();
}

/** A ring gauge with rounded ends. */
export function gauge(c: Ctx2D, cx: number, cy: number, r: number, v: number, width: number, color: string = TV.redHot): void {
  c.lineCap = "round";
  c.lineWidth = width;
  c.strokeStyle = "rgba(255, 255, 255, 0.07)";
  c.beginPath();
  c.arc(cx, cy, r, 0, Math.PI * 2);
  c.stroke();
  const share = clamp01(v);
  if (share > 0.002) {
    c.strokeStyle = "rgba(255, 42, 42, 0.25)";
    c.lineWidth = width * 2.2;
    c.beginPath();
    c.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * share);
    c.stroke();
    c.strokeStyle = color;
    c.lineWidth = width;
    c.stroke();
  }
  c.lineCap = "butt";
}

/** A horizontal bar with a dim track and a bright tip. */
export function bar(c: Ctx2D, x: number, y: number, w: number, h: number, v: number, color: string = TV.red): void {
  fillRound(c, x, y, w, h, h / 2, "rgba(255, 255, 255, 0.07)");
  const fw = Math.max(h, w * clamp01(v));
  fillRound(c, x, y, fw, h, h / 2, linear(c, x, 0, x + w, 0, [[0, TV.redDeep], [1, color]]));
}

// --- atmosphere ------------------------------------------------------------------------------
/** Darkens the corners like a lens (drawn last, over everything). */
export function vignette(p: Painter, strength = 0.55): void {
  const { w, h } = p;
  const c = p.ctx;
  c.fillStyle = radial(c, w / 2, h / 2, Math.min(w, h) * 0.35, Math.hypot(w, h) * 0.62, [
    [0, "rgba(0, 0, 0, 0)"],
    [1, `rgba(0, 0, 0, ${strength})`],
  ]);
  c.fillRect(0, 0, w, h);
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smoothstep(a: number, b: number, v: number): number {
  const k = clamp01((v - a) / (b - a));
  return k * k * (3 - 2 * k);
}

/** Ease-out cubic, 0..1. */
export function easeOut(k: number): number {
  const q = 1 - clamp01(k);
  return 1 - q * q * q;
}

/** A canvas of its own: OffscreenCanvas in a worker, a DOM canvas on the fallback path. */
export function makeCanvas(w: number, h: number): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: Ctx2D } | null {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    return ctx ? { canvas, ctx } : null;
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    return ctx ? { canvas, ctx } : null;
  }
  return null;
}

/** A fixed starfield (drawn once per size, then blitted). */
const starfields = new Map<string, OffscreenCanvas | HTMLCanvasElement | null>();
export function starfield(w: number, h: number, seed = 1): OffscreenCanvas | HTMLCanvasElement | null {
  const key = `${w}x${h}:${seed}`;
  if (starfields.has(key)) return starfields.get(key) ?? null;
  const made = makeCanvas(w, h);
  if (made) {
    const { ctx } = made;
    let s = seed * 2654435761;
    const rnd = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let q = s;
      q = Math.imul(q ^ (q >>> 15), q | 1);
      q ^= q + Math.imul(q ^ (q >>> 7), q | 61);
      return ((q ^ (q >>> 14)) >>> 0) / 4294967296;
    };
    const count = Math.round((w * h) / 900);
    for (let i = 0; i < count; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      const b = rnd();
      const r = b > 0.985 ? 1.3 : b > 0.9 ? 0.9 : 0.6;
      ctx.globalAlpha = 0.15 + 0.75 * b * b;
      ctx.fillStyle = b > 0.93 ? "#ffe9e4" : "#ffb8ae";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  starfields.set(key, made?.canvas ?? null);
  return made?.canvas ?? null;
}
