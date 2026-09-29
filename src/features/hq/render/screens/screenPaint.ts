import {
  CHAT_LINES,
  CODE_PY,
  CODE_SQL,
  CODE_TS,
  DOC_TEXT,
  DOC_TITLE,
  KANBAN,
  LOG_MESSAGES,
  LOG_SERVICES,
  PAPERS,
  REGIONS,
  RESEARCH_TEXT,
  RESEARCH_TITLE,
  TASK_KINDS,
  TERM_BUILD,
  TERM_OPS,
  TERM_TESTS,
  TS_KEYWORDS,
  hash2,
  makeRng,
  pick,
  type TermLine,
} from "./screenText";
import { HQ_DEFAULT_TIME_ZONE, hqTimeZone, hqWallClock } from "@/features/hq/core/hqTime";

/**
 * Canvas 2D painters for the HQ's screens: a small drawing toolkit and one
 * painter per "app" a monitor can show (code editor, terminal, logs,
 * dashboards, tables, research, chat…). Red on black like the rest of the HQ.
 * Painters are pure functions of (time, seed, feed), so a screen can be
 * repainted at any rate and every repaint moves the content along.
 */

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** What the screens know about the floor; refreshed about once a second. */
export type HqScreenFeed = {
  /** Wall clock, ms since the epoch (the worker sets it to the time of each paint). */
  clock: number;
  /** The HQ's IANA time zone (hqTime.ts); the worker adopts it for its clocks. */
  timeZone: string;
  /** How many feeds the hub has built, one history sample each: a phase that moves with `history`. */
  sample: number;
  total: number;
  working: number;
  idle: number;
  error: number;
  /** Agent names on the floor, for tables, logs and chat. */
  names: readonly string[];
  /** The latest status changes, newest first. */
  events: ReadonlyArray<{ at: number; name: string; status: number }>;
  /** Working share 0..1, one sample per second, oldest first. */
  history: readonly number[];
  /** Per role family (HQ_ROLE_FAMILY order): the department boards and quotes. */
  teams: readonly HqTeamStat[];
  /** AM7's briefing on the video wall (HqScreenHub.setBriefing), or null for the usual panels. */
  briefing: HqScreenBriefing | null;
};

/** What a briefing puts on the video wall: the task, the goal and the plan, as given. */
export type HqBriefingText = { task: string; goal: string; plan: string };

/** A briefing as the screens paint it; `id` grows whenever its text changes. */
export type HqScreenBriefing = HqBriefingText & { id: number };

export type HqTeamStat = {
  total: number;
  working: number;
  error: number;
  /** Working agents about a minute ago, for the change columns. */
  workingAgo: number;
};

export const EMPTY_FEED: HqScreenFeed = {
  clock: 0,
  timeZone: HQ_DEFAULT_TIME_ZONE,
  sample: 0,
  total: 0,
  working: 0,
  idle: 0,
  error: 0,
  names: [],
  events: [],
  history: [],
  teams: [],
  briefing: null,
};

// Like real software on a dark theme: neutral near-black chrome, light grey
// text, red and orange for the accents (highlights, charts, alerts).
export const INK = {
  bg: "#0a0a0c",
  panel: "#14151892",
  panelSolid: "#131417",
  line: "#2c2e33",
  grid: "#1a1b1f",
  dim: "#6b6f78",
  mid: "#9a9ea8",
  text: "#c9ccd2",
  hot: "#ff4a3a",
  white: "#f1f2f4",
  warn: "#ffae5c",
  good: "#ff8a5c",
  /** Terminal prompt accents (Kali's root prompt: a red user, blue brackets). */
  promptUser: "#ff5555",
  promptFrame: "#5c9dff",
} as const;

export const MONO = `"JetBrains Mono", "Cascadia Mono", Consolas, "Menlo", monospace`;
export const SANS = `"Inter", "Segoe UI", "Roboto", "Helvetica Neue", Arial, sans-serif`;

/** Drawing helpers over one 2D context of a fixed size. */
export class Painter {
  private font = "";

  constructor(
    readonly ctx: Ctx2D,
    readonly w: number,
    readonly h: number,
  ) {}

  setFont(size: number, weight = 400, family = MONO): void {
    const font = `${weight} ${Math.round(size)}px ${family}`;
    if (font !== this.font) {
      this.ctx.font = font;
      this.font = font;
    }
  }

  /** Forgets the cached font (after a save/restore or a canvas reused between painters). */
  resetFont(): void {
    this.font = "";
  }

  clear(color: string = INK.bg): void {
    const c = this.ctx;
    c.globalAlpha = 1;
    c.fillStyle = color;
    c.fillRect(0, 0, this.w, this.h);
  }

