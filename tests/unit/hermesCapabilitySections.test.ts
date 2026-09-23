import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HermesControlProvider, type HermesControl } from "@/features/hermes/HermesControlContext";
import { HermesToolsetsSection } from "@/features/hermes/components/HermesToolsetsSection";
import { HermesMemorySection } from "@/features/hermes/components/HermesMemorySection";
import { HermesMcpSection } from "@/features/hermes/components/HermesMcpSection";

class CodedError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const mount = (element: ReturnType<typeof createElement>, handler: (method: string, params: Record<string, unknown>) => unknown) => {
  const call = vi.fn(async (method: string, params: Record<string, unknown> = {}) => handler(method, params));
  const control: HermesControl = { available: true, call: call as HermesControl["call"], onEvent: () => () => {} };
  render(createElement(HermesControlProvider, { value: control }, element));
  return call;
};

describe("Hermes capability sections", () => {
  afterEach(() => cleanup());

  it("toggles_a_toolset_and_keeps_the_main_agents_board_on", async () => {
    let browser = false;
    const rows = () => [
      { name: "browser", label: "Браузер", description: "", enabled: browser, configured: false, tools: ["browse"], locked: false },
      { name: "kanban", label: "Доска", description: "", enabled: true, configured: true, tools: [], locked: true },
    ];
    const call = mount(createElement(HermesToolsetsSection, { agentId: "main" }), (method, params) => {
      if (method === "hermes.toolsets.set") browser = params.enabled as boolean;
      return { toolsets: rows() };
    });
    expect(await screen.findByText("нужен ключ или настройка")).toBeTruthy();
    expect((screen.getByLabelText("Набор Доска включён") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Набор Браузер включён"));
    await waitFor(() => expect(call).toHaveBeenCalledWith("hermes.toolsets.set", { agentId: "main", name: "browser", enabled: true }));
    expect(await screen.findByText("Сохранено. Агент получит изменения со следующего хода.")).toBeTruthy();
  });

  it("edits_memory_and_reloads_when_the_agent_changed_it_meanwhile", async () => {
    let version = "v1";
    let entries = ["Любит краткость"];
    let conflict = false;
    const view = () => ({
      provider: null,
      targets: {
        memory: { entries, chars: entries.join("\n§\n").length, limit: 40, enabled: true, version },
        user: { entries: [], chars: 0, limit: 20, enabled: true, version: "u1" },
      },
    });
    const call = mount(createElement(HermesMemorySection, { agentId: "main" }), (method, params) => {
      if (method === "hermes.memory.set") {
        if (conflict) throw new CodedError("CONFLICT", "Пока вы правили, агент изменил свою память.");
        entries = params.entries as string[];
        version = "v2";
      }
      return view();
    });
    expect(await screen.findByText("Любит краткость")).toBeTruthy();
    fireEvent.click(screen.getAllByText("Изменить")[0]);
    fireEvent.click(screen.getByText("Добавить запись"));
    fireEvent.change(screen.getByLabelText("Запись 2"), { target: { value: "Сборка: npm run build" } });
    fireEvent.click(screen.getByText("Сохранить"));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("hermes.memory.set", { agentId: "main", target: "memory", entries: ["Любит краткость", "Сборка: npm run build"], version: "v1" }),
    );
    expect(await screen.findByText("Сборка: npm run build")).toBeTruthy();

    // Over the budget, saving is off.
    fireEvent.click(screen.getAllByText("Изменить")[1]);
    fireEvent.click(screen.getByText("Добавить запись"));
    fireEvent.change(screen.getByLabelText("Запись 1"), { target: { value: "x".repeat(21) } });
    expect((screen.getByText("Сохранить") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Отмена"));

    conflict = true;
    fireEvent.click(screen.getAllByText("Изменить")[0]);
    fireEvent.click(screen.getByText("Сохранить"));
    expect(await screen.findByText(/агент изменил свою память/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Сохранить")).toBeNull());
  });

  it("adds_a_server_with_a_token_and_leaves_the_offices_own_alone", async () => {
    const servers = [
      { name: "office3d_team", transport: "http", url: "http://office3d:3010/mcp/default", command: null, args: [], auth: "header", enabled: true, source: "config", plugin: null, managed: true },
    ];
    const call = mount(createElement(HermesMcpSection, { agentId: "main" }), (method, params) => {
      if (method === "hermes.mcp.list") return { servers };
      if (method === "hermes.mcp.add") {
        servers.push({ name: params.name as string, transport: "http", url: params.url as string, command: null, args: [], auth: "header", enabled: true, source: "config", plugin: null, managed: false });
        return { added: ["default"], failed: [] };
      }
      if (method === "hermes.mcp.test") return { ok: false, error: "Connection refused", tools: [] };
      throw new Error(method);
    });
    expect(await screen.findByText("доступ к офису")).toBeTruthy();
    expect(screen.queryByLabelText("Сервер office3d_team включён")).toBeNull();
    expect(screen.queryByText("Удалить")).toBeNull();

    fireEvent.click(screen.getByText("Добавить свой"));
    fireEvent.change(screen.getByLabelText("Имя сервера"), { target: { value: "docs" } });
    fireEvent.change(screen.getByLabelText("Адрес сервера"), { target: { value: "https://docs.example.com/mcp" } });
    fireEvent.change(screen.getByLabelText("Токен доступа (если нужен)"), { target: { value: "tok" } });
    fireEvent.click(screen.getByText("Добавить"));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("hermes.mcp.add", { agentId: "main", name: "docs", url: "https://docs.example.com/mcp", auth: "header", bearerToken: "tok" }),
    );
    expect(await screen.findByText("docs")).toBeTruthy();
    fireEvent.click(screen.getAllByText("Проверить")[1]);
    expect(await screen.findByText("Не отвечает: Connection refused")).toBeTruthy();
  });

  it("installs_a_catalog_server_that_runs_a_program_only_after_confirmation", async () => {
    const call = mount(createElement(HermesMcpSection, { agentId: "main" }), (method) => {
      if (method === "hermes.mcp.list") return { servers: [] };
      if (method === "hermes.mcp.catalog") {
        return {
          entries: [
            { name: "sqlite", description: "SQLite", transport: "stdio", authType: "none", requiredEnv: [{ name: "SQLITE_PATH", prompt: "Путь", required: true }], command: "uvx", args: ["mcp-server-sqlite"], url: null, installUrl: null, bootstrap: [], needsInstall: false, installed: false },
          ],
        };
      }
      if (method === "hermes.mcp.install") return { background: false, action: null };
      throw new Error(method);
    });
    fireEvent.click(await screen.findByText("Каталог Hermes"));
    fireEvent.click(await screen.findByText("Установить"));
    expect(screen.getByText("uvx mcp-server-sqlite")).toBeTruthy();
    const installButton = () => screen.getAllByText("Установить").at(-1) as HTMLButtonElement;
    expect(installButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("SQLITE_PATH"), { target: { value: "/d.db" } });
    fireEvent.click(screen.getByText("Я посмотрел, что запускается, и доверяю этому"));
    fireEvent.click(installButton());
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("hermes.mcp.install", { agentId: "main", name: "sqlite", env: { SQLITE_PATH: "/d.db" }, confirm: true }),
    );
    expect(await screen.findByText("Сервер установлен.")).toBeTruthy();
  });
});
