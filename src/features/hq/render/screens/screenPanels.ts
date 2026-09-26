import { channelLogo, clockBlock, drawEarth, phaseIcon, statusChip, stretch } from "./screenBroadcast";
import { GlobeView } from "./screenGlobe";
import {
  DISPLAY,
  MONO,
  SANS,
  TV,
  areaChart,
  arrow,
  bar,
  dot,
  fillRound,
  fit,
  gauge,
  glassCard,
  label,
  linear,
  liveDot,
  radial,
  sparkline,
  vignette,
} from "./screenKit";
import { series, wave, type HqScreenFeed, type Painter } from "./screenPaint";
import {
  PHASE_WORD,
  TEAM_NAMES,
  WORLD_CITIES,
  city,
  cityTime,
  dayPhase,
  decimal,
  hhmmss,
  shareAgo,
  signedPoints,
  sunElevation,
  workingShare,
} from "./screenStories";
import { makeRng, pick } from "./screenText";
import { subsolarPoint } from "@/features/hq/render/map/sun";

/**
 * AM7's office screens and the map wall's side panels, in the same broadcast
 * package as the lounge channels (screenBroadcast.ts): AM7's curved command
 * monitor, the executive wall screen with a real-time Earth, and the two
 * control-room panels either side of the world map. Everything they count is
 * the floor's real state (agents, statuses, departments, the last status
 * changes, the per-second history) and the real clock.
 */

type Line = { time: string; name: string; status: number; real: boolean };

/**
 * A generated line for when the floor is quiet. Never an error: the names are
 * real agents, and a made-up failure next to one would read as a real alarm.
 */
function syntheticLine(k: number, feed: HqScreenFeed): { name: string; status: number } {
  const rng = makeRng(k * 2246822519);
  const name = feed.names.length > 0 ? feed.names[Math.floor(rng() * feed.names.length)] : pick(["Nova", "Vex", "Rune", "Kade", "Lyra"], rng());
  return { name, status: rng() < 0.6 ? 0 : 1 };
}

/** The latest status changes, topped up with quiet-floor lines to fill a list. */
function eventLines(feed: HqScreenFeed, count: number, t: number): Line[] {
  const out: Line[] = [];
  for (const e of feed.events) {
    if (out.length >= count) break;
    out.push({ time: hhmmss(e.at), name: e.name, status: e.status, real: true });
  }
  const tick = Math.floor(t * 0.5);
  const oldest = feed.events.length > 0 ? feed.events[Math.min(feed.events.length, count) - 1].at : feed.clock;
  for (let k = 0; out.length < count; k++) {
    const ev = syntheticLine(tick - k, feed);
    out.push({ time: hhmmss(oldest - (k + 1) * 7000 - (tick % 7) * 400), ...ev, real: false });
  }
  return out;
}