  fill(x: number, y: number, w: number, h: number, color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x, y, w, h);
  }

  stroke(x: number, y: number, w: number, h: number, color: string, width = 1): void {
    const c = this.ctx;
    c.strokeStyle = color;
    c.lineWidth = width;
    c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  text(str: string, x: number, y: number, color: string, align: CanvasTextAlign = "left"): number {
    const c = this.ctx;
    c.fillStyle = color;
    c.textAlign = align;
    c.textBaseline = "alphabetic";
    c.fillText(str, x, y);
    return c.measureText(str).width;
  }

  /** A titled panel: a faint fill, a hairline border and a small caps header. */
  panel(x: number, y: number, w: number, h: number, title?: string, size = 11): number {
    this.fill(x, y, w, h, INK.panelSolid);
    this.stroke(x, y, w, h, INK.line);
    if (!title) return y;
    this.fill(x, y, w, size + 8, "#242427");
    this.setFont(size, 600);
    this.text(title.toUpperCase(), x + 7, y + size + 3, INK.mid);
    return y + size + 8;
  }

  /** A line chart of values (0..1) inside a box, with a faint area fill. */
  chart(values: ArrayLike<number>, x: number, y: number, w: number, h: number, color: string = INK.hot, fill = true): void {
    const n = values.length;
    if (n < 2) return;
    const c = this.ctx;
    c.strokeStyle = INK.grid;
    c.lineWidth = 1;
    c.beginPath();
    for (let k = 1; k < 4; k++) {
      const gy = Math.round(y + (h * k) / 4) + 0.5;
      c.moveTo(x, gy);
      c.lineTo(x + w, gy);
    }
    c.stroke();
    c.beginPath();
    for (let i = 0; i < n; i++) {
      const px = x + (w * i) / (n - 1);
      const py = y + h - h * clamp01(values[i]);
      if (i === 0) c.moveTo(px, py);
      else c.lineTo(px, py);
    }
    if (fill) {
      c.save();
      c.lineTo(x + w, y + h);
      c.lineTo(x, y + h);
      c.closePath();
      c.globalAlpha = 0.18;
      c.fillStyle = color;
      c.fill();
      c.restore();
      c.beginPath();
      for (let i = 0; i < n; i++) {
        const px = x + (w * i) / (n - 1);
        const py = y + h - h * clamp01(values[i]);
        if (i === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
    }
    c.strokeStyle = color;
    c.lineWidth = 1.6;
    c.stroke();
  }

  bars(values: ArrayLike<number>, x: number, y: number, w: number, h: number, color: string = INK.text): void {
    const n = values.length;
    const bw = w / n;
    for (let i = 0; i < n; i++) {
      const v = clamp01(values[i]);
      const bh = Math.max(1, v * h);
      this.fill(x + i * bw + bw * 0.18, y + h - bh, bw * 0.64, bh, i === n - 1 ? INK.hot : color);
    }
  }

  /** Horizontal bar with a track. */
  meter(x: number, y: number, w: number, h: number, v: number, color: string = INK.text): void {
    this.fill(x, y, w, h, "#2a2a2d");
    this.fill(x, y, Math.max(1, w * clamp01(v)), h, color);
  }

  ring(cx: number, cy: number, r: number, v: number, width: number, color: string = INK.hot): void {
    const c = this.ctx;
    c.lineWidth = width;
    c.strokeStyle = "#2c2c2f";
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = color;
    c.beginPath();
    c.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp01(v));
    c.stroke();
  }

  /** Window chrome: title bar with dots, tabs, and a status bar. Returns the content box. */
  window(title: string, tabs: readonly string[], active: number, status: string): Box {
    const { w, h } = this;
    this.clear();
    this.fill(0, 0, w, 22, "#1d1d20");
    for (let i = 0; i < 3; i++) {
      this.ctx.fillStyle = i === 0 ? INK.hot : INK.dim;
      this.ctx.beginPath();
      this.ctx.arc(11 + i * 13, 11, 3.6, 0, Math.PI * 2);
      this.ctx.fill();
    }
    this.setFont(11, 600, SANS);
    this.text(title, w / 2, 15, INK.mid, "center");
    let tx = 4;
    this.setFont(10.5, 500, SANS);
    for (let i = 0; i < tabs.length; i++) {
      const tw = this.ctx.measureText(tabs[i]).width + 22;
      this.fill(tx, 23, tw, 19, i === active ? "#27272a" : "#141417");
      if (i === active) this.fill(tx, 23, tw, 2, INK.hot);
      this.text(tabs[i], tx + 11, 36, i === active ? INK.white : INK.dim);
      tx += tw + 2;
    }
    this.fill(0, h - 16, w, 16, "#1a1a1d");
    this.setFont(9.5, 500, MONO);
    this.text(status, 8, h - 4.5, INK.mid);
    return { x: 0, y: 43, w, h: h - 43 - 16 };
  }
}

export type Box = { x: number; y: number; w: number; h: number };

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Smooth pseudo-random 0..1 signal, stable per seed. */
export function wave(t: number, seed: number): number {
  const a = Math.sin(t * 0.9 + seed * 12.9) * 0.5 + Math.sin(t * 2.3 + seed * 3.1) * 0.3 + Math.sin(t * 5.7 + seed) * 0.2;
  return 0.5 + 0.42 * a;
}

export function series(n: number, t: number, seed: number, rate = 1): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = wave((t - (n - 1 - i) * 0.35) * rate, seed);
  return out;
}

