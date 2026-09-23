// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { createMcpHandler, startMcpServer, deriveMcpToken, validateArgs, ToolError } = await import("../../server/hermes/mcp.js");

const SECRET = "office3d-mcp-test-secret-0123456789abcdef";

type Rpc = { jsonrpc: string; id?: unknown; result?: Record<string, unknown>; error?: { code: number; message: string } };

describe("office3d mcp server", () => {
  let server: Awaited<ReturnType<typeof startMcpServer>>;
  let base: string;
  let profiles: Set<string>;
  const calls: Array<{ profile: string; args: unknown }> = [];

  beforeEach(async () => {
    profiles = new Set(["default", "analyst-1a2b3c"]);
    calls.length = 0;
    const echo = {
      name: "echo",
      description: "Echo",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", maxLength: 10 }, loud: { type: "boolean" } },
        required: ["text"],
        additionalProperties: false,
      },
      handler: async (args: { text: string }, ctx: { profile: string }) => {
        calls.push({ profile: ctx.profile, args });
        if (args.text === "refuse") throw new ToolError("Нельзя.");
        if (args.text === "crash") throw new Error("secret internals");
        return { text: `echo:${args.text}`, data: { text: args.text } };
      },
    };
    const handler = createMcpHandler({
      secret: SECRET,
      profileExists: async (profile: string) => profiles.has(profile),
      toolsFor: (profile: string) => (profile === "default" ? [echo, { ...echo, name: "boss_only" }] : [echo]),
    });
    server = await startMcpServer({ host: "127.0.0.1", port: 0, handler });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.close();
  });

  const post = (profile: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/mcp/${profile}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${deriveMcpToken(SECRET, profile)}`,
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  const rpc = async (profile: string, method: string, params: unknown = {}, id: unknown = 1) => {
    const res = await post(profile, { jsonrpc: "2.0", id, method, params });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    return (await res.json()) as Rpc;
  };

  it("negotiates_a_handshake_version_it_speaks", async () => {
    const offered = await rpc("default", "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(offered.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "office3d" } });
    const unknown = await rpc("default", "initialize", { protocolVersion: "2099-01-01" });
    expect(unknown.result?.protocolVersion).toBe("2025-11-25");
  });

  it("sends_stateless_discovery_back_to_the_handshake", async () => {
    const discover = await rpc("default", "server/discover", {});
    expect(discover.error?.code).toBe(-32601);
  });

  it("accepts_notifications_without_a_body_and_refuses_other_verbs", async () => {
    const note = await post("default", { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");
    const get = await fetch(`${base}/mcp/default`, { headers: { authorization: `Bearer ${deriveMcpToken(SECRET, "default")}` } });
    expect(get.status).toBe(405);
  });

  it("lets_each_agent_in_only_with_its_own_token", async () => {
    const stolen = await post("default", { jsonrpc: "2.0", id: 1, method: "tools/list" }, {
      authorization: `Bearer ${deriveMcpToken(SECRET, "analyst-1a2b3c")}`,
    });
    expect(stolen.status).toBe(401);
    const none = await post("default", { jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: "" });
    expect(none.status).toBe(401);
    const browser = await post("default", { jsonrpc: "2.0", id: 1, method: "tools/list" }, { origin: "http://evil.example" });
    expect(browser.status).toBe(403);
  });

  it("shuts_out_an_agent_that_left_the_team", async () => {
    profiles.delete("analyst-1a2b3c");
    const res = await post("analyst-1a2b3c", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(403);
  });

  it("lists_tools_by_role_and_calls_them_as_the_caller", async () => {
    const boss = await rpc("default", "tools/list");
    expect((boss.result?.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["echo", "boss_only"]);
    const member = await rpc("analyst-1a2b3c", "tools/list");
    expect((member.result?.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["echo"]);

    const denied = await rpc("analyst-1a2b3c", "tools/call", { name: "boss_only", arguments: { text: "hi" } });
    expect(denied.error?.code).toBe(-32602);

    const ok = await rpc("analyst-1a2b3c", "tools/call", { name: "echo", arguments: { text: "hi" } });
    expect(ok.result).toMatchObject({ content: [{ type: "text", text: "echo:hi" }], structuredContent: { text: "hi" } });
    expect(calls).toEqual([{ profile: "analyst-1a2b3c", args: { text: "hi" } }]);
  });

  it("reports_bad_arguments_and_tool_failures_to_the_model", async () => {
    const tooLong = await rpc("default", "tools/call", { name: "echo", arguments: { text: "x".repeat(11) } });
    expect(tooLong.result).toMatchObject({ isError: true });
    const unknownArg = await rpc("default", "tools/call", { name: "echo", arguments: { text: "a", extra: 1 } });
    expect(unknownArg.result).toMatchObject({ isError: true });
    const refused = await rpc("default", "tools/call", { name: "echo", arguments: { text: "refuse" } });
    expect(refused.result).toMatchObject({ isError: true, content: [{ text: "Нельзя." }] });
    const crashed = await rpc("default", "tools/call", { name: "echo", arguments: { text: "crash" } });
    expect(JSON.stringify(crashed.result)).not.toContain("secret internals");
    expect(crashed.result).toMatchObject({ isError: true });
  });

  it("rejects_malformed_oversized_and_unsupported_requests", async () => {
    expect((await post("default", "{nope")).status).toBe(400);
    expect((await post("default", { jsonrpc: "2.0", id: 1, method: "x", params: { blob: "y".repeat(300_000) } })).status).toBe(413);
    const version = await post("default", { jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "1999-01-01" });
    expect(version.status).toBe(400);
    const pinged = await post("default", { jsonrpc: "2.0", id: 7, method: "ping" }, { "mcp-protocol-version": "2025-11-25" });
    expect(await pinged.json()).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });

  it("answers_a_batch_from_older_clients", async () => {
    const res = await post("default", [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    const body = (await res.json()) as Rpc[];
    expect(body.map((r) => r.id)).toEqual([1, 2]);
  });

  it("validates_the_schema_subset_the_tools_use", () => {
    const schema = {
      type: "object",
      properties: { n: { type: "integer" }, s: { type: "string", enum: ["a", "b"] } },
      required: ["s"],
    };
    expect(validateArgs(schema, { s: "a", n: 2 })).toBeNull();
    expect(validateArgs(schema, { s: "c" })).toContain("one of");
    expect(validateArgs(schema, { s: "a", n: 1.5 })).toContain("integer");
    expect(validateArgs(schema, { n: 1 })).toContain("required");
    expect(validateArgs(schema, [])).toContain("object");
  });
});