function teamRows(feed: HqScreenFeed, max: number): Array<{ name: string; total: number; working: number; error: number }> {
  const rows = feed.teams
    .map((team, i) => ({ name: TEAM_NAMES[i], ...team }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, max);
  if (rows.length > 0) return rows;
  const total = Math.max(1, feed.total);
  return [
    { name: "В работе", total, working: feed.working, error: 0 },
    { name: "Ожидают", total, working: feed.idle, error: 0 },
    { name: "Ошибки", total, working: feed.error, error: feed.error },
  ];
}

function backdrop(p: Painter, glowX: number, glowY: number, glowR: number): void {
  const { w, h } = p;
  const c = p.ctx;
  c.fillStyle = linear(c, 0, 0, 0, h, [[0, "#090405"], [1, "#030202"]]);
  c.fillRect(0, 0, w, h);
  c.fillStyle = radial(c, glowX, glowY, 0, glowR, [[0, "rgba(150, 12, 18, 0.26)"], [1, "rgba(0, 0, 0, 0)"]]);
  c.fillRect(0, 0, w, h);
}

function shiftName(clock: number): string {
  const hour = new Date(clock).getHours();
  return hour >= 7 && hour < 19 ? "дневная" : "ночная";
}

// --- AM7's curved command monitor ------------------------------------------------------------
export function paintExecMonitor(p: Painter, t: number, feed: HqScreenFeed): void {
  const { w, h } = p;
  const c = p.ctx;
  backdrop(p, w * 0.5, 0, w * 0.55);
  // Header.
  c.fillStyle = "rgba(8, 4, 5, 0.9)";
  c.fillRect(0, 0, w, 56);
  c.fillStyle = linear(c, 0, 0, w, 0, [[0, "rgba(227, 20, 28, 0)"], [0.5, TV.red], [1, "rgba(227, 20, 28, 0)"]]);
  c.fillRect(0, 55, w, 2);
  const right = channelLogo(p, 20, 11, "КОМАНДНЫЙ ЦЕНТР");
  // Status chips.
  let x = right + 18;
  const chip = (text: string, live: boolean) => {
    p.setFont(12, 700, MONO);
    const cw = c.measureText(text).width + (live ? 34 : 22);
    fillRound(c, x, 16, cw, 24, 12, "rgba(255, 255, 255, 0.05)");
    if (live) liveDot(c, x + 13, 28, 3.4, t);
    p.text(text, x + (live ? 24 : 11), 32, TV.white80);
    x += cw + 10;
  };
  chip("СВЯЗЬ · ОНЛАЙН", true);
  chip(`АГЕНТОВ ${feed.total}`, false);
  chip(`СМЕНА ${shiftName(feed.clock).toUpperCase()}`, false);
  const offset = -new Date(feed.clock).getTimezoneOffset();
  const offsetText = `${Math.floor(Math.abs(offset) / 60)}${Math.abs(offset) % 60 ? `:${String(Math.abs(offset) % 60).padStart(2, "0")}` : ""}`;
  label(p, `UTC${offset >= 0 ? "+" : "−"}${offsetText}`, w - 190, 33, TV.white45, 12, "right");
  clockBlock(p, w - 20, 4, feed.clock, 0.95);

  // A. The team: three rings.
  const ax = 20;
  const ay = 72;
  const aw = 420;
  const ah = h - ay - 18;
  glassCard(p, ax, ay, aw, ah);
  label(p, "Команда", ax + 18, ay + 28, TV.white45, 12);
  const rings: Array<[string, number, string]> = [
    ["в работе", feed.working, TV.redHot],
    ["ожидают", feed.idle, "rgba(255, 255, 255, 0.75)"],
    ["ошибки", feed.error, "#f87171"],
  ];
  rings.forEach(([name, value, color], i) => {
    const cx = ax + aw * ((i + 0.5) / 3);
    const cy = ay + 124;
    gauge(c, cx, cy, 50, feed.total > 0 ? value / feed.total : 0, 9, color);
    p.setFont(30, 700, DISPLAY);
    p.text(String(value), cx, cy + 11, TV.white, "center");
    label(p, name, cx, cy + 82, TV.white65, 11.5, "center");
  });
  const share = workingShare(feed);
  p.setFont(15, 600, SANS);
  p.text("Загрузка штаба", ax + 18, ay + 264, TV.white80);
  p.setFont(26, 700, DISPLAY);
  p.text(`${Math.round(share * 100)}%`, ax + aw - 18, ay + 266, TV.white, "right");
  bar(c, ax + 18, ay + 280, aw - 36, 8, share, TV.redHot);
  const delta = share - shareAgo(feed, 60);
  arrow(c, delta >= 0, ax + 24, ay + 322, 5, delta >= 0 ? TV.white : TV.redSoft);
  p.setFont(13, 500, SANS);
  p.text(`${signedPoints(delta)} п.п. за минуту · всего агентов ${feed.total}`, ax + 36, ay + 322, TV.white65);
  label(p, `Отделов ${Math.max(1, feed.teams.filter((tm) => tm.total > 0).length)} · смена ${shiftName(feed.clock)}`, ax + 18, ay + ah - 18, TV.white45, 11);

  // B. Activity (the real working share) and the departments.
  const bx = 456;
  const bw = 880;
  glassCard(p, bx, ay, bw, 224);
  label(p, "Активность штаба · последние 3 минуты", bx + 18, ay + 28, TV.white45, 12);
  p.setFont(15, 600, SANS);
  p.text(`${feed.working} в работе`, bx + bw - 18, ay + 28, TV.white80, "right");
  const values = feed.history.length >= 2 ? stretch(feed.history.slice(-180)) : series(60, t, 3);
  areaChart(p, values, bx + 18, ay + 44, bw - 36, 162, { t, lineWidth: 2.4 });

  const dy = ay + 236;
  const dh = ah - 236;
  glassCard(p, bx, dy, bw, dh);
  label(p, "Отделы · в работе сейчас", bx + 18, dy + 28, TV.white45, 12);
  const rows = teamRows(feed, 8);
  const cellW = (bw - 36) / Math.max(4, rows.length);
  rows.forEach((r, i) => {
    const x0 = bx + 18 + i * cellW;
    const v = r.total > 0 ? r.working / r.total : 0;
    p.setFont(13, 600, SANS);
    p.text(fit(c, r.name, cellW - 14), x0, dy + 56, TV.white);
    p.setFont(26, 700, DISPLAY);
    p.text(`${Math.round(v * 100)}%`, x0, dy + 90, TV.white);
    p.setFont(11.5, 500, MONO);
    p.text(`${r.working}/${r.total}`, x0 + cellW - 16, dy + 90, TV.white45, "right");
    bar(c, x0, dy + 104, cellW - 16, 5, v, r.error > 0 ? TV.redHot : TV.red);
  });

  // C. Live events.
  const cx0 = 1352;
  const cw = w - cx0 - 20;
  glassCard(p, cx0, ay, cw, ah);
  label(p, "События · в реальном времени", cx0 + 18, ay + 28, TV.white45, 12);
  liveDot(c, cx0 + cw - 22, ay + 24, 3.6, t);
  const lines = eventLines(feed, Math.floor((ah - 48) / 36), t);
  lines.forEach((e, i) => {
    const y = ay + 64 + i * 36;
    c.globalAlpha = e.real ? 1 : 0.7;
    p.setFont(12.5, 500, MONO);
    p.text(e.time, cx0 + 18, y, TV.white45);
    p.setFont(15, 600, SANS);
    p.text(fit(c, e.name, cw - 230), cx0 + 102, y, TV.white);
    statusChip(p, cx0 + cw - 18, y - 14, e.status, 1, "right");
    c.globalAlpha = 1;
    if (i < lines.length - 1) {
      c.fillStyle = TV.white06;
      c.fillRect(cx0 + 18, y + 12, cw - 36, 1);
    }
  });
  vignette(p, 0.3);
}

// --- executive wall screen in AM7's office -----------------------------------------------------
let execGlobe: GlobeView | null = null;

export function paintExecWall(p: Painter, t: number, feed: HqScreenFeed): void {
  const { w, h } = p;
  const c = p.ctx;
  backdrop(p, 220, 300, 460);
  // Header.
  const right = channelLogo(p, 24, 20, "ШТАБ");
  p.setFont(20, 600, DISPLAY);
  p.text("Сводка руководителя", right + 16, 44, TV.white);
  label(p, "обновляется в реальном времени", right + 16, 60, TV.white45, 9.5);
  clockBlock(p, w - 24, 16, feed.clock);

  // The Earth, lit as it is now, with the network's routes.
  const gx = 24;
  const gy = 84;
  const gw = 404;
  const gh = h - gy - 24;
  glassCard(p, gx, gy, gw, gh);
  label(p, "Глобальная сеть", gx + 16, gy + 26, TV.white45, 10.5);
  const onlineW = label(p, "онлайн", gx + gw - 16, gy + 26, TV.white65, 10.5, "right");
  liveDot(c, gx + gw - 30 - onlineW, gy + 22, 3.4, t);
  execGlobe ??= new GlobeView(150, 22);
  drawEarth(p, execGlobe, gx + gw / 2, gy + 222, 30 - t * 3, t, feed, { routes: 6, callouts: [city("Москва"), city("Лондон"), city("Дубай"), city("Нью-Йорк"), city("Токио"), city("Сингапур")], maxY: gy + gh - 70, scale: 0.9 });
  const sun = subsolarPoint(feed.clock || Date.now());
  const latText = `${decimal(Math.abs(sun.lat), 1)}° ${sun.lat >= 0 ? "с. ш." : "ю. ш."}`;
  const lonText = `${decimal(Math.abs(sun.lon), 1)}° ${sun.lon >= 0 ? "в. д." : "з. д."}`;
  c.fillStyle = TV.white06;
  c.fillRect(gx + 16, gy + gh - 56, gw - 32, 1);
  label(p, "Солнце в зените", gx + 16, gy + gh - 34, TV.white45, 9.5);
  p.setFont(13, 600, SANS);
  p.text(`${latText}, ${lonText}`, gx + 16, gy + gh - 14, TV.white80);
  const moscow = city("Москва");
  const phase = dayPhase(sunElevation(moscow.lon, moscow.lat, feed.clock));
  const phaseW = label(p, `Москва · ${PHASE_WORD[phase]}`, gx + gw - 16, gy + gh - 26, TV.white65, 10, "right");
  phaseIcon(p, gx + gw - 30 - phaseW, gy + gh - 30, 7, phase);

  // KPI tiles.
  const kx = 444;
  const kw = (w - kx - 24 - 3 * 10) / 4;
  const share = workingShare(feed);
  const pctOf = (v: number) => (feed.total > 0 ? `${decimal((v / feed.total) * 100, 0)}% штаба` : "нет данных");
  const tiles: Array<[string, number, string, boolean]> = [
    ["Агентов", feed.total, "в сети", false],
    ["В работе", feed.working, pctOf(feed.working), false],
    ["Ожидают", feed.idle, pctOf(feed.idle), false],
    ["Ошибки", feed.error, pctOf(feed.error), feed.error > 0],
  ];
  tiles.forEach(([name, value, note, alarm], i) => {
    const x = kx + i * (kw + 10);
    glassCard(p, x, 84, kw, 112, { accent: i === 1 || alarm });
    label(p, name, x + 14, 108, TV.white45, 10);
    p.setFont(40, 700, DISPLAY);
    p.text(String(value), x + 14, 152, alarm ? "#f87171" : TV.white);
    p.setFont(12, 500, SANS);
    p.text(note, x + 14, 178, TV.white65);
    if (i === 1) sparkline(p, stretch(feed.history.slice(-60)), x + kw - 64, 128, 50, 22, TV.redHot, 1.4);
  });

  // The working share over the last minutes.
  const cy0 = 208;
  const cw = w - kx - 24;
  glassCard(p, kx, cy0, cw, 170);
  label(p, "Загрузка штаба · последние 3 минуты", kx + 16, cy0 + 24, TV.white45, 10);
  p.setFont(22, 700, DISPLAY);
  p.text(`${Math.round(share * 100)}%`, kx + cw - 16, cy0 + 28, TV.white, "right");
  const values = feed.history.length >= 2 ? stretch(feed.history.slice(-180)) : series(60, t * 0.3, 11);
  areaChart(p, values, kx + 16, cy0 + 40, cw - 32, 116, { t });

  // Departments and the latest events.
  const by = 390;
  const bh = h - by - 24;
  const half = (cw - 10) / 2;
  glassCard(p, kx, by, half, bh);
  label(p, "Отделы", kx + 16, by + 24, TV.white45, 10);
  teamRows(feed, 4).forEach((r, i) => {
    const y = by + 50 + i * 30;
    const v = r.total > 0 ? r.working / r.total : 0;
    p.setFont(13, 600, SANS);
    p.text(fit(c, r.name, half - 90), kx + 16, y, TV.white);
    p.setFont(15, 700, DISPLAY);
    p.text(`${Math.round(v * 100)}%`, kx + half - 16, y, TV.white, "right");
    bar(c, kx + 16, y + 7, half - 32, 3, v, r.error > 0 ? TV.redHot : TV.red);
  });
  const ex = kx + half + 10;
  glassCard(p, ex, by, half, bh);
  label(p, "События", ex + 16, by + 24, TV.white45, 10);
  eventLines(feed, 4, t).forEach((e, i) => {
    const y = by + 50 + i * 30;
    c.globalAlpha = e.real ? 1 : 0.7;
    p.setFont(13, 600, SANS);
    p.text(fit(c, e.name, half - 120), ex + 16, y, TV.white);
    statusChip(p, ex + half - 14, y - 13, e.status, 0.9, "right");
    c.globalAlpha = 1;
  });
  vignette(p, 0.35);
}

// --- the map wall's side panels ---------------------------------------------------------------------
export function paintMapLeft(p: Painter, t: number, feed: HqScreenFeed): void {
  const { w, h } = p;
  const c = p.ctx;
  backdrop(p, 300, 0, 900);
  p.setFont(36, 600, DISPLAY);
  const tw = p.text("ГЛОБАЛЬНАЯ АКТИВНОСТЬ", 40, 60, TV.white);
  liveDot(c, 40 + tw + 26, 48, 6, t);
  label(p, `Поток событий в реальном времени · ${hhmmss(feed.clock)}`, 40, 90, TV.white45, 15);

  // KPI tiles, 2 x 2.
  const share = workingShare(feed);
  const tiles: Array<[string, number, string, boolean]> = [
    ["Агентов в сети", feed.total, `${Math.max(1, feed.teams.filter((tm) => tm.total > 0).length)} отделов`, false],
    ["В работе", feed.working, `${Math.round(share * 100)}% штаба`, false],
    ["Ожидают", feed.idle, feed.total > 0 ? `${Math.round((feed.idle / feed.total) * 100)}% штаба` : "нет данных", false],
    ["Ошибки", feed.error, feed.total > 0 ? `${decimal((feed.error / feed.total) * 100)}% штаба` : "нет данных", feed.error > 0],
  ];
  const tw0 = 322;
  const th0 = 222;
  tiles.forEach(([name, value, note, alarm], i) => {
    const x = 40 + (i % 2) * (tw0 + 18);
    const y = 118 + Math.floor(i / 2) * (th0 + 18);
    glassCard(p, x, y, tw0, th0, { accent: alarm || i === 1, radius: 10 });
    label(p, name, x + 22, y + 38, TV.white45, 15);
    p.setFont(92, 700, DISPLAY);
    p.text(String(value), x + 20, y + 136, alarm ? "#f87171" : TV.white);
    p.setFont(19, 500, SANS);
    p.text(note, x + 22, y + 174, TV.white65);
    if (i === 1) sparkline(p, stretch(feed.history.slice(-90)), x + 22, y + 186, tw0 - 44, 22, TV.redHot, 2);
    else bar(c, x + 22, y + 196, tw0 - 44, 6, feed.total > 0 ? value / feed.total : 0, alarm ? TV.redHot : TV.red);
  });

  // The event feed.
  const fx = 740;
  const fw = 620;
  const fy = 118;
  const fh = h - fy - 20;
  glassCard(p, fx, fy, fw, fh, { radius: 10 });
  label(p, "Лента событий", fx + 22, fy + 38, TV.white45, 15);
  p.setFont(17, 500, SANS);
  p.text(`изменений за минуту: ${feed.events.filter((e) => feed.clock - e.at < 60_000).length}`, fx + fw - 22, fy + 38, TV.white65, "right");
  const lines = eventLines(feed, Math.floor((fh - 66) / 46), t);
  lines.forEach((e, i) => {
    const y = fy + 90 + i * 46;
    c.globalAlpha = e.real ? 1 : 0.68;
    p.setFont(17, 500, MONO);
    p.text(e.time, fx + 22, y, TV.white45);
    p.setFont(21, 600, SANS);
    p.text(fit(c, e.name, fw - 360), fx + 132, y, TV.white);
    statusChip(p, fx + fw - 22, y - 19, e.status, 1.35, "right");
    c.globalAlpha = 1;
    if (i < lines.length - 1) {
      c.fillStyle = TV.white06;
      c.fillRect(fx + 22, y + 17, fw - 44, 1);
    }
  });

  // Departments.
  const dx = 1380;
  const dw = w - dx - 40;
  glassCard(p, dx, fy, dw, fh, { radius: 10 });
  label(p, "Загрузка отделов", dx + 22, fy + 38, TV.white45, 15);
  const rows = teamRows(feed, 7);
  const rowH = Math.min(52, (fh - 150) / rows.length);
  rows.forEach((r, i) => {
    const y = fy + 88 + i * rowH;
    const v = r.total > 0 ? r.working / r.total : 0;
    p.setFont(20, 600, SANS);
    p.text(fit(c, r.name, 220), dx + 22, y, TV.white);
    p.setFont(15, 500, MONO);
    p.text(`${r.working}/${r.total}`, dx + 262, y, TV.white45);
    bar(c, dx + 340, y - 11, dw - 460, 8, v, r.error > 0 ? TV.redHot : TV.red);
    p.setFont(24, 700, DISPLAY);
    p.text(`${Math.round(v * 100)}%`, dx + dw - 22, y + 1, TV.white, "right");
  });
  c.fillStyle = TV.white06;
  c.fillRect(dx + 22, fy + fh - 70, dw - 44, 1);
  p.setFont(19, 600, SANS);
  p.text("Загрузка штаба", dx + 22, fy + fh - 34, TV.white80);
  p.setFont(30, 700, DISPLAY);
  p.text(`${Math.round(share * 100)}%`, dx + dw - 22, fy + fh - 30, TV.white, "right");
  bar(c, dx + 220, fy + fh - 44, dw - 360, 10, share, TV.redHot);
  vignette(p, 0.25);
}

let mapGlobe: GlobeView | null = null;
const CLOCK_CITIES = ["Нью-Йорк", "Лондон", "Москва", "Дубай", "Сингапур", "Токио", "Сидней", "Сан-Паулу"].map(city);

export function paintMapRight(p: Painter, t: number, feed: HqScreenFeed): void {
  const { w, h } = p;
  const c = p.ctx;
  backdrop(p, w - 300, 0, 900);
  p.setFont(36, 600, DISPLAY);
  p.text("СЕТЬ И ВЫЧИСЛЕНИЯ", w - 40, 60, TV.white, "right");
  label(p, `Кластер prod-eu · ${Math.round(96 + wave(t * 0.1, 7) * 4)}% узлов в строю`, w - 40, 90, TV.white45, 15, "right");

  // World clocks, day and night where the Sun really is.
  const kx = 40;
  const ky = 118;
  const kw = 640;
  const kh = h - ky - 20;
  glassCard(p, kx, ky, kw, kh, { radius: 10 });
  label(p, "Мировое время", kx + 22, ky + 38, TV.white45, 15);
  const cellW = (kw - 44) / 4;
  const cellH = (kh - 70) / 2;
  CLOCK_CITIES.forEach((target, i) => {
    const x = kx + 22 + (i % 4) * cellW + cellW / 2;
    const y = ky + 70 + Math.floor(i / 4) * cellH;
    const local = cityTime(target, feed.clock);
    const phase = dayPhase(sunElevation(target.lon, target.lat, feed.clock));
    const cx = x;
    const cy = y + 56;
    const r = 44;
    c.fillStyle = phase === "day" ? "rgba(255, 255, 255, 0.09)" : "rgba(255, 255, 255, 0.025)";
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = phase === "day" ? "rgba(255, 255, 255, 0.35)" : "rgba(255, 60, 52, 0.35)";
    c.lineWidth = 1.5;
    c.stroke();
    c.strokeStyle = TV.white45;
    c.beginPath();
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const r0 = k % 3 === 0 ? r - 11 : r - 7;
      c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      c.lineTo(cx + Math.cos(a) * (r - 3), cy + Math.sin(a) * (r - 3));
    }
    c.stroke();
    const seconds = new Date(feed.clock).getSeconds();
    const ha = ((local.hours % 12) + local.minutes / 60) * (Math.PI / 6) - Math.PI / 2;
    const ma = (local.minutes + seconds / 60) * (Math.PI / 30) - Math.PI / 2;
    c.lineCap = "round";
    c.strokeStyle = TV.white;
    c.lineWidth = 4;
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx + Math.cos(ha) * r * 0.5, cy + Math.sin(ha) * r * 0.5);
    c.stroke();
    c.lineWidth = 2.5;
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx + Math.cos(ma) * r * 0.78, cy + Math.sin(ma) * r * 0.78);
    c.stroke();
    const sa = seconds * (Math.PI / 30) - Math.PI / 2;
    c.strokeStyle = TV.redHot;
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(cx - Math.cos(sa) * 8, cy - Math.sin(sa) * 8);
    c.lineTo(cx + Math.cos(sa) * r * 0.86, cy + Math.sin(sa) * r * 0.86);
    c.stroke();
    c.lineCap = "butt";
    dot(c, cx, cy, 3.5, TV.redHot);
    p.setFont(19, 600, SANS);
    p.text(target.name, cx, cy + r + 28, TV.white, "center");
    p.setFont(22, 600, DISPLAY);
    const tw = p.text(local.text, cx - 18, cy + r + 54, TV.white80, "center");
    phaseIcon(p, cx + tw / 2 - 4, cy + r + 47, 7, phase);
    label(p, PHASE_WORD[phase], cx + tw / 2 + 8, cy + r + 52, TV.white45, 12);
  });

  // The Earth right now.
  const gx = 700;
  const gw = 560;
  glassCard(p, gx, ky, gw, kh, { radius: 10 });
  label(p, "Орбитальный вид · день и ночь сейчас", gx + 22, ky + 38, TV.white45, 15);
  mapGlobe ??= new GlobeView(196, 20);
  drawEarth(p, mapGlobe, gx + gw / 2, ky + 258, 20 - t * 1.2, t, feed, { routes: 8, callouts: [WORLD_CITIES[0]], scale: 1.2 });

  // Traffic and resources.
  const rx = 1280;
  const rw = w - rx - 40;
  const th = (kh - 18) / 2;
  glassCard(p, rx, ky, rw, th, { radius: 10 });
  label(p, "Входящий трафик · Гбит/с", rx + 22, ky + 38, TV.white45, 15);
  const now = 18 + wave(t * 0.8, 21) * 30;
  p.setFont(34, 700, DISPLAY);
  p.text(decimal(now, 1), rx + rw - 22, ky + 44, TV.white, "right");
  areaChart(p, series(90, t * 0.8, 21), rx + 22, ky + 62, rw - 44, th - 82, { t, lineWidth: 2.4 });
  const gy = ky + th + 18;
  glassCard(p, rx, gy, rw, th, { radius: 10 });
  label(p, "Ресурсы кластера", rx + 22, gy + 38, TV.white45, 15);
  const gauges: Array<[string, number]> = [
    ["CPU", wave(t * 0.2, 1)],
    ["GPU", 0.55 + 0.4 * wave(t * 0.15, 2)],
    ["RAM", 0.4 + 0.3 * wave(t * 0.05, 3)],
    ["СЕТЬ", workingShare(feed) * 0.8 + 0.1],
  ];
  gauges.forEach(([name, v], i) => {
    const cx = rx + rw * ((i + 0.5) / 4);
    const cy = gy + th / 2 + 12;
    const r = Math.min(rw / 11, th / 3.4);
    gauge(c, cx, cy, r, v, 9, i === 1 ? TV.redHot : TV.red);
    p.setFont(26, 700, DISPLAY);
    p.text(`${Math.round(v * 100)}%`, cx, cy + 9, TV.white, "center");
    label(p, name, cx, cy + r + 30, TV.white65, 14, "center");
  });
  vignette(p, 0.25);
}
