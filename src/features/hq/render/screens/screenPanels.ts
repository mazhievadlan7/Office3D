import { INK, MONO, SANS, Painter, clockText, series, wave, type HqScreenFeed } from "./screenPaint";
import { CITIES, NEWS_HEADLINES, NEWS_TICKER, REGIONS, TASK_KINDS, hash2, makeRng, pick } from "./screenText";

/**
 * Painters for the HQ's big displays: AM7's curved command monitor, the
 * executive wall screen in his office, the lounge screens (a news channel, a
 * security monitor and a music visualiser) and the two data panels either side
 * of the globe on the map wall. Each shows the floor's real numbers (agents,
 * statuses, the latest status changes) around its own decoration.
 */

const STATUS_WORD = ["в работе", "ожидает", "ошибка"];

function share(feed: HqScreenFeed): number {
  return feed.total > 0 ? feed.working / feed.total : 0;
}

function historyOr(feed: HqScreenFeed, n: number, t: number, seed: number): number[] {
  if (feed.history.length >= 8) {
    const h = feed.history.slice(-n);
    // Stretch to the working share's own range so the curve has shape.
    let lo = 1;
    let hi = 0;
    for (const v of h) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    const span = Math.max(0.08, hi - lo);
    return h.map((v) => 0.12 + (0.76 * (v - lo)) / span);
  }
  return series(n, t, seed);
}

/** A generated event line for when the floor is quiet. */
function syntheticEvent(k: number, feed: HqScreenFeed): { name: string; text: string; hot: boolean } {
  const rng = makeRng(k * 2246822519);
  const name = feed.names.length > 0 ? feed.names[Math.floor(rng() * feed.names.length)] : pick(["Nova", "Vex", "Rune"], rng());
  const kind = pick(TASK_KINDS, rng());
  const verbs = ["закрыл задачу", "взял задачу", "отправил отчёт", "запустил проверку", "обновил данные"];
  return { name, text: `${pick(verbs, rng())} · ${kind}`, hot: rng() < 0.12 };
}

function eventLines(feed: HqScreenFeed, count: number, t: number): Array<{ time: string; name: string; text: string; hot: boolean }> {
  const out: Array<{ time: string; name: string; text: string; hot: boolean }> = [];
  for (const e of feed.events) {
    if (out.length >= count) break;
    out.push({ time: clockText(e.at), name: e.name, text: `статус: ${STATUS_WORD[e.status] ?? "—"}`, hot: e.status === 2 });
  }
  const tick = Math.floor(t * 0.8);
  for (let k = 0; out.length < count; k++) {
    const ev = syntheticEvent(tick - k, feed);
    out.push({ time: clockText(feed.clock - k * 1250), ...ev });
  }
  return out;
}

