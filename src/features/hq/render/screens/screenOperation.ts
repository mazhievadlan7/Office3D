import type { HqOperationLogEntry, HqOperationOverall, HqOperationStep } from "@/features/hq/core/operation";
import { liveBug } from "./screenBroadcast";
import {
  BODY_WEIGHT,
  RED_GRADIENT,
  TASK_FIT,
  baseline,
  bodyCard,
  drawParagraph,
  fitText,
  headerRule,
  sectionTag,
  type FitOptions,
} from "./screenBriefing";
import {
  DISPLAY,
  MONO,
  TV,
  clamp01,
  fillRound,
  label,
  linear,
  radial,
  spaced,
  strokeRound,
  vignette,
} from "./screenKit";
import { backdrop } from "./screenPanels";
import { clockText, type Box, type HqScreenOperation, type Painter } from "./screenPaint";

/**
 * The video wall after a briefing, in «ХОД ЗАДАЧИ» mode (design_wall.md),
 * painted in the same broadcast language as the briefing (screenBriefing.ts):
 *
 *  - the west wing (paintOperationTask): «ЗАДАЧА», the task, a status line
 *    (start time, a T+ clock, the overall status) and the team bar;
 *  - the banner (paintOperationBanner): the «ХОД ЗАДАЧИ · AM7» live tag, the
 *    goal, and a segmented step indicator with «ЭТАП n/M»;
 *  - the east wing (paintOperationPlan): «ПЛАН» with per-step state, and a
 *    short journal of real events.
 *
 * Everything shown is a fact from the tracker (core/operation.ts). Elapsed
 * time is a clock, never progress: a step lights up only when the lead's words
 * marked it. Pure of three.js and the DOM, so it runs in the painting worker.
 */

/** Block and its warning colour (the briefing's amber, screenPaint INK.warn). */
const AMBER = "#ffae5c";
const DONE = TV.white65;
const PENDING = TV.white45;

const BADGE = 1.2;
const BADGE_GAP = 0.5;
const COLUMN_GAP = 56;
const STEP_FIT: FitOptions = { max: 58, min: 22, leading: 1.14, gap: 0.42 };
const GOAL_FIT: FitOptions = { max: 54, min: 26, leading: 1.08 };

const OVERALL_TEXT: Record<HqOperationOverall, string> = {
  waiting: "ОЖИДАНИЕ",
  live: "В РАБОТЕ",
  blocked: "БЛОК",
  done: "ГОТОВО",
};

function overallColor(overall: HqOperationOverall): string {
  return overall === "blocked" ? AMBER : overall === "done" ? TV.white : overall === "waiting" ? PENDING : TV.redHot;
}

function stepColor(state: HqOperationStep["state"]): string {
  return state === "done" ? DONE : state === "blocked" ? AMBER : state === "active" ? TV.redHot : PENDING;
}

/** hh:mm of a wall-clock time, for the start stamp. */
function hhmm(clock: number): string {
  return clockText(clock).slice(0, 5);
}

/** A T+hh:mm:ss counter from the elapsed milliseconds (a clock, not progress). */
function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `T+${hh}:${mm}:${ss}`;
}

/** How many of the steps are done. */
function doneCount(steps: readonly HqOperationStep[]): number {
  let n = 0;
  for (const s of steps) if (s.state === "done") n++;
  return n;
}

// --- shared frames -----------------------------------------------------------------------------

/** The 1.5 s hand-off frame, on any of the three surfaces: «ЗАВЕРШЕНО · передача на панели». */
function paintHandoff(p: Painter): void {
  const { w, h } = p;
  const c = p.ctx;
  c.fillStyle = linear(c, 0, 0, 0, h, [
    [0, "#0b0405"],
    [1, "#030202"],
  ]);
  c.fillRect(0, 0, w, h);
  c.fillStyle = radial(c, w / 2, h / 2, 0, Math.min(w, h) * 0.7, [
    [0, "rgba(150, 12, 18, 0.24)"],
    [1, "rgba(0, 0, 0, 0)"],
  ]);
  c.fillRect(0, 0, w, h);
  const big = h > 200;
  p.setFont(big ? 58 : 34, 700, DISPLAY);
  spaced(p, "ЗАВЕРШЕНО", w / 2, h / 2 - (big ? 2 : 6), TV.white, 6, "center");
  label(p, "передача на панели", w / 2, h / 2 + (big ? 40 : 22), TV.white45, big ? 20 : 13, "center");
}

