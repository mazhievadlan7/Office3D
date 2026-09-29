import { describe, expect, it } from "vitest";

import {
  OP_LOG_MAX,
  OP_STALE_MS,
  demoOperation,
  isOperationStale,
  operationReducer,
  parseStepMarks,
  planSteps,
  type HqOperation,
  type HqOperationEvent,
} from "@/features/hq/core/operation";
import { paintOperationBanner, paintOperationPlan, paintOperationTask } from "@/features/hq/render/screens/screenOperation";
import { Painter, type Ctx2D, type HqScreenOperation } from "@/features/hq/render/screens/screenPaint";
import { BANNER_H, BANNER_W, MAP_H, MAP_W } from "@/features/hq/render/screens/screenSurfaces";

const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);

function run(events: HqOperationEvent[], start: HqOperation | null = null): HqOperation | null {
  return events.reduce<HqOperation | null>((op, event) => operationReducer(op, event), start);
}

const begin: HqOperationEvent = { type: "begin", id: "op-1", task: "Проверить стенд", crew: 3, lead: "AM7", at: T0 };
const planReply = "Цель: карта поверхности\nПлан:\n1. Разведка\n2. Сканирование\n3. Отчёт";

describe("parseStepMarks", () => {
  it("reads «Шаг N — выполнен» and «Этап N/M: в работе» and «Шаг N: блок»", () => {
    expect(parseStepMarks("Шаг 1 — выполнен", 3)).toEqual([{ index: 0, state: "done" }]);
    expect(parseStepMarks("Этап 2/3: в работе", 3)).toEqual([{ index: 1, state: "active" }]);
    expect(parseStepMarks("Шаг 3: блок", 3)).toEqual([{ index: 2, state: "blocked" }]);
    expect(parseStepMarks("шаг 2 заблокирован", 3)).toEqual([{ index: 1, state: "blocked" }]);
    expect(parseStepMarks("Шаг 2 — готово", 3)).toEqual([{ index: 1, state: "done" }]);
  });

  it("reads checklists «[x] N» and «✅ N.»", () => {
    expect(parseStepMarks("[x] 1", 3)).toEqual([{ index: 0, state: "done" }]);
    expect(parseStepMarks("✅ 2. Сканирование", 3)).toEqual([{ index: 1, state: "done" }]);
    expect(parseStepMarks("[ ] 3 ещё не начато", 3)).toEqual([]);
  });

  it("reads several marks in one message and keeps the last state per step", () => {
    expect(parseStepMarks("шаг 1 выполнен, шаг 2 в работе", 3)).toEqual([
      { index: 0, state: "done" },
      { index: 1, state: "active" },
    ]);
    // "выполняется" is active, not done (it must not match the done rule first).
    expect(parseStepMarks("Шаг 2 выполняется", 3)).toEqual([{ index: 1, state: "active" }]);
    // A later clause about the same step wins.
    expect(parseStepMarks("шаг 1 в работе; шаг 1 выполнен", 3)).toEqual([{ index: 0, state: "done" }]);
  });

  it("ignores numbers out of range, decimals and messages with no state word", () => {
    expect(parseStepMarks("Шаг 5 — выполнен", 3)).toEqual([]);
    expect(parseStepMarks("Шаг 2", 3)).toEqual([]);
    expect(parseStepMarks("версия 2.5 собрана", 3)).toEqual([]);
    expect(parseStepMarks("Шаг 1 — выполнен", 0)).toEqual([]);
  });
});

describe("planSteps (moved to core/operation)", () => {
  it("still parses a numbered plan", () => {
    expect(planSteps("1. Разведка\n2) Сканирование\n3. Отчёт")).toEqual({
      intro: "",
      steps: ["Разведка", "Сканирование", "Отчёт"],
    });
    expect(planSteps("Просто прозой без списка")).toBeNull();
  });
});

