// @vitest-environment node
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { createHermesGate } = await import("../../server/hermes-gate.js");

const TOKEN = "gate-session-token-0123456789";

describe("hermes-gate", () => {
  let upstream: http.Server;
  let gate: ReturnType<typeof createHermesGate>;
  let gateUrl: string;
  const seen: Array<{ url?: string; host?: string; token?: string }> = [];

  beforeEach(async () => {
    seen.length = 0;
    upstream = http.createServer((req, res) => {
      seen.push({ url: req.url, host: req.headers.host, token: req.headers["x-hermes-session-token"] as string });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: req.url }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    gate = createHermesGate({ token: TOKEN, target: `http://127.0.0.1:${upstreamPort}`, log: () => {}, logError: () => {} });
    await gate.listen(0, "127.0.0.1");
    gateUrl = `http://127.0.0.1:${(gate.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await gate.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("refuses_requests_without_the_session_token_including_plugin_routes", async () => {
    for (const path of ["/api/profiles", "/api/plugins/kanban/board"]) {
      const res = await fetch(`${gateUrl}${path}`);
      expect(res.status).toBe(401);
    }
    const wrong = await fetch(`${gateUrl}/api/profiles`, { headers: { "X-Hermes-Session-Token": "nope" } });
    expect(wrong.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("forwards_an_authenticated_request_with_the_dashboard_host", async () => {
    const res = await fetch(`${gateUrl}/api/plugins/kanban/board?tenant=x`, { headers: { "X-Hermes-Session-Token": TOKEN } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/api/plugins/kanban/board?tenant=x" });
    expect(seen[0]).toMatchObject({ token: TOKEN });
    expect(seen[0].host).toMatch(/^127\.0\.0\.1:\d+$/);
  });

  it("answers_its_own_health_check_without_a_token", async () => {
    const res = await fetch(`${gateUrl}/gate/health`);
    expect(res.status).toBe(200);
  });

  it("reports_an_unreachable_dashboard_as_502", async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    upstream = http.createServer();
    const res = await fetch(`${gateUrl}/api/profiles`, { headers: { "X-Hermes-Session-Token": TOKEN } });
    expect(res.status).toBe(502);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  });

  it("refuses_to_start_with_a_short_token", () => {
    expect(() => createHermesGate({ token: "short" })).toThrow(/16 characters/);
  });
});
