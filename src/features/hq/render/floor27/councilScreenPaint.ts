/**
 * Paints the Floor 27 screen wall behind AM7: a compact visual summary of the
 * floor whose chief is reporting (metrics / operations / incidents), or the
 * session header between speakers. Voice, not text — this is a dashboard the
 * eye reads at a glance, never a transcript of what is said.
 *
 * Drawn to an offscreen canvas the screen mesh samples as a CanvasTexture.
 */

import { HQ_THEME } from "@/features/hq/core/config";
import type { CouncilScreen } from "@/features/hq/core/council/agenda";
import type { CouncilHeader } from "@/features/hq/core/council/machine";

export const COUNCIL_SCREEN_W = 1536;
export const COUNCIL_SCREEN_H = 640;

const KIND_LABEL: Record<string, string> = {
  daily: "ЕЖЕДНЕВНЫЙ СОВЕТ",
  evening: "ВЕЧЕРНИЙ СОВЕТ",
  emergency: "ЭКСТРЕННЫЙ СОВЕТ",
  oneonone: "ОДИН НА ОДИН",
};

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Clears the canvas to the screen background and draws the subtle grid + frame. */
function base(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#05070a";
  ctx.fillRect(0, 0, COUNCIL_SCREEN_W, COUNCIL_SCREEN_H);
  ctx.strokeStyle = "rgba(232,53,42,0.10)";
  ctx.lineWidth = 2;
  for (let x = 0; x < COUNCIL_SCREEN_W; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, COUNCIL_SCREEN_H);
    ctx.stroke();
  }
  for (let y = 0; y < COUNCIL_SCREEN_H; y += 64) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(COUNCIL_SCREEN_W, y);
    ctx.stroke();
  }
  ctx.strokeStyle = HQ_THEME.accent;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 4;
  ctx.strokeRect(10, 10, COUNCIL_SCREEN_W - 20, COUNCIL_SCREEN_H - 20);
  ctx.globalAlpha = 1;
}

/** The screen between speakers: the session kind and how many chiefs have gathered. */
export function paintCouncilHeader(ctx: CanvasRenderingContext2D, header: CouncilHeader): void {
  base(ctx);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ff6a50";
  ctx.font = "700 76px 'Segoe UI', sans-serif";
  ctx.fillText("ШТАБ · КАБИНЕТ AM7", 70, 150);
  ctx.fillStyle = "#e8e6e3";
  ctx.font = "600 52px 'Segoe UI', sans-serif";
  ctx.fillText(KIND_LABEL[header.kind] ?? "СОВЕТ", 70, 240);
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "500 40px 'Segoe UI', sans-serif";
  ctx.fillText(`СОВЕТ УПРАВЛЕНИЙ · ${header.expected} ШЕФОВ`, 70, 330);
  // Gather progress bar.
  const w = COUNCIL_SCREEN_W - 140;
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  roundRect(ctx, 70, 400, w, 40, 20);
  ctx.fill();
  const p = header.expected > 0 ? header.gathered / header.expected : 0;
  ctx.fillStyle = HQ_THEME.accent;
  roundRect(ctx, 70, 400, Math.max(40, w * p), 40, 20);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = "500 34px 'Segoe UI', sans-serif";
  ctx.fillText(`СБОР: ${header.gathered}/${header.expected}`, 70, 500);
}

/** The screen while a chief reports: that floor's metrics, operations, incidents. */
export function paintCouncilScreen(ctx: CanvasRenderingContext2D, screen: CouncilScreen): void {
  base(ctx);
  ctx.textBaseline = "alphabetic";
  // Header: the DIRECTORATE name and its callsign — no floor number (units are
  // referred to by their directorate, never «этаж N»).
  ctx.fillStyle = "#ff6a50";
  ctx.font = "600 34px 'Segoe UI', sans-serif";
  ctx.fillText("УПРАВЛЕНИЕ ШТАБА", 70, 92);
  ctx.fillStyle = "#e8e6e3";
  ctx.font = "700 66px 'Segoe UI', sans-serif";
  ctx.fillText(screen.title.toUpperCase(), 70, 164);
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "600 40px 'Segoe UI', sans-serif";
  ctx.fillText(`· ${screen.callsign}`, 90 + ctx.measureText(screen.title.toUpperCase()).width, 164);

  // Metric tiles.
  const tileW = 268;
  const tileH = 150;
  const gap = 24;
  let x = 70;
  const y = 240;
  for (const m of screen.metrics) {
    ctx.fillStyle = m.accent ? "rgba(232,53,42,0.18)" : "rgba(255,255,255,0.05)";
    roundRect(ctx, x, y, tileW, tileH, 16);
    ctx.fill();
    ctx.strokeStyle = m.accent ? HQ_THEME.accent : "rgba(255,255,255,0.12)";
    ctx.lineWidth = 2;
    roundRect(ctx, x, y, tileW, tileH, 16);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "600 30px 'Segoe UI', sans-serif";
    ctx.fillText(m.label, x + 24, y + 48);
    ctx.fillStyle = m.accent ? "#ff6a50" : "#e8e6e3";
    ctx.font = "700 72px 'Segoe UI', sans-serif";
    ctx.fillText(m.value, x + 24, y + 128);
    x += tileW + gap;
  }

  // Operations as status chips, along the bottom.
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "600 30px 'Segoe UI', sans-serif";
  ctx.fillText("ОПЕРАЦИИ", 70, 470);
  let cx = 70;
  const cy = 500;
  for (const op of screen.operations) {
    const label = `${op.label} · ${op.status}`;
    ctx.font = "500 30px 'Segoe UI', sans-serif";
    const w = ctx.measureText(label).width + 48;
    const hot = op.status === "доработка";
    ctx.fillStyle = hot ? "rgba(232,53,42,0.2)" : "rgba(255,255,255,0.07)";
    roundRect(ctx, cx, cy, w, 58, 29);
    ctx.fill();
    ctx.strokeStyle = hot ? HQ_THEME.accent : "rgba(255,255,255,0.15)";
    ctx.lineWidth = 2;
    roundRect(ctx, cx, cy, w, 58, 29);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText(label, cx + 24, cy + 39);
    cx += w + 20;
    if (cx > COUNCIL_SCREEN_W - 300) break;
  }
}
