import { APP_LAYER, type HqScreenApp } from "@/features/hq/render/screens/screenApps";
import { mapLeftCards, mapRightCards, type PanelRect } from "@/features/hq/render/screens/screenPanels";
import { BANNER_H, BANNER_W, MAP_H, MAP_W, MONITOR_ATLAS, tileOrigin } from "@/features/hq/render/screens/screenSurfaces";
import type { MapFit } from "./mapProjection";

/**
 * The video wall's wings: the glass either side of the map, tiled like a
 * control room's wall of dashboards. Each wing has a title row (its canvas's
 * title at the outer end) over two rows of panels. The panels are the side
 * canvases' cards (map/left: the floor's activity, events and operations;
 * map/right: world time, the Earth, traffic) one by one, interleaved with the
 * monitor apps that read as wall dashboards (metrics, topology, regions,
 * cluster, logs), so neighbours never repeat and no picture is stretched.
 * Everything here is already painted by the screen hub: the wings cost no
 * extra canvas, only UV rects. Pure (no three.js).
 */

/** The texture a tile samples: the side canvases, the monitor atlas, or the briefing's banner. */
export type MapWingSource = "left" | "right" | "apps" | "banner";

/** One picture on a wing: where it sits on the glass and which part of which texture it shows. */
export type MapWingTile = {
  name: string;
  source: MapWingSource;
  /** Display-local metres, x0 < x1 and y0 < y1. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Texture rect: u left to right, v = 0 at the picture's top row (u0 < u1, v0 < v1). */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
};

export type MapWingLayout = {
  tiles: MapWingTile[];
  /** |x| where each wing begins (beside the map) and ends (at the frame). */
  inner: number;
  outer: number;
  /** y of the hairline under the wings' title row. */
  ruleY: number;
};

type Block = { name: string; source: MapWingSource; rect: PanelRect; texW: number; texH: number };

/** Pixels kept round a card so its rounded border shows whole (cards stand 18+ px apart). */
const CARD_PAD = 6;
/** Pixels trimmed inside a monitor atlas tile, clear of its dark gutter. */
const APP_INSET = 1;
const ROWS = 2;
/** Width over height the panel slots aim for: between the cards (~1.4) and the apps (1.6). */
const SLOT_ASPECT = 1.45;

function card(name: string, source: "left" | "right", rect: PanelRect, pad = CARD_PAD): Block {
  const x = Math.max(0, rect.x - pad);
  const y = Math.max(0, rect.y - pad);
  const w = Math.min(MAP_W, rect.x + rect.w + pad) - x;
  const h = Math.min(MAP_H, rect.y + rect.h + pad) - y;
  return { name, source, rect: { x, y, w, h }, texW: MAP_W, texH: MAP_H };
}

function app(name: HqScreenApp): Block {
  const { x, y } = tileOrigin(MONITOR_ATLAS, APP_LAYER[name]);
  return {
    name,
    source: "apps",
    rect: { x: x + APP_INSET, y: y + APP_INSET, w: MONITOR_ATLAS.tileW - 2 * APP_INSET, h: MONITOR_ATLAS.tileH - 2 * APP_INSET },
    texW: MONITOR_ATLAS.width,
    texH: MONITOR_ATLAS.height,
  };
}

const LEFT = mapLeftCards(MAP_W, MAP_H);
const RIGHT = mapRightCards(MAP_W, MAP_H);

/** The panels, in the order slots take them: the two canvases' cards alternate with the apps. */
export const MAP_WING_BLOCKS: readonly Block[] = [
  card("activity", "left", LEFT.kpi),
  app("metrics"),
  card("clocks", "right", RIGHT.clocks),
  app("network"),
  card("events", "left", LEFT.feed),
  app("worldops"),
  card("earth", "right", RIGHT.earth),
  app("cluster"),
  card("operations", "left", LEFT.teams),
  app("logs"),
  card("traffic", "right", RIGHT.traffic),
];

/** Each wing's title: the left canvas's on the west wing, the right one's on the east. */
const TITLES: readonly [Block, Block] = [card("title-left", "left", LEFT.title, 0), card("title-right", "right", RIGHT.title, 0)];

function aspectOf(block: Block): number {
  return block.rect.w / block.rect.h;
}

function tile(block: Block, x0: number, y0: number, x1: number, y1: number): MapWingTile {
  const { rect, texW, texH } = block;
  return {
    name: block.name,
    source: block.source,
    x0,
    y0,
    x1,
    y1,
    u0: rect.x / texW,
    v0: rect.y / texH,
    u1: (rect.x + rect.w) / texW,
    v1: (rect.y + rect.h) / texH,
  };
}

