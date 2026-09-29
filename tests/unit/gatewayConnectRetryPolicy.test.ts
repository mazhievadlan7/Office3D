import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ReconnectScheduler,
  classifyGatewayFailure,
  computeReconnectDelayMs,
} from "@/lib/gateway/reconnectPolicy";

describe("computeReconnectDelayMs", () => {
  it("doubles from 1 s and caps at 15 s", () => {
    const top = () => 1; // the whole jitter range: the ceiling itself
    expect([0, 1, 2, 3, 4, 5, 20].map((attempt) => computeReconnectDelayMs(attempt, { random: top }))).toEqual([
      1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000,
    ]);
  });

  it("jitters between half the ceiling and the ceiling", () => {
    expect(computeReconnectDelayMs(0, { random: () => 0 })).toBe(500);
    expect(computeReconnectDelayMs(3, { random: () => 0 })).toBe(4_000);
    expect(computeReconnectDelayMs(10, { random: () => 0 })).toBe(7_500);
    for (let i = 0; i < 200; i += 1) {
      const delay = computeReconnectDelayMs(10);
      expect(delay).toBeGreaterThanOrEqual(7_500);
      expect(delay).toBeLessThanOrEqual(15_000);
    }
  });

  it("waits at least 15 s after a rate-limit close (1008)", () => {
    expect(computeReconnectDelayMs(0, { random: () => 0, lastCloseCode: 1008 })).toBe(15_000);
    expect(computeReconnectDelayMs(0, { random: () => 0, lastCloseCode: 1012 })).toBe(500);
  });
});

describe("classifyGatewayFailure", () => {
  it("retries while the upstream is down, timing out or restarting", () => {
    for (const code of ["studio.upstream_error", "studio.upstream_timeout", "studio.upstream_closed"]) {
      expect(classifyGatewayFailure({ code, message: "Не удалось подключиться к шлюзу по WebSocket." })).toBe(
        "transient",
      );
    }
    expect(classifyGatewayFailure({ code: null, message: "Шлюз закрыл соединение (1012): upstream closed" })).toBe(
      "transient",
    );
    expect(classifyGatewayFailure({ code: null, message: "Время ожидания подключения к шлюзу истекло." })).toBe(
      "transient",
    );
  });

  it("stops on a wrong token or a refused pairing", () => {
    expect(classifyGatewayFailure({ code: "studio.upstream_rejected", message: "pairing required" })).toBe("auth");
    expect(classifyGatewayFailure({ code: "studio.gateway_token_missing", message: "" })).toBe("auth");
    expect(classifyGatewayFailure({ code: "UNAUTHORIZED", message: "Нет доступа к адаптеру Hermes." })).toBe("auth");
    expect(
      classifyGatewayFailure({ code: "INVALID_REQUEST", message: "unauthorized: gateway token mismatch" }),
    ).toBe("auth");
  });

  it("stops when the address is missing or blocked", () => {
    for (const code of ["studio.gateway_url_missing", "studio.gateway_url_blocked", "studio.gateway_url_invalid"]) {
      expect(classifyGatewayFailure({ code, message: "" })).toBe("config");
    }
  });
});

describe("ReconnectScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries with growing delays until reset, then starts over", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const scheduler = new ReconnectScheduler({ run, random: () => 1 });

    expect(scheduler.schedule()).toBe(1_000);
    vi.advanceTimersByTime(999);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);

    // Each failure schedules the next step: 2 s, 4 s, 8 s, 15 s, 15 s, …
    const delays = [];
    for (let i = 0; i < 6; i += 1) {
      delays.push(scheduler.schedule());
      vi.advanceTimersByTime(delays.at(-1)!);
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
    expect(run).toHaveBeenCalledTimes(7);

    scheduler.reset();
    expect(scheduler.schedule()).toBe(1_000);
  });

  it("keeps a single pending attempt however often it is scheduled", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const scheduler = new ReconnectScheduler({ run, random: () => 1 });
    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    vi.advanceTimersByTime(60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retries at once when kicked (network back, tab visible)", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const scheduler = new ReconnectScheduler({ run, random: () => 1 });
    expect(scheduler.kick()).toBe(false);
    scheduler.schedule();
    scheduler.schedule();
    expect(scheduler.pending).toBe(true);
    expect(scheduler.kick()).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.pending).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    // The backoff step survives the kick.
    expect(scheduler.schedule()).toBe(4_000);
  });

  it("does nothing after cancel", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const scheduler = new ReconnectScheduler({ run });
    scheduler.schedule();
    scheduler.cancel();
    vi.advanceTimersByTime(60_000);
    expect(run).not.toHaveBeenCalled();
  });
});
