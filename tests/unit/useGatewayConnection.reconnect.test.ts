import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

// The office loses its gateway (it stopped, or the proxy closed the socket)
// and must get it back on its own: retry with backoff while the gateway is
// down, stop on a wrong token.

type Outcome = "ok" | { fail: string; message?: string };
type Opts = {
  onHello?: (hello: unknown) => void;
  onClose?: (info: { code: number; reason: string }) => void;
};

const harness = vi.hoisted(() => ({
  plan: [] as Outcome[],
  instances: [] as Array<{ opts: Record<string, unknown> }>,
  starts: 0,
}));

vi.mock("@/lib/gateway/openclaw/GatewayBrowserClient", () => {
  class GatewayBrowserClient {
    connected = false;
    constructor(private opts: Opts) {
      harness.instances.push({ opts: opts as Record<string, unknown> });
    }
    start() {
      harness.starts += 1;
      const outcome = harness.plan.shift() ?? "ok";
      queueMicrotask(() => {
        if (outcome === "ok") {
          this.connected = true;
          this.opts.onHello?.({ type: "hello-ok", protocol: 3, adapterType: "demo" });
          return;
        }
        this.opts.onClose?.({
          code: 4008,
          reason: `connect failed: ${outcome.fail} ${outcome.message ?? "down"}`,
        });
      });
    }
    stop() {
      this.connected = false;
    }
    request() {
      return Promise.resolve({});
    }
  }
  return { GatewayBrowserClient, clearGatewayBrowserSessionStorage: () => {} };
});

const coordinator = {
  loadSettingsEnvelope: async () => ({
    settings: {
      version: 1,
      gateway: { url: "wss://gateway.example", token: "", adapterType: "demo" },
    },
    localGatewayDefaults: null,
  }),
  loadSettings: async () => null,
  schedulePatch: () => {},
  flushPending: async () => {},
};

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const dropConnection = async (code = 1012, reason = "upstream closed") => {
  const latest = harness.instances.at(-1)?.opts as Opts | undefined;
  await act(async () => {
    latest?.onClose?.({ code, reason });
  });
};

const renderProbe = async () => {
  const { useGatewayConnection } = await import("@/lib/gateway/GatewayClient");
  const Probe = () => {
    const state = useGatewayConnection(coordinator as never);
    return createElement(
      "div",
      null,
      createElement("div", { "data-testid": "status" }, state.status),
      createElement("div", { "data-testid": "reconnecting" }, state.reconnecting ? "yes" : "no"),
      createElement("div", { "data-testid": "blocked" }, state.reconnectBlocked ? "yes" : "no"),
      createElement("div", { "data-testid": "error" }, state.error ?? ""),
    );
  };
  render(createElement(Probe));
  // Settings load, then the automatic first connect (900 ms for demo).
  await advance(0);
  await advance(0);
  await advance(1_000);
  process.stderr.write(`
`);
};

describe("useGatewayConnection reconnect", () => {
  beforeEach(() => {
    harness.plan = [];
    harness.instances = [];
    harness.starts = 0;
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(Math, "random").mockReturnValue(1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps retrying with backoff while the gateway is down and recovers without a reload", async () => {
    await renderProbe();
    expect(screen.getByTestId("status")).toHaveTextContent(/^connected$/);

    // The gateway stops: every attempt now fails at the proxy.
    harness.plan = Array.from({ length: 6 }, () => ({ fail: "studio.upstream_error" }));
    await dropConnection();
    expect(screen.getByTestId("status")).toHaveTextContent(/^disconnected$/);
    expect(screen.getByTestId("reconnecting")).toHaveTextContent("yes");
    const startsAtDrop = harness.starts;

    // 1 s, 2 s, 4 s, 8 s, 15 s, 15 s: six failures, far past the old limits.
    for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000, 15_000]) {
      await advance(delay);
    }
    expect(harness.starts - startsAtDrop).toBe(6);
    expect(screen.getByTestId("reconnecting")).toHaveTextContent("yes");
    // Having been connected, the office stays on screen: no error, no form.
    expect(screen.getByTestId("error")).toHaveTextContent("");

    // The gateway is back: the next attempt (at most 15 s later) connects.
    await advance(15_000);
    expect(screen.getByTestId("status")).toHaveTextContent(/^connected$/);
    expect(screen.getByTestId("reconnecting")).toHaveTextContent("no");
  });

  it("retries at once when the network comes back or the tab becomes visible", async () => {
    await renderProbe();
    harness.plan = [{ fail: "studio.upstream_error" }, { fail: "studio.upstream_error" }, { fail: "studio.upstream_error" }];
    await dropConnection();
    await advance(1_000);
    await advance(2_000);
    const before = harness.starts;
    // Now waiting 4 s; "online" skips the wait.
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(harness.starts).toBe(before + 1);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(harness.starts).toBe(before + 2);
    expect(screen.getByTestId("status")).toHaveTextContent(/^connected$/);
  });

  it("stops retrying and surfaces a wrong token", async () => {
    await renderProbe();
    harness.plan = [{ fail: "UNAUTHORIZED", message: "Нет доступа к адаптеру Hermes." }];
    await dropConnection();
    await advance(1_000);
    expect(screen.getByTestId("reconnecting")).toHaveTextContent("no");
    expect(screen.getByTestId("blocked")).toHaveTextContent("yes");
    expect(screen.getByTestId("error").textContent).toContain("UNAUTHORIZED");
    const starts = harness.starts;
    await advance(120_000);
    expect(harness.starts).toBe(starts);
  });
});