/** The block as large as the slot allows at its own aspect, centred in it. */
function contain(block: Block, x0: number, y0: number, w: number, h: number): MapWingTile {
  const aspect = aspectOf(block);
  const tw = Math.min(w, h * aspect);
  const th = tw / aspect;
  const tx = x0 + (w - tw) / 2;
  const ty = y0 + (h - th) / 2;
  return tile(block, tx, ty, tx + tw, ty + th);
}

/** Where the wings are: |x| from beside the map to the glowing frame, over the map's height; null without room. */
function wingSpan(fit: MapFit): { inner: number; outer: number } | null {
  const margin = fit.frameInset * 1.6;
  const inner = fit.mapX1 + margin;
  const outer = fit.panelW / 2 - fit.frameInset - margin;
  if (outer - inner < 1.2 || fit.mapY1 - fit.mapY0 < 0.8) return null;
  return { inner, outer };
}

/**
 * The tiles of both wings, west wing first, or null when the display is too
 * narrow to have wings (the glass then draws its own glyph panels there).
 * The wings span the map's height, from beside it to the glowing frame.
 */
export function mapWings(fit: MapFit): MapWingLayout | null {
  const span = wingSpan(fit);
  if (!span) return null;
  const { inner, outer } = span;
  const width = outer - inner;
  const top = fit.mapY1;
  const height = fit.mapY1 - fit.mapY0;

  const gap = clamp(height * 0.024, 0.03, 0.14);
  const titleH = clamp(height * 0.1, 0.1, 0.55);
  const slotH = (height - titleH - gap * ROWS) / ROWS;
  const cols = Math.max(1, Math.round((width + gap) / (slotH * SLOT_ASPECT + gap)));
  const slotW = (width - gap * (cols - 1)) / cols;
  // Slots take consecutive blocks, row after row across both wings; a row as
  // long as the list would put a block right above itself, so skip one then.
  const count = MAP_WING_BLOCKS.length;
  const stride = cols % count === 0 ? cols + 1 : cols;

  const tiles: MapWingTile[] = [];
  for (let wing = 0; wing < 2; wing++) {
    const west = wing === 0;
    const left = west ? -outer : inner;
    // The title at the wing's outer end: left-aligned text in the west, right-aligned in the east.
    const title = TITLES[wing];
    const titleW = Math.min(width, titleH * aspectOf(title));
    const titleX = west ? -outer : outer - titleW;
    tiles.push(tile(title, titleX, top - (titleW / aspectOf(title)), titleX + titleW, top));
    for (let row = 0; row < ROWS; row++) {
      const y1 = top - titleH - gap - row * (slotH + gap);
      for (let col = 0; col < cols; col++) {
        const block = MAP_WING_BLOCKS[((wing * ROWS + row) * stride + col) % count];
        tiles.push(contain(block, left + col * (slotW + gap), y1 - slotH, slotW, slotH));
      }
    }
  }
  return { tiles, inner, outer, ruleY: top - titleH - gap / 2 };
}

/** A whole texture as a block. */
function whole(name: string, source: MapWingSource, texW: number, texH: number): Block {
  return { name, source, rect: { x: 0, y: 0, w: texW, h: texH }, texW, texH };
}

/** At most this share of the map's height goes under the briefing's banner. */
const BANNER_MAX_SHARE = 0.2;

/**
 * The video wall during a briefing (HqScreenHub.setBriefing): each side
 * canvas whole on its wing, the task («ЗАДАЧА», map/left) in the west and the
 * plan («ПЛАН», map/right) in the east, as large as the wing allows and level
 * with the map's top; and the goal's banner across the top of the map, the
 * map's full width at the banner's own aspect. Null when there are no wings.
 */
export function mapBriefing(fit: MapFit): MapWingTile[] | null {
  const span = wingSpan(fit);
  if (!span) return null;
  const { inner, outer } = span;
  const width = outer - inner;
  const height = fit.mapY1 - fit.mapY0;
  const wing = (block: Block, x0: number): MapWingTile => {
    const t = contain(block, x0, fit.mapY0, width, height);
    // Level with the map's top (and the banner) rather than centred.
    const lift = fit.mapY1 - t.y1;
    return { ...t, y0: t.y0 + lift, y1: t.y1 + lift };
  };
  const mapW = fit.mapX1 - fit.mapX0;
  const bannerH = Math.min(height * BANNER_MAX_SHARE, (mapW * BANNER_H) / BANNER_W);
  const bannerW = (bannerH * BANNER_W) / BANNER_H;
  const mid = (fit.mapX0 + fit.mapX1) / 2;
  return [
    wing(whole("task", "left", MAP_W, MAP_H), -outer),
    wing(whole("plan", "right", MAP_W, MAP_H), inner),
    tile(whole("goal", "banner", BANNER_W, BANNER_H), mid - bannerW / 2, fit.mapY1 - bannerH, mid + bannerW / 2, fit.mapY1),
  ];
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
