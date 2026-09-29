import { describe, expect, it } from "vitest";
import { BRIEFING_LIMITS, briefingScreens } from "@/features/hq/core/briefing";

describe("briefingScreens", () => {
  it("takes the goal and the plan from AM7's «Цель: … План: …» answer", () => {
    const s = briefingScreens(
      "Провести разведку внешнего периметра",
      "Цель: карта внешнего периметра заказчика. План: 1) пассивная разведка DNS, 2) проверка сервисов в скоупе, 3) отчёт к 18:00.",
    );
    expect(s.task).toBe("Провести разведку внешнего периметра");
    expect(s.goal).toBe("карта внешнего периметра заказчика.");
    expect(s.plan).toBe("1) пассивная разведка DNS,\n2) проверка сервисов в скоупе,\n3) отчёт к 18:00.");
  });

  it("reads markdown and line breaks", () => {
    const s = briefingScreens("Задача", "**Цель:** закрыть критичные уязвимости\n\n**План:**\n1. Приоритизация\n2. Патчи\n3. Перепроверка");
    expect(s.goal).toBe("закрыть критичные уязвимости");
    expect(s.plan).toBe("1. Приоритизация\n2. Патчи\n3. Перепроверка");
  });

  it("splits a free answer into a first-sentence goal and the rest", () => {
    const s = briefingScreens("Задача", "Берём аудит конфигураций. Начнём с периметра, затем внутренняя сеть.");
    expect(s.goal).toBe("Берём аудит конфигураций.");
    expect(s.plan).toBe("Начнём с периметра, затем внутренняя сеть.");
  });

  it("works before the answer arrives and with a plan alone", () => {
    expect(briefingScreens("Задача", "")).toEqual({ task: "Задача", goal: "", plan: "" });
    const s = briefingScreens("Задача", "Понял. План: 1) раз 2) два");
    expect(s.goal).toBe("Понял.");
    expect(s.plan).toBe("1) раз\n2) два");
  });

  it("cuts long texts on a word with an ellipsis", () => {
    const long = "слово ".repeat(200);
    const s = briefingScreens(long, `Цель: ${long} План: ${long}`);
    expect(s.task.length).toBeLessThanOrEqual(BRIEFING_LIMITS.task);
    expect(s.goal.length).toBeLessThanOrEqual(BRIEFING_LIMITS.goal);
    expect(s.plan.length).toBeLessThanOrEqual(BRIEFING_LIMITS.plan);
    expect(s.task.endsWith("…")).toBe(true);
  });
});