// --- west wing: the task ------------------------------------------------------------------------

/** The team bar: адресовано N · приступили X · ответили Y · ошибки Z, with proportion bars. */
function drawTeamBar(p: Painter, box: Box, op: HqScreenOperation): void {
  const c = p.ctx;
  const { addressed, started, replied, errors } = op.team;
  const cells: Array<[string, number, string]> = [
    ["АДРЕСОВАНО", addressed, TV.white65],
    ["ПРИСТУПИЛИ", started, TV.redHot],
    ["ОТВЕТИЛИ", replied, TV.white],
    ["ОШИБКИ", errors, AMBER],
  ];
  const gap = 24;
  const cw = (box.w - gap * (cells.length - 1)) / cells.length;
  const denom = Math.max(1, addressed);
  cells.forEach(([name, value, color], i) => {
    const x = box.x + i * (cw + gap);
    label(p, name, x, box.y + 16, TV.white45, 14);
    p.setFont(40, 700, DISPLAY);
    p.text(String(value), x, box.y + 54, color);
    // A thin share bar under the number (addressed itself fills the track).
    const share = name === "АДРЕСОВАНО" ? 1 : clamp01(value / denom);
    fillRound(c, x, box.y + 66, cw, 5, 2.5, "rgba(255, 255, 255, 0.08)");
    if (share > 0) fillRound(c, x, box.y + 66, Math.max(5, cw * share), 5, 2.5, linear(c, x, 0, x + cw, 0, [[0, TV.redDeep], [1, color]]));
  });
}

/** The status line: the start stamp, the T+ clock and the overall status chip. */
function drawStatusLine(p: Painter, box: Box, op: HqScreenOperation, clock: number): void {
  const c = p.ctx;
  const y = box.y + 34;
  const x = box.x + label(p, `СТАРТ ${hhmm(op.startedAt)}`, box.x, y, TV.white45, 16) + 34;
  p.setFont(38, 600, DISPLAY);
  p.text(elapsedText(Math.max(0, clock - op.startedAt)), x, y + 6, TV.white);
  // The overall status chip on the right.
  const text = OVERALL_TEXT[op.overall];
  const color = overallColor(op.overall);
  p.setFont(20, 700, MONO);
  const chipW = c.measureText(text).width + text.length * 2 + 44;
  const chipX = box.x + box.w - chipW;
  const chipY = box.y + 4;
  fillRound(c, chipX, chipY, chipW, 40, 8, "rgba(255, 255, 255, 0.05)");
  strokeRound(c, chipX, chipY, chipW, 40, 8, color === TV.white ? TV.redBorder : colorToRgba(color, 0.5));
  c.fillStyle = color;
  c.beginPath();
  c.arc(chipX + 20, chipY + 20, op.overall === "live" ? 6.5 : 6, 0, Math.PI * 2);
  c.fill();
  spaced(p, text, chipX + 36, chipY + 27, TV.white, 2);
}

