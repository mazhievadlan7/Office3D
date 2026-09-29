import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GatewayBrowserClient } from "@/lib/gateway/openclaw/GatewayBrowserClient";

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  static sent: string[] = [];
  static closes: Array<{ code: number; reason: string }> = [];

  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    MockWebSocket.sent.push(String(data));
  }

  close(code?: number, reason?: string) {
    MockWebSocket.closes.push({ code: code ?? 1000, reason: reason ?? "" });
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? "" } as CloseEvent);
  }
}

describe("GatewayBrowserClient", () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalSubtle = globalThis.crypto?.subtle;

  beforeEach(() => {
    MockWebSocket.instances = [];
    MockWebSocket.sent = [];
    MockWebSocket.closes = [];
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    if (globalThis.crypto) {
      Object.defineProperty(globalThis.crypto, "subtle", {
        value: undefined,
        configurable: true,
      });
    }
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
    if (globalThis.crypto) {
      Object.defineProperty(globalThis.crypto, "subtle", {
        value: originalSubtle,
        configurable: true,
      });
    }
  });

  it("sends connect when connect.challenge arrives", async () => {
    const client = new GatewayBrowserClient({ url: "ws://example.com" });
    client.start();

    const ws = MockWebSocket.instances[0];
    if (!ws) {
      throw new Error("WebSocket not created");
    }

    ws.onopen?.();

    expect(MockWebSocket.sent).toHaveLength(0);

    ws.onmessage?.({
      data: JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "abc" },
      }),
    } as MessageEvent);

    await vi.runAllTicks();

    expect(MockWebSocket.sent).toHaveLength(1);
    const frame = JSON.parse(MockWebSocket.sent[0] ?? "{}");
    expect(frame.type).toBe("req");
    expect(frame.method).toBe("connect");
    expect(typeof frame.id).toBe("string");
    expect(frame.id).toMatch(UUID_V4_RE);
    expect(frame.params?.client?.id).toBe("openclaw-control-ui");
  });

  it("truncates connect-failed close reason to websocket limit", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new GatewayBrowserClient({ url: "ws://example.com", token: "secret" });
    client.start();

    const ws = MockWebSocket.instances[0];
    if (!ws) {
      throw new Error("WebSocket not created");
    }

    ws.onopen?.();
    // The connect frame waits 75 ms for a challenge; the heartbeat watch is an
    // interval, so the clock is advanced rather than run dry.
    vi.advanceTimersByTime(100);

    const connectFrame = JSON.parse(MockWebSocket.sent[0] ?? "{}");
    const connectId = String(connectFrame.id ?? "");
    expect(connectId).toMatch(UUID_V4_RE);

    ws.onmessage?.({
      data: JSON.stringify({
        type: "res",
        id: connectId,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: `invalid config ${"x".repeat(260)}`,
        },
      }),
    } as MessageEvent);

    await vi.runAllTicks();
    await vi.runAllTimersAsync();
    await Promise.resolve();

    const lastClose = MockWebSocket.closes.at(-1);
    expect(lastClose?.code).toBe(4008);
    expect(lastClose?.reason.startsWith("connect failed: INVALID_REQUEST")).toBe(true);
    expect(new TextEncoder().encode(lastClose?.reason ?? "").byteLength).toBeLessThanOrEqual(123);
    warnSpy.mockRestore();
  });

  it("consumes studio.heartbeat events without passing them on", () => {
    const onEvent = vi.fn();
    const client = new GatewayBrowserClient({ url: "ws://example.com", onEvent });
    client.start();
    const ws = MockWebSocket.instances[0]!;
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify({ type: "event", event: "studio.heartbeat", payload: { ts: 1 } }) } as MessageEvent);
    ws.onmessage?.({ data: JSON.stringify({ type: "event", event: "presence", seq: 1 }) } as MessageEvent);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]?.[0]?.event).toBe("presence");
    client.stop();
  });

  it("drops a socket that stays silent after heartbeats started, and reports it closed", () => {
    const onClose = vi.fn();
    const client = new GatewayBrowserClient({ url: "ws://example.com", onClose });
    client.start();
    const ws = MockWebSocket.instances[0]!;
    ws.onopen?.();
    // No heartbeat seen yet: silence alone is not taken for a dead socket.
    vi.advanceTimersByTime(60_000);
    expect(onClose).not.toHaveBeenCalled();

    ws.onmessage?.({ data: JSON.stringify({ type: "event", event: "studio.heartbeat" }) } as MessageEvent);
    vi.advanceTimersByTime(40_000);
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ code: 4000, reason: "heartbeat timeout" });
    expect(MockWebSocket.closes.at(-1)).toEqual({ code: 4000, reason: "heartbeat timeout" });
    client.stop();
  });
});
