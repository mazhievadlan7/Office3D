import { GlobeView, greatCircle, type GlobePoint } from "./screenGlobe";
import {
  DISPLAY,
  MONO,
  SANS,
  TV,
  areaChart,
  arrow,
  bar,
  clamp01,
  dot,
  easeOut,
  fillRound,
  fit,
  glassCard,
  label,
  linear,
  liveDot,
  radial,
  smoothstep,
  spaced,
  sparkline,
  starfield,
  strokeRound,
  vignette,
} from "./screenKit";
import type { HqScreenFeed, HqTeamStat, Painter } from "./screenPaint";
import {
  EXCHANGES,
  PHASE_WORD,
  TEAM_NAMES,
  candles,
  city,
  cityTime,
  dayPhase,
  decimal,
  durationText,
  exchangeState,
  hhmm,
  indexSeries,
  longDate,
  marketQuotes,
  newsStories,
  newsTicker,
  shareAgo,
  signedPoints,
  sunElevation,
  workingShare,
  type NewsStory,
  type WorldCity,
} from "./screenStories";

/**
 * The lounge TVs, built like real channels: HACKING NEWS (a live news channel
 * whose rundown is written from the floor's real activity, over a real-time
 * Earth), AM7 BUSINESS (a markets channel quoting the HQ index and the
 * departments, with the world's exchanges open or closed right now) and AM7
 * RADIO. Plus the shared on-air pieces (logo, live bug, clock, the Earth with
 * its routes) the office screens and the map panels reuse.
 *
 * Painters keep a little state between frames (the ticker's crawl, the story
 * on air) so motion is continuous; everything else is a function of the time,
 * the feed and the clock.
 */

// --- on-air pieces ------------------------------------------------------------------------------
/**
 * The channel logo: a red brand block (AM7 by default) and the channel's name
 * on glass. Returns the right edge.
 */
export function channelLogo(p: Painter, x: number, y: number, name: string, scale = 1, brand = "AM7"): number {
  const c = p.ctx;
  const h = 34 * scale;
  p.setFont(22 * scale, 700, DISPLAY);
  // The block grows with a longer brand (HACKING) and keeps AM7's size.
  const bw = Math.max(62 * scale, c.measureText(brand).width + 24 * scale);
  fillRound(c, x, y, bw, h, 4 * scale, linear(c, 0, y, 0, y + h, [[0, "#ff2d2d"], [1, "#b00b12"]]));
  c.fillStyle = "rgba(255, 255, 255, 0.22)";
  c.fillRect(x + 3 * scale, y + 1, bw - 6 * scale, 1);
  p.text(brand, x + bw / 2, y + h * 0.74, TV.white, "center");
  p.setFont(17 * scale, 600, DISPLAY);
  const nw = c.measureText(name).width + name.length * 2 * scale + 26 * scale;
  fillRound(c, x + bw - 2, y, nw, h, 4 * scale, "rgba(8, 4, 5, 0.9)");
  strokeRound(c, x + bw - 2, y, nw, h, 4 * scale, "rgba(255, 255, 255, 0.1)");
  spaced(p, name, x + bw + 11 * scale, y + h * 0.71, TV.white, 2 * scale);
  return x + bw - 2 + nw;
}

/** A live bug: a pulsing dot and «В ЭФИРЕ» on glass. */
export function liveBug(p: Painter, x: number, y: number, t: number, text = "В ЭФИРЕ", scale = 1): number {
  const c = p.ctx;
  p.setFont(12 * scale, 700, SANS);
  const w = c.measureText(text).width + text.length * 1.4 * scale + 38 * scale;
  const h = 26 * scale;
  fillRound(c, x, y, w, h, h / 2, "rgba(8, 4, 5, 0.88)");
  strokeRound(c, x, y, w, h, h / 2, "rgba(255, 50, 44, 0.55)");
  liveDot(c, x + 15 * scale, y + h / 2, 4.2 * scale, t);
  spaced(p, text, x + 27 * scale, y + h * 0.69, TV.white, 1.4 * scale);
  return x + w;
}

/** A broadcast clock, right-aligned: big hh:mm, small seconds, the date under it. */
export function clockBlock(p: Painter, right: number, y: number, clock: number, scale = 1): void {
  const d = new Date(clock);
  const ss = `:${String(d.getSeconds()).padStart(2, "0")}`;
  p.setFont(17 * scale, 500, DISPLAY);
  const sw = p.ctx.measureText(ss).width;
  p.text(ss, right, y + 26 * scale, TV.white45, "right");
  p.setFont(30 * scale, 600, DISPLAY);
  p.text(hhmm(clock), right - sw - 2, y + 26 * scale, TV.white, "right");
  label(p, longDate(clock), right, y + 44 * scale, TV.white45, 10.5 * scale, "right");
}

/** A status chip: working reads white with a red dot, idle grey, error red on dark red. */
export function statusChip(p: Painter, x: number, y: number, status: number, scale = 1, align: CanvasTextAlign = "left"): number {
  const c = p.ctx;
  const text = status === 0 ? "В РАБОТЕ" : status === 2 ? "ОШИБКА" : "ОЖИДАЕТ";
  p.setFont(10.5 * scale, 700, MONO);
  const w = c.measureText(text).width + text.length * 1.2 * scale + (status === 0 ? 26 : 16) * scale;
  const h = 19 * scale;
  const x0 = align === "right" ? x - w : x;
  if (status === 2) {
    fillRound(c, x0, y, w, h, 4 * scale, "rgba(69, 10, 10, 0.75)");
    strokeRound(c, x0, y, w, h, 4 * scale, "rgba(239, 68, 68, 0.55)");
  } else {
    fillRound(c, x0, y, w, h, 4 * scale, status === 0 ? "rgba(255, 255, 255, 0.08)" : "rgba(255, 255, 255, 0.04)");
    strokeRound(c, x0, y, w, h, 4 * scale, status === 0 ? "rgba(255, 60, 52, 0.4)" : "rgba(255, 255, 255, 0.1)");
  }
  let tx = x0 + 8 * scale;
  if (status === 0) {
    dot(c, tx + 3 * scale, y + h / 2, 3 * scale, TV.redHot);
    tx += 11 * scale;
  }
  spaced(p, text, tx, y + h * 0.7, status === 2 ? "#f87171" : status === 0 ? TV.white : TV.white45, 1.2 * scale);
  return w;
}

