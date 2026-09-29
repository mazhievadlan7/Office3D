// @vitest-environment node

import http from "node:http";
import { describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

// What the same-origin proxy does when the upstream gateway goes away, so the
// browser can reconnect by itself: it closes the browser (1012), heartbeats
// the browser, and drops an upstream that stops answering pings.

type Upstream = { server: WebSocketServer; url: string };

const startUpstream = async (options: { autoPong?: boolean } = {}): Promise<Upstream> => {
  const server = new WebSocketServer({ port: 0, autoPong: options.autoPong ?? true });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a port");
  server.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame?.method === "connect") {
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { type: "hello-ok", protocol: 3 } }));
      }
    });
  });
  return { server, url: `ws://127.0.0.1:${address.port}` };
};

const startProxy = async (upstreamUrl: string, heartbeatIntervalMs: number) => {
  const { createGatewayProxy } = await import("../../server/gateway-proxy");
  const httpServer = http.createServer();
  const proxy = createGatewayProxy({
    loadUpstreamSettings: async () => ({ url: upstreamUrl, token: "t" }),
    allowWs: (req: { url?: string }) => req.url === "/api/gateway/ws",
    logError: () => {},
    heartbeatIntervalMs,
  });
  httpServer.on("upgrade", (req, socket, head) => proxy.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("expected a port");
  return { httpServer, url: `ws://127.0.0.1:${address.port}/api/gateway/ws` };
};

const connectBrowser = async (url: string) => {
  const browser = new WebSocket(url);
  const frames: Array<{ type?: string; event?: string; id?: string; ok?: boolean }> = [];
  browser.on("message", (raw) => frames.push(JSON.parse(String(raw))));
  await new Promise<void>((resolve) => browser.once("open", () => resolve()));
  browser.send(JSON.stringify({ type: "req", id: "c1", method: "connect", params: { auth: {} } }));
  const deadline = Date.now() + 3_000;
  while (!frames.some((frame) => frame.id === "c1") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(frames.find((frame) => frame.id === "c1")?.ok).toBe(true);
  return { browser, frames };
};

const waitForClose = (ws: WebSocket, timeoutMs = 3_000) =>
  new Promise<{ code: number; reason: string } | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    ws.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: String(reason) });
    });
  });

const closeServer = (server: { close: (cb: () => void) => void }) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

describe("gateway proxy reconnect support", () => {
  it("closes the browser with 1012 when the upstream goes away after connect", async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy(upstream.url, 0);
    const { browser } = await connectBrowser(proxy.url);
    try {
      const closed = waitForClose(browser);
      for (const client of upstream.server.clients) client.terminate();
      expect(await closed).toEqual({ code: 1012, reason: "upstream closed" });
    } finally {
      browser.terminate();
      await closeServer(upstream.server);
      await closeServer(proxy.httpServer);
    }
  });

  it("sends the browser studio.heartbeat events", async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy(upstream.url, 50);
    const { browser, frames } = await connectBrowser(proxy.url);
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const beats = frames.filter((frame) => frame.type === "event" && frame.event === "studio.heartbeat");
      expect(beats.length).toBeGreaterThanOrEqual(2);
      expect(browser.readyState).toBe(WebSocket.OPEN);
    } finally {
      browser.terminate();
      for (const client of upstream.server.clients) client.terminate();
      await closeServer(upstream.server);
      await closeServer(proxy.httpServer);
    }
  });

  it("drops a half-open upstream that stops answering pings and closes the browser with 1012", async () => {
    const upstream = await startUpstream({ autoPong: false });
    const proxy = await startProxy(upstream.url, 50);
    const { browser } = await connectBrowser(proxy.url);
    try {
      const closed = await waitForClose(browser);
      expect(closed).toEqual({ code: 1012, reason: "upstream heartbeat timeout" });
    } finally {
      browser.terminate();
      for (const client of upstream.server.clients) client.terminate();
      await closeServer(upstream.server);
      await closeServer(proxy.httpServer);
    }
  });
});