describe("operationReducer", () => {
  it("begins a live operation with the crew addressed and nothing done", () => {
    const op = run([begin])!;
    expect(op.state).toBe("live");
    expect(op.team).toEqual({ addressed: 3, started: 0, replied: 0, errors: 0 });
    expect(op.lead).toBe("working");
    expect(op.overall).toBe("live"); // AM7 is working out the plan
    expect(op.steps).toEqual([]);
    expect(op.log.map((l) => l.kind)).toEqual(["begin"]);
    expect(op.startedAt).toBe(T0);
  });

  it("takes the goal and steps from the lead's plan", () => {
    const op = run([begin, { type: "plan", text: planReply, who: "AM7", at: T0 + 1000 }])!;
    expect(op.goal).toBe("карта поверхности");
    expect(op.steps.map((s) => s.text)).toEqual(["Разведка", "Сканирование", "Отчёт"]);
    expect(op.steps.every((s) => s.state === "pending")).toBe(true);
    expect(op.activeStep).toBe(-1);
  });

  it("never advances a step without an explicit mark", () => {
    // Crew reactions and the passage of events do not move any step.
    const op = run([
      begin,
      { type: "plan", text: planReply, who: "AM7", at: T0 + 1000 },
      { type: "agentStarted", who: "Ирис", at: T0 + 2000 },
      { type: "agentReplied", who: "Ирис", at: T0 + 3000 },
      { type: "agentReplied", who: "Корвус", at: T0 + 4000 },
    ])!;
    expect(op.steps.every((s) => s.state === "pending")).toBe(true);
    expect(op.activeStep).toBe(-1);
    expect(op.team).toEqual({ addressed: 3, started: 1, replied: 2, errors: 0 });
  });

  it("moves a step only when the lead marks it, and picks the active one", () => {
    const op = run([
      begin,
      { type: "plan", text: planReply, who: "AM7", at: T0 + 1000 },
      { type: "leadMessage", text: "Шаг 1 — выполнен, шаг 2 в работе", who: "AM7", at: T0 + 5000 },
    ])!;
    expect(op.steps.map((s) => s.state)).toEqual(["done", "active", "pending"]);
    expect(op.activeStep).toBe(1);
    // A step-mark line each: two journal entries added.
    expect(op.log.filter((l) => l.kind.startsWith("step-")).map((l) => [l.kind, l.step])).toEqual([
      ["step-done", 1],
      ["step-active", 2],
    ]);
  });

  it("counts each crew agent once and clamps to the addressed count", () => {
    const op = run([
      begin,
      { type: "agentStarted", who: "Ирис", at: T0 + 1 },
      { type: "agentStarted", who: "Ирис", at: T0 + 2 },
      { type: "agentError", who: "Корвус", at: T0 + 3 },
    ])!;
    // (the hook fires distinct agents; the reducer still clamps defensively)
    expect(op.team.started).toBe(2);
    expect(op.team.errors).toBe(1);
    // A crew error is counted, but the operation's own status is «БЛОК» only
    // when a plan step is blocked or AM7 himself errors.
    expect(op.overall).toBe("live");
  });

  it("routes the lead's own status without touching the team counters", () => {
    const op = run([
      begin,
      { type: "agentReplied", who: "AM7", isLead: true, at: T0 + 1 },
      { type: "agentError", who: "AM7", isLead: true, at: T0 + 2 },
    ])!;
    expect(op.team.replied).toBe(0);
    expect(op.lead).toBe("error");
    expect(op.overall).toBe("blocked");
    expect(op.log.some((l) => l.kind === "error" && l.who === "AM7")).toBe(true);
  });

  it("completes on the complete event and reports «done»", () => {
    const op = run([begin, { type: "complete", at: T0 + 10_000 }])!;
    expect(op.state).toBe("complete");
    expect(op.overall).toBe("done");
    expect(run([begin, { type: "complete", at: T0 + 1 }, { type: "complete", at: T0 + 2 }])!.log.filter((l) => l.kind === "complete")).toHaveLength(1);
  });

  it("goes done when every step is marked done", () => {
    const op = run([
      begin,
      { type: "plan", text: planReply, who: "AM7", at: T0 + 1 },
      { type: "leadMessage", text: "шаг 1 выполнен; шаг 2 выполнен; шаг 3 выполнен", who: "AM7", at: T0 + 2 },
    ])!;
    expect(op.steps.every((s) => s.state === "done")).toBe(true);
    expect(op.overall).toBe("done");
  });

  it("clears on dismiss", () => {
    expect(run([begin, { type: "dismiss", at: T0 + 1 }])).toBeNull();
    // Events on no operation are ignored (begin excepted).
    expect(operationReducer(null, { type: "agentStarted", who: "X", at: T0 })).toBeNull();
  });

  it("keeps the journal to the last OP_LOG_MAX entries", () => {
    const events: HqOperationEvent[] = [begin];
    for (let i = 0; i < OP_LOG_MAX + 5; i++) events.push({ type: "agentStarted", who: `A${i}`, at: T0 + i });
    const op = run(events)!;
    expect(op.log).toHaveLength(OP_LOG_MAX);
    // The newest is kept.
    expect(op.log[op.log.length - 1].who).toBe(`A${OP_LOG_MAX + 4}`);
  });
});

describe("isOperationStale", () => {
  it("is stale after 20 min without an event, but not once complete", () => {
    const op = run([begin])!;
    expect(isOperationStale(op, T0 + OP_STALE_MS - 1)).toBe(false);
    expect(isOperationStale(op, T0 + OP_STALE_MS)).toBe(true);
    const done = run([begin, { type: "complete", at: T0 }])!;
    expect(isOperationStale(done, T0 + OP_STALE_MS)).toBe(false);
  });

  it("resets its clock on every real event", () => {
    const op = run([begin, { type: "agentStarted", who: "Ирис", at: T0 + 60_000 }])!;
    expect(op.lastEventAt).toBe(T0 + 60_000);
    expect(isOperationStale(op, T0 + 60_000 + OP_STALE_MS - 1)).toBe(false);
  });
});

describe("demoOperation", () => {
  it("builds a valid snapshot for the free wall preview", () => {
    const demo = demoOperation();
    expect(demo.state).toBe("live");
    expect(demo.steps.length).toBeGreaterThan(0);
    expect(typeof demo.rev).toBe("number");
    expect(demoOperation({ state: "complete" }).state).toBe("complete");
  });
});

