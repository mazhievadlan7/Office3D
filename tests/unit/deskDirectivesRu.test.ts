import { describe, expect, it } from "vitest";

import {
  resolveOfficeDeskDirective,
  resolveOfficeGithubDirective,
  resolveOfficeGymCommandDirective,
  resolveOfficeGymDirective,
  resolveOfficeIntentSnapshot,
  resolveOfficeQaDirective,
  resolveOfficeStandupDirective,
} from "@/lib/office/deskDirectives";

// The office is in Russian, so the commands people type to agents are too.
describe("русские команды офиса", () => {
  it("отправляет_агента_за_стол_и_отпускает", () => {
    for (const text of [
      "Иди к своему столу.",
      "вернись за стол",
      "Садись за свой стол!",
      "идите обратно на рабочее место",
      "назад к столу",
    ]) {
      expect(resolveOfficeDeskDirective(text), text).toBe("desk");
    }
    for (const text of ["можешь встать из-за стола", "прогуляйся", "иди погулять", "отойди от стола"]) {
      expect(resolveOfficeDeskDirective(text), text).toBe("release");
    }
    expect(resolveOfficeDeskDirective("столько всего сделали сегодня")).toBeNull();
  });

  it("ведёт_в_серверную_на_ревью", () => {
    for (const text of [
      "Проверь пул-реквесты",
      "давай посмотрим PR",
      "сделай ревью кода",
      "открой гитхаб",
      "иди в серверную",
      "есть ли новые пулл-реквесты?",
    ]) {
      expect(resolveOfficeGithubDirective(text), text).toBe("github");
    }
    expect(resolveOfficeGithubDirective("выйди из серверной")).toBe("release");
    expect(resolveOfficeGithubDirective("хватит ревью кода")).toBe("release");
  });

  it("отличает_спортзал_от_навыков", () => {
    expect(resolveOfficeGymCommandDirective("пойдём в спортзал")).toBe("gym");
    expect(resolveOfficeGymCommandDirective("иди потренируйся")).toBe("gym");
    expect(resolveOfficeGymCommandDirective("выйди из зала")).toBe("release");
    expect(resolveOfficeGymDirective("установи навык для погоды")).toBe("gym");
    expect(resolveOfficeGymDirective("хватит с навыками")).toBe("release");
  });

  it("понимает_подсказки_qa_лаборатории", () => {
    for (const text of [
      "напиши тесты",
      "запусти тесты",
      "проверь",
      "воспроизведи баг",
      "проверь, работает ли это",
      "протестируй сборку",
    ]) {
      expect(resolveOfficeQaDirective(text), text).toBe("qa_lab");
    }
    expect(resolveOfficeQaDirective("выйди из лаборатории")).toBe("release");
    expect(resolveOfficeQaDirective("хватит тестировать")).toBe("release");
    // «Проверь пул-реквесты» — это ревью, а не тесты.
    expect(resolveOfficeQaDirective("проверь пул-реквесты")).toBeNull();
  });

  it("собирает_планёрку", () => {
    expect(resolveOfficeStandupDirective("давайте проведём планёрку")).toBe("standup");
    expect(resolveOfficeStandupDirective("пора на стендап")).toBe("standup");
    expect(resolveOfficeStandupDirective("время собрания")).toBe("standup");
    expect(resolveOfficeStandupDirective("как прошло собрание вчера?")).toBeNull();
  });

  it("по_прежнему_понимает_английский", () => {
    expect(resolveOfficeDeskDirective("Go to your desk.")).toBe("desk");
    expect(resolveOfficeIntentSnapshot("Let's go to the gym.").gym).toEqual({
      directive: "gym",
      source: "manual",
    });
  });
});