/** A hex/rgb colour with an alpha, for a translucent stroke (the few we pass are simple). */
function colorToRgba(color: string, alpha: number): string {
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

/** The west wing: «ЗАДАЧА», the task, the status line and the team bar. */
export function paintOperationTask(p: Painter, t: number, op: HqScreenOperation, clock: number): void {
  if (op.state === "handoff") return paintHandoff(p);
  backdrop(p, 300, 0, 900);
  const tagW = sectionTag(p, 40, 26, "ЗАДАЧА", "left");
  label(p, "ход задачи · штаб AM7", 40 + tagW + 24, 66, TV.white45, 15);
  headerRule(p, false);
  const card = bodyCard(p);
  const complete = op.state === "complete";
  // The task fills the upper part; the status line and the team bar sit below.
  const teamH = 90;
  const statusH = 56;
  const taskBox: Box = { x: card.x, y: card.y, w: card.w, h: card.h - teamH - statusH - 40 };
  drawParagraph(p, fitText(p, "op-task", [op.task], taskBox.w, taskBox.w, taskBox.h, TASK_FIT), taskBox, TASK_FIT.leading, complete ? TV.white65 : TV.white);
  if (complete) {
    const y = card.y + taskBox.h + 8;
    p.setFont(46, 700, DISPLAY);
    spaced(p, "ЗАДАЧА ЗАВЕРШЕНА", card.x, y + 34, TV.white, 4);
  } else {
    drawStatusLine(p, { x: card.x, y: card.y + taskBox.h + 12, w: card.w, h: statusH }, op, clock);
  }
  drawTeamBar(p, { x: card.x, y: card.y + card.h - teamH, w: card.w, h: teamH }, op);
  vignette(p, 0.2);
}

// --- banner: the goal and the step indicator ----------------------------------------------------

/** The segmented step indicator: done solid, active pulsing, blocked amber, pending outlined. */
function drawSegments(p: Painter, x: number, y: number, w: number, h: number, steps: readonly HqOperationStep[], t: number): void {
  const c = p.ctx;
  const n = steps.length;
  if (n === 0) return;
  const gap = Math.min(8, w / (n * 4));
  const segW = (w - gap * (n - 1)) / n;
  const pulse = 0.55 + 0.45 * Math.sin(t * Math.PI * 2.2);
  for (let i = 0; i < n; i++) {
    const sx = x + i * (segW + gap);
    const state = steps[i].state;
    if (state === "done") {
      fillRound(c, sx, y, segW, h, h / 2, linear(c, 0, y, 0, y + h, RED_GRADIENT));
    } else if (state === "active") {
      c.globalAlpha = 0.5 + 0.5 * pulse;
      fillRound(c, sx, y, segW, h, h / 2, TV.redHot);
      c.globalAlpha = 1;
    } else if (state === "blocked") {
      fillRound(c, sx, y, segW, h, h / 2, AMBER);
    } else {
      fillRound(c, sx, y, segW, h, h / 2, "rgba(255, 255, 255, 0.06)");
      strokeRound(c, sx, y, segW, h, h / 2, TV.white25);
    }
  }
}

/** The «ЭТАП n/M» caption for the current stage. */
function stageCaption(op: HqScreenOperation): string {
  const total = op.steps.length;
  if (total === 0) return "план не задан";
  if (op.activeStep >= 0) return `ЭТАП ${op.activeStep + 1}/${total}`;
  const done = doneCount(op.steps);
  return done > 0 ? `${done}/${total} ГОТОВО` : "этап не отмечен";
}

/** The banner over the map: «ХОД ЗАДАЧИ · AM7», the goal, the step indicator and «ЭТАП n/M». */
export function paintOperationBanner(p: Painter, t: number, op: HqScreenOperation): void {
  if (op.state === "handoff") return paintHandoff(p);
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
  const tagRight = liveBug(p, 28, (h - 26 * scale) / 2, t, "ХОД ЗАДАЧИ · AM7", scale);
  c.fillStyle = TV.white25;
  c.fillRect(tagRight + 28, 20, 2, h - 40);

  // The step indicator and its caption take a fixed strip on the right.
  const rightW = op.steps.length > 0 ? Math.min(760, Math.max(320, op.steps.length * 60)) : 300;
  const rightX = w - 36 - rightW;
  if (op.state === "complete") {
    p.setFont(30, 700, DISPLAY);
    spaced(p, "ЗАДАЧА ЗАВЕРШЕНА", w - 36, h / 2 + 12, TV.white, 3, "right");
  } else {
    label(p, stageCaption(op), w - 36, h / 2 - 12, TV.white45, 15, "right");
    if (op.steps.length > 0) drawSegments(p, rightX, h / 2 - 4, rightW, 16, op.steps, t);
  }

  // The goal fills the space between the tag and the indicator.
  p.setFont(42, 700, DISPLAY);
  const goalLabelW = spaced(p, "ЦЕЛЬ", tagRight + 58, h / 2 + 15, TV.redHot, 4);
  const gx = tagRight + 58 + goalLabelW + 28;
  const gw = (op.state === "complete" ? w - 300 : rightX - 28) - gx;
  const box: Box = { x: gx, y: 8, w: Math.max(120, gw), h: h - 16 };
  if (!op.goal) {
    p.setFont(40, BODY_WEIGHT, DISPLAY);
    p.text("операция идёт", gx, h / 2 + 14, TV.white45);
    return;
  }
  drawParagraph(p, fitText(p, "op-goal", [op.goal], box.w, box.w, box.h, GOAL_FIT), box, GOAL_FIT.leading, TV.white);
}

// --- east wing: the plan and the journal --------------------------------------------------------

/** A step's number badge in its state colour: done shows a check, the rest the number. */
function drawStepBadge(p: Painter, x: number, y: number, size: number, index: number, state: HqOperationStep["state"], t: number): void {
  const c = p.ctx;
  const badge = size * BADGE;
  const active = state === "active";
  const pulse = 0.6 + 0.4 * Math.sin(t * Math.PI * 2.2);
  if (state === "done") {
    fillRound(c, x, y, badge, badge, badge * 0.18, linear(c, 0, y, 0, y + badge, RED_GRADIENT));
    // A check mark.
    c.strokeStyle = TV.white;
    c.lineWidth = Math.max(2, badge * 0.09);
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(x + badge * 0.28, y + badge * 0.52);
    c.lineTo(x + badge * 0.44, y + badge * 0.68);
    c.lineTo(x + badge * 0.74, y + badge * 0.34);
    c.stroke();
    c.lineCap = "butt";
    return;
  }
  if (active) {
    c.globalAlpha = 0.35 * pulse;
    fillRound(c, x - 3, y - 3, badge + 6, badge + 6, badge * 0.22, TV.redHot);
    c.globalAlpha = 1;
    fillRound(c, x, y, badge, badge, badge * 0.18, linear(c, 0, y, 0, y + badge, RED_GRADIENT));
    strokeRound(c, x, y, badge, badge, badge * 0.18, TV.white);
  } else if (state === "blocked") {
    fillRound(c, x, y, badge, badge, badge * 0.18, "rgba(255, 174, 92, 0.16)");
    strokeRound(c, x, y, badge, badge, badge * 0.18, AMBER);
  } else {
    fillRound(c, x, y, badge, badge, badge * 0.18, "rgba(255, 255, 255, 0.06)");
    strokeRound(c, x, y, badge, badge, badge * 0.18, TV.white25);
  }
  p.setFont(size * 0.7, 700, DISPLAY);
  p.text(String(index + 1), x + badge / 2, y + badge * 0.74, state === "blocked" ? AMBER : state === "pending" ? PENDING : TV.white, "center");
}

/** The plan's steps, each in its own state, one or two columns, all at one size. */
function drawStates(p: Painter, steps: readonly HqOperationStep[], box: Box, t: number): void {
  const columns = steps.length > 4 ? 2 : 1;
  const colW = (box.w - COLUMN_GAP * (columns - 1)) / columns;
  const perColumn = Math.ceil(steps.length / columns);
  const parts = Array.from({ length: columns }, (_, k) => steps.slice(k * perColumn, (k + 1) * perColumn));
  const textW = (size: number) => colW - size * (BADGE + BADGE_GAP);
  let size = STEP_FIT.max;
  for (const [k, part] of parts.entries()) {
    size = Math.min(size, fitText(p, `op-steps${k}`, part.map((s) => s.text), textW, colW, box.h, STEP_FIT).size);
  }
  const fitted = parts.map((part, k) => fitText(p, `op-steps${k}`, part.map((s) => s.text), textW, colW, box.h, { ...STEP_FIT, max: size }));
  const pitch = size * STEP_FIT.leading;
  let index = 0;
  fitted.forEach((column, k) => {
    const x = box.x + k * (colW + COLUMN_GAP);
    let top = box.y;
    for (const lines of column.blocks) {
      const state = steps[index].state;
      const badge = size * BADGE;
      const by = top + (pitch - badge) / 2;
      drawStepBadge(p, x, by, size, index, state, t);
      p.setFont(size, BODY_WEIGHT, DISPLAY);
      lines.forEach((line, i) => p.text(line, x + size * (BADGE + BADGE_GAP), baseline(top, size, STEP_FIT.leading, i), stepColor(state)));
      top += lines.length * pitch + (STEP_FIT.gap ?? 0) * size;
      index++;
    }
  });
}

/** One journal line's verb and colour, from a tracker event. */
function logVerb(entry: HqOperationLogEntry): { text: string; color: string } {
  switch (entry.kind) {
    case "started":
      return { text: "приступил", color: TV.white65 };
    case "replied":
      return { text: "ответил", color: TV.white };
    case "error":
      return { text: "ошибка", color: AMBER };
    case "step-done":
      return { text: `шаг ${entry.step} — выполнен`, color: TV.redHot };
    case "step-active":
      return { text: `шаг ${entry.step} — в работе`, color: TV.redHot };
    case "step-blocked":
      return { text: `шаг ${entry.step} — блок`, color: AMBER };
    case "complete":
      return { text: "задача завершена", color: TV.white };
    default:
      return { text: "брифинг", color: TV.white45 };
  }
}

/** The event journal, newest at the bottom, monospace: [hh:mm:ss] Имя — событие. */
function drawJournal(p: Painter, box: Box, log: readonly HqOperationLogEntry[]): void {
  label(p, "журнал", box.x, box.y - 8, TV.white45, 14);
  const size = 22;
  const lh = size * 1.35;
  const rows = Math.max(1, Math.floor(box.h / lh));
  const shown = log.slice(Math.max(0, log.length - rows));
  shown.forEach((entry, i) => {
    const y = box.y + 20 + i * lh;
    const verb = logVerb(entry);
    let x = box.x;
    p.setFont(size, 500, MONO);
    x += p.text(`[${clockText(entry.at)}]`, x, y, TV.white45) + 12;
    if (entry.who) {
      x += p.text(entry.who, x, y, TV.white);
      x += p.text(" — ", x, y, TV.white45);
    }
    p.text(verb.text, x, y, verb.color);
  });
}

/** The east wing: «ПЛАН» with per-step state, and the event journal below. */
export function paintOperationPlan(p: Painter, t: number, op: HqScreenOperation): void {
  if (op.state === "handoff") return paintHandoff(p);
  const { w } = p;
  backdrop(p, w - 300, 0, 900);
  const tagW = sectionTag(p, w - 40, 26, "ПЛАН", "right");
  const total = op.steps.length;
  const note = total > 0 ? `${doneCount(op.steps)}/${total}` : "ход задачи";
  label(p, note, w - 40 - tagW - 24, 66, TV.white45, 15, "right");
  headerRule(p, true);
  const card = bodyCard(p);
  const journalH = Math.min(190, card.h * 0.42);
  const stepsBox: Box = { x: card.x, y: card.y, w: card.w, h: card.h - journalH - 24 };
  if (total === 0) {
    p.setFont(40, BODY_WEIGHT, DISPLAY);
    p.text("план не отмечен", stepsBox.x, stepsBox.y + 44, TV.white45);
  } else {
    drawStates(p, op.steps, stepsBox, t);
  }
  drawJournal(p, { x: card.x, y: card.y + card.h - journalH, w: card.w, h: journalH }, op.log);
  vignette(p, 0.2);
}