// --- AM7's curved command monitor ------------------------------------------------------------
export function paintExecMonitor(p: Painter, t: number, feed: HqScreenFeed): void {
  const { w, h } = p;
  p.clear("#050102");
  const c = p.ctx;
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#14030499");
  g.addColorStop(1, "#050102");
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  // header
  p.fill(0, 0, w, 44, "#120304");
  p.fill(0, 43, w, 1, INK.hot);
  p.setFont(20, 800, SANS);
  p.text("AM7  ·  КОМАНДНЫЙ ЦЕНТР", 24, 30, INK.white);
  p.setFont(14, 500, MONO);
  p.text(`${clockText(feed.clock)}   UTC${-new Date(feed.clock).getTimezoneOffset() / 60 >= 0 ? "+" : ""}${-new Date(feed.clock).getTimezoneOffset() / 60}`, w - 24, 29, INK.mid, "right");

  const col = w / 4;
  // 1. team rings
  let y0 = p.panel(16, 58, col - 24, h - 74, "команда");
  const rings: Array<[string, number, number, string]> = [
    ["в работе", feed.working, feed.total, INK.hot],
    ["ожидают", feed.idle, feed.total, INK.mid],
    ["ошибки", feed.error, feed.total, INK.warn],
  ];
  rings.forEach(([label, v, total, color], i) => {
    const cx = 16 + (col - 24) * ((i + 0.5) / 3);
    const cy = y0 + 70;
    p.ring(cx, cy, 44, total > 0 ? v / total : 0, 9, color);
    p.setFont(24, 800, SANS);
    p.text(String(v), cx, cy + 9, INK.white, "center");
    p.setFont(12, 600, SANS);
    p.text(label.toUpperCase(), cx, cy + 72, INK.mid, "center");
  });
  p.setFont(13, 500, SANS);
  p.text(`Всего агентов: ${feed.total}`, 30, y0 + 190, INK.text);
  p.text(`Загрузка штаба: ${Math.round(share(feed) * 100)}%`, 30, y0 + 212, INK.text);
  p.meter(30, y0 + 224, col - 60, 10, share(feed), INK.hot);
  p.setFont(12, 500, SANS);
  p.text(`Отделов: 10   Смена: дневная`, 30, y0 + 256, INK.dim);

  // 2. activity curve (the real working share over the last minutes)
  y0 = p.panel(col + 8, 58, col * 2 - 16, (h - 74) * 0.58, "активность штаба — последние минуты");
  p.chart(historyOr(feed, 120, t, 3), col + 22, y0 + 12, col * 2 - 44, (h - 74) * 0.58 - (y0 - 58) - 24, INK.hot);
  const by = 58 + (h - 74) * 0.58 + 10;
  y0 = p.panel(col + 8, by, col * 2 - 16, h - by - 16, "задачи по отделам");
  const depts = ["Исслед.", "Разраб.", "Аналит.", "Данные", "Дизайн", "DevOps", "QA", "Тексты", "План.", "Поддержка"];
  const bw = (col * 2 - 44) / depts.length;
  depts.forEach((d, i) => {
    const v = 0.25 + 0.7 * wave(t * 0.25, i * 1.7);
    const bh = (h - y0 - 46) * v;
    p.fill(col + 22 + i * bw + bw * 0.2, h - 40 - bh, bw * 0.6, bh, i === Math.floor(t / 4) % depts.length ? INK.hot : INK.mid);
    p.setFont(11, 500, SANS);
    p.text(d, col + 22 + i * bw + bw / 2, h - 24, INK.dim, "center");
  });

  // 3. live events
  y0 = p.panel(col * 3, 58, col - 16, h - 74, "события — в реальном времени");
  const lines = eventLines(feed, Math.floor((h - y0 - 30) / 22), t);
  lines.forEach((e, i) => {
    const y = y0 + 22 + i * 22;
    p.setFont(12, 500, MONO);
    p.text(e.time, col * 3 + 12, y, INK.dim);
    p.setFont(13, 700, SANS);
    const nw = p.text(e.name, col * 3 + 84, y, e.hot ? INK.warn : INK.white);
    p.setFont(12.5, 400, SANS);
    p.text(e.text, col * 3 + 92 + nw, y, e.hot ? INK.warn : INK.text);
  });
}

// --- executive wall screen in AM7's office -----------------------------------------------------
export function paintExecWall(p: Painter, t: number, feed: HqScreenFeed): void {
  const { w, h } = p;
  p.clear("#060102");
  p.setFont(13, 700, SANS);
  p.text("ОТЧЁТ ДЛЯ РУКОВОДИТЕЛЯ", 28, 36, INK.mid);
  p.setFont(30, 800, SANS);
  p.text("Штаб AM7 — сегодня", 28, 74, INK.white);
  p.setFont(15, 500, MONO);
  p.text(clockText(feed.clock), w - 28, 40, INK.hot, "right");
  const done = 8400 + Math.floor(t * 1.7) + feed.working * 3;
  const cards: Array<[string, string, string]> = [
    ["задач выполнено", done.toLocaleString("ru-RU"), "+12% к вчера"],
    ["успешность", `${(97.2 + wave(t * 0.05, 2) * 1.5).toFixed(1)}%`, "цель 97%"],
    ["средний ответ", `${Math.round(160 + wave(t * 0.1, 4) * 60)} мс`, "−38% за месяц"],
    ["агентов в сети", String(feed.total || 0), `${feed.working} в работе`],
  ];
  const cw = (w - 56 - 36) / 4;
  cards.forEach(([label, value, note], i) => {
    const x = 28 + i * (cw + 12);
    p.fill(x, 96, cw, 110, "#130405");
    p.fill(x, 96, 3, 110, i === 0 ? INK.hot : INK.dim);
    p.setFont(12, 600, SANS);
    p.text(label.toUpperCase(), x + 16, 122, INK.mid);
    p.setFont(34, 800, SANS);
    p.text(value, x + 16, 166, INK.white);
    p.setFont(12, 500, SANS);
    p.text(note, x + 16, 192, i === 2 ? INK.good : INK.dim);
  });
  let y0 = p.panel(28, 222, w * 0.62 - 28, h - 250, "выполнение задач за день");
  p.chart(series(64, t * 0.15, 11).map((v, i) => Math.min(1, v * 0.5 + i / 90)), 44, y0 + 16, w * 0.62 - 60, h - y0 - 60, INK.hot);
  y0 = p.panel(w * 0.62 + 12, 222, w * 0.38 - 40, h - 250, "лучшие агенты недели");
  for (let i = 0; i < 7; i++) {
    const y = y0 + 28 + i * 30;
    if (y > h - 40) break;
    const name = feed.names.length > 0 ? feed.names[Math.floor(hash2(i, 77) * feed.names.length)] : pick(["Nova", "Vex", "Rune", "Kade"], hash2(i, 5));
    p.setFont(15, 700, SANS);
    p.text(`${i + 1}. ${name}`, w * 0.62 + 28, y, i === 0 ? INK.hot : INK.white);
    p.setFont(13, 500, MONO);
    p.text(String(Math.round(420 - i * 37 + wave(t * 0.02, i) * 10)), w - 56, y, INK.text, "right");
  }
}