/** The HQ's wall time (Moscow), hh:mm:ss. */
export function clockText(ms: number, withMs = false): string {
  const d = hqWallClock(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return withMs ? `${hh}:${mm}:${ss}.${String(d.getUTCMilliseconds()).padStart(3, "0")}` : `${hh}:${mm}:${ss}`;
}

function nameAt(feed: HqScreenFeed, k: number): string {
  if (feed.names.length === 0) return pick(["Nova", "Vex", "Rune", "Kade", "Lyra", "Orion"], hash2(k, 7));
  return feed.names[Math.floor(hash2(k, 11) * feed.names.length) % feed.names.length];
}

// --- syntax-coloured source ---------------------------------------------------------------
function codeLine(p: Painter, line: string, x: number, y: number, maxChars: number): void {
  const s = line.length > maxChars ? line.slice(0, maxChars) : line;
  const trimmed = s.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("#")) {
    p.text(s, x, y, INK.dim);
    return;
  }
  const cw = p.ctx.measureText("M").width;
  const re = /("[^"]*"|'[^']*'|`[^`]*`|\b\d+(?:\.\d+)?\b|[A-Za-z_][A-Za-z0-9_]*|\s+|.)/g;
  let col = 0;
  for (const m of s.matchAll(re)) {
    const tok = m[0];
    let color: string = INK.text;
    if (/^\s+$/.test(tok)) {
      col += tok.length;
      continue;
    }
    if (tok[0] === '"' || tok[0] === "'" || tok[0] === "`") color = INK.warn;
    else if (/^\d/.test(tok)) color = INK.good;
    else if (TS_KEYWORDS.has(tok)) color = INK.hot;
    else if (/^[A-Z][A-Za-z0-9]*$/.test(tok)) color = INK.white;
    else if (/^[^A-Za-z0-9_]$/.test(tok)) color = INK.mid;
    p.text(tok, x + col * cw, y, color);
    col += tok.length;
  }
}

// --- the apps -------------------------------------------------------------------------------
export type AppPainter = (p: Painter, t: number, seed: number, feed: HqScreenFeed) => void;

function editor(source: readonly string[], file: string, lang: string): AppPainter {
  return (p, t, seed) => {
    const rate = 1.6;
    const total = source.length;
    const typedLines = t * rate + seed * 997;
    const cursorLine = Math.floor(typedLines) % total;
    const partial = typedLines - Math.floor(typedLines);
    const box = p.window(`${file} — agent-core`, [file, "types.ts", "README.md"], 0, `${lang}  UTF-8  Ln ${cursorLine + 1}, Col ${Math.floor(partial * 40) + 1}   ● main`);
    // file tree
    const treeW = 92;
    p.fill(box.x, box.y, treeW, box.h, "#141417");
    p.setFont(10, 400, SANS);
    const tree = ["▾ src", "  ▸ memory", "  ▸ tools", "    router.ts", "    scheduler.ts", "    types.ts", "▸ tests", "  package.json"];
    tree.forEach((line, i) => p.text(line, box.x + 6, box.y + 16 + i * 15, i === 3 ? INK.white : INK.dim));
    const lh = 14;
    const rows = Math.floor((box.h - 8) / lh);
    const first = Math.max(0, cursorLine - rows + 4);
    const gx = box.x + treeW;
    p.fill(gx, box.y, 30, box.h, "#111114");
    p.setFont(11);
    const maxChars = Math.floor((box.w - treeW - 44 - 50) / p.ctx.measureText("M").width);
    for (let r = 0; r < rows; r++) {
      const li = first + r;
      if (li > cursorLine) break;
      const y = box.y + 13 + r * lh;
      if (li === cursorLine) p.fill(gx + 30, y - 11, box.w - treeW - 80, lh, "#242427");
      p.text(String(li + 1).padStart(3, " "), gx + 26, y, li === cursorLine ? INK.mid : INK.line, "right");
      let line = source[li] ?? "";
      if (li === cursorLine) line = line.slice(0, Math.floor(line.length * partial));
      codeLine(p, line, gx + 38, y, maxChars);
      if (li === cursorLine && Math.floor(t * 2.4) % 2 === 0) {
        const cx = gx + 38 + line.length * p.ctx.measureText("M").width;
        p.fill(cx, y - 10, 6, 13, INK.hot);
      }
    }
    // minimap
    const mx = box.x + box.w - 44;
    p.fill(mx, box.y, 44, box.h, "#111114");
    for (let i = 0; i < total; i++) {
      const len = Math.min(36, (source[i]?.length ?? 0) * 0.5);
      p.fill(mx + 4 + (source[i]?.search(/\S/) ?? 0) * 0.5, box.y + 4 + i * 2.2, len, 1.2, i <= cursorLine ? INK.dim : INK.grid);
    }
    p.fill(mx, box.y + 4 + first * 2.2, 44, rows * 2.2, "#ff5b4b18");
  };
}