// --- the Earth with its routes ------------------------------------------------------------------
const ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["Москва", "Нью-Йорк"],
  ["Москва", "Токио"],
  ["Лондон", "Дубай"],
  ["Сингапур", "Сидней"],
  ["Сан-Франциско", "Лондон"],
  ["Дубай", "Сингапур"],
  ["Нью-Йорк", "Сан-Паулу"],
  ["Франкфурт", "Гонконг"],
];
const routeCache = new Map<number, Array<[number, number]>>();
function routePoints(i: number): Array<[number, number]> {
  let pts = routeCache.get(i);
  if (!pts) {
    const [a, b] = ROUTES[i % ROUTES.length];
    const A = city(a);
    const B = city(b);
    pts = greatCircle(A.lon, A.lat, B.lon, B.lat, 56);
    routeCache.set(i, pts);
  }
  return pts;
}

const MARKERS = ["Москва", "Лондон", "Нью-Йорк", "Токио", "Дубай", "Сингапур", "Сидней", "Сан-Франциско", "Сан-Паулу", "Франкфурт", "Гонконг"].map(city);

export type EarthOptions = {
  /** How many routes to draw. */
  routes?: number;
  /** Cities to call out with a label (their local time) when they face the viewer. */
  callouts?: readonly WorldCity[];
  /** Keep callouts above this y. */
  maxY?: number;
  /** A glow behind the globe. */
  halo?: boolean;
  scale?: number;
};

const scratch: GlobePoint = { x: 0, y: 0, z: 0 };

/** The globe at (cx, cy) turned to viewLon, lit by the real Sun, with routes, cities and callouts. */
export function drawEarth(p: Painter, globe: GlobeView, cx: number, cy: number, viewLon: number, t: number, feed: HqScreenFeed, options: EarthOptions = {}): void {
  const c = p.ctx;
  const R = globe.radius;
  const s = options.scale ?? 1;
  if (options.halo !== false) {
    c.fillStyle = radial(c, cx, cy, R * 0.9, R * 1.3, [
      [0, "rgba(255, 36, 30, 0.34)"],
      [0.35, "rgba(200, 16, 20, 0.12)"],
      [1, "rgba(120, 8, 10, 0)"],
    ]);
    c.fillRect(cx - R * 1.35, cy - R * 1.35, R * 2.7, R * 2.7);
  }
  const image = globe.render(viewLon, feed.clock || Date.now());
  if (image) c.drawImage(image, cx - globe.size / 2, cy - globe.size / 2);

  // Routes: great circles lifted off the surface, hidden behind the planet.
  const routes = options.routes ?? 4;
  for (let i = 0; i < routes; i++) {
    const pts = routePoints(i);
    const n = pts.length;
    c.beginPath();
    let pen = false;
    const xs: number[] = [];
    const ys: number[] = [];
    const vis: boolean[] = [];
    for (let k = 0; k < n; k++) {
      const f = k / (n - 1);
      const rho = 1 + 0.16 * Math.sin(Math.PI * f);
      globe.project(pts[k][0], pts[k][1], viewLon, scratch);
      const x = scratch.x * rho;
      const y = scratch.y * rho;
      const visible = scratch.z > 0 || Math.hypot(x, y) > R;
      xs.push(cx + x);
      ys.push(cy + y);
      vis.push(visible);
      if (visible) {
        if (pen) c.lineTo(cx + x, cy + y);
        else c.moveTo(cx + x, cy + y);
        pen = true;
      } else pen = false;
    }
    c.lineCap = "round";
    c.strokeStyle = "rgba(255, 50, 40, 0.18)";
    c.lineWidth = 4 * s;
    c.stroke();
    c.strokeStyle = "rgba(255, 90, 80, 0.75)";
    c.lineWidth = 1.2 * s;
    c.stroke();
    // A packet travelling the route.
    const head = ((t * 0.18 + i * 0.37) % 1) * (n - 1);
    const k0 = Math.floor(head);
    if (vis[k0]) {
      for (let q = 0; q < 6; q++) {
        const k = k0 - q;
        if (k < 0 || !vis[k]) break;
        c.globalAlpha = (1 - q / 6) * 0.9;
        dot(c, xs[k], ys[k], (2.6 - q * 0.3) * s, q === 0 ? TV.white : TV.redHot);
      }
      c.globalAlpha = 1;
    }
  }

  // City lights: a dot and a slow ring on the visible side.
  for (let i = 0; i < MARKERS.length; i++) {
    const m = MARKERS[i];
    globe.project(m.lon, m.lat, viewLon, scratch);
    if (scratch.z < 0.08) continue;
    const a = smoothstep(0.08, 0.35, scratch.z);
    const x = cx + scratch.x;
    const y = cy + scratch.y;
    const ring = (t * 0.55 + i * 0.29) % 1;
    c.globalAlpha = a * (1 - ring) * 0.8;
    c.strokeStyle = TV.redHot;
    c.lineWidth = 1.2 * s;
    c.beginPath();
    c.arc(x, y, (3 + 11 * ring) * s, 0, Math.PI * 2);
    c.stroke();
    c.globalAlpha = a;
    dot(c, x, y, 2.4 * s, TV.white);
    c.globalAlpha = 1;
  }

  // Callouts: the local time in the cities facing us.
  const callouts = options.callouts ?? [];
  const placed: Array<readonly [number, number, number, number]> = [];
  const maxY = options.maxY ?? p.h - 16;
  for (const target of callouts) {
    if (placed.length >= 2) break;
    globe.project(target.lon, target.lat, viewLon, scratch);
    if (scratch.z < 0.42) continue;
    const a = smoothstep(0.42, 0.6, scratch.z);
    const x = cx + scratch.x;
    const y = cy + scratch.y;
    const local = cityTime(target, feed.clock);
    const phase = dayPhase(sunElevation(target.lon, target.lat, feed.clock));
    p.setFont(13 * s, 700, SANS);
    const name = target.name.toUpperCase();
    const nw = p.ctx.measureText(name).width;
    p.setFont(13 * s, 500, DISPLAY);
    const tw = p.ctx.measureText(local.text).width;
    const w = nw + tw + 30 * s;
    const h = 38 * s;
    // The first free spot among above/below, right/left of the city.
    let spot: readonly [number, number, boolean] | null = null;
    for (const [dx, dy] of [[1, -1], [1, 1], [-1, -1], [-1, 1]] as const) {
      const lx = dx > 0 ? x + 30 * s : x - 30 * s - w;
      const ly = dy < 0 ? y - 44 * s : y + 14 * s;
      if (lx < 16 || lx + w > p.w - 16 || ly < 70 || ly + h > maxY) continue;
      if (placed.some(([px, py, pw, ph]) => lx < px + pw + 6 && lx + w + 6 > px && ly < py + ph + 6 && ly + h + 6 > py)) continue;
      spot = [lx, ly, dx > 0];
      break;
    }
    if (!spot) continue;
    const [lx, ly, right] = spot;
    placed.push([lx, ly, w, h]);
    c.globalAlpha = a;
    c.strokeStyle = "rgba(255, 255, 255, 0.55)";
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(right ? lx : lx + w, ly + h / 2);
    c.stroke();
    fillRound(c, lx, ly, w, h, 5 * s, "rgba(8, 4, 5, 0.86)");
    strokeRound(c, lx, ly, w, h, 5 * s, "rgba(255, 60, 52, 0.45)");
    c.fillStyle = TV.red;
    c.fillRect(right ? lx : lx + w - 3 * s, ly + 5 * s, 3 * s, h - 10 * s);
    p.setFont(13 * s, 700, SANS);
    p.text(name, lx + 12 * s, ly + 17 * s, TV.white);
    p.setFont(13 * s, 500, DISPLAY);
    p.text(local.text, lx + 18 * s + nw, ly + 17 * s, TV.white80);
    label(p, PHASE_WORD[phase], lx + 12 * s, ly + 31 * s, TV.white45, 9.5 * s);
    c.globalAlpha = 1;
  }
}