// --- lounge: a news channel ----------------------------------------------------------------------
export function paintNews(p: Painter, t: number, feed: HqScreenFeed): void {
  const { w, h } = p;
  const c = p.ctx;
  p.clear("#070102");
  // studio backdrop
  const g = c.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, "#2a0508");
  g.addColorStop(0.6, "#0d0203");
  g.addColorStop(1, "#1c0406");
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  // a spinning wireframe globe as the story visual
  const gx = w * 0.72;
  const gy = h * 0.42;
  const r = h * 0.28;
  c.lineWidth = 1.2;
  c.strokeStyle = "#ff5b4b66";
  c.beginPath();
  c.arc(gx, gy, r, 0, Math.PI * 2);
  c.stroke();
  for (let k = 0; k < 8; k++) {
    const a = ((k / 8) * Math.PI + t * 0.3) % Math.PI;
    c.beginPath();
    c.ellipse(gx, gy, Math.abs(Math.cos(a)) * r, r, 0, 0, Math.PI * 2);
    c.stroke();
  }
  for (let k = 1; k < 6; k++) {
    const yy = gy - r + (2 * r * k) / 6;
    const rr = Math.sqrt(Math.max(0, r * r - (yy - gy) * (yy - gy)));
    c.beginPath();
    c.ellipse(gx, yy, rr, rr * 0.12, 0, 0, Math.PI * 2);
    c.stroke();
  }
  // channel bug and LIVE
  p.fill(24, 22, 150, 34, "#c0141a");
  p.setFont(18, 900, SANS);
  p.text("HQ NEWS 24", 36, 46, "#fff1ee");
  const blink = Math.floor(t * 1.5) % 2 === 0;
  p.fill(184, 22, 74, 34, blink ? "#ff3030" : "#7a0a0c");
  p.setFont(15, 800, SANS);
  p.text("● LIVE", 194, 45, "#fff1ee");
  p.setFont(16, 600, MONO);
  p.text(clockText(feed.clock).slice(0, 5), w - 28, 46, INK.white, "right");
  // headline card
  const story = Math.floor(t / 7) % NEWS_HEADLINES.length;
  const slide = Math.min(1, (t % 7) / 0.6);
  const hx = 24 - (1 - slide) * 60;
  p.fill(hx, h * 0.6, w * 0.66, 92, "#0b0203ee");
  p.fill(hx, h * 0.6, 6, 92, "#ff3030");
  p.setFont(13, 800, SANS);
  p.text("ГЛАВНОЕ", hx + 22, h * 0.6 + 26, "#ff5b4b");
  p.setFont(24, 800, SANS);
  const head = NEWS_HEADLINES[story];
  p.text(head.length > 46 ? `${head.slice(0, 45)}…` : head, hx + 22, h * 0.6 + 60, "#fff1ee");
  p.setFont(14, 500, SANS);
  p.text(`В сети ${feed.total} агентов · ${feed.working} работают прямо сейчас`, hx + 22, h * 0.6 + 82, INK.mid);
  // ticker
  p.fill(0, h - 44, w, 44, "#c0141a");
  p.fill(0, h - 44, 120, 44, "#7a0a0c");
  p.setFont(15, 900, SANS);
  p.text("СРОЧНО", 22, h - 16, "#fff1ee");
  c.save();
  c.beginPath();
  c.rect(120, h - 44, w - 120, 44);
  c.clip();
  p.setFont(17, 700, SANS);
  const tw = c.measureText(NEWS_TICKER).width;
  const x = 130 - ((t * 90) % tw);
  p.text(NEWS_TICKER, x, h - 15, "#fff1ee");
  p.text(NEWS_TICKER, x + tw, h - 15, "#fff1ee");
  c.restore();
}

