import type { HqBriefingFocus, HqBriefingHold } from "@/features/hq/core/briefingScript";
import { briefingText, planSteps, type PlanSteps } from "@/features/hq/core/operation";
import { plural, type PluralForms } from "@/lib/i18n/plural";
import { liveBug } from "./screenBroadcast";
import { DISPLAY, TV, fillRound, fit, glassCard, label, linear, liveDot, radial, spaced, vignette } from "./screenKit";
import { backdrop } from "./screenPanels";
import type { HqBriefingText, HqScreenBriefing, Painter } from "./screenPaint";

// planSteps and briefingText now live in core/operation.ts (the wall's text
// parsing has one home there); re-exported so importers, and hqMap.test, keep
// working through this module.
export { briefingText, planSteps, type PlanSteps };

/**
 * AM7's briefing on the video wall (HqScreenHub.setBriefing): the task on the
 * west wing («ЗАДАЧА»), the plan on the east wing («ПЛАН», numbered when it is
 * written as a list), and the goal on a banner across the top of the map
 * («ЦЕЛЬ», with the «БРИФИНГ · AM7» live tag). Painted into the side panels'
 * canvases (and the banner's) in their broadcast look, red and white on
 * black; every text is set as large as its box allows, so it reads from the
 * rows. The text layout below is pure, so it is tested without a canvas.
 */

// --- text layout (pure) -------------------------------------------------------------------------

/** Width of a string at the current font, in pixels. */
export type Measure = (text: string) => number;

/**
 * The briefing to paint for `input`: its text cleaned up, and the current
 * briefing itself (same id) when nothing changed, so repeated calls cost no
 * repaint. A change of text takes `id`.
 */
export function nextBriefing(current: HqScreenBriefing | null, input: HqBriefingText | null, id: number): HqScreenBriefing | null {
  if (!input) return null;
  const task = briefingText(input.task ?? "");
  const goal = briefingText(input.goal ?? "").replace(/\n/g, " ");
  const plan = briefingText(input.plan ?? "");
  const focus = input.focus ?? null;
  const hold = input.hold ?? null;
  if (
    current &&
    current.task === task &&
    current.goal === goal &&
    current.plan === plan &&
    sameFocus(current.focus ?? null, focus) &&
    sameHold(current.hold ?? null, hold)
  ) {
    return current;
  }
  const next: HqScreenBriefing = { id, task, goal, plan };
  if (focus) next.focus = { ...focus };
  if (hold) next.hold = { ...hold };
  return next;
}

function sameFocus(a: HqBriefingFocus | null, b: HqBriefingFocus | null): boolean {
  if (!a || !b) return a === b;
  return a.section === b.section && a.step === b.step && a.steps === b.steps && a.label === b.label && a.title === b.title;
}

function sameHold(a: HqBriefingHold | null, b: HqBriefingHold | null): boolean {
  if (!a || !b) return a === b;
  return a.gathered === b.gathered && a.expected === b.expected;
}

/** How many characters from the start of `text` fit in `width` (at least one). */
function longestFit(text: string, width: number, measure: Measure): number {
  let lo = 1;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(text.slice(0, mid)) <= width) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The lines of `text` at most `width` wide: a line break starts a new line,
 * words wrap, and a word longer than a whole line is broken where it must be.
 */
