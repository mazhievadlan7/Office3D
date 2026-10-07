import { describe, expect, it } from "vitest";

import { parseWhiteboardCommand } from "@/features/hq/geo/whiteboard";

describe("whiteboard · pin commands", () => {
  it("recognises «отметь Москву»", () => {
    const action = parseWhiteboardCommand("отметь Москву");
    expect(action).toEqual(expect.objectContaining({ type: "pin", lat: 55.7558, lon: 37.6176, label: "Москва" }));
  });

  it("recognises «пометь Берлин как Цель»", () => {
    const action = parseWhiteboardCommand("пометь Берлин как Цель");
    expect(action).toEqual(expect.objectContaining({ type: "pin", label: "Цель" }));
    if (action?.type === "pin") {
      expect(action.lat).toBeCloseTo(52.52, 2);
      expect(action.lon).toBeCloseTo(13.405, 2);
    }
  });

  it("recognises a bare city name as a pin", () => {
    const action = parseWhiteboardCommand("Токио");
    expect(action).toEqual(expect.objectContaining({ type: "pin", label: "Токио" }));
  });
});

describe("whiteboard · arc commands", () => {
  it("recognises «нарисуй дугу от Москвы до Берлина»", () => {
    const action = parseWhiteboardCommand("нарисуй дугу от Москвы до Берлина");
    expect(action?.type).toBe("arc");
    if (action?.type === "arc") {
      expect(action.from.label).toBe("Москва");
      expect(action.to.label).toBe("Берлин");
    }
  });

  it("recognises «проведи линию от Парижа до Токио»", () => {
    const action = parseWhiteboardCommand("проведи линию от Парижа до Токио");
    expect(action?.type).toBe("arc");
    if (action?.type === "arc") {
      expect(action.from.label).toBe("Париж");
      expect(action.to.label).toBe("Токио");
    }
  });

  it("returns null when one of the places is unknown", () => {
    const action = parseWhiteboardCommand("нарисуй дугу от Моросомаа до Берлина");
    expect(action).toBeNull();
  });
});

describe("whiteboard · relabel and clear", () => {
  it("recognises «подпиши точку АГЕНТ-07»", () => {
    const action = parseWhiteboardCommand("подпиши точку АГЕНТ-07");
    expect(action).toEqual({ type: "relabel-last", label: "АГЕНТ-07" });
  });

  it("recognises «очисти доску»", () => {
    expect(parseWhiteboardCommand("очисти доску")).toEqual({ type: "clear" });
    expect(parseWhiteboardCommand("сотри всё")).toEqual({ type: "clear" });
  });

  it("returns null on an unrelated phrase", () => {
    expect(parseWhiteboardCommand("что сегодня на обед")).toBeNull();
    expect(parseWhiteboardCommand("")).toBeNull();
  });
});