/** A small sun or moon glyph for day, twilight and night. */
export function phaseIcon(p: Painter, x: number, y: number, r: number, phase: "day" | "twilight" | "night"): void {
  const c = p.ctx;
  if (phase === "day") {
    dot(c, x, y, r * 0.55, TV.white);
    c.strokeStyle = TV.white80;
    c.lineWidth = 1.2;
    c.beginPath();
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      c.moveTo(x + Math.cos(a) * r * 0.78, y + Math.sin(a) * r * 0.78);
      c.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    c.stroke();
  } else if (phase === "twilight") {
    c.fillStyle = TV.white65;
    c.beginPath();
    c.arc(x, y + r * 0.2, r * 0.6, Math.PI, 0);
    c.fill();
    c.fillRect(x - r, y + r * 0.2, r * 2, 1.4);
  } else {
    c.fillStyle = TV.white65;
    c.beginPath();
    c.arc(x, y, r * 0.62, 0, Math.PI * 2);
    c.arc(x + r * 0.32, y - r * 0.18, r * 0.52, 0, Math.PI * 2, true);
    c.fill("evenodd");
  }
}

// --- a continuous ticker crawl --------------------------------------------------------------------
type Span = { text: string; color: string; font: string };

/**
 * A news crawl that never jumps: items scroll on and off, and new ones are
 * written from the latest feed as the tail comes into view.
 */
class Crawl {
  private items: Array<{ spans: Span[]; w: number }> = [];
  private head = 0;
  private last = Number.NaN;

  constructor(
    private readonly speed: number,
    private readonly gap: number,
  ) {}

  draw(p: Painter, x: number, y: number, w: number, t: number, supply: () => Span[][]): void {
    const c = p.ctx;
    const dt = t - this.last;
    if (!(dt >= 0 && dt < 5)) {
      this.items = [];
      this.head = w * 0.6;
    } else this.head -= dt * this.speed;
    this.last = t;
    while (this.items.length > 0 && this.head + this.items[0].w < 0) {
      this.head += this.items[0].w;
      this.items.shift();
    }
    let end = this.head;
    for (const item of this.items) end += item.w;
    for (let guard = 0; end < w + 60 && guard < 4; guard++) {
      const batch = supply();
      if (batch.length === 0) break;
      for (const spans of batch) {
        let iw = 0;
        for (const s of spans) {
          c.font = s.font;
          iw += c.measureText(s.text).width;
        }
        iw += this.gap;
        this.items.push({ spans, w: iw });
        end += iw;
      }
    }
    let cx = x + this.head;
    for (const item of this.items) {
      if (cx > x + w) break;
      if (cx + item.w >= x) {
        let sx = cx;
        for (const s of item.spans) {
          c.font = s.font;
          c.fillStyle = s.color;
          c.textAlign = "left";
          c.fillText(s.text, sx, y);
          sx += c.measureText(s.text).width;
        }
        c.fillStyle = TV.red;
        c.fillRect(cx + item.w - this.gap / 2 - 3, y - 9, 6, 6);
      }
      cx += item.w;
    }
    p.resetFont();
  }
}

// --- HACKING NEWS -------------------------------------------------------------------------------
/** The news channel's own brand, on its logo and its stinger. */
const NEWS_BRAND = "HACKING";
const NEWS_CYCLE = 32;
const NEWS_DATA_AT = 20;
const STORY_HOLD = 8;

let newsGlobe: GlobeView | null = null;
const newsCrawl = new Crawl(72, 34);
const rundown = { slot: Number.NaN, cursor: -1, story: null as NewsStory | null, breaking: "" };

/** The story on air; the rundown is written from the feed only when the next story is due. */
function currentStory(t: number, rundownOf: () => NewsStory[]): { story: NewsStory; age: number } {
  const slot = Math.floor(t / STORY_HOLD);
  if (slot !== rundown.slot || !rundown.story) {
    const stories = rundownOf();
    rundown.slot = slot;
    // A fresh error jumps the queue: it goes on air at the next story change
    // rather than when the rotation comes round to it.
    const lead = stories[0]?.key;
    if (lead && lead !== rundown.breaking) {
      rundown.breaking = lead;
      rundown.cursor = 0;
    } else rundown.cursor = (rundown.cursor + 1) % Math.max(1, stories.length);
    rundown.story = stories[rundown.cursor % stories.length] ?? stories[0];
  }
  return { story: rundown.story, age: t - slot * STORY_HOLD };
}

