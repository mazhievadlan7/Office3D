// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { createAutonomy, localClock, withinWindow, mergeSettings } = await import("../../server/hermes/autonomy.js");
const { createHermesStore } = await import("../../server/hermes/store.js");

class AdapterError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const T0 = Date.parse("2026-09-23T06:00:00Z"); // 09:00 in Moscow

describe("autonomy", () => {
  let dir: string;
  let store: Loose;
  let clock: number;
  let totals: Record<string, { total_actual_cost: number; total_estimated_cost: number }>;
  let profiles: string[];
  let board: Array<Record<string, unknown>>;
  let runs: Array<{ sessionKey: string; message: string }>;
  let configPuts: Array<Record<string, unknown>>;
  let hired: Record<string, number>;
  let active: boolean;
  let usageFails: boolean;
  let autonomy: Loose;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "office3d-autonomy-"));
    store = createHermesStore({ filePath: path.join(dir, "state.json") });
    clock = T0;
    totals = { default: { total_actual_cost: 0, total_estimated_cost: 10 }, "a-1": { total_actual_cost: 2, total_estimated_cost: 1 } };
    profiles = ["default", "a-1"];
    board = [];
    runs = [];
    configPuts = [];
    hired = {};
    active = false;
    usageFails = false;
    const client = {
      dashboard: async (route: string, opts: { method?: string; query?: Record<string, unknown>; body?: Loose } = {}) => {
        if (route === "/api/analytics/usage") {
          if (usageFails) throw new Error("hermes down");
          return { totals: totals[String(opts.query?.profile)] ?? {} };
        }
        if (route === "/api/config" && opts.method === "PUT") {
          configPuts.push(opts.body.config);
          return { ok: true };
        }
        throw new Error(`unexpected ${route}`);
      },
    };
    autonomy = createAutonomy({
      client,
      store,
      listProfiles: async () => profiles.map((name) => ({ name })),
      hiredAt: (profile: string) => hired[profile] ?? null,
      readBoard: async () => board,
      startRun: async (params: { sessionKey: string; message: string }) => {
        runs.push(params);
        return { runId: `r${runs.length}` };
      },
      isRunActive: () => active,
      hasDashboard: () => true,
      AdapterError,
      broadcast: () => {},
      defaultTimeZone: "Europe/Moscow",
      now: () => clock,
    });
  });

  afterEach(async () => {
    await store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const set = (settings: Record<string, unknown>) => autonomy.handlers["org.autonomy.set"]({ settings });
  const minutes = (n: number) => {
    clock += n * 60_000;
  };

  it("counts_todays_spending_from_local_midnight_baselines", async () => {
    expect((await autonomy.spending({ fresh: true })).spentUsd).toBe(0);
    totals.default.total_estimated_cost = 10.5; // default grew by 0.5
    totals["a-1"].total_actual_cost = 2.25; // actual wins over estimate
    expect((await autonomy.spending({ fresh: true })).spentUsd).toBe(0.75);

    // A hire from today starts from zero; its whole spending is today's.
    profiles.push("b-2");
    hired["b-2"] = clock + 1;
    totals["b-2"] = { total_actual_cost: 0, total_estimated_cost: 0.3 };
    expect((await autonomy.spending({ fresh: true })).spentUsd).toBe(1.05);

    // A dismissed agent's spending stays spent.
    profiles.pop();
    expect((await autonomy.spending({ fresh: true })).spentUsd).toBe(1.05);

    // Next local day starts from zero.
    clock = Date.parse("2026-09-23T21:30:00Z"); // 00:30 in Moscow, 24 Sept
    const next = await autonomy.spending({ fresh: true });
    expect(next).toEqual({ day: "2026-09-24", spentUsd: 0 });
  });

  it("stops_reviews_and_pauses_the_board_past_the_budget", async () => {
    await set({ mode: "scheduled", dailyBudgetUsd: 1 });
    await autonomy.tick(); // baseline + first review
    expect(runs).toHaveLength(1);
    totals.default.total_estimated_cost = 11.2;
    minutes(200);
    await autonomy.tick();
    expect(runs).toHaveLength(1);
    expect(configPuts.at(-1)).toEqual({ kanban: { dispatch_profiles: [] } });
    const status = await autonomy.status({ fresh: true });
    expect(status).toMatchObject({ budgetExceeded: true, boardPaused: true, spentTodayUsd: 1.2 });

    // Raising the budget opens the board for the whole current team.
    await set({ dailyBudgetUsd: 5 });
    expect(configPuts.at(-1)).toEqual({ kanban: { dispatch_profiles: ["a-1", "default"] } });
    await autonomy.tick();
    expect(runs).toHaveLength(2);
  });

  it("leaves_hermes_claim_list_alone_until_it_first_pauses", async () => {
    await set({ mode: "off" });
    await autonomy.tick();
    expect(configPuts).toEqual([]);
    await autonomy.handlers["org.autonomy.pause"]({ paused: true });
    expect(configPuts).toEqual([{ kanban: { dispatch_profiles: [] } }]);
    await autonomy.handlers["org.autonomy.pause"]({ paused: false });
    expect(configPuts.at(-1)).toEqual({ kanban: { dispatch_profiles: ["a-1", "default"] } });

    // A new hire can take tasks at once.
    profiles.push("b-2");
    autonomy.teamChanged();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(configPuts.at(-1)).toEqual({ kanban: { dispatch_profiles: ["a-1", "b-2", "default"] } });
  });

  it("reviews_on_schedule_within_active_hours", async () => {
    await set({ mode: "scheduled", intervalMinutes: 120, activeFrom: "08:00", activeTo: "20:00" });
    await autonomy.tick();
    expect(runs).toHaveLength(1);
    expect(runs[0].sessionKey).toBe("agent:main:autonomy-2026-09-23");
    expect(runs[0].message).toContain("Плановый обзор");
    minutes(60);
    await autonomy.tick();
    expect(runs).toHaveLength(1);
    minutes(61);
    await autonomy.tick();
    expect(runs).toHaveLength(2);

    // 21:00 Moscow — outside the window.
    clock = Date.parse("2026-09-23T18:00:00Z");
    await autonomy.tick();
    expect(runs).toHaveLength(2);
  });

  it("calls_the_main_agent_when_the_board_runs_dry_and_backs_off", async () => {
    board = [{ id: "t1", status: "running", assignee: "a-1" }];
    await set({ mode: "continuous" });
    await autonomy.tick();
    expect(runs).toHaveLength(0);

    board = [{ id: "t1", status: "done", assignee: "a-1" }];
    await autonomy.tick();
    expect(runs).toHaveLength(1);
    expect(runs[0].message).toContain("нет активной работы");

    // Nothing changed: the next call waits longer (30 min, not 15).
    minutes(16);
    await autonomy.tick();
    expect(runs).toHaveLength(1);
    minutes(15);
    await autonomy.tick();
    expect(runs).toHaveLength(2);

    // A new proposal in triage brings the main agent in right away.
    minutes(2);
    board = [...board, { id: "t2", status: "triage", assignee: null }];
    await autonomy.tick();
    expect(runs).toHaveLength(3);
    expect(runs[2].message).toContain("предложили новые задачи");
  });

  it("does_nothing_while_paused_busy_or_blind_to_spending", async () => {
    await set({ mode: "scheduled" });
    await autonomy.handlers["org.autonomy.pause"]({ paused: true });
    await autonomy.tick();
    expect(runs).toHaveLength(0);
    await autonomy.handlers["org.autonomy.pause"]({ paused: false });

    active = true;
    await autonomy.tick();
    expect(runs).toHaveLength(0);
    active = false;

    usageFails = true;
    await autonomy.tick();
    expect(runs).toHaveLength(0);
    usageFails = false;
    await autonomy.tick();
    expect(runs).toHaveLength(1);
  });

  it("runs_a_review_on_request_but_not_twice_at_once", async () => {
    const started = await autonomy.handlers["org.autonomy.runNow"]();
    expect(started.runId).toBe("r1");
    expect(runs[0].message).toContain("по просьбе руководителя");
    active = true;
    await expect(autonomy.handlers["org.autonomy.runNow"]()).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("validates_settings", () => {
    const invalid = (message: string) => new AdapterError("INVALID_REQUEST", message);
    const base = { mode: "off", intervalMinutes: 120, activeFrom: null, activeTo: null, dailyBudgetUsd: 5, pauseBoardOnBudget: true, paused: false, timeZone: "UTC" };
    expect(() => mergeSettings(base, { mode: "always" }, invalid)).toThrow("режим");
    expect(() => mergeSettings(base, { intervalMinutes: 5 }, invalid)).toThrow("Интервал");
    expect(() => mergeSettings(base, { activeFrom: "25:00" }, invalid)).toThrow("ЧЧ:ММ");
    expect(() => mergeSettings(base, { dailyBudgetUsd: -1 }, invalid)).toThrow("Бюджет");
    expect(() => mergeSettings(base, { timeZone: "Mars/Olympus" }, invalid)).toThrow("часовой пояс");
    expect(mergeSettings(base, { dailyBudgetUsd: "2.345", activeTo: "" }, invalid)).toMatchObject({ dailyBudgetUsd: 2.35, activeTo: null });
  });

  it("reads_local_time_and_windows_across_midnight", () => {
    expect(localClock(new Date("2026-09-23T22:30:00Z"), "Europe/Moscow")).toEqual({ day: "2026-09-24", minute: 90 });
    expect(withinWindow(30, 22 * 60, 6 * 60)).toBe(true);
    expect(withinWindow(12 * 60, 22 * 60, 6 * 60)).toBe(false);
    expect(withinWindow(12 * 60, null, null)).toBe(true);
  });
});