/** Kali's root prompt, first row: ┌──(root㉿kali)-[dir]. */
function kaliPromptTop(p: Painter, x: number, y: number, dir: string): void {
  let cx = x;
  cx += p.text("┌──(", cx, y, INK.promptFrame);
  cx += p.text("root㉿kali", cx, y, INK.promptUser);
  cx += p.text(")-[", cx, y, INK.promptFrame);
  cx += p.text(dir, cx, y, INK.white);
  p.text("]", cx, y, INK.promptFrame);
}

/** Kali's root prompt, second row: └─# ; returns the x where the command starts. */
function kaliPromptBottom(p: Painter, x: number, y: number): number {
  const w = p.text("└─", x, y, INK.promptFrame);
  return x + w + p.text("# ", x + w, y, INK.promptUser);
}

type TermRow = { kind: "top" } | { kind: "cmd"; text: string } | { kind: "out"; line: TermLine } | { kind: "cursor" };

function terminal(session: readonly TermLine[], title: string, dir: string): AppPainter {
  return (p, t, seed) => {
    const box = p.window(title, ["root@kali", "logs", "notes"], 0, `${session.length} lines  •  zsh  •  utf-8`);
    const lh = 14;
    const rows = Math.floor((box.h - 6) / lh);
    const progress = t * 1.4 + seed * 311;
    const shown = Math.floor(progress) % (session.length + 6);
    p.setFont(11);
    // Every command sits under its two-row prompt; the live prompt waits at the end.
    const all: TermRow[] = [];
    for (const line of session.slice(0, Math.min(shown, session.length))) {
      if (line.kind === "cmd") all.push({ kind: "top" }, { kind: "cmd", text: line.text });
      else all.push({ kind: "out", line });
    }
    all.push({ kind: "top" }, { kind: "cursor" });
    const visible = all.slice(Math.max(0, all.length - rows));
    let y = box.y + 14;
    for (const row of visible) {
      if (row.kind === "top") {
        kaliPromptTop(p, 8, y, dir);
      } else if (row.kind === "cmd") {
        p.text(row.text, kaliPromptBottom(p, 8, y), y, INK.white);
      } else if (row.kind === "cursor") {
        const x = kaliPromptBottom(p, 8, y);
        if (Math.floor(t * 2.2) % 2 === 0) p.fill(x, y - 10, 7, 13, INK.white);
      } else {
        const kind = row.line.kind;
        const color = kind === "ok" ? INK.good : kind === "warn" ? INK.warn : kind === "err" ? INK.hot : kind === "dim" ? INK.dim : INK.text;
        p.text(row.line.text, 8, y, color);
      }
      y += lh;
    }
  };
}

const logs: AppPainter = (p, t, seed, feed) => {
  const box = p.window("logs — gateway / router / worker", ["Live", "Errors", "Traces"], 0, `tail -f  •  ${Math.round(40 + wave(t, seed) * 60)} lines/s`);
  const lh = 13;
  const rows = Math.floor((box.h - 6) / lh);
  const tick = Math.floor(t * 3 + seed * 1000);
  p.setFont(10);
  const cw = p.ctx.measureText("M").width;
  for (let r = 0; r < rows; r++) {
    const k = tick - (rows - 1 - r);
    const rng = makeRng(k * 7919 + Math.floor(seed * 1e6));
    const at = feed.clock - (rows - 1 - r) * 330;
    const level = rng() < 0.08 ? "WARN" : rng() < 0.03 ? "ERROR" : "INFO";
    const service = pick(LOG_SERVICES, rng());
    const msg = pick(LOG_MESSAGES, rng())
      .replace("%id", `t-${(k * 2654435761 >>> 0).toString(16).slice(0, 6)}`)
      .replace("%ms", String(Math.round(40 + rng() * 900)))
      .replace("%kind", pick(TASK_KINDS, rng()))
      .replace("%name", nameAt(feed, k))
      .replace("%n", String(Math.round(2 + rng() * 60)))
      .replace(/%w/g, String(8 + Math.round(rng() * 8)));
    const y = box.y + 12 + r * lh;
    let x = 6;
    x += p.text(clockText(at, true), x, y, INK.dim) + cw;
    const lc = level === "ERROR" ? INK.hot : level === "WARN" ? INK.warn : INK.mid;
    p.text(level.padEnd(5), x, y, lc);
    x += cw * 6;
    p.text(service.padEnd(8), x, y, INK.white);
    x += cw * 9;
    p.text(msg, x, y, level === "ERROR" ? INK.hot : INK.text);
  }
};