// --- the «ХОД ЗАДАЧИ» painters (Canvas 2D, no three.js, no DOM) ---------------------------------

/** A 2D context that draws nothing and records every text, for the wall painters. */
class FakeContext {
  font = "10px sans-serif";
  fillStyle: unknown = "#000";
  strokeStyle: unknown = "#000";
  globalAlpha = 1;
  lineWidth = 1;
  lineCap = "butt";
  lineJoin = "miter";
  textAlign: CanvasTextAlign = "left";
  textBaseline = "alphabetic";
  letterSpacing = "0px";
  readonly texts: Array<{ text: string; left: number; right: number; y: number; size: number }> = [];
  constructor(readonly canvas: { width: number; height: number }) {}
  private size(): number {
    return Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 10);
  }
  measureText(text: string): { width: number } {
    return { width: text.length * this.size() * 0.55 };
  }
  fillText(text: string, x: number, y: number): void {
    const width = this.measureText(text).width;
    const left = this.textAlign === "right" ? x - width : this.textAlign === "center" ? x - width / 2 : x;
    this.texts.push({ text, left, right: left + width, y, size: this.size() });
  }
  createLinearGradient(): { addColorStop(): void } {
    return { addColorStop() {} };
  }
  createRadialGradient(): { addColorStop(): void } {
    return { addColorStop() {} };
  }
  fillRect(): void {}
  strokeRect(): void {}
  beginPath(): void {}
  closePath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  arc(): void {}
  arcTo(): void {}
  roundRect(): void {}
  quadraticCurveTo(): void {}
  fill(): void {}
  stroke(): void {}
  save(): void {}
  restore(): void {}
}

function paintInto(w: number, h: number, paint: (p: Painter) => void): FakeContext {
  const ctx = new FakeContext({ width: w, height: h });
  paint(new Painter(ctx as unknown as Ctx2D, w, h));
  return ctx;
}

function screenOp(overrides: Partial<HqOperation> = {}): HqScreenOperation {
  const { id: key, ...rest } = demoOperation(overrides);
  return { ...rest, key, id: 7 };
}

describe("the «ХОД ЗАДАЧИ» wall painters", () => {
  const inside = (ctx: FakeContext, w: number, h: number) => {
    for (const s of ctx.texts) {
      expect(s.left, s.text).toBeGreaterThanOrEqual(-1);
      expect(s.right, s.text).toBeLessThanOrEqual(w + 1);
      expect(s.y, s.text).toBeGreaterThan(0);
      expect(s.y, s.text).toBeLessThanOrEqual(h);
    }
  };

  it("paints the task, the status line and the team bar on the west wing", () => {
    const op = screenOp();
    const ctx = paintInto(MAP_W, MAP_H, (p) => paintOperationTask(p, 1, op, op.startedAt + 761_000));
    const texts = ctx.texts.map((s) => s.text);
    expect(texts).toContain("ЗАДАЧА");
    expect(texts).toContain("В РАБОТЕ");
    expect(texts.some((s) => s.startsWith("T+00:12:41"))).toBe(true);
    expect(texts).toContain("АДРЕСОВАНО");
    inside(ctx, MAP_W, MAP_H);
  });

  it("paints the plan with per-step state and the journal on the east wing", () => {
    const op = screenOp();
    const ctx = paintInto(MAP_W, MAP_H, (p) => paintOperationPlan(p, 1, op));
    const texts = ctx.texts.map((s) => s.text);
    expect(texts).toContain("ПЛАН");
    expect(texts).toContain("ЖУРНАЛ"); // the label helper upper-cases its text
    expect(texts.some((s) => s.includes("выполнен") || s.includes("ответил"))).toBe(true);
    inside(ctx, MAP_W, MAP_H);
  });

  it("paints the goal, the live tag and «ЭТАП n/M» on the banner", () => {
    const op = screenOp();
    const ctx = paintInto(BANNER_W, BANNER_H, (p) => paintOperationBanner(p, 1, op));
    const texts = ctx.texts.map((s) => s.text);
    expect(texts).toContain("ЦЕЛЬ");
    expect(texts).toContain("ХОД ЗАДАЧИ · AM7");
    expect(texts.some((s) => s.startsWith("ЭТАП 2/4"))).toBe(true);
    inside(ctx, BANNER_W, BANNER_H);
  });

  it("shows «ЗАДАЧА ЗАВЕРШЕНА» when complete and the hand-off frame at the end", () => {
    const done = paintInto(MAP_W, MAP_H, (p) => paintOperationTask(p, 1, screenOp({ state: "complete" }), Date.now()));
    expect(done.texts.some((s) => s.text.includes("ЗАВЕРШЕНА"))).toBe(true);
    const handoff = paintInto(MAP_W, MAP_H, (p) => paintOperationPlan(p, 1, screenOp({ state: "handoff" })));
    expect(handoff.texts.some((s) => s.text === "ЗАВЕРШЕНО")).toBe(true);
  });
});
