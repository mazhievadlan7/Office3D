import { EMPTY_FEED, Painter, type HqScreenFeed } from "./screenPaint";
import { SCREEN_SURFACES } from "./screenSurfaces";

/**
 * Paints the HQ's screens off the main thread. Every surface of
 * SCREEN_SURFACES is repainted on its own period into an OffscreenCanvas and
 * handed over as an ImageBitmap (transferred, not copied); the main thread
 * uploads it straight into its texture and acks, and the surface is not
 * painted again until then, so a busy or hidden page never piles frames up.
 *
 * Messages in:  { type: "feed", feed } | { type: "slowdown", value } | { type: "ack", index }
 * Messages out: { index, bitmap }
 */

type Incoming =
  | { type: "feed"; feed: HqScreenFeed }
  | { type: "slowdown"; value: number }
  | { type: "ack"; index: number };

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
// Stagger the first paints so the first frames do not all land at once.
for (let i = 0; i < count; i++) next[i] = (i % 8) * 0.05;
let feed: HqScreenFeed = EMPTY_FEED;
let slowdown = 1;
let cursor = 0;
const start = performance.now();
/** At most this long painting per tick, so acks and feed updates are never kept waiting. */
const TICK_BUDGET_MS = 12;

function tick(): void {
  const now = (performance.now() - start) / 1000;
  const until = performance.now() + TICK_BUDGET_MS;
  for (let k = 0; k < count && performance.now() < until; k++) {
    const i = (cursor + k) % count;
    if (inFlight[i] || now < next[i]) continue;
    const surface = SCREEN_SURFACES[i];
    next[i] = now + surface.period * slowdown;
    const painter = painterFor(surface.w, surface.h);
    surface.paint(painter, now, feed);
    const bitmap = (painter.ctx.canvas as OffscreenCanvas).transferToImageBitmap();
    inFlight[i] = 1;
    scope.postMessage({ index: i, bitmap }, [bitmap]);
  }
  cursor = (cursor + 1) % count;
}

scope.onmessage = (event: MessageEvent<Incoming>) => {
  const message = event.data;
  if (message.type === "ack") inFlight[message.index] = 0;
  else if (message.type === "feed") feed = message.feed;
  else if (message.type === "slowdown") slowdown = message.value;
};

setInterval(tick, 16);