export function paintNews(p: Painter, t: number, feed: HqScreenFeed): void {
  const { w, h } = p;
  const c = p.ctx;
  const phase = t % NEWS_CYCLE;
  if (phase < NEWS_DATA_AT) newsGlobeSegment(p, t, feed);
  else newsDataSegment(p, t, feed, phase - NEWS_DATA_AT);
  // The stinger covers the cut between segments.
  const cut = phase >= NEWS_DATA_AT - 0.6 && phase < NEWS_DATA_AT + 0.6 ? phase - NEWS_DATA_AT : phase >= NEWS_CYCLE - 0.6 ? phase - NEWS_CYCLE : phase < 0.6 ? phase : Number.NaN;
  if (Number.isFinite(cut)) stinger(p, cut, "NEWS", NEWS_BRAND);
  vignette(p, 0.5);

  // Package: logo, live bug, clock.
  const right = channelLogo(p, 36, 22, "NEWS", 1, NEWS_BRAND);
  liveBug(p, right + 10, 26, t);
  label(p, "Прямой эфир из штаба", 36, 76, TV.white45, 10);
  clockBlock(p, w - 36, 20, feed.clock);

  // Lower third.
  const { story, age } = currentStory(t, () => newsStories(feed));
  lowerThird(p, story, age, t);

  // Ticker.
  const ty = h - 52;
  c.fillStyle = linear(c, 0, ty, 0, ty + 32, [[0, "rgba(10, 5, 6, 0.95)"], [1, "rgba(4, 2, 3, 0.95)"]]);
  c.fillRect(0, ty, w, 32);
  c.fillStyle = TV.red;
  c.fillRect(0, ty - 2, w, 2);
  c.save();
  c.beginPath();
  c.rect(128, ty, w - 128, 32);
  c.clip();
  const body = `600 16px ${SANS}`;
  const strong = `700 16px ${SANS}`;
  newsCrawl.draw(p, 128, ty + 22, w - 128, t, () =>
    newsTicker(feed).map((item, i) => [{ text: item, color: i < 4 ? TV.white : TV.white80, font: i < 4 ? strong : body }]),
  );
  c.restore();
  p.resetFont();
  c.fillStyle = linear(c, 0, ty, 0, ty + 32, [[0, "#f0222a"], [1, "#a50a10"]]);
  c.fillRect(0, ty, 128, 32);
  p.setFont(16, 700, DISPLAY);
  spaced(p, "ЛЕНТА", 22, ty + 22, TV.white, 2);
  c.fillStyle = "rgba(0, 0, 0, 0.35)";
  c.fillRect(128, ty, 8, 32);
}

function lowerThird(p: Painter, story: NewsStory, age: number, t: number): void {
  const c = p.ctx;
  const x = 36;
  const maxW = p.w - 72;
  const k = easeOut(age / 0.5);
  const out = clamp01((age - (STORY_HOLD - 0.35)) / 0.35);
  // Tag.
  p.setFont(13, 700, DISPLAY);
  const tagW = c.measureText(story.tag).width + story.tag.length * 1.6 + 24;
  const flash = story.hot && Math.floor(t * 2.2) % 2 === 0;
  const ty = 398;
  c.globalAlpha = k;
  fillRound(c, x, ty, tagW, 26, 3, flash ? TV.redHot : TV.red);
  spaced(p, story.tag, x + 12, ty + 18, TV.white, 1.6);
  c.globalAlpha = 1;
  // Headline bar wipes in from the left.
  p.setFont(28, 700, DISPLAY);
  const title = fit(c, story.title, maxW - 44);
  const titleW = Math.min(maxW, c.measureText(title).width + 44);
  const barW = Math.max(tagW, titleW) * k;
  const hy = 426;
  c.fillStyle = linear(c, 0, hy, 0, hy + 50, [[0, "rgba(22, 9, 11, 0.94)"], [1, "rgba(8, 4, 5, 0.94)"]]);
  c.fillRect(x, hy, barW, 50);
  c.fillStyle = "rgba(255, 255, 255, 0.08)";
  c.fillRect(x, hy, barW, 1);
  c.fillStyle = TV.red;
  c.fillRect(x, hy, Math.min(4, barW), 50);
  c.save();
  c.beginPath();
  c.rect(x, hy, barW, 76);
  c.clip();
  const lift = (1 - k) * 18 + out * -10;
  c.globalAlpha = (1 - out) * clamp01((age - 0.12) / 0.3);
  p.text(title, x + 22, hy + 35 + lift, TV.white);
  // Sub line.
  c.globalAlpha = 1;
  c.fillStyle = "rgba(4, 2, 3, 0.9)";
  c.fillRect(x, hy + 50, barW, 26);
  c.globalAlpha = (1 - out) * clamp01((age - 0.25) / 0.3);
  p.setFont(14, 500, SANS);
  p.text(fit(c, story.sub, maxW - 44), x + 22, hy + 68, TV.white65);
  c.restore();
  p.resetFont();
  c.globalAlpha = 1;
}

function stinger(p: Painter, s: number, name: string, brand = "AM7"): void {
  const { w, h } = p;
  const c = p.ctx;
  const skew = 140;
  const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k));
  // In: the slab's leading edge sweeps right to left; out: its trailing edge follows.
  const k = s < 0 ? ease((s + 0.6) / 0.6) : ease(s / 0.6);
  const lead = s < 0 ? w + skew - k * (w + 2 * skew) : -skew - 20;
  const tail = s < 0 ? w + skew + 40 : w + skew - k * (w + 2 * skew);
  const slab = (l: number, r: number, fill: string | CanvasGradient) => {
    c.fillStyle = fill;
    c.beginPath();
    c.moveTo(l + skew, 0);
    c.lineTo(r + skew, 0);
    c.lineTo(r, h);
    c.lineTo(l, h);
    c.closePath();
    c.fill();
  };
  slab(lead - 60, tail + 40, "rgba(90, 6, 10, 0.95)");
  slab(lead, tail, linear(c, 0, 0, w, h, [[0, "#b00b12"], [0.5, "#e3141c"], [1, "#8a0b10"]]));
  c.fillStyle = "rgba(255, 255, 255, 0.85)";
  c.beginPath();
  c.moveTo(lead + skew, 0);
  c.lineTo(lead + skew + 3, 0);
  c.lineTo(lead + 3, h);
  c.lineTo(lead, h);
  c.closePath();
  c.fill();
  const a = 1 - clamp01(Math.abs(s) / 0.3);
  if (a > 0) {
    c.globalAlpha = a;
    p.setFont(92, 700, DISPLAY);
    const aw = c.measureText(brand).width;
    p.setFont(54, 600, DISPLAY);
    const nw = c.measureText(name).width + name.length * 6;
    const x0 = w / 2 - (aw + 18 + nw) / 2;
    p.setFont(92, 700, DISPLAY);
    p.text(brand, x0, h / 2 + 32, TV.white);
    p.setFont(54, 600, DISPLAY);
    spaced(p, name, x0 + aw + 18, h / 2 + 30, "rgba(255, 255, 255, 0.85)", 6);
    c.globalAlpha = 1;
  }
}

