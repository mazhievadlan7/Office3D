import { loadEarth } from "./screenGlobe";
import { EMPTY_FEED, Painter, type HqScreenFeed } from "./screenPaint";
import { SCREEN_SURFACES, surfacePeriod } from "./screenSurfaces";
import { setHqTimeZone } from "@/features/hq/core/hqTime";

/**
 * Paints the HQ's screens off the main thread. Every surface of
 * SCREEN_SURFACES is repainted on its own period into an OffscreenCanvas and
 * handed over as an ImageBitmap (transferred, not copied); the main thread
 * uploads it straight into its texture and acks, and the surface is not
 * painted again until then, so a busy or hidden page never piles frames up.
 * The big screens repaint at their full rate only while one of them is in
 * view ("views"); the NASA Earth images for the globes load here, once. A
 * new briefing in the feed repaints the surfaces that show it at once, and
 * every picture says which briefing it shows, so the wall switches its
 * layout only once the pictures are there.
 *
 * Messages in:  { type: "feed", feed } | { type: "slowdown", value } | { type: "ack", index }
 *               | { type: "views", value: number[] (1 = in view, per surface) }
 * Messages out: { index, bitmap, briefing (the briefing's id painted, 0 for none) }
 */

type Incoming =
  | { type: "feed"; feed: HqScreenFeed }
  | { type: "slowdown"; value: number }
  | { type: "ack"; index: number }
  | { type: "views"; value: number[] };

// The project compiles against the DOM lib; the worker needs only these two.
type WorkerScope = {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<Incoming>) => void) | null;
};
const scope = self as unknown as WorkerScope;

// One canvas per size: every paint clears it, and transferToImageBitmap
// leaves it blank for the next surface.
const canvases = new Map<string, Painter>();
function painterFor(w: number, h: number): Painter {
  const key = `${w}x${h}`;
  let painter = canvases.get(key);
  if (!painter) {
    const ctx = new OffscreenCanvas(w, h).getContext("2d", { alpha: false });
    if (!ctx) throw new Error("HQ screens: no 2D context in the worker");
    painter = new Painter(ctx, w, h);
    canvases.set(key, painter);
  }
  return painter;
}

const count = SCREEN_SURFACES.length;
const next = new Float64Array(count);
const inFlight = new Uint8Array(count);
const inView = new Uint8Array(count).fill(1);
// Stagger the first paints so the first frames do not all land at once.
for (let i = 0; i < count; i++) next[i] = (i % 8) * 0.05;
// A copy of its own: the clock is set on it before every paint.
let feed: HqScreenFeed = { ...EMPTY_FEED };
let slowdown = 1;
let cursor = 0;
const start = performance.now();
/** At most this long painting per tick, so acks and feed updates are never kept waiting. */
const TICK_BUDGET_MS = 12;

// The globes are procedural until (and unless) the images arrive.
void loadEarth();

function now(): number {
  return (performance.now() - start) / 1000;
}

function tick(): void {
  const t = now();
  const until = performance.now() + TICK_BUDGET_MS;
  for (let k = 0; k < count && performance.now() < until; k++) {
    const i = (cursor + k) % count;
    if (inFlight[i] || t < next[i]) continue;
    const surface = SCREEN_SURFACES[i];
    next[i] = t + surfacePeriod(surface, inView[i] === 1) * slowdown;
    if (surface.when && !surface.when(feed)) continue;
    const painter = painterFor(surface.w, surface.h);
    // The feed comes about once a second, stamped at a frame's time; the
    // on-screen clocks read the wall clock now, so their seconds never lag,
    // skip or repeat (and are right before the first feed).
    feed.clock = Date.now();
    surface.paint(painter, t, feed);
    const bitmap = (painter.ctx.canvas as OffscreenCanvas).transferToImageBitmap();
    inFlight[i] = 1;
    scope.postMessage({ index: i, bitmap, briefing: feed.briefing?.id ?? 0 }, [bitmap]);
  }
  cursor = (cursor + 1) % count;
}

scope.onmessage = (event: MessageEvent<Incoming>) => {
  const message = event.data;
  if (message.type === "ack") inFlight[message.index] = 0;
  else if (message.type === "feed") {
    const briefing = feed.briefing?.id ?? 0;
    feed = message.feed;
    // A briefing on or off (or a new one): the wall shows it at once.
    if ((feed.briefing?.id ?? 0) !== briefing) {
      const t = now();
      for (let i = 0; i < count; i++) if (SCREEN_SURFACES[i].briefing) next[i] = Math.min(next[i], t);
    }
    // The worker has its own copy of the HQ's time module: keep its zone in step.
    setHqTimeZone(feed.timeZone);
  }
  else if (message.type === "slowdown") slowdown = message.value;
  else if (message.type === "views") {
    const t = now();
    for (let i = 0; i < count; i++) {
      const seen = message.value[i] ? 1 : 0;
      // Coming into view: repaint at once rather than at the end of an idle wait.
      if (seen && !inView[i]) next[i] = Math.min(next[i], t);
      inView[i] = seen;
    }
  }
};

setInterval(tick, 16);
