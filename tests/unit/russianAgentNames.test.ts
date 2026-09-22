import { describe, expect, it, vi } from "vitest";

import type { GatewayClient } from "@/lib/gateway/GatewayClient";
import { createGatewayAgent, slugifyAgentName } from "@/lib/gateway/agentConfig";
import { hasCyrillic, transliterate } from "@/lib/text/transliterate";

/**
 * A Russian office has Russian agent names, and OpenClaw refuses them:
 * agents.create derives the id from the name and accepts only a-z, 0-9, "_"
 * and "-". Before this, creating «Новый агент» — now the default name —
 * failed with "has no valid id characters".
 */

const configSnapshot = {
  exists: true,
  hash: "h1",
  path: "/home/office/.openclaw/openclaw.json",
  config: { agents: { list: [] } },
};

const gateway = (overrides: { update?: () => Promise<unknown> } = {}) => {
  const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "config.get") return configSnapshot;
    if (method === "agents.create") {
      // Mirrors OpenClaw's normalizeAgentIdStrict on the name it is given.
      const name = String(params?.name ?? "");
      const id = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
      if (!id) throw new Error(`Agent name "${name}" has no valid id characters.`);
      return { ok: true, agentId: id, name, workspace: String(params?.workspace) };
    }
    if (method === "agents.update") {
      return overrides.update ? overrides.update() : { ok: true, agentId: params?.agentId };
    }
    throw new Error(`unexpected ${method}`);
  });
  return { client: { call } as unknown as GatewayClient, call };
};

describe("transliterate", () => {
  it("turns_russian_into_a_readable_latin_form", () => {
    expect(transliterate("новый агент")).toBe("novyy agent");
    expect(transliterate("Щука и Ёж")).toBe("Shchuka i Ezh");
    expect(transliterate("Бухгалтерия")).toBe("Bukhgalteriya");
  });

  it("drops_the_hard_and_soft_signs", () => {
    expect(transliterate("объём, связь")).toBe("obem, svyaz");
  });

  it("leaves_latin_digits_and_punctuation_alone", () => {
    expect(transliterate("Agent-2 (beta)")).toBe("Agent-2 (beta)");
  });

  it("detects_cyrillic", () => {
    expect(hasCyrillic("Агент 2")).toBe(true);
    expect(hasCyrillic("Agent 2")).toBe(false);
  });
});

describe("slugifyAgentName", () => {
  it("gives_a_russian_name_a_real_folder_name_instead_of_throwing", () => {
    expect(slugifyAgentName("Новый агент")).toBe("novyy-agent");
  });

  it("still_refuses_a_name_with_nothing_usable_in_any_alphabet", () => {
    expect(() => slugifyAgentName("!!!")).toThrow("Из имени не удалось получить имя папки.");
  });
});

describe("createGatewayAgent with a Russian name", () => {
  it("creates_under_a_latin_id_then_sets_the_russian_name", async () => {
    const { client, call } = gateway();

    const entry = await createGatewayAgent({ client, name: "Новый агент" });

    expect(entry).toEqual({ id: "novyy-agent", name: "Новый агент" });
    const create = call.mock.calls.find(([method]) => method === "agents.create");
    expect(create?.[1]).toMatchObject({
      name: "Novyy agent",
      workspace: "/home/office/.openclaw/workspace-novyy-agent",
    });
    // The display name is Russian; only the id is Latin.
    expect(call).toHaveBeenCalledWith("agents.update", {
      agentId: "novyy-agent",
      name: "Новый агент",
    });
  });

  it("does_not_rename_an_agent_whose_name_was_already_latin", async () => {
    const { client, call } = gateway();

    await createGatewayAgent({ client, name: "My Project" });

    expect(call.mock.calls.map(([method]) => method)).not.toContain("agents.update");
  });

  it("reports_the_agent_under_its_real_name_when_the_rename_fails", async () => {
    // The agent exists either way; throwing would hide it from the office
    // until the next refresh.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = gateway({
      update: () => Promise.reject(new Error("gateway restarting")),
    });

    const entry = await createGatewayAgent({ client, name: "Бухгалтер" });

    expect(entry).toEqual({ id: "bukhgalter", name: "Bukhgalter" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
