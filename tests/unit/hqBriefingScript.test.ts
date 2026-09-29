import { describe, expect, it } from "vitest";

import { briefingParts } from "@/features/hq/core/briefing";
import { briefingCues, briefingWall, cueFocus, stepTitle } from "@/features/hq/core/briefingScript";
import { nextBriefing } from "@/features/hq/render/screens/screenBriefing";
import { canStartAddress, hallImpulse } from "@/lib/voice/briefingAddress";
import { splitSentences } from "@/lib/voice/speechChunks";

const REPLY =
  "Цель: карта внешнего периметра заказчика. План: 1) пассивная разведка DNS и сертификатов, " +
  "2) проверка сервисов в скоупе. Смотрите на экран: там список хостов. 3) отчёт к 18:00.";

describe("AM7's briefing, sentence by sentence", () => {
  it("says the goal, then the plan step by step, each sentence tied to its plan step", () => {
    const cues = briefingCues(REPLY);
    expect(cues.map((c) => c.speech)).toEqual([
      "Цель: карта внешнего периметра заказчика.",
      "План. Первое: пассивная разведка DNS и сертификатов.",
      "Второе: проверка сервисов в скоупе.",
      "Смотрите на экран: там список хостов.",
      "Третье: отчёт к 18:00.",
    ]);
    expect(cues.map((c) => c.section)).toEqual(["goal", "step", "step", "step", "step"]);
    expect(cues.map((c) => c.step)).toEqual([-1, 0, 1, 1, 2]);
    expect(cues.every((c) => c.steps === 3)).toBe(true);
    expect(cues.map((c) => c.index)).toEqual([0, 1, 2, 3, 4]);
    // He shows the wall when a step opens and when a sentence mentions the screen; faces the rows for the goal.
    expect(cues.map((c) => c.point)).toEqual([false, true, true, true, true]);
    expect(cues.map((c) => c.opens)).toEqual([true, true, true, false, true]);
    // The sentence without what he says before it.
    expect(cues[1].text).toBe("пассивная разведка DNS и сертификатов.");
  });

  it("reads markdown lists, keeps a plan's own lead-in, and never repeats the goal", () => {
    const md = briefingCues("**Цель:** закрыть критичные уязвимости\n\n**План:**\nСначала главное.\n1. Приоритизация\n2. Патчи\n3. Перепроверка");
    expect(md.map((c) => c.speech)).toEqual([
      "Цель: закрыть критичные уязвимости.",
      "План: сначала главное.",
      "Первое: приоритизация.",
      "Второе: патчи.",
      "Третье: перепроверка.",
    ]);
    expect(md.map((c) => c.step)).toEqual([-1, -1, 0, 1, 2]);
    expect(md[1]).toMatchObject({ section: "plan", point: true });
    // An unnamed goal is said as it is, not as «Цель: понял.».
    const plain = briefingCues("Понял. План: 1) раз 2) два");
    expect(plain.map((c) => c.speech)).toEqual(["Понял.", "План. Первое: раз.", "Второе: два."]);
    // A goal that is only the plan's first sentence is said once, with the plan.
    const free = briefingCues("Берём аудит конфигураций. Начнём с периметра, затем внутренняя сеть.");
    expect(free.map((c) => c.speech)).toEqual(["Берём аудит конфигураций.", "План: начнём с периметра, затем внутренняя сеть."]);
  });

  it("finds a step named in prose, and has nothing to say for an empty answer", () => {
    const prose = briefingCues("Цель: проверить VPN. План: сначала инвентаризация. Шаг 2 возьмёт Лазарь.");
    expect(prose.map((c) => c.section)).toEqual(["goal", "plan", "plan"]);
    expect(prose[2].step).toBe(1);
    expect(briefingCues("")).toEqual([]);
    expect(briefingCues("   ")).toEqual([]);
  });

  it("keeps the whole answer for speech (the screens cut it)", () => {
    const long = "слово ".repeat(80).trim();
    const parts = briefingParts(`Цель: ${long}. План: 1) раз 2) два`);
    expect(parts.goal.length).toBeGreaterThan(400);
    expect(parts.goalNamed).toBe(true);
    const cues = briefingCues(`Цель: ${long}. План: 1) раз 2) два`);
    // A sentence too long for one request is cut at word boundaries, all of it said.
    const said = cues.filter((c) => c.section === "goal").map((c) => c.text.replace(/[.]$/, "")).join(" ");
    expect(said.replace(/\s+/g, " ")).toContain(long.slice(0, 200));
  });

  it("splits sentences, merging a lone short word into the next", () => {
    expect(splitSentences("Так. Начинаем разведку периметра. Вопросы есть?")).toEqual(["Так. Начинаем разведку периметра.", "Вопросы есть?"]);
    // A short last word goes with the sentence before it.
    expect(splitSentences("Начинаем разведку периметра. Вперёд!")).toEqual(["Начинаем разведку периметра. Вперёд!"]);
    expect(splitSentences("")).toEqual([]);
  });

  it("titles a step by its first clause, short", () => {
    expect(stepTitle("пассивная разведка DNS: сабдомены и сертификаты")).toBe("Пассивная разведка DNS");
    expect(stepTitle("сканирование — только порты из скоупа")).toBe("Сканирование");
    const long = stepTitle("очень длинное описание шага без знаков препинания которое никак не помещается в заголовок экрана");
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("the video wall follows the sentence being heard", () => {
  const TASK = "Провести разведку внешнего периметра";
  const cues = briefingCues(REPLY);

  it("puts the hold up until the floor has gathered, and nothing singled out before he speaks", () => {
    const wall = briefingWall(TASK, REPLY, -1, { gathered: 12, expected: 40 }, cues);
    expect(wall.hold).toEqual({ gathered: 12, expected: 40 });
    expect(wall.focus).toBeUndefined();
    expect(wall.task).toBe(TASK);
    expect(wall.plan).toContain("1) пассивная разведка");
  });

  it("lights the step being talked about, its number and title, the goal on the goal", () => {
    const goal = briefingWall(TASK, REPLY, 0, null, cues);
    expect(goal.focus).toMatchObject({ section: "goal", label: "ЦЕЛЬ", title: "карта внешнего периметра заказчика." });
    const step1 = briefingWall(TASK, REPLY, 1, null, cues);
    expect(step1.focus).toMatchObject({ section: "step", step: 0, steps: 3, label: "ШАГ 1 / 3", title: "Пассивная разведка DNS и сертификатов" });
    // The screen mention inside step 2 keeps step 2 lit.
    expect(briefingWall(TASK, REPLY, 3, null, cues).focus).toMatchObject({ step: 1, label: "ШАГ 2 / 3" });
    expect(briefingWall(TASK, REPLY, 4, null, cues).focus).toMatchObject({ step: 2, label: "ШАГ 3 / 3" });
    // Past the end: nothing singled out.
    expect(briefingWall(TASK, REPLY, 99, null, cues).focus).toBeUndefined();
    expect(cueFocus(undefined, "")).toBeNull();
  });

  it("repaints the wall exactly when the sentence (or the hold) changes", () => {
    const at = (cue: number, hold: { gathered: number; expected: number } | null = null) => briefingWall(TASK, REPLY, cue, hold, cues);
    const waiting = nextBriefing(null, at(-1, { gathered: 3, expected: 9 }), 1)!;
    expect(waiting.hold).toEqual({ gathered: 3, expected: 9 });
    expect(nextBriefing(waiting, at(-1, { gathered: 3, expected: 9 }), 2)).toBe(waiting);
    const more = nextBriefing(waiting, at(-1, { gathered: 4, expected: 9 }), 2)!;
    expect(more.id).toBe(2);
    const first = nextBriefing(more, at(1), 3)!;
    expect(first.id).toBe(3);
    expect(first.hold).toBeUndefined();
    expect(first.focus?.step).toBe(0);
    // The same sentence again: the same picture, no repaint.
    expect(nextBriefing(first, at(1), 4)).toBe(first);
    // The next step: a new picture at once.
    const second = nextBriefing(first, at(2), 4)!;
    expect(second.id).toBe(4);
    expect(second.focus?.step).toBe(1);
    // Done speaking: back to the plain briefing screens.
    expect(nextBriefing(second, at(-1), 5)?.focus).toBeUndefined();
  });
});

describe("AM7 on the PA begins only when he can say it all back to back", () => {
  const line = (chars: number, seconds: number | null) => ({ chars, seconds });

  it("waits for the first two sentences (or all, if fewer)", () => {
    expect(canStartAddress([line(40, 3), line(40, null), line(40, null)], 1)).toBe(false);
    expect(canStartAddress([line(40, 3)], 1000)).toBe(true);
    expect(canStartAddress([], 1000)).toBe(true);
    expect(canStartAddress([line(40, null)], 1)).toBe(false);
  });

  it("begins when, at the rendering pace, the rest keep ahead of the voice", () => {
    // Rendered faster than spoken (10 ms per character vs ~75): go.
    expect(canStartAddress([line(40, 3), line(40, 3), line(40, null), line(40, null)], 10)).toBe(true);
    // Rendering 3.5x slower than speech: the third would come late, so wait.
    expect(canStartAddress([line(40, 3), line(40, 3), line(40, null), line(40, null)], 260)).toBe(false);
    // Once most are rendered, the last one is due late enough.
    expect(canStartAddress([line(40, 3), line(40, 3), line(40, 3), line(20, null)], 260)).toBe(true);
    // A sentence the service gave up on does not hold him back.
    expect(canStartAddress([line(40, 3), { chars: 40, seconds: null, failed: true }, line(40, 3)], 260)).toBe(true);
  });

  it("builds a short, decaying hall reverb", () => {
    const [left, right] = hallImpulse(8000, 1);
    expect(left.length).toBe(8000);
    expect(right.length).toBe(8000);
    const energy = (from: number, to: number) => left.slice(from, to).reduce((sum, v) => sum + v * v, 0);
    expect(energy(100, 1100)).toBeGreaterThan(energy(6000, 7000) * 20);
    expect(left[0]).toBe(0);
  });
});
