import { describe, expect, it } from "vitest";

import {
  resolveOfficeCallDirective,
  resolveOfficeDeskDirective,
  resolveOfficeGithubDirective,
  resolveOfficeGymCommandDirective,
  resolveOfficeGymDirective,
  resolveOfficeIntentSnapshot,
  resolveOfficeQaDirective,
  resolveOfficeStandupDirective,
  resolveOfficeTextDirective,
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

  it("звонит_и_передаёт_сообщение", () => {
    expect(resolveOfficeCallDirective("Позвони маме и скажи, что я опоздаю")).toEqual({
      callee: "маме",
      message: "что я опоздаю",
      phase: "ready_to_call",
    });
    expect(resolveOfficeCallDirective("позвони Ивану, передай ему: встреча в пять")).toEqual({
      callee: "ивану",
      message: "встреча в пять",
      phase: "ready_to_call",
    });
    expect(resolveOfficeCallDirective("набери +79001234567")).toEqual({
      callee: "+79001234567",
      message: null,
      phase: "needs_message",
    });
    expect(resolveOfficeCallDirective("позвони мне")).toBeNull();
    expect(resolveOfficeCallDirective("подумай над звонками")).toBeNull();
  });

  it("пишет_сообщение_только_когда_оно_названо", () => {
    expect(resolveOfficeTextDirective("напиши сообщение Ивану, что встреча переносится")).toEqual({
      recipient: "ивану",
      message: "встреча переносится",
      phase: "ready_to_send",
    });
    expect(resolveOfficeTextDirective("отправь смс маме: буду поздно")).toEqual({
      recipient: "маме",
      message: "буду поздно",
      phase: "ready_to_send",
    });
    expect(resolveOfficeTextDirective("напиши в ватсап Олегу")).toEqual({
      recipient: "олегу",
      message: null,
      phase: "needs_message",
    });
    // Без слова «сообщение» это просьба написать код, а не письмо.
    expect(resolveOfficeTextDirective("напиши тесты")).toBeNull();
    expect(resolveOfficeTextDirective("напиши мне сообщение")).toBeNull();
  });

  it("по_прежнему_понимает_английский", () => {
    expect(resolveOfficeDeskDirective("Go to your desk.")).toBe("desk");
    expect(resolveOfficeIntentSnapshot("Let's go to the gym.").gym).toEqual({
      directive: "gym",
      source: "manual",
    });
  });
});