const metrics: AppPainter = (p, t, seed, feed) => {
  const box = p.window("Grafana — agents / overview", ["Overview", "Latency", "Errors"], 0, `last 15m  •  refresh 5s  •  ${clockText(feed.clock)}`);
  const pad = 6;
  const w2 = (box.w - pad * 3) / 2;
  const h2 = (box.h - pad * 3) / 2;
  const kpis = [
    ["req/s", String(Math.round(900 + wave(t * 0.3, seed) * 700))],
    ["p95", `${Math.round(120 + wave(t * 0.4, seed + 1) * 140)} ms`],
    ["errors", `${(wave(t * 0.2, seed + 2) * 1.8).toFixed(2)}%`],
  ];
  let y0 = p.panel(box.x + pad, box.y + pad, w2, h2, "throughput");
  p.chart(series(48, t, seed), box.x + pad + 6, y0 + 6, w2 - 12, h2 - (y0 - box.y - pad) - 12);
  y0 = p.panel(box.x + pad * 2 + w2, box.y + pad, w2, h2, "latency p95");
  p.chart(series(48, t * 1.3, seed + 5), box.x + pad * 2 + w2 + 6, y0 + 6, w2 - 12, h2 - (y0 - box.y - pad) - 12, INK.warn);
  const by = box.y + pad * 2 + h2;
  y0 = p.panel(box.x + pad, by, w2, h2, "tasks by department");
  p.bars(series(10, t * 0.5, seed + 9), box.x + pad + 6, y0 + 6, w2 - 12, h2 - (y0 - by) - 12);
  p.panel(box.x + pad * 2 + w2, by, w2, h2);
  kpis.forEach(([label, value], i) => {
    const kx = box.x + pad * 2 + w2 + 10 + (i * (w2 - 20)) / 3;
    p.setFont(9.5, 600, SANS);
    p.text(label.toUpperCase(), kx, by + 20, INK.dim);
    p.setFont(19, 700, SANS);
    p.text(value, kx, by + 46, i === 2 ? INK.warn : INK.white);
  });
  p.ring(box.x + pad * 2 + w2 + w2 / 2, by + h2 - 30, 18, feed.total ? feed.working / feed.total : wave(t, seed), 5);
};

const sql: AppPainter = (p, t, seed, feed) => {
  const box = p.window("psql — hq_analytics", ["query.sql", "results"], 1, `14 rows  •  ${(38 + wave(t, seed) * 30).toFixed(1)} ms`);
  p.setFont(10.5);
  CODE_SQL.slice(0, 5).forEach((line, i) => codeLine(p, line, 8, box.y + 13 + i * 13, 90));
  const ty = box.y + 13 * 5 + 10;
  const cols = ["name", "role", "tasks", "avg_ms", "ok_pct"];
  const cx = [8, 0.26, 0.5, 0.66, 0.82].map((f, i) => (i === 0 ? 8 : f * box.w));
  p.fill(0, ty, box.w, 16, "#242427");
  p.setFont(10, 700);
  cols.forEach((c, i) => p.text(c, cx[i], ty + 12, INK.hot));
  p.setFont(10.5);
  const rows = Math.floor((box.y + box.h - ty - 20) / 15);
  const hl = Math.floor(t * 0.8) % Math.max(1, rows);
  for (let r = 0; r < rows; r++) {
    const y = ty + 30 + r * 15;
    if (r === hl) p.fill(0, y - 11, box.w, 15, "#27272a");
    const k = r + Math.floor(seed * 100);
    const tasks = Math.round(40 + hash2(k, Math.floor(t / 6)) * 200);
    p.text(nameAt(feed, k), cx[0], y, INK.white);
    p.text(pick(["research", "builder", "analyst", "devops", "qa", "design"], hash2(k, 3)), cx[1], y, INK.mid);
    p.text(String(tasks), cx[2], y, INK.text);
    p.text(String(Math.round(90 + hash2(k, 5) * 500)), cx[3], y, INK.text);
    p.text(`${(92 + hash2(k, 9) * 8).toFixed(1)}`, cx[4], y, INK.good);
  }
};

const notebook: AppPainter = (p, t, seed) => {
  const box = p.window("anomalies.ipynb — Jupyter", ["anomalies.ipynb", "eda.ipynb"], 0, "Python 3.12  •  kernel idle");
  p.setFont(10.5);
  p.text("[14]:", 6, box.y + 14, INK.dim);
  const code = CODE_PY.slice(21, 27);
  code.forEach((line, i) => codeLine(p, line, 44, box.y + 14 + i * 13, 70));
  const cy = box.y + 14 + code.length * 13 + 8;
  p.text("[14]:", 6, cy + 10, INK.dim);
  const ch = box.y + box.h - cy - 14;
  p.panel(44, cy, box.w - 52, ch);
  // scatter with a robust fit line and flagged outliers
  const rng = makeRng(Math.floor(seed * 1e6) + Math.floor(t / 4));
  for (let i = 0; i < 70; i++) {
    const x = rng();
    const y = 0.25 + x * 0.5 + (rng() - 0.5) * 0.18;
    const out = rng() < 0.05;
    p.fill(50 + x * (box.w - 66), cy + ch - 6 - (out ? y + 0.25 : y) * (ch - 12), out ? 4 : 3, out ? 4 : 3, out ? INK.white : INK.mid);
  }
  p.ctx.strokeStyle = INK.hot;
  p.ctx.lineWidth = 1.5;
  p.ctx.beginPath();
  p.ctx.moveTo(50, cy + ch - 6 - 0.25 * (ch - 12));
  p.ctx.lineTo(box.w - 16, cy + ch - 6 - 0.75 * (ch - 12));
  p.ctx.stroke();
};

