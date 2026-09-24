// @vitest-environment node
import { describe, expect, it } from "vitest";

const { createRequestGuard, createTrustedProxies } = await import("../../server/request-guard.js");
const { createAccessGate } = await import("../../server/access-gate.js");

const req = (headers: Record<string, string>, remoteAddress = "10.0.0.2") => ({ headers, socket: { remoteAddress } });

describe("request guard", () => {
  it("lets_only_this_sites_pages_open_websockets", () => {
    const guard = createRequestGuard({ allowedOrigins: ["https://studio.example.com/"] });
    expect(guard.allowWebSocketOrigin(req({ host: "office.example.com", origin: "https://office.example.com" }))).toBe(true);
    expect(guard.allowWebSocketOrigin(req({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }))).toBe(true);
    // Another site in the same browser.
    expect(guard.allowWebSocketOrigin(req({ host: "127.0.0.1:3000", origin: "https://evil.example" }))).toBe(false);
    expect(guard.allowWebSocketOrigin(req({ host: "office.example.com", origin: "https://office.example.com.evil.example" }))).toBe(false);
    expect(guard.allowWebSocketOrigin(req({ host: "office.example.com", origin: "null" }))).toBe(false);
    expect(guard.allowWebSocketOrigin(req({ host: "office.example.com", origin: "https://studio.example.com" }))).toBe(true);
    // Not a browser.
    expect(guard.allowWebSocketOrigin(req({ host: "office.example.com" }))).toBe(true);
  });

  it("answers_the_token_less_local_mode_only_by_loopback_names", () => {
    const guard = createRequestGuard();
    for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "app.localhost:3000"]) {
      expect(guard.addressedToLoopback(req({ host }))).toBe(true);
    }
    // A public name rebound to 127.0.0.1.
    for (const host of ["rebind.evil.example:3000", "192.168.1.5:3000", ""]) {
      expect(guard.addressedToLoopback(req({ host }))).toBe(false);
    }
  });

  it("believes_x_forwarded_for_only_from_the_named_proxy", async () => {
    const proxies = createTrustedProxies({
      hosts: ["caddy"],
      lookup: (async () => [{ address: "172.20.0.5", family: 4 }]) as never,
    });
    await proxies.refresh!();
    process.env.TRUSTED_PROXY = "1";
    try {
      const gate = createAccessGate({ token: "t".repeat(32), isTrustedProxy: proxies.isTrusted });
      const res = () => ({ statusCode: 0, setHeader: () => {}, end: () => {} });
      // From an agent's container: rotating X-Forwarded-For buys nothing.
      for (let i = 0; i < 10; i++) {
        gate.handleHttp({ url: "/api/x", headers: { cookie: "studio_access=wrong", "x-forwarded-for": `198.51.100.${i}` }, socket: { remoteAddress: "172.20.0.9" } }, res());
      }
      const blocked = res();
      gate.handleHttp({ url: "/api/x", headers: { cookie: "studio_access=wrong", "x-forwarded-for": "198.51.100.99" }, socket: { remoteAddress: "172.20.0.9" } }, blocked);
      expect(blocked.statusCode).toBe(429);
      // Through the proxy, the client's own address is what counts.
      const viaProxy = res();
      gate.handleHttp({ url: "/api/x", headers: { cookie: "studio_access=wrong", "x-forwarded-for": "203.0.113.7" }, socket: { remoteAddress: "172.20.0.5" } }, viaProxy);
      expect(viaProxy.statusCode).toBe(401);
    } finally {
      delete process.env.TRUSTED_PROXY;
      proxies.close();
    }
  });
});