function newsGlobeSegment(p: Painter, t: number, feed: HqScreenFeed): void {
  const { w, h } = p;
  const c = p.ctx;
  const cx = 648;
  const cy = 246;
  c.fillStyle = "#020102";
  c.fillRect(0, 0, w, h);
  c.fillStyle = radial(c, cx, cy, 150, 560, [[0, "rgba(110, 10, 14, 0.42)"], [1, "rgba(0, 0, 0, 0)"]]);
  c.fillRect(0, 0, w, h);
  const stars = starfield(w, h, 3);
  if (stars) {
    c.globalAlpha = 0.85;
    c.drawImage(stars, 0, 0);
    c.globalAlpha = 1;
  }
  newsGlobe ??= new GlobeView(200, 24);
  // The camera drifts west to east over the planet: Europe first.
  const viewLon = 42 - t * 4.2;
  drawEarth(p, newsGlobe, cx, cy, viewLon, t, feed, { routes: 5, callouts: [city("Москва"), city("Нью-Йорк"), city("Токио"), city("Лондон"), city("Дубай"), city("Сингапур"), city("Сидней"), city("Сан-Франциско")], maxY: 386 });

  // World time.
  const px = 36;
  const py = 98;
  glassCard(p, px, py, 214, 190, { opacity: 0.82 });
  label(p, "Мировое время", px + 14, py + 22, TV.white45, 10.5);
  ["Москва", "Лондон", "Нью-Йорк", "Токио"].forEach((name, i) => {
    const target = city(name);
    const y = py + 52 + i * 36;
    const local = cityTime(target, feed.clock);
    const phase = dayPhase(sunElevation(target.lon, target.lat, feed.clock));
    phaseIcon(p, px + 22, y - 6, 7, phase);
    p.setFont(15, 600, SANS);
    p.text(name, px + 38, y, TV.white);
    p.setFont(20, 600, DISPLAY);
    p.text(local.text, px + 200, y, TV.white, "right");
    if (i < 3) {
      c.fillStyle = TV.white06;
      c.fillRect(px + 14, y + 12, 186, 1);
    }
  });

  // Load widget.
  const wy = 300;
  glassCard(p, px, wy, 214, 84, { opacity: 0.82 });
  label(p, "Загрузка штаба", px + 14, wy + 22, TV.white45, 10.5);
  const share = workingShare(feed);
  p.setFont(34, 700, DISPLAY);
  p.text(`${Math.round(share * 100)}%`, px + 14, wy + 64, TV.white);
  const delta = share - shareAgo(feed, 60);
  const up = delta >= 0;
  arrow(c, up, px + 94, wy + 58, 5, up ? TV.white : TV.redSoft);
  p.setFont(12, 600, SANS);
  p.text(`${signedPoints(delta)} п.п.`, px + 104, wy + 58, up ? TV.white80 : TV.redSoft);
  sparkline(p, stretch(feed.history.slice(-90)), px + 104, wy + 30, 96, 18, TV.redHot, 1.4);
}

function newsDataSegment(p: Painter, t: number, feed: HqScreenFeed, s: number): void {
  const { w, h } = p;
  const c = p.ctx;
  c.fillStyle = "#030203";
  c.fillRect(0, 0, w, h);
  // A perspective floor grid flowing toward the viewer.
  const horizon = 250;
  const vx = w / 2;
  c.save();
  c.beginPath();
  c.rect(0, horizon, w, h - horizon);
  c.clip();
  c.lineWidth = 1;
  const flow = (t * 0.6) % 1;
  for (let k = 0; k < 14; k++) {
    const z = k + 1 - flow;
    const y = horizon + 900 / (z * 3 + 1);
    if (y > h) continue;
    c.strokeStyle = `rgba(255, 40, 36, ${(0.05 + 0.2 * (1 - z / 14)).toFixed(3)})`;
    c.beginPath();
    c.moveTo(0, y);
    c.lineTo(w, y);
    c.stroke();
  }
  c.strokeStyle = "rgba(255, 40, 36, 0.14)";
  c.beginPath();
  for (let k = -12; k <= 12; k++) {
    c.moveTo(vx + k * 18, horizon);
    c.lineTo(vx + k * 180, h);
  }
  c.stroke();
  c.restore();
  c.fillStyle = radial(c, vx, horizon, 0, 520, [[0, "rgba(255, 30, 30, 0.22)"], [1, "rgba(0, 0, 0, 0)"]]);
  c.fillRect(0, 0, w, h);

  label(p, "Загрузка штаба · в реальном времени", 36, 112, TV.white65, 11);
  const share = workingShare(feed);
  const delta = share - shareAgo(feed, 60);
  const k = easeOut(s / 0.8);
  p.setFont(76, 700, DISPLAY);
  c.globalAlpha = k;
  const bw = p.text(`${Math.round(share * 100 * k)}%`, 34, 186, TV.white);
  const up = delta >= 0;
  arrow(c, up, 34 + bw + 22, 160, 8, up ? TV.white : TV.redSoft);
  p.setFont(18, 600, SANS);
  p.text(`${signedPoints(delta)} п.п. за минуту`, 34 + bw + 36, 162, up ? TV.white : TV.redSoft);
  p.setFont(14, 500, SANS);
  p.text(`${feed.working} из ${feed.total} агентов в работе`, 34 + bw + 16, 184, TV.white65);
  c.globalAlpha = 1;

  // The chart of the last minutes.
  const gx = 36;
  const gy = 204;
  const gw = 636;
  const gh = 180;
  glassCard(p, gx, gy, gw, gh, { opacity: 0.85 });
  const values = feed.history.length >= 2 ? feed.history.slice(-150) : [share, share];
  const { norm, lo, hi } = stretchRange(values);
  areaChart(p, norm, gx + 16, gy + 16, gw - 70, gh - 42, { reveal: easeOut(s / 1.6), t });
  label(p, `${Math.round(hi * 100)}%`, gx + gw - 12, gy + 24, TV.white45, 10, "right");
  label(p, `${Math.round(lo * 100)}%`, gx + gw - 12, gy + gh - 26, TV.white45, 10, "right");
  label(p, `−${Math.round(values.length / 60)} мин`, gx + 16, gy + gh - 8, TV.white45, 9.5);
  label(p, "сейчас", gx + gw - 54, gy + gh - 8, TV.white45, 9.5, "right");

  // Status board.
  const bx = 688;
  const by = 98;
  glassCard(p, bx, by, 300, 286, { opacity: 0.85 });
  label(p, "Статусы агентов", bx + 16, by + 26, TV.white45, 10.5);
  const rows: Array<[string, number, string]> = [
    ["В работе", feed.working, TV.white],
    ["Ожидают", feed.idle, TV.white80],
    ["Ошибки", feed.error, feed.error > 0 ? "#f87171" : TV.white80],
  ];
  rows.forEach(([name, value, color], i) => {
    const e = easeOut((s - 0.2 - i * 0.15) / 0.6);
    const y = by + 50 + i * 70;
    c.globalAlpha = e;
    const x = bx + 16 + (1 - e) * 30;
    p.setFont(14, 600, SANS);
    p.text(name, x, y + 12, TV.white65);
    p.setFont(38, 700, DISPLAY);
    p.text(String(value), bx + 284, y + 30, color, "right");
    bar(c, x, y + 40, 268 - (1 - e) * 30, 6, feed.total > 0 ? value / feed.total : 0, i === 2 ? TV.redHot : TV.red);
    c.globalAlpha = 1;
  });
  p.setFont(13, 500, SANS);
  p.text(`Агентов в сети: ${feed.total}`, bx + 16, by + 270, TV.white65);
}