const research: AppPainter = (p, t, seed) => {
  const box = p.window("Исследование — браузер", ["arxiv.org", "Заметки", "Хабр"], 1, "Автосохранение  •  3 источника");
  p.fill(6, box.y + 4, box.w - 12, 18, "#1d1d20");
  p.setFont(10, 400, SANS);
  p.text("https://notes.hq.internal/research/hybrid-search", 12, box.y + 17, INK.mid);
  p.setFont(15, 700, SANS);
  p.text(RESEARCH_TITLE, 12, box.y + 44, INK.white);
  p.setFont(11, 400, SANS);
  const hl = Math.floor(t * 0.3 + seed * 10) % RESEARCH_TEXT.length;
  const rows = Math.floor((box.h - 60) / 15);
  for (let i = 0; i < Math.min(rows, RESEARCH_TEXT.length); i++) {
    const y = box.y + 64 + i * 15;
    if (i === hl && RESEARCH_TEXT[i]) p.fill(10, y - 11, p.ctx.measureText(RESEARCH_TEXT[i]).width + 4, 15, "#ff5b4b30");
    p.text(RESEARCH_TEXT[i], 12, y, i === hl ? INK.white : INK.text);
  }
};

const papers: AppPainter = (p, t, seed) => {
  const box = p.window("Поиск статей", ["Результаты", "Избранное"], 0, `${PAPERS.length} из 1 284  •  сортировка: цитирования`);
  p.fill(8, box.y + 6, box.w - 16, 20, "#1d1d20");
  p.setFont(11, 400, SANS);
  const q = "hybrid retrieval agents memory";
  const typed = q.slice(0, Math.min(q.length, Math.floor((t * 6 + seed * 50) % (q.length + 20))));
  p.text(`⌕  ${typed}`, 14, box.y + 20, INK.white);
  PAPERS.forEach(([title, authors, year, cites], i) => {
    const y = box.y + 46 + i * 34;
    if (y > box.y + box.h - 10) return;
    p.setFont(11.5, 600, SANS);
    p.text(title, 12, y, i === Math.floor(t * 0.4) % PAPERS.length ? INK.white : INK.hot);
    p.setFont(10, 400, SANS);
    p.text(`${authors} · ${year}`, 12, y + 14, INK.mid);
    p.text(`★ ${cites}`, box.w - 12, y + 14, INK.text, "right");
  });
};

const design: AppPainter = (p, t, seed) => {
  const box = p.window("Figma — HQ dashboard v3", ["Дашборд", "Компоненты"], 0, "100%  •  3 выбрано");
  const lw = 86;
  p.fill(0, box.y, lw, box.h, "#141417");
  p.setFont(10, 400, SANS);
  ["▾ Frame / Home", "   Header", "   KPI cards", "   Chart", "   Table", "▸ Frame / Agent", "▸ Components"].forEach((l, i) =>
    p.text(l, 6, box.y + 16 + i * 15, i === 3 ? INK.white : INK.dim),
  );
  const ax = lw + 18;
  const aw = box.w - lw - 110;
  const ah = box.h - 30;
  p.fill(ax, box.y + 14, aw, ah, "#1a1a1d");
  p.stroke(ax, box.y + 14, aw, ah, INK.dim);
  p.fill(ax + 8, box.y + 22, aw - 16, 16, "#353538");
  for (let i = 0; i < 3; i++) p.fill(ax + 8 + i * ((aw - 16) / 3), box.y + 44, (aw - 16) / 3 - 6, 34, "#28282b");
  p.chart(series(24, t * 0.2, seed), ax + 10, box.y + 86, aw - 20, ah * 0.36, INK.hot);
  // selection box moving
  const sx = ax + 8 + (Math.floor(t * 0.5) % 3) * ((aw - 16) / 3);
  p.stroke(sx - 2, box.y + 42, (aw - 16) / 3 - 2, 38, INK.warn, 1.5);
  // swatches
  const px = box.w - 86;
  p.fill(px, box.y, 86, box.h, "#141417");
  ["#ff1a1a", "#b0302d", "#6e0000", "#ffd8d0", "#242427", "#ffae5c"].forEach((c, i) => {
    p.fill(px + 8, box.y + 12 + i * 22, 16, 16, c);
    p.setFont(9.5);
    p.text(c, px + 30, box.y + 24 + i * 22, INK.mid);
  });
};

const cluster: AppPainter = (p, t, seed) => {
  const box = p.window("k9s — agents", ["pods", "nodes", "events"], 0, "context: prod-eu  •  ns: agents");
  const nodes = 12;
  const nw = (box.w - 16) / 6;
  for (let i = 0; i < nodes; i++) {
    const x = 8 + (i % 6) * nw;
    const y = box.y + 8 + Math.floor(i / 6) * 50;
    p.panel(x + 2, y, nw - 4, 44);
    p.setFont(9.5, 600);
    p.text(`node-${String(i + 1).padStart(2, "0")}`, x + 8, y + 13, INK.white);
    p.meter(x + 8, y + 20, nw - 20, 5, wave(t * 0.4, seed + i), INK.hot);
    p.meter(x + 8, y + 30, nw - 20, 5, wave(t * 0.3, seed + i + 20), INK.mid);
  }
  p.setFont(10.5);
  const lines = TERM_OPS.filter((l) => l.kind !== "cmd").slice(0, 8);
  lines.forEach((l, i) => p.text(l.text, 8, box.y + 124 + i * 14, l.kind === "warn" ? INK.warn : l.kind === "dim" ? INK.dim : INK.text));
};