// --- lounge: a security monitor ------------------------------------------------------------------
export function paintSecurity(p: Painter, t: number, feed: HqScreenFeed): void {
  const { w, h } = p;
  const c = p.ctx;
  p.clear("#040101");
  p.setFont(15, 800, SANS);
  p.text("КИБЕРМОНИТОР · ПЕРИМЕТР", 24, 34, INK.white);
  p.setFont(13, 500, MONO);
  p.text(`угроз заблокировано: ${(18240 + Math.floor(t * 2.3)).toLocaleString("ru-RU")}`, w - 24, 34, INK.hot, "right");
  // radar
  const cx = w * 0.3;
  const cy = h * 0.56;
  const r = h * 0.36;
  c.strokeStyle = "#ff5b4b40";
  c.lineWidth = 1;
  for (let k = 1; k <= 4; k++) {
    c.beginPath();
    c.arc(cx, cy, (r * k) / 4, 0, Math.PI * 2);
    c.stroke();
  }
  c.beginPath();
  c.moveTo(cx - r, cy);
  c.lineTo(cx + r, cy);
  c.moveTo(cx, cy - r);
  c.lineTo(cx, cy + r);
  c.stroke();
  const sweep = (t * 1.3) % (Math.PI * 2);
  const grad = c.createConicGradient ? c.createConicGradient(sweep - 0.9, cx, cy) : null;
  if (grad) {
    grad.addColorStop(0, "#ff5b4b00");
    grad.addColorStop(0.14, "#ff5b4b55");
    grad.addColorStop(0.145, "#ff5b4b00");
    c.fillStyle = grad;
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fill();
  }
  c.strokeStyle = INK.hot;
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(cx, cy);
  c.lineTo(cx + Math.cos(sweep) * r, cy + Math.sin(sweep) * r);
  c.stroke();
  for (let i = 0; i < 14; i++) {
    const a = hash2(i, 3) * Math.PI * 2;
    const d = (0.2 + hash2(i, 5) * 0.75) * r;
    const age = (sweep - a + Math.PI * 4) % (Math.PI * 2);
    const glow = Math.max(0, 1 - age / 2.5);
    c.globalAlpha = 0.25 + glow * 0.75;
    p.fill(cx + Math.cos(a) * d - 3, cy + Math.sin(a) * d - 3, 6, 6, i % 5 === 0 ? INK.warn : INK.hot);
  }
  c.globalAlpha = 1;
  // event list
  const x0 = w * 0.58;
  p.panel(x0, 58, w - x0 - 24, h - 82, "журнал событий");
  p.setFont(12.5, 500, MONO);
  const rows = Math.floor((h - 120) / 20);
  const tick = Math.floor(t * 1.2);
  for (let i = 0; i < rows; i++) {
    const rng = makeRng((tick - i) * 97531);
    const ip = `${Math.floor(rng() * 223) + 1}.${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}`;
    const blocked = rng() < 0.7;
    const y = 104 + i * 20;
    p.text(clockText(feed.clock - i * 830), x0 + 12, y, INK.dim);
    p.text(ip.padEnd(16), x0 + 92, y, INK.white);
    p.text(blocked ? "БЛОК" : "ОК", w - 40, y, blocked ? INK.hot : INK.good, "right");
  }
}