/** Stretches values to their own range (so a flat day still has shape). */
function stretchRange(values: readonly number[]): { norm: number[]; lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const mid = (lo + hi) / 2;
  const span = Math.max(0.06, hi - lo) * 1.35;
  lo = Math.max(0, mid - span / 2);
  hi = Math.min(1, lo + span);
  lo = Math.max(0, hi - span);
  return { norm: values.map((v) => (v - lo) / (hi - lo || 1)), lo, hi };
}

export function stretch(values: readonly number[]): number[] {
  return values.length >= 2 ? stretchRange(values).norm : [0.5, 0.5];
}

// --- AM7 BUSINESS ---------------------------------------------------------------------------------
const quoteCrawl = new Crawl(64, 30);

export function paintMarkets(p: Painter, t: number, feed: HqScreenFeed): void {
  const { w, h } = p;
  const c = p.ctx;
  c.fillStyle = linear(c, 0, 0, 0, h, [[0, "#0b0506"], [1, "#030202"]]);
  c.fillRect(0, 0, w, h);
  c.strokeStyle = "rgba(255, 255, 255, 0.025)";
  c.lineWidth = 1;
  c.beginPath();
  for (let x = 0.5; x < w; x += 32) {
    c.moveTo(x, 0);
    c.lineTo(x, h);
  }
  for (let y = 0.5; y < h; y += 32) {
    c.moveTo(0, y);
    c.lineTo(w, y);
  }
  c.stroke();
  c.fillStyle = radial(c, 300, 220, 0, 520, [[0, "rgba(160, 12, 18, 0.2)"], [1, "rgba(0, 0, 0, 0)"]]);
  c.fillRect(0, 0, w, h);

  const right = channelLogo(p, 28, 18, "BUSINESS");
  liveBug(p, right + 10, 22, t);
  clockBlock(p, w - 28, 14, feed.clock);

  // The HQ index.
  const series = indexSeries(feed, 180);
  const bars = candles(series, 6).slice(-30);
  const last = series[series.length - 1] ?? 0;
  const first = series[0] ?? last;
  const change = last - first;
  const cx0 = 28;
  const cy0 = 70;
  const cw = 628;
  const ch = 330;
  glassCard(p, cx0, cy0, cw, ch, { opacity: 0.88 });
  label(p, "Индекс штаба · AM7X", cx0 + 18, cy0 + 26, TV.white45, 10.5);
  p.setFont(42, 700, DISPLAY);
  const pw = p.text(decimal(last, 2), cx0 + 16, cy0 + 72, TV.white);
  const up = change >= 0;
  arrow(c, up, cx0 + 36 + pw, cy0 + 64, 7, up ? TV.white : TV.redSoft);
  p.setFont(18, 600, DISPLAY);
  const pct = first !== 0 ? (change / first) * 100 : 0;
  p.text(`${change >= 0 ? "+" : "−"}${decimal(Math.abs(change), 2)} (${change >= 0 ? "+" : "−"}${decimal(Math.abs(pct), 2)}%)`, cx0 + 50 + pw, cy0 + 66, up ? TV.white : TV.redSoft);
  p.setFont(11, 700, MONO);
  fillRound(c, cx0 + cw - 150, cy0 + 16, 60, 22, 4, "rgba(227, 20, 28, 0.2)");
  strokeRound(c, cx0 + cw - 150, cy0 + 16, 60, 22, 4, "rgba(255, 60, 52, 0.6)");
  p.text("3 МИН", cx0 + cw - 120, cy0 + 31, TV.white, "center");
  label(p, "свеча 6 с", cx0 + cw - 18, cy0 + 31, TV.white45, 10, "right");

  const ax = cx0 + 18;
  const ay = cy0 + 92;
  const aw = cw - 88;
  const ah = ch - 116;
  let lo = Infinity;
  let hi = -Infinity;
  for (const k of bars) {
    lo = Math.min(lo, k.low);
    hi = Math.max(hi, k.high);
  }
  if (!Number.isFinite(lo)) {
    lo = last - 1;
    hi = last + 1;
  }
  const pad = Math.max(0.3, (hi - lo) * 0.15);
  lo -= pad;
  hi += pad;
  const yOf = (v: number) => ay + ah * 0.86 - ((v - lo) / (hi - lo)) * ah * 0.86;
  // Price grid and axis.
  c.strokeStyle = TV.white06;
  c.beginPath();
  for (let g = 0; g <= 4; g++) {
    const v = lo + ((hi - lo) * g) / 4;
    const y = Math.round(yOf(v)) + 0.5;
    c.moveTo(ax, y);
    c.lineTo(ax + aw, y);
  }
  c.stroke();
  for (let g = 0; g <= 4; g++) {
    const v = lo + ((hi - lo) * g) / 4;
    p.setFont(11, 500, MONO);
    p.text(decimal(v, 1), ax + aw + 50, yOf(v) + 4, TV.white45, "right");
  }
  // Candles, volume and a moving average.
  const slot = aw / 30;
  const bodyW = Math.max(3, slot * 0.56);
  const x0 = ax + aw - bars.length * slot;
  const avg: number[] = [];
  let ema = bars[0]?.close ?? last;
  bars.forEach((k, i) => {
    ema = ema + (k.close - ema) * 0.3;
    avg.push(ema);
    const x = x0 + i * slot + slot / 2;
    const upK = k.close >= k.open;
    const color = upK ? TV.white : TV.redHot;
    c.strokeStyle = upK ? TV.white65 : TV.redHot;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(Math.round(x) + 0.5, yOf(k.high));
    c.lineTo(Math.round(x) + 0.5, yOf(k.low));
    c.stroke();
    const y1 = yOf(Math.max(k.open, k.close));
    const y2 = yOf(Math.min(k.open, k.close));
    const bh = Math.max(1.5, y2 - y1);
    if (upK) {
      c.fillStyle = "rgba(255, 255, 255, 0.14)";
      c.fillRect(x - bodyW / 2, y1, bodyW, bh);
      c.strokeStyle = color;
      c.strokeRect(Math.round(x - bodyW / 2) + 0.5, Math.round(y1) + 0.5, Math.round(bodyW) - 1, Math.max(1, Math.round(bh) - 1));
    } else {
      c.fillStyle = color;
      c.fillRect(x - bodyW / 2, y1, bodyW, bh);
    }
    const vol = clamp01(Math.abs(k.close - k.open) / 0.6 + 0.15);
    c.fillStyle = upK ? "rgba(255, 255, 255, 0.16)" : "rgba(255, 42, 42, 0.35)";
    c.fillRect(x - bodyW / 2, ay + ah - vol * ah * 0.12, bodyW, vol * ah * 0.12);
  });
  if (avg.length > 1) {
    c.strokeStyle = "rgba(255, 90, 82, 0.85)";
    c.lineWidth = 1.6;
    c.beginPath();
    avg.forEach((v, i) => {
      const x = x0 + i * slot + slot / 2;
      if (i === 0) c.moveTo(x, yOf(v));
      else c.lineTo(x, yOf(v));
    });
    c.stroke();
  }
  // The last price: a dashed line and a tag on the axis.
  const ly = yOf(last);
  c.setLineDash([4, 4]);
  c.strokeStyle = TV.white25;
  c.beginPath();
  c.moveTo(ax, Math.round(ly) + 0.5);
  c.lineTo(ax + aw, Math.round(ly) + 0.5);
  c.stroke();
  c.setLineDash([]);
  fillRound(c, ax + aw + 4, ly - 10, 54, 20, 3, TV.red);
  p.setFont(11.5, 700, MONO);
  p.text(decimal(last, 2), ax + aw + 31, ly + 4, TV.white, "center");

  // Departments.
  const dx = 672;
  const dy = 70;
  const dw = w - dx - 28;
  glassCard(p, dx, dy, dw, ch, { opacity: 0.88 });
  label(p, "Операции", dx + 16, dy + 26, TV.white45, 10.5);
  label(p, "в работе · 1 мин", dx + dw - 16, dy + 26, TV.white45, 10, "right");
  const rows = feed.teams
    .map((team, i): { name: string; team: HqTeamStat } => ({ name: TEAM_NAMES[i], team }))
    .filter((r) => r.team.total > 0)
    .sort((a, b) => b.team.total - a.team.total)
    .slice(0, 7);
  if (rows.length === 0) {
    rows.push(
      { name: "В работе", team: { total: Math.max(1, feed.total), working: feed.working, error: 0, workingAgo: feed.working } },
      { name: "Ожидают", team: { total: Math.max(1, feed.total), working: feed.idle, error: 0, workingAgo: feed.idle } },
      { name: "Ошибки", team: { total: Math.max(1, feed.total), working: feed.error, error: feed.error, workingAgo: feed.error } },
    );
  }
  rows.forEach(({ name, team }, i) => {
    const y = dy + 44 + i * 40;
    const share = team.total > 0 ? team.working / team.total : 0;
    const diff = team.working - team.workingAgo;
    p.setFont(14, 600, SANS);
    p.text(fit(c, name, 150), dx + 16, y + 16, TV.white);
    p.setFont(11, 500, MONO);
    p.text(`${team.working}/${team.total}`, dx + 16, y + 31, TV.white45);
    p.setFont(20, 700, DISPLAY);
    p.text(`${Math.round(share * 100)}%`, dx + dw - 64, y + 24, TV.white, "right");
    if (diff === 0) {
      p.setFont(12, 600, MONO);
      p.text("—", dx + dw - 30, y + 22, TV.white25, "center");
    } else {
      arrow(c, diff > 0, dx + dw - 44, y + 19, 5, diff > 0 ? TV.white : TV.redSoft);
      p.setFont(12, 700, MONO);
      p.text(String(Math.abs(diff)), dx + dw - 36, y + 22, diff > 0 ? TV.white : TV.redSoft);
    }
    bar(c, dx + 96, y + 27, dw - 190, 3, share, team.error > 0 ? TV.redHot : TV.red);
    if (i < rows.length - 1) {
      c.fillStyle = TV.white06;
      c.fillRect(dx + 16, y + 38, dw - 32, 1);
    }
  });

  // The world's exchanges, open or closed right now.
  const ex0 = 28;
  const ey = 412;
  const ew = (w - 56 - 5 * 8) / 6;
  EXCHANGES.forEach((ex, i) => {
    const x = ex0 + i * (ew + 8);
    const state = exchangeState(ex, feed.clock);
    glassCard(p, x, ey, ew, 82, { opacity: 0.88, radius: 6 });
    p.setFont(16, 700, DISPLAY);
    p.text(ex.code, x + 12, ey + 24, TV.white);
    const pill = state.open ? "ОТКРЫТА" : "ЗАКРЫТА";
    p.setFont(9.5, 700, MONO);
    const pwid = c.measureText(pill).width + 16 + (state.open ? 10 : 0);
    const px = x + ew - 10 - pwid;
    fillRound(c, px, ey + 10, pwid, 18, 9, state.open ? "rgba(227, 20, 28, 0.25)" : "rgba(255, 255, 255, 0.04)");
    strokeRound(c, px, ey + 10, pwid, 18, 9, state.open ? "rgba(255, 60, 52, 0.65)" : "rgba(255, 255, 255, 0.12)");
    if (state.open) liveDot(c, px + 9, ey + 19, 2.6, t);
    p.text(pill, px + (state.open ? 17 : 8), ey + 23, state.open ? TV.white : TV.white45);
    p.setFont(12.5, 500, SANS);
    p.text(`${ex.city} · ${state.local.text}`, x + 12, ey + 48, TV.white65);
    p.setFont(10.5, 500, MONO);
    p.text(`${state.open ? "до закрытия" : "до открытия"} ${durationText(state.minutes)}`, x + 12, ey + 68, TV.white45);
  });

  // The quote crawl.
  const qy = h - 52;
  c.fillStyle = "rgba(6, 3, 4, 0.95)";
  c.fillRect(0, qy, w, 32);
  c.fillStyle = TV.red;
  c.fillRect(0, qy - 2, w, 2);
  c.save();
  c.beginPath();
  c.rect(150, qy, w - 150, 32);
  c.clip();
  const codeFont = `600 13px ${MONO}`;
  const valueFont = `700 16px ${DISPLAY}`;
  const deltaFont = `600 14px ${DISPLAY}`;
  quoteCrawl.draw(p, 150, qy + 22, w - 150, t, () =>
    marketQuotes(feed, last, change).map((q) => {
      const spans: Span[] = [
        { text: `${q.code}  `, color: TV.white65, font: codeFont },
        { text: q.value, color: TV.white, font: valueFont },
      ];
      if (q.delta !== 0) {
        const upQ = q.delta > 0;
        spans.push({ text: ` ${upQ ? "▲" : "▼"} ${decimal(Math.abs(q.delta), Number.isInteger(q.delta) ? 0 : 2)}`, color: upQ ? TV.white : TV.redSoft, font: deltaFont });
      }
      return spans;
    }),
  );
  c.restore();
  p.resetFont();
  c.fillStyle = linear(c, 0, qy, 0, qy + 32, [[0, "#f0222a"], [1, "#a50a10"]]);
  c.fillRect(0, qy, 150, 32);
  p.setFont(15, 700, DISPLAY);
  spaced(p, "КОТИРОВКИ", 18, qy + 22, TV.white, 1.5);
  vignette(p, 0.35);
}