const kanban: AppPainter = (p, t) => {
  const box = p.window("Задачи — спринт 42", ["Доска", "Бэклог"], 0, "12 задач  •  3 на ревью");
  const cols: Array<[string, readonly string[]]> = [
    ["К работе", KANBAN.todo],
    ["В работе", KANBAN.doing],
    ["Ревью", KANBAN.review],
    ["Готово", KANBAN.done],
  ];
  const cw = (box.w - 10) / 4;
  const moving = Math.floor(t / 3) % 3;
  cols.forEach(([title, cards], c) => {
    const x = 5 + c * cw;
    p.fill(x + 2, box.y + 4, cw - 4, box.h - 8, "#141417");
    p.setFont(10.5, 700, SANS);
    p.text(`${title}  ${cards.length}`, x + 8, box.y + 18, INK.mid);
    cards.forEach((card, i) => {
      const y = box.y + 26 + i * 40;
      const active = c === 1 && i === moving;
      p.fill(x + 6, y, cw - 12, 34, active ? "#353538" : "#1e1e21");
      p.fill(x + 6, y, 3, 34, c === 3 ? INK.dim : INK.hot);
      p.setFont(9.8, 500, SANS);
      p.text(card.length > 24 ? `${card.slice(0, 23)}…` : card, x + 13, y + 14, active ? INK.white : INK.text);
      p.setFont(9, 400, SANS);
      p.text(`#${400 + c * 10 + i}`, x + 13, y + 27, INK.dim);
    });
  });
};

const chat: AppPainter = (p, t, seed, feed) => {
  const box = p.window("Команда — общий канал", ["# штаб", "# релиз", "AM7"], 0, `${feed.total || 300} в сети`);
  const shown = Math.floor(t * 0.35 + seed * 20) % CHAT_LINES.length;
  const rows = Math.floor((box.h - 30) / 30);
  p.setFont(10.5, 400, SANS);
  for (let r = 0; r < rows; r++) {
    const k = (shown - (rows - 1 - r) + CHAT_LINES.length * 4) % CHAT_LINES.length;
    const [who, msg] = CHAT_LINES[k];
    const y = box.y + 8 + r * 30;
    const lead = who === "AM7";
    p.fill(8, y, 18, 18, lead ? INK.hot : INK.dim);
    p.setFont(10, 700, SANS);
    p.text(who, 32, y + 10, lead ? INK.hot : INK.white);
    p.setFont(10.5, 400, SANS);
    p.text(msg, 32, y + 24, INK.text);
  }
  p.fill(8, box.y + box.h - 22, box.w - 16, 18, "#1d1d20");
  p.setFont(10, 400, SANS);
  p.text(Math.floor(t * 2) % 2 ? "Сообщение в # штаб…" : "Сообщение в # штаб… |", 14, box.y + box.h - 9, INK.dim);
};

const docs: AppPainter = (p, t, seed) => {
  const box = p.window(`${DOC_TITLE} — Документы`, ["Документ", "Комментарии"], 0, "Сохранено  •  4 соавтора");
  p.fill(40, box.y + 6, box.w - 80, box.h - 12, "#18181b");
  p.setFont(15, 700, SANS);
  p.text(DOC_TITLE, 56, box.y + 32, INK.white);
  p.setFont(10.8, 400, SANS);
  const chars = Math.floor((t * 14 + seed * 400) % 900);
  let left = chars;
  for (let i = 0; i < DOC_TEXT.length; i++) {
    const y = box.y + 54 + i * 15;
    if (y > box.y + box.h - 14) break;
    const line = DOC_TEXT[i];
    const part = line.slice(0, Math.max(0, Math.min(line.length, left)));
    left -= line.length + 1;
    p.text(part, 56, y, INK.text);
    if (left < 0 && part.length < line.length) {
      if (Math.floor(t * 2.2) % 2 === 0) p.fill(56 + p.ctx.measureText(part).width + 1, y - 10, 2, 13, INK.hot);
      break;
    }
  }
};