// --- lounge: a music visualiser ------------------------------------------------------------------
export function paintMusic(p: Painter, t: number): void {
  const { w, h } = p;
  p.clear("#050101");
  const n = 48;
  const bw = (w - 80) / n;
  for (let i = 0; i < n; i++) {
    const v = 0.08 + 0.85 * Math.abs(Math.sin(t * (1.2 + (i % 7) * 0.31) + i * 0.7)) * (1 - i / (n * 1.4));
    const bh = v * (h - 170);
    p.fill(40 + i * bw + 1, h - 110 - bh, bw - 3, bh, i % 6 === 0 ? INK.hot : INK.mid);
    p.fill(40 + i * bw + 1, h - 106, bw - 3, bh * 0.25, "#ff5b4b30");
  }
  p.setFont(13, 700, SANS);
  p.text("СЕЙЧАС ИГРАЕТ", 40, 44, INK.mid);
  p.setFont(26, 800, SANS);
  p.text("Deep Focus — Night Shift Mix", 40, 80, INK.white);
  const len = 262;
  const pos = t % len;
  p.meter(40, h - 58, w - 80, 4, pos / len, INK.hot);
  p.setFont(13, 500, MONO);
  p.text(`${Math.floor(pos / 60)}:${String(Math.floor(pos % 60)).padStart(2, "0")}`, 40, h - 30, INK.dim);
  p.text("4:22", w - 40, h - 30, INK.dim, "right");
}

// --- the map wall's side panels ---------------------------------------------------------------------
export function paintMapLeft(p: Painter, t: number, feed: HqScreenFeed): void {
  const { w, h } = p;
  p.clear("#030001");
  p.setFont(22, 800, SANS);
  p.text("ГЛОБАЛЬНАЯ АКТИВНОСТЬ", 28, 40, INK.white);
  p.setFont(15, 500, MONO);
  p.text(`${clockText(feed.clock)}  ·  поток событий в реальном времени`, 28, 66, INK.mid);
  // big counters
  const counters: Array<[string, string]> = [
    ["агентов", String(feed.total)],
    ["в работе", String(feed.working)],
    ["задач/мин", String(Math.round(180 + share(feed) * 420 + wave(t * 0.2, 1) * 40))],
    ["ошибки", String(feed.error)],
  ];
  const cw = (w * 0.34) / 2;
  counters.forEach(([label, value], i) => {
    const x = 28 + (i % 2) * cw;
    const y = 96 + Math.floor(i / 2) * 118;
    p.fill(x, y, cw - 14, 104, "#0e0304");
    p.fill(x, y, 3, 104, i === 3 && feed.error > 0 ? INK.warn : INK.hot);
    p.setFont(14, 700, SANS);
    p.text(label.toUpperCase(), x + 16, y + 28, INK.mid);
    p.setFont(46, 800, SANS);
    p.text(value, x + 16, y + 84, i === 3 && feed.error > 0 ? INK.warn : INK.white);
  });
  p.setFont(14, 600, SANS);
  p.text(`ЗАГРУЗКА ШТАБА  ${Math.round(share(feed) * 100)}%`, 28, h - 60, INK.mid);
  p.meter(28, h - 46, w * 0.34 - 42, 14, share(feed), INK.hot);
  // event feed
  const fx = w * 0.36;
  const fw = w * 0.36;
  let y0 = p.panel(fx, 90, fw, h - 110, "лента событий", 14);
  const lines = eventLines(feed, Math.floor((h - y0 - 36) / 30), t);
  lines.forEach((e, i) => {
    const y = y0 + 30 + i * 30;
    p.setFont(15, 500, MONO);
    p.text(e.time, fx + 16, y, INK.dim);
    p.setFont(17, 700, SANS);
    const nw = p.text(e.name, fx + 112, y, e.hot ? INK.warn : INK.white);
    p.setFont(16, 400, SANS);
    p.text(e.text, fx + 124 + nw, y, e.hot ? INK.warn : INK.text);
  });
  // regional load
  const rx = w * 0.74;
  const rw = w - rx - 28;
  y0 = p.panel(rx, 90, rw, h - 110, "нагрузка по регионам", 14);
  REGIONS.forEach((region, i) => {
    const y = y0 + 34 + i * ((h - y0 - 60) / REGIONS.length);
    const v = 0.2 + 0.75 * wave(t * 0.3, i * 2.3);
    p.setFont(16, 600, MONO);
    p.text(region, rx + 16, y, INK.white);
    p.meter(rx + 150, y - 12, rw - 250, 14, v, i % 3 === 0 ? INK.hot : INK.mid);
    p.setFont(15, 500, MONO);
    p.text(`${Math.round(v * 100)}%`, rx + rw - 16, y, INK.text, "right");
  });
}