// --- AM7 RADIO -----------------------------------------------------------------------------------
const TRACKS: ReadonlyArray<readonly [string, string, number]> = [
  ["Deep Focus — Night Shift Mix", "AM7 Radio", 262],
  ["Signal / Noise", "Red Room Sessions", 214],
  ["Midnight Build", "Kade & Lyra", 238],
  ["Low Latency", "Orion", 197],
  ["Server Room Rain", "Echo Ambient", 251],
];

export function paintMusic(p: Painter, t: number, feed: HqScreenFeed): void {
  const { w, h } = p;
  const c = p.ctx;
  c.fillStyle = "#040203";
  c.fillRect(0, 0, w, h);
  const beat = Math.pow(0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 1.02), 6);
  // One cached gradient pulsed through alpha: a gradient per beat value would
  // flush the cache the wall channels share (screenKit.ts cachedGradient).
  c.globalAlpha = 0.7 + 0.3 * beat;
  c.fillStyle = radial(c, 250, 300, 0, 420, [[0, "rgba(190, 14, 20, 0.4)"], [1, "rgba(0, 0, 0, 0)"]]);
  c.fillRect(0, 0, w, h);
  c.globalAlpha = 1;

  // Which track, and how far into it.
  const total = TRACKS.reduce((s, tr) => s + tr[2], 0);
  let pos = t % total;
  let ti = 0;
  while (pos >= TRACKS[ti][2]) {
    pos -= TRACKS[ti][2];
    ti++;
  }
  const [title, artist, len] = TRACKS[ti];

  // A spinning record with a red label.
  const rx = 250;
  const ry = 300;
  const rr = 170;
  c.fillStyle = radial(c, rx, ry, rr * 0.2, rr, [[0, "#141012"], [0.7, "#0a0708"], [1, "#050304"]]);
  c.beginPath();
  c.arc(rx, ry, rr, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = "rgba(255, 255, 255, 0.05)";
  c.lineWidth = 1;
  for (let g = rr * 0.42; g < rr - 4; g += 4) {
    c.beginPath();
    c.arc(rx, ry, g, 0, Math.PI * 2);
    c.stroke();
  }
  const spin = t * Math.PI * 2 * 0.55;
  c.strokeStyle = "rgba(255, 255, 255, 0.16)";
  c.lineWidth = 10;
  c.beginPath();
  c.arc(rx, ry, rr * 0.72, spin, spin + 0.5);
  c.stroke();
  c.beginPath();
  c.arc(rx, ry, rr * 0.72, spin + Math.PI, spin + Math.PI + 0.5);
  c.stroke();
  c.fillStyle = linear(c, rx - rr * 0.36, ry - rr * 0.36, rx + rr * 0.36, ry + rr * 0.36, [[0, "#ff2d2d"], [1, "#8a0b10"]]);
  c.beginPath();
  c.arc(rx, ry, rr * 0.36, 0, Math.PI * 2);
  c.fill();
  c.save();
  c.translate(rx, ry);
  c.rotate(spin);
  p.setFont(30, 700, DISPLAY);
  p.text("AM7", 0, 4, TV.white, "center");
  p.setFont(10, 600, MONO);
  p.text("RADIO", 0, 22, "rgba(255, 255, 255, 0.8)", "center");
  c.restore();
  p.resetFont();
  dot(c, rx, ry, 5, "#050304");

  const right = channelLogo(p, 36, 22, "RADIO");
  liveBug(p, right + 10, 26, t, "В ЭФИРЕ");
  clockBlock(p, w - 36, 20, feed.clock || Date.now());

  const tx = 470;
  label(p, "Сейчас в эфире", tx, 150, TV.white45, 11);
  p.setFont(34, 700, DISPLAY);
  p.text(fit(c, title, w - tx - 36), tx, 196, TV.white);
  p.setFont(17, 500, SANS);
  p.text(`${artist} · ночной эфир штаба`, tx, 226, TV.white65);

  // A mirrored spectrum.
  const n = 36;
  const sx = tx;
  const sw = w - tx - 36;
  const base = 360;
  const slot = sw / n;
  for (let i = 0; i < n; i++) {
    const f = i / n;
    const v =
      clamp01(0.12 + 0.55 * Math.abs(Math.sin(t * (1.3 + (i % 5) * 0.37) + i * 0.9)) * (1 - f * 0.55) + 0.3 * beat * (1 - f)) * 90;
    const x = sx + i * slot;
    c.fillStyle = linear(c, 0, base - 90, 0, base, [[0, TV.white], [0.35, TV.redHot], [1, TV.redDeep]]);
    c.fillRect(x + 1, base - v, slot - 3, v);
    c.fillStyle = "rgba(255, 42, 42, 0.18)";
    c.fillRect(x + 1, base + 3, slot - 3, v * 0.35);
  }
  // Progress.
  bar(c, tx, 410, sw, 4, pos / len, TV.redHot);
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  p.setFont(12, 500, MONO);
  p.text(mmss(pos), tx, 432, TV.white45);
  p.text(mmss(len), tx + sw, 432, TV.white45, "right");
  // Up next.
  label(p, "Далее", tx, 470, TV.white45, 10.5);
  for (let k = 1; k <= 2; k++) {
    const [nt, na] = TRACKS[(ti + k) % TRACKS.length];
    p.setFont(15, 600, SANS);
    p.text(nt, tx, 470 + k * 30, k === 1 ? TV.white80 : TV.white45);
    p.setFont(13, 500, SANS);
    p.text(na, tx + sw, 470 + k * 30, TV.white45, "right");
  }
  vignette(p, 0.45);
}
