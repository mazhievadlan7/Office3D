// @vitest-environment node
import { describe, expect, it } from "vitest";

const { createUsageHandlers, periodOf } = await import("../../server/hermes/usage.js");

class AdapterError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const NOW = Date.parse("2026-09-23T12:00:00Z");

const build = (dashboard: (path: string, opts: { query: Record<string, unknown> }) => Promise<unknown>, profiles = ["default", "writer"]) => {
  const logs: string[] = [];
  const handlers = createUsageHandlers({
    client: { dashboard },
    store: { listSessions: () => [] },
    listProfiles: async () => profiles.map((name) => ({ name })),
    agentIdOf: (profile: string) => (profile === "default" ? "main" : profile),
    hasDashboard: () => true,
    AdapterError,
    now: () => NOW,
    log: (message: string) => logs.push(message),
  });
  return { handlers, logs };
};

describe("hermes usage", () => {
  it("keeps_the_period_within_a_year_and_not_past_today", () => {
    expect(periodOf({ startDate: "2026-09-01", endDate: "2026-09-10" }, NOW)).toMatchObject({ start: "2026-09-01", end: "2026-09-10", days: 23 });
    expect(periodOf({ startDate: "2026-09-20", endDate: "2027-01-01" }, NOW)).toMatchObject({ end: "2026-09-23", days: 4 });
    expect(periodOf({ startDate: "2020-01-01" }, NOW)).toMatchObject({ days: 365 });
    expect(periodOf({ startDate: "2026-09-23", endDate: "2026-09-01" }, NOW)).toMatchObject({ start: "2026-09-01", end: "2026-09-01" });
    expect(periodOf({ startDate: "garbage" }, NOW)).toMatchObject({ start: "2026-08-25", end: "2026-09-23" });
  });

  it("shows_the_team_that_answered_when_one_agent_cannot", async () => {
    const { handlers, logs } = build(async (_path, { query }) => {
      if (query.profile === "writer") throw new Error("HTTP 500");
      return { daily: [{ day: "2026-09-23", input_tokens: 5, output_tokens: 1, cache_read_tokens: 0, estimated_cost: 0.5, actual_cost: 0 }] };
    });
    const result = await handlers["usage.cost"]({ startDate: "2026-09-23", endDate: "2026-09-23" });
    expect(result.daily).toEqual([expect.objectContaining({ date: "2026-09-23", totalTokens: 6, totalCost: 0.5 })]);
    expect(logs.join("\n")).toContain("writer");
  });

  it("refuses_when_no_agent_answers", async () => {
    const { handlers } = build(async () => {
      throw new Error("down");
    });
    await expect(handlers["usage.cost"]({})).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("pages_through_sessions_until_the_period_starts", async () => {
    const calls: number[] = [];
    const start = Date.parse("2026-09-22T00:00:00Z") / 1000;
    // 250 sessions a minute apart, newest first; only those since the 22nd count.
    const all = Array.from({ length: 250 }, (_, index) => ({ id: `s${index}`, started_at: NOW / 1000 - index * 600, input_tokens: 1 }));
    const { handlers } = build(async (_path, { query }) => {
      calls.push(Number(query.offset));
      const offset = Number(query.offset);
      return { sessions: all.slice(offset, offset + Number(query.limit)) };
    }, ["default"]);
    const result = await handlers["sessions.usage"]({ startDate: "2026-09-22", endDate: "2026-09-23" });
    expect(result.sessions).toHaveLength(all.filter((row) => row.started_at >= start).length);
    expect(calls).toEqual([0, 100, 200]);
    expect(result.truncated).toBe(false);
    expect(result.totals.input).toBe(result.sessions.length);
  });
});