export function paintMapRight(p: Painter, t: number, feed: HqScreenFeed): void {
  const { w, h } = p;
  const c = p.ctx;
  p.clear("#030001");
  p.setFont(22, 800, SANS);
  p.text("СЕТЬ И ВЫЧИСЛЕНИЯ", w - 28, 40, INK.white, "right");
  p.setFont(15, 500, MONO);
  p.text(`кластер prod-eu · ${Math.round(96 + wave(t * 0.1, 7) * 4)}% узлов в строю`, w - 28, 66, INK.mid, "right");
  // world clocks
  const now = new Date(feed.clock);
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const cw = (w * 0.3) / 4;
  CITIES.forEach(([city, offset], i) => {
    const x = 28 + (i % 4) * cw;
    const y = 96 + Math.floor(i / 4) * 92;
    const local = new Date(utc + offset * 3600000);
    const hh = local.getHours();
    const mm = local.getMinutes();
    const cx = x + 30;
    const cy = y + 34;
    c.strokeStyle = INK.dim;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(cx, cy, 26, 0, Math.PI * 2);
    c.stroke();
    const ha = ((hh % 12) + mm / 60) * (Math.PI / 6) - Math.PI / 2;
    const ma = mm * (Math.PI / 30) - Math.PI / 2;
    c.strokeStyle = INK.white;
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx + Math.cos(ha) * 15, cy + Math.sin(ha) * 15);
    c.stroke();
    c.strokeStyle = INK.hot;
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx + Math.cos(ma) * 22, cy + Math.sin(ma) * 22);
    c.stroke();
    p.setFont(14, 700, SANS);
    p.text(city, x + 64, y + 28, INK.white);
    p.setFont(15, 500, MONO);
    p.text(`${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`, x + 64, y + 50, INK.mid);
  });
  // throughput charts
  const gx = w * 0.33;
  const gw = w * 0.34;
  let y0 = p.panel(gx, 90, gw, (h - 120) / 2, "входящий трафик, Гбит/с", 14);
  p.chart(series(90, t * 0.8, 21), gx + 14, y0 + 10, gw - 28, (h - 120) / 2 - (y0 - 90) - 20, INK.hot);
  const g2 = 90 + (h - 120) / 2 + 10;
  y0 = p.panel(gx, g2, gw, (h - 120) / 2, "исходящий трафик, Гбит/с", 14);
  p.chart(series(90, t * 0.7, 33), gx + 14, y0 + 10, gw - 28, (h - 120) / 2 - (y0 - g2) - 20, INK.warn);
  // heatmap: load per region over the last hours, shifting left every few seconds
  const hx = w * 0.69;
  const hw = w - hx - 28;
  y0 = p.panel(hx, 90, hw, h * 0.55, "нагрузка GPU по часам", 14);
  const cols = 24;
  const rows = REGIONS.length;
  const cellW = (hw - 110) / cols;
  const cellH = (h * 0.55 - (y0 - 90) - 24) / rows;
  const shift = Math.floor(t / 3);
  for (let r = 0; r < rows; r++) {
    p.setFont(12, 500, MONO);
    p.text(REGIONS[r], hx + 12, y0 + 12 + r * cellH + cellH * 0.6, INK.dim);
    for (let k = 0; k < cols; k++) {
      const v = hash2(r * 131 + k + shift, 17) * 0.6 + wave(k * 0.3 + shift * 0.1, r) * 0.4;
      const a = Math.round(20 + v * 235).toString(16).padStart(2, "0");
      p.fill(hx + 100 + k * cellW, y0 + 8 + r * cellH, cellW - 2, cellH - 2, `#ff3a2e${a}`);
    }
  }
  // gauges
  const gy = 90 + h * 0.55 + 12;
  y0 = p.panel(hx, gy, hw, h - gy - 20, "ресурсы кластера", 14);
  const gauges: Array<[string, number]> = [
    ["CPU", wave(t * 0.2, 1)],
    ["GPU", 0.55 + 0.4 * wave(t * 0.15, 2)],
    ["RAM", 0.4 + 0.3 * wave(t * 0.05, 3)],
    ["СЕТЬ", share(feed) * 0.8 + 0.1],
  ];
  gauges.forEach(([label, v], i) => {
    const cx = hx + hw * ((i + 0.5) / 4);
    const cy = y0 + (h - y0 - 20) / 2 - 4;
    const r = Math.min(hw / 10, (h - y0) / 3.2);
    p.ring(cx, cy, r, v, 8, i === 1 ? INK.hot : INK.mid);
    p.setFont(18, 800, SANS);
    p.text(`${Math.round(v * 100)}%`, cx, cy + 6, INK.white, "center");
    p.setFont(13, 700, SANS);
    p.text(label, cx, cy + r + 22, INK.mid, "center");
  });
}
