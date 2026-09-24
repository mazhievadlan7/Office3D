import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HermesControlProvider, type HermesControl } from "@/features/hermes/HermesControlContext";
import { HermesEndpointsSection } from "@/features/hermes/components/HermesEndpointsSection";

describe("HermesEndpointsSection", () => {
  afterEach(() => cleanup());

  it("finds_the_models_at_an_address_then_saves_and_uses_one", async () => {
    const endpoints: Array<Record<string, unknown>> = [];
    const call = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === "hermes.endpoints.list") return { endpoints };
      if (method === "hermes.endpoints.validate") {
        return String(params.baseUrl).includes("down")
          ? { ok: false, reachable: false, message: "Could not reach it.", models: [] }
          : { ok: true, reachable: true, message: "", models: ["llama3.1:8b", "qwen2.5:14b"] };
      }
      if (method === "hermes.endpoints.save") {
        endpoints.push({ id: "ollama", name: params.name, baseUrl: params.baseUrl, model: params.model, models: [], hasApiKey: false, isCurrent: true });
        return { ok: true, applied: ["default"], failed: [] };
      }
      throw new Error(method);
    });
    const control: HermesControl = { available: true, call: call as HermesControl["call"], onEvent: () => () => {} };
    render(createElement(HermesControlProvider, { value: control }, createElement(HermesEndpointsSection, { agentId: "main" })));

    fireEvent.click(await screen.findByText("Добавить адрес"));
    fireEvent.change(screen.getByLabelText("Адрес сервера модели"), { target: { value: "http://down:1/v1" } });
    fireEvent.click(screen.getByText("Найти модели"));
    expect(await screen.findByText("Could not reach it.")).toBeTruthy();
    expect((screen.getByText("Сохранить и использовать") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Название, например «Ollama дома»"), { target: { value: "Ollama" } });
    fireEvent.change(screen.getByLabelText("Адрес сервера модели"), { target: { value: "http://host.docker.internal:11434/v1" } });
    fireEvent.click(screen.getByText("Найти модели"));
    expect(await screen.findByText("Найдено моделей: 2.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Модель"), { target: { value: "qwen2.5:14b" } });
    fireEvent.click(screen.getByText("Сохранить и использовать"));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("hermes.endpoints.save", {
        agentId: "main", name: "Ollama", baseUrl: "http://host.docker.internal:11434/v1", apiKey: "", model: "qwen2.5:14b", useNow: true,
      }),
    );
    expect(await screen.findByText("используется")).toBeTruthy();
  });
});