const network: AppPainter = (p, t, seed) => {
  const box = p.window("Топология сети", ["Граф", "Потоки"], 0, `${Math.round(18 + wave(t, seed) * 30)} Гбит/с`);
  const cx = box.w / 2;
  const cy = box.y + box.h / 2;
  const R = Math.min(box.w, box.h) * 0.38;
  const n = 10;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + seed;
    pts.push([cx + Math.cos(a) * R * 1.4, cy + Math.sin(a) * R]);
  }
  const c = p.ctx;
  c.lineWidth = 1;
  c.strokeStyle = INK.line;
  c.beginPath();
  for (let i = 0; i < n; i++) {
    c.moveTo(cx, cy);
    c.lineTo(pts[i][0], pts[i][1]);
    const j = (i + 3) % n;
    c.moveTo(pts[i][0], pts[i][1]);
    c.lineTo(pts[j][0], pts[j][1]);
  }
  c.stroke();
  for (let i = 0; i < n; i++) {
    const f = (t * (0.4 + hash2(i, 3) * 0.6) + hash2(i, 5)) % 1;
    p.fill(cx + (pts[i][0] - cx) * f - 2, cy + (pts[i][1] - cy) * f - 2, 4, 4, INK.white);
    p.fill(pts[i][0] - 5, pts[i][1] - 5, 10, 10, INK.mid);
    p.setFont(9);
    p.text(REGIONS[i % REGIONS.length], pts[i][0] + 8, pts[i][1] + 3, INK.dim);
  }
  p.fill(cx - 9, cy - 9, 18, 18, INK.hot);
  p.setFont(10, 700);
  p.text("HQ", cx, cy + 22, INK.white, "center");
};

const lock: AppPainter = (p, t, _seed, feed) => {
  p.clear("#0c0c0f");
  const { w, h } = p;
  const c = p.ctx;
  const g = c.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w * 0.6);
  g.addColorStop(0, "#2c2c2f");
  g.addColorStop(1, "#0c0c0f");
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  p.setFont(64, 200, SANS);
  p.text(clockText(feed.clock).slice(0, 5), w / 2, h / 2 + 8, INK.white, "center");
  p.setFont(12, 500, SANS);
  p.text(
    new Date(feed.clock).toLocaleDateString("ru-RU", { timeZone: hqTimeZone(), weekday: "long", day: "numeric", month: "long" }),
    w / 2,
    h / 2 + 34,
    INK.mid,
    "center",
  );
  p.setFont(10, 700, SANS);
  p.text("ШТАБ AM7  •  ЭКРАН ЗАБЛОКИРОВАН", w / 2, h - 22, INK.dim, "center");
  p.ring(w / 2, h / 2 - 60, 12, (t * 0.2) % 1, 2, INK.hot);
};

const alert: AppPainter = (p, t, seed, feed) => {
  p.clear("#0f0f12");
  const { w, h } = p;
  const flash = Math.floor(t * 2) % 2 === 0;
  p.fill(0, 0, w, 42, flash ? "#8a0a0a" : "#4a0506");
  p.setFont(16, 800, SANS);
  p.text("⚠  ОШИБКА ВЫПОЛНЕНИЯ ЗАДАЧИ", 14, 27, INK.white);
  p.setFont(10.5, 500, MONO);
  p.text(`task t-${Math.floor(hash2(Math.floor(seed * 1e4), 1) * 0xffffff).toString(16)}  •  ${clockText(feed.clock)}  •  retry 2/3`, 14, 60, INK.warn);
  const trace = [
    "Error: upstream timed out after 30000 ms",
    "    at HttpTool.call (tools/http.ts:88:13)",
    "    at async TaskRouter.run (router.ts:52:22)",
    "    at async Promise.all (index 3)",
    "    at async Planner.step (planner.ts:131:9)",
    "caused by: ECONNRESET 10.0.4.17:443",
    "",
    "→ retrying with backoff 4000 ms…",
    "→ notifying AM7",
  ];
  trace.forEach((line, i) => p.text(line, 14, 84 + i * 15, i === 0 ? INK.hot : i === 5 ? INK.warn : INK.text));
  p.chart(series(40, t * 2, seed + 3).map((v) => v * 0.9), 14, h - 70, w - 28, 54, INK.hot);
};

const worldops: AppPainter = (p, t, seed, feed) => {
  const box = p.window("Операции по регионам", ["Карта", "Список"], 0, `${feed.working || 0} задач в работе`);
  REGIONS.forEach((region, i) => {
    const y = box.y + 16 + i * ((box.h - 20) / REGIONS.length);
    p.setFont(10.5, 600);
    p.text(region, 10, y + 4, INK.white);
    const v = wave(t * 0.35, seed + i * 3);
    p.meter(96, y - 5, box.w - 180, 9, v, i % 3 === 0 ? INK.hot : INK.mid);
    p.setFont(10.5);
    p.text(`${Math.round(v * 480)} rps`, box.w - 10, y + 4, INK.text, "right");
  });
};

/** Every monitor app, in atlas layer order (HQ_SCREEN_APPS). */
export const APP_PAINTERS: Record<string, AppPainter> = {
  code_ts: editor(CODE_TS, "router.ts", "TypeScript"),
  code_py: editor(CODE_PY, "anomalies.py", "Python"),
  term_build: terminal(TERM_BUILD, "root@kali: ~/agent-core", "~/agent-core"),
  term_ops: terminal(TERM_OPS, "root@kali: ~/infra", "~/infra"),
  logs,
  metrics,
  sql,
  notebook,
  research,
  papers,
  design,
  cluster,
  tests: terminal(TERM_TESTS, "root@kali: ~/e2e", "~/e2e"),
  kanban,
  chat,
  docs,
  network,
  worldops,
  alert,
  lock,
};