export function wrapLines(text: string, width: number, measure: Measure): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/[ \t ]+/)) {
      if (!word) continue;
      const joined = line ? `${line} ${word}` : word;
      if (measure(joined) <= width) {
        line = joined;
        continue;
      }
      if (line) lines.push(line);
      line = word;
      while (line.length > 1 && measure(line) > width) {
        const cut = longestFit(line, width, measure);
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** `line` shortened to fit `width` with an ellipsis after it. */
export function ellipsize(line: string, width: number, measure: Measure): string {
  const withDots = `${line.replace(/[\s.,;:…]+$/, "")}…`;
  if (measure(withDots) <= width) return withDots;
  return `${line.slice(0, longestFit(line, Math.max(1, width - measure("…")), measure)).trimEnd()}…`;
}

export type FitOptions = {
  /** Largest and smallest font size tried, px. */
  max: number;
  min: number;
  /** Line pitch, as a multiple of the font size. */
  leading: number;
  /** Space between blocks, as a multiple of the font size. */
  gap?: number;
};

export type Fitted = {
  size: number;
  /** Each block's lines. */
  blocks: string[][];
  /** True when even the smallest size could not show it all (the last line kept ends in an ellipsis). */
  clipped: boolean;
};

/** Height of wrapped blocks at a font size. */
export function blocksHeight(blocks: readonly (readonly string[])[], size: number, options: FitOptions): number {
  let lines = 0;
  for (const block of blocks) lines += block.length;
  return lines * size * options.leading + Math.max(0, blocks.length - 1) * (options.gap ?? 0) * size;
}

/**
 * The largest font size, from `max` down to `min`, at which every block wraps
 * into `width` (or `width(size)`) and all of them stack into `height`. At
 * `min` whatever still overflows is cut: the lines that fit are kept, the last
 * one ends in an ellipsis. `measureAt(size)` measures at that size.
 */
export function fitBlocks(
  blocks: readonly string[],
  width: number | ((size: number) => number),
  height: number,
  measureAt: (size: number) => Measure,
  options: FitOptions,
): Fitted {
  const widthAt = typeof width === "number" ? () => width : width;
  const wrapAt = (size: number) => {
    const measure = measureAt(size);
    return { measure, lines: blocks.map((block) => wrapLines(block, widthAt(size), measure)) };
  };
  // Each step about 6% smaller, so the fit costs a couple of dozen passes at most.
  for (let size = options.max; size > options.min; size = Math.max(options.min, Math.floor(size * 0.94))) {
    const { lines } = wrapAt(size);
    if (blocksHeight(lines, size, options) <= height) return { size, blocks: lines, clipped: false };
  }
  const size = options.min;
  const { measure, lines } = wrapAt(size);
  if (blocksHeight(lines, size, options) <= height) return { size, blocks: lines, clipped: false };
  const pitch = size * options.leading;
  const kept: string[][] = [];
  let used = 0;
  for (const block of lines) {
    const lead = kept.length > 0 ? (options.gap ?? 0) * size : 0;
    const room = Math.floor((height - used - lead) / pitch + 1e-6);
    if (room <= 0) break;
    const take = block.slice(0, room);
    kept.push(take);
    used += lead + take.length * pitch;
    if (take.length < block.length) break;
  }
  const last = kept[kept.length - 1];
  if (last && last.length > 0) last[last.length - 1] = ellipsize(last[last.length - 1], widthAt(size), measure);
  return { size, blocks: kept, clipped: true };
}


// --- painting --------------------------------------------------------------------------------

const STEPS: PluralForms = ["шаг", "шага", "шагов"];
/** The cards start under the header, as on the side panels (screenPanels.ts). */
const CARD_TOP = 118;
const CARD_BOTTOM = 20;
export const BODY_WEIGHT = 600;
export const RED_GRADIENT: ReadonlyArray<readonly [number, string]> = [
  [0, "#ff2d2d"],
  [1, "#b00b12"],
];

// Fits are the costly part and the text rarely changes: keep the last few.
const fits = new Map<string, Fitted>();

export function fitText(p: Painter, key: string, blocks: readonly string[], width: number | ((size: number) => number), widthKey: number, height: number, options: FitOptions): Fitted {
  const id = `${key}|${p.w}x${p.h}|${widthKey.toFixed(1)}x${height.toFixed(1)}|${options.max}-${options.min}|${blocks.join("\u0001")}`;
  let fitted = fits.get(id);
  if (!fitted) {
    fitted = fitBlocks(
      blocks,
      width,
      height,
      (size) => {
        p.setFont(size, BODY_WEIGHT, DISPLAY);
        return (text) => p.ctx.measureText(text).width;
      },
      options,
    );
    if (fits.size >= 48) fits.clear();
    fits.set(id, fitted);
  }
  return fitted;
}

/** Baseline of line `i` of a block whose top is `top`. */
export function baseline(top: number, size: number, leading: number, i: number): number {
  return top + size * (0.8 + (leading - 1) / 2) + i * size * leading;
}

/** A section's name on a red tag, the channels' logo block (screenBroadcast.ts); returns its width. */
export function sectionTag(p: Painter, x: number, y: number, text: string, align: "left" | "right"): number {
  const c = p.ctx;
  const h = 64;
  const spacing = 4;
  p.setFont(40, 700, DISPLAY);
  const w = c.measureText(text).width + spacing * text.length + 52;
  const x0 = align === "right" ? x - w : x;
  fillRound(c, x0, y, w, h, 6, linear(c, 0, y, 0, y + h, RED_GRADIENT));
  c.fillStyle = "rgba(255, 255, 255, 0.22)";
  c.fillRect(x0 + 4, y + 1, w - 8, 1);
  spaced(p, text, x0 + 26, y + h * 0.73, TV.white, spacing);
  return w;
}

/** The header's red rule, fading away from the tag's side. */
export function headerRule(p: Painter, fromRight: boolean): void {
  const c = p.ctx;
  const stops: ReadonlyArray<readonly [number, string]> = fromRight
    ? [
        [0, "rgba(227, 20, 28, 0)"],
        [1, "rgba(227, 20, 28, 0.75)"],
      ]
    : [
        [0, "rgba(227, 20, 28, 0.75)"],
        [1, "rgba(227, 20, 28, 0)"],
      ];
  c.fillStyle = linear(c, 40, 0, p.w - 40, 0, stops);
  c.fillRect(40, 104, p.w - 80, 2);
}

/** The panel's card, and the box its text goes in. */
export function bodyCard(p: Painter): { x: number; y: number; w: number; h: number } {
  const ch = p.h - CARD_TOP - CARD_BOTTOM;
  glassCard(p, 40, CARD_TOP, p.w - 80, ch, { accent: true, radius: 10 });
  return { x: 40 + 46, y: CARD_TOP + 26, w: p.w - 80 - 92, h: ch - 52 };
}

/** Lines of one fitted paragraph, centred in the box's height. */
export function drawParagraph(p: Painter, fitted: Fitted, box: { x: number; y: number; w: number; h: number }, leading: number, color: string): void {
  const lines = fitted.blocks.flat();
  const top = box.y + (box.h - lines.length * fitted.size * leading) / 2;
  p.setFont(fitted.size, BODY_WEIGHT, DISPLAY);
  lines.forEach((line, i) => p.text(line, box.x, baseline(top, fitted.size, leading, i), color));
}

/** A quiet placeholder while AM7 is still working a part out: a live dot and the words. */
export function drawWaiting(p: Painter, t: number, box: { x: number; y: number; w: number; h: number }, text: string): void {
  const y = box.y + box.h / 2;
  liveDot(p.ctx, box.x + 14, y - 14, 9, t);
  p.setFont(48, BODY_WEIGHT, DISPLAY);
  p.text(`${text}${".".repeat(1 + (Math.floor(t * 2) % 3))}`, box.x + 44, y, TV.white45);
}

export const TASK_FIT: FitOptions = { max: 78, min: 30, leading: 1.18 };

/** The west wing during a briefing: «ЗАДАЧА» and the task, as large as it fits. */
export function paintBriefingTask(p: Painter, t: number, briefing: HqScreenBriefing): void {
  backdrop(p, 300, 0, 900);
  const tagW = sectionTag(p, 40, 26, "ЗАДАЧА", "left");
  const focus = briefing.focus;
  const onStep = focus && focus.section === "step" && focus.step >= 0 && focus.title;
  if (onStep && briefing.task) {
    // AM7 is on a step: the task shrinks into the header, the step fills the card.
    p.setFont(28, 500, DISPLAY);
    p.text(fit(p.ctx, briefing.task, p.w - 80 - tagW - 60), 40 + tagW + 24, 72, TV.white65);
  } else {
    label(p, "для всего штаба · бриф AM7", 40 + tagW + 24, 66, TV.white45, 15);
  }
  headerRule(p, false);
  const box = bodyCard(p);
  if (onStep) paintStepFocus(p, t, focus, box);
  else if (!briefing.task) drawWaiting(p, t, box, "Задача формулируется");
  else drawParagraph(p, fitText(p, "task", [briefing.task], box.w, box.w, box.h, TASK_FIT), box, TASK_FIT.leading, TV.white);
  vignette(p, 0.2);
}

/** A slow 0..1 breath (0.6 Hz), in eighths so the gradient cache stays small. */
function breath(t: number): number {
  return Math.round((0.5 + 0.5 * Math.sin(t * Math.PI * 1.2)) * 8) / 8;
}

const FOCUS_FIT: FitOptions = { max: 96, min: 40, leading: 1.1 };

/**
 * The step AM7 is talking about, on the task screen: its number huge in red
 * (a slow glow while he speaks), «ШАГ N ИЗ M» over its title, as large as it fits.
 */
function paintStepFocus(p: Painter, t: number, focus: HqBriefingFocus, box: { x: number; y: number; w: number; h: number }): void {
  const c = p.ctx;
  const number = String(focus.step + 1).padStart(2, "0");
  const numSize = Math.min(box.h * 0.82, 300);
  p.setFont(numSize, 700, DISPLAY);
  const numW = c.measureText(number).width;
  const glow = breath(t);
  const cy = box.y + box.h / 2;
  c.fillStyle = radial(c, box.x + numW / 2, cy, 0, numW, [
    [0, `rgba(255, 30, 30, ${(0.16 + 0.14 * glow).toFixed(3)})`],
    [1, "rgba(0, 0, 0, 0)"],
  ]);
  c.fillRect(box.x - 40, box.y, numW + 80, box.h);
  c.fillStyle = linear(c, 0, cy - numSize * 0.4, 0, cy + numSize * 0.4, RED_GRADIENT);
  c.fillText(number, box.x, cy + numSize * 0.36);
  const x = box.x + numW + 48;
  const w = box.x + box.w - x;
  const caption = focus.steps > 0 ? `шаг ${focus.step + 1} из ${focus.steps}` : `шаг ${focus.step + 1}`;
  label(p, caption, x, box.y + 44, TV.redSoft, 22);
  const textBox = { x, y: box.y + 64, w, h: box.h - 64 };
  drawParagraph(p, fitText(p, "focus", [focus.title], textBox.w, textBox.w, textBox.h, FOCUS_FIT), textBox, FOCUS_FIT.leading, TV.white);
}

const PLAN_FIT: FitOptions = { max: 64, min: 24, leading: 1.16, gap: 0.5 };
/** A step's number badge and the space after it, per px of font size. */
const BADGE = 1.22;
const BADGE_GAP = 0.55;
const COLUMN_GAP = 56;

/** The east wing during a briefing: «ПЛАН», its steps numbered when it is a list. */
export function paintBriefingPlan(p: Painter, t: number, briefing: HqScreenBriefing): void {
  const c = p.ctx;
  const { w } = p;
  backdrop(p, w - 300, 0, 900);
  const tagW = sectionTag(p, w - 40, 26, "ПЛАН", "right");
  const list = briefing.plan ? planSteps(briefing.plan) : null;
  const note = list ? `${list.steps.length} ${plural(list.steps.length, STEPS)}` : briefing.plan ? "порядок действий" : "бриф AM7";
  const noteW = label(p, note, w - 40 - tagW - 24, 66, TV.white45, 15, "right");
  if (list?.intro) {
    // The plan's own lead-in, on the header's free side.
    p.setFont(28, 500, DISPLAY);
    p.text(fit(c, list.intro, w - 80 - tagW - noteW - 90), 40, 72, TV.white65);
  }
  headerRule(p, true);
  const box = bodyCard(p);
  if (!briefing.plan) {
    drawWaiting(p, t, box, "AM7 составляет план");
  } else if (!list) {
    drawParagraph(p, fitText(p, "plan", [briefing.plan], box.w, box.w, box.h, TASK_FIT), box, TASK_FIT.leading, TV.white);
  } else {
    const focus = briefing.focus;
    drawSteps(p, t, list.steps, box, focus && focus.section === "step" ? focus.step : -1);
  }
  vignette(p, 0.2);
}

/**
 * Numbered steps in one column, or two when there are more than four, all at
 * one size. The step AM7 is talking about (`focus`, -1: none) is lit: a red
 * band behind it that breathes, its badge glowing; the others dim.
 */
function drawSteps(p: Painter, t: number, steps: readonly string[], box: { x: number; y: number; w: number; h: number }, focus: number): void {
  const c = p.ctx;
  const columns = steps.length > 4 ? 2 : 1;
  const colW = (box.w - COLUMN_GAP * (columns - 1)) / columns;
  const perColumn = Math.ceil(steps.length / columns);
  const parts = Array.from({ length: columns }, (_, k) => steps.slice(k * perColumn, (k + 1) * perColumn));
  const textW = (size: number) => colW - size * (BADGE + BADGE_GAP);
  // One size for every column: the smallest of their own best fits.
  let size = PLAN_FIT.max;
  for (const [k, part] of parts.entries()) size = Math.min(size, fitText(p, `steps${k}`, part, textW, colW, box.h, PLAN_FIT).size);
  const fitted = parts.map((part, k) => fitText(p, `steps${k}`, part, textW, colW, box.h, { ...PLAN_FIT, max: size }));
  const tallest = Math.max(...fitted.map((f) => blocksHeight(f.blocks, f.size, PLAN_FIT)));
  const pitch = size * PLAN_FIT.leading;
  let number = 1;
  fitted.forEach((column, k) => {
    const x = box.x + k * (colW + COLUMN_GAP);
    let top = box.y + (box.h - tallest) / 2;
    for (const lines of column.blocks) {
      const badge = column.size * BADGE;
      const by = top + (pitch - badge) / 2;
      const lit = focus === number - 1;
      const dim = focus >= 0 && !lit;
      if (lit) {
        // A band behind the step, breathing slowly, and a glow round its badge.
        const k = breath(t);
        const bandH = lines.length * pitch + column.size * 0.3;
        c.fillStyle = `rgba(227, 20, 28, ${(0.14 + 0.12 * k).toFixed(3)})`;
        fillRound(c, x - column.size * 0.3, top - column.size * 0.15, colW + column.size * 0.6, bandH, 10, c.fillStyle);
        c.fillStyle = `rgba(255, 60, 52, ${(0.55 + 0.35 * k).toFixed(3)})`;
        c.fillRect(x - column.size * 0.3, top - column.size * 0.15, 5, bandH);
        c.fillStyle = radial(c, x + badge / 2, by + badge / 2, 0, badge * 1.4, [
          [0, `rgba(255, 40, 40, ${(0.35 + 0.25 * k).toFixed(3)})`],
          [1, "rgba(0, 0, 0, 0)"],
        ]);
        c.fillRect(x - badge, by - badge, badge * 3, badge * 3);
      }
      c.globalAlpha = dim ? 0.45 : 1;
      fillRound(c, x, by, badge, badge, badge * 0.18, linear(c, 0, by, 0, by + badge, RED_GRADIENT));
      p.setFont(column.size * 0.74, 700, DISPLAY);
      p.text(String(number), x + badge / 2, by + badge * 0.76, TV.white, "center");
      c.globalAlpha = 1;
      p.setFont(column.size, BODY_WEIGHT, DISPLAY);
      const color = dim ? TV.white45 : TV.white;
      lines.forEach((line, i) => p.text(line, x + column.size * (BADGE + BADGE_GAP), baseline(top, column.size, PLAN_FIT.leading, i), color));
      top += lines.length * pitch + (PLAN_FIT.gap ?? 0) * column.size;
      number++;
    }
  });
}

const GOAL_FIT: FitOptions = { max: 54, min: 26, leading: 1.08 };

/**
 * The banner across the top of the map during a briefing: the «БРИФИНГ · AM7»
 * live tag, «ЦЕЛЬ» and the goal on one line (two when it must).
 */
export function paintBriefingBanner(p: Painter, t: number, briefing: HqScreenBriefing): void {
  const c = p.ctx;
  const { w, h } = p;
  c.fillStyle = linear(c, 0, 0, 0, h, [
    [0, "#100506"],
    [1, "#050203"],
  ]);
  c.fillRect(0, 0, w, h);
  c.fillStyle = radial(c, 0, h / 2, 0, w * 0.3, [
    [0, "rgba(150, 12, 18, 0.34)"],
    [1, "rgba(0, 0, 0, 0)"],
  ]);
  c.fillRect(0, 0, w, h);
  c.fillStyle = "rgba(255, 60, 52, 0.6)";
  c.fillRect(0, 0, w, 2);
  c.fillRect(0, h - 2, w, 2);
  const scale = 1.7;
  const tagRight = liveBug(p, 28, (h - 26 * scale) / 2, t, "БРИФИНГ · AM7", scale);
  c.fillStyle = TV.white25;
  c.fillRect(tagRight + 28, 20, 2, h - 40);
  const hold = briefing.hold;
  if (hold) {
    // The floor is still gathering: AM7 waits at the microphone.
    p.setFont(42, 700, DISPLAY);
    const dots = ".".repeat(1 + (Math.floor(t * 2) % 3));
    spaced(p, `ОЖИДАНИЕ КОМАНДЫ${dots}`, tagRight + 58, h / 2 + 15, TV.white80, 4);
    if (hold.expected > 0) {
      p.setFont(40, BODY_WEIGHT, DISPLAY);
      p.text(`на местах ${hold.gathered} / ${hold.expected}`, w - 36, h / 2 + 14, TV.white65, "right");
    }
    return;
  }
  const focus = briefing.focus;
  const title = focus?.title || briefing.goal;
  const tag = focus?.title ? focus.label : "ЦЕЛЬ";
  p.setFont(42, 700, DISPLAY);
  const goalLabelW = spaced(p, tag, tagRight + 58, h / 2 + 15, TV.redHot, 4);
  const x = tagRight + 58 + goalLabelW + 28;
  const box = { x, y: 8, w: w - x - 36, h: h - 16 };
  if (!title) {
    p.setFont(40, BODY_WEIGHT, DISPLAY);
    p.text(`уточняется${".".repeat(1 + (Math.floor(t * 2) % 3))}`, x, h / 2 + 14, TV.white45);
    return;
  }
  drawParagraph(p, fitText(p, "goal", [title], box.w, box.w, box.h, GOAL_FIT), box, GOAL_FIT.leading, TV.white);
}
