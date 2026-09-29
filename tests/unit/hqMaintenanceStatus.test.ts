import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ARCHIVE_RUN_MAX_AGE_MS,
  ARCHIVE_SEEN_STORAGE_KEY,
  EMPTY_MAINTENANCE_FEED,
  MAINTENANCE_STATUS_URL,
  createArchiveRunGuard,
  describeMaintenanceLogEvent,
  formatBytesRu,
  markMaintenanceFeedOffline,
  nextMaintenanceFeed,
  parseMaintenanceStatus,
  shouldLogMaintenanceMemory,
  type MaintenanceFeedRun,
  type MaintenanceStatus,
} from "@/features/hq/maintenance/maintenanceStatus";
import {
  MAINTENANCE_ERROR_POLL_MS,
  MAINTENANCE_POLL_MS,
  useMaintenanceFeed,
} from "@/features/hq/maintenance/useMaintenanceFeed";

// The server's example body from the frozen contract (stream A), trimmed to one run.
const run = (overrides: Record<string, unknown> = {}) => ({
  id: "run-mg3k2a1b-4f09c2",
  trigger: "threshold",
  dryRun: false,
  startedAt: 1790647240000,
  finishedAt: 1790647242000,
  freedBytes: 475629,
  removedFiles: 952,
  truncatedFiles: 0,
  clutterBefore: 0.6347,
  clutterAfter: 0,
  cartworthy: true,
  capped: null,
  actions: [
    { target: "hmr-updates", op: "remove", bytes: 382729, items: 152 },
    { target: "test-temp", op: "remove", bytes: 92900, items: 800 },
  ],
  errors: [{ target: "test-temp", code: "EBUSY", count: 1 }],
  ...overrides,
});

const statusBody = (overrides: Record<string, unknown> = {}) => ({
  schema: 1,
  mode: "on",
  service: "idle",
  now: 1790647310000,
  running: false,
  clutter: {
    level: 0.0133,
    reclaimableBytes: 20480,
    reclaimableItems: 20,
    fullAtBytes: 67108864,
    measuredAt: 1790647302574,
    byTarget: [
      { id: "dev-trace", bytes: 0, items: 0 },
      { id: "hmr-updates", bytes: 20480, items: 20 },
    ],
  },
  weight: [
    { id: "settings", bytes: 565638, prunable: false },
    { id: "next-cache", bytes: 152922305, items: 104, prunable: false },
  ],
  memory: {
    rss: 3650000000,
    heapUsed: 2100000000,
    heapLimit: 4496293888,
    external: 42000000,
    arrayBuffers: 9000000,
    trendMbPerHour: 212.4,
    level: "high",
    recommendation: "restart-dev-server",
    sampledAt: 1790647302574,
  },
  schedule: {
    nextMeasureAt: 1790647602574,
    nextScheduledRunAt: 1790668842000,
    threshold: 0.75,
    minGapMs: 1800000,
  },
  lastRun: run(),
  recentRuns: [run()],
  ...overrides,
});

const parsed = (overrides: Record<string, unknown> = {}): MaintenanceStatus => {
  const status = parseMaintenanceStatus(statusBody(overrides));
  if (!status) throw new Error("fixture did not parse");
  return status;
};

const feedRun = (overrides: Partial<MaintenanceFeedRun> = {}): MaintenanceFeedRun => ({
  id: "run-a",
  finishedAt: 1_000,
  freedBytes: 5 * 1024 * 1024,
  cartworthy: true,
  dryRun: false,
  ageMs: 30_000,
  ...overrides,
});

const memoryStorage = () => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
};

describe("parseMaintenanceStatus", () => {
  it("accepts_the_contract_example", () => {
    const status = parsed();
    expect(status.mode).toBe("on");
    expect(status.clutter.level).toBeCloseTo(0.0133);
    expect(status.lastRun?.id).toBe("run-mg3k2a1b-4f09c2");
    expect(status.lastRun?.cartworthy).toBe(true);
    expect(status.recentRuns).toHaveLength(1);
    expect(status.memory.recommendation).toBe("restart-dev-server");
    expect(status.weight[1]).toEqual({ id: "next-cache", bytes: 152922305, items: 104, prunable: false });
  });

  it("ignores_unknown_fields", () => {
    const status = parseMaintenanceStatus({ ...statusBody(), extra: { deep: true }, lastRun: run({ later: 1 }) });
    expect(status).not.toBeNull();
    expect(status && "extra" in status).toBe(false);
  });

  it("rejects_what_is_not_a_schema_1_status", () => {
    expect(parseMaintenanceStatus(null)).toBeNull();
    expect(parseMaintenanceStatus("<html>")).toBeNull();
    expect(parseMaintenanceStatus([])).toBeNull();
    expect(parseMaintenanceStatus(statusBody({ schema: 2 }))).toBeNull();
    expect(parseMaintenanceStatus(statusBody({ mode: "turbo" }))).toBeNull();
    expect(parseMaintenanceStatus(statusBody({ now: "soon" }))).toBeNull();
    expect(parseMaintenanceStatus(statusBody({ clutter: null }))).toBeNull();
    expect(parseMaintenanceStatus(statusBody({ memory: { level: "ok" } }))).toBeNull();
    expect(parseMaintenanceStatus({ error: "unauthorized" })).toBeNull();
  });

  it("fails_the_whole_status_on_a_malformed_last_run", () => {
    // lastRun decides whether an agent walks off with the cart: never guessed at.
    expect(parseMaintenanceStatus(statusBody({ lastRun: run({ cartworthy: "yes" }) }))).toBeNull();
    expect(parseMaintenanceStatus(statusBody({ lastRun: run({ id: "" }) }))).toBeNull();
    expect(parseMaintenanceStatus(statusBody({ lastRun: run({ id: "x".repeat(200) }) }))).toBeNull();
    expect(parseMaintenanceStatus(statusBody({ lastRun: run({ freedBytes: -1 }) }))).toBeNull();
    expect(parseMaintenanceStatus(statusBody({ lastRun: run({ trigger: "cron" }) }))).toBeNull();
  });

  it("drops_malformed_recent_runs_and_list_entries", () => {
    const status = parsed({
      recentRuns: [run(), { id: 5 }, run({ id: "run-b", actions: [{ target: "x", op: "burn" }, null] })],
    });
    expect(status.recentRuns.map((entry) => entry.id)).toEqual(["run-mg3k2a1b-4f09c2", "run-b"]);
    expect(status.recentRuns[1].actions).toEqual([]);
  });

  it("accepts_no_last_run_and_an_unmeasured_service", () => {
    const status = parsed({
      service: "starting",
      lastRun: null,
      recentRuns: [],
      clutter: { level: 0, reclaimableBytes: 0, reclaimableItems: 0, fullAtBytes: 1, measuredAt: null, byTarget: [] },
      schedule: { nextMeasureAt: null, nextScheduledRunAt: null, threshold: 0.75, minGapMs: 1800000 },
    });
    expect(status.lastRun).toBeNull();
    expect(status.clutter.measuredAt).toBeNull();
  });

  it("never_calls_a_dry_run_cartworthy", () => {
    const status = parsed({ lastRun: run({ dryRun: true, cartworthy: true }) });
    expect(status.lastRun?.cartworthy).toBe(false);
  });

  it("clamps_the_level", () => {
    const body = statusBody();
    (body.clutter as { level: number }).level = 3;
    expect(parseMaintenanceStatus(body)?.clutter.level).toBe(1);
  });
});

describe("nextMaintenanceFeed", () => {
  it("quantises_the_fill_to_hundredths", () => {
    const feed = nextMaintenanceFeed(EMPTY_MAINTENANCE_FEED, parsed());
    expect(feed.fill).toBe(0.01);
    expect(feed.online).toBe(true);
    expect(nextMaintenanceFeed(feed, parsed({ clutter: { ...statusBody().clutter, level: 0.6347 } })).fill).toBe(0.63);
  });

  it("has_no_fill_until_measured_or_when_off", () => {
    const unmeasured = parsed({ clutter: { ...statusBody().clutter, measuredAt: null } });
    expect(nextMaintenanceFeed(EMPTY_MAINTENANCE_FEED, unmeasured).fill).toBeNull();
    expect(nextMaintenanceFeed(EMPTY_MAINTENANCE_FEED, parsed({ mode: "off" })).fill).toBeNull();
  });

  it("returns_the_same_object_when_nothing_changed", () => {
    const first = nextMaintenanceFeed(EMPTY_MAINTENANCE_FEED, parsed());
    const second = nextMaintenanceFeed(first, parsed({ now: 1790647330000 }));
    expect(second).toBe(first);
  });

  it("keeps_the_run_object_for_the_same_run_id", () => {
    const first = nextMaintenanceFeed(EMPTY_MAINTENANCE_FEED, parsed());
    const second = nextMaintenanceFeed(first, parsed({ clutter: { ...statusBody().clutter, level: 0.5 } }));
    expect(second).not.toBe(first);
    expect(second.lastRun).toBe(first.lastRun);
    expect(second.memory).toBe(first.memory);
  });

  it("measures_the_run_age_by_the_server_clock", () => {
    const feed = nextMaintenanceFeed(EMPTY_MAINTENANCE_FEED, parsed());
    expect(feed.lastRun).toEqual({
      id: "run-mg3k2a1b-4f09c2",
      finishedAt: 1790647242000,
      freedBytes: 475629,
      cartworthy: true,
      dryRun: false,
      ageMs: 68000,
    });
  });

  it("changes_memory_only_on_a_level_or_a_64_mib_step", () => {
    const first = nextMaintenanceFeed(EMPTY_MAINTENANCE_FEED, parsed());
    const memory = statusBody().memory;
    const nudged = nextMaintenanceFeed(first, parsed({ memory: { ...memory, rss: memory.rss + 1_000_000 } }));
    expect(nudged).toBe(first);
    const grown = nextMaintenanceFeed(first, parsed({ memory: { ...memory, rss: memory.rss + 200 * 1024 * 1024 } }));
    expect(grown.memory).not.toBe(first.memory);
    const calm = nextMaintenanceFeed(first, parsed({ memory: { ...memory, level: "ok", recommendation: null } }));
    expect(calm.memory?.level).toBe("ok");
  });

  it("keeps_the_last_values_when_a_poll_fails", () => {
    const feed = nextMaintenanceFeed(EMPTY_MAINTENANCE_FEED, parsed());
    const offline = markMaintenanceFeedOffline(feed);
    expect(offline.online).toBe(false);
    expect(offline.fill).toBe(feed.fill);
    expect(offline.lastRun).toBe(feed.lastRun);
    expect(markMaintenanceFeedOffline(offline)).toBe(offline);
  });
});

describe("createArchiveRunGuard", () => {
  it("makes_a_trip_for_a_new_cartworthy_run_once", () => {
    const storage = memoryStorage();
    const guard = createArchiveRunGuard(storage);
    expect(guard.admit(feedRun())).toBe("trip");
    expect(guard.admit(feedRun())).toBe("ignore");
    expect(storage.map.get(ARCHIVE_SEEN_STORAGE_KEY)).toBe("run-a");
  });

  it("does_not_replay_a_run_after_a_reload_or_in_another_tab", () => {
    const storage = memoryStorage();
    expect(createArchiveRunGuard(storage).admit(feedRun())).toBe("trip");
    expect(createArchiveRunGuard(storage).admit(feedRun())).toBe("ignore");
  });

  it("says_checked_for_a_run_with_nothing_to_take_out", () => {
    const guard = createArchiveRunGuard(memoryStorage());
    expect(guard.admit(feedRun({ cartworthy: false }))).toBe("checked");
  });

  it("marks_an_old_run_seen_without_a_trip", () => {
    const storage = memoryStorage();
    const guard = createArchiveRunGuard(storage);
    expect(guard.admit(feedRun({ ageMs: ARCHIVE_RUN_MAX_AGE_MS + 1 }))).toBe("ignore");
    expect(storage.map.get(ARCHIVE_SEEN_STORAGE_KEY)).toBe("run-a");
    expect(guard.admit(feedRun({ id: "run-b" }))).toBe("trip");
  });

  it("stays_quiet_about_dry_runs", () => {
    const guard = createArchiveRunGuard(memoryStorage());
    expect(guard.admit(feedRun({ dryRun: true, cartworthy: false }))).toBe("ignore");
  });

  it("takes_the_first_run_as_seen_without_storage", () => {
    const guard = createArchiveRunGuard(null);
    expect(guard.admit(feedRun())).toBe("ignore");
    expect(guard.admit(feedRun())).toBe("ignore");
    expect(guard.admit(feedRun({ id: "run-b" }))).toBe("trip");
  });

  it("survives_storage_that_throws", () => {
    const guard = createArchiveRunGuard({
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(guard.admit(feedRun())).toBe("ignore");
    expect(guard.admit(feedRun({ id: "run-b" }))).toBe("trip");
    expect(guard.admit(feedRun({ id: "run-b" }))).toBe("ignore");
  });

  it("ignores_no_run", () => {
    expect(createArchiveRunGuard(memoryStorage()).admit(null)).toBe("ignore");
  });
});

describe("formatBytesRu", () => {
  it("uses_russian_units_with_a_decimal_comma", () => {
    expect(formatBytesRu(0)).toBe("0 КБ");
    expect(formatBytesRu(10)).toBe("1 КБ");
    expect(formatBytesRu(475629)).toBe("464 КБ");
    expect(formatBytesRu(51.2 * 1024 * 1024)).toBe("51,2 МБ");
    expect(formatBytesRu(3650000000)).toBe("3,4 ГБ");
  });

  it("never_prints_four_digits_before_switching_unit", () => {
    expect(formatBytesRu(1023 * 1024)).toBe("1,0 МБ");
    expect(formatBytesRu(1023.99 * 1024 * 1024)).toBe("1,0 ГБ");
  });

  it("treats_nonsense_as_zero", () => {
    expect(formatBytesRu(Number.NaN)).toBe("0 КБ");
    expect(formatBytesRu(-5)).toBe("0 КБ");
  });
});

describe("describeMaintenanceLogEvent", () => {
  const base = { runId: "run-a", agentId: "a1", name: "APT28", freedBytes: 51.2 * 1024 * 1024 };

  it("words_every_cart_event", () => {
    expect(describeMaintenanceLogEvent({ ...base, type: "taken" })).toBe("APT28 везёт архив к выходу");
    expect(describeMaintenanceLogEvent({ ...base, type: "paused" })).toBe("APT28 оставил тележку — брифинг");
    expect(describeMaintenanceLogEvent({ ...base, type: "resumed" })).toBe("APT28 вернулся за тележкой");
    expect(describeMaintenanceLogEvent({ ...base, type: "reassigned", previousName: "APT29" })).toBe(
      "APT28 подхватил тележку за APT29",
    );
    expect(describeMaintenanceLogEvent({ ...base, type: "handover" })).toBe(
      "APT28 вывез архив: освобождено 51,2 МБ",
    );
    expect(describeMaintenanceLogEvent({ ...base, agentId: null, name: "", type: "auto" })).toBe(
      "Архив вывезен: освобождено 51,2 МБ",
    );
    expect(describeMaintenanceLogEvent({ ...base, type: "parked" })).toBeNull();
  });

  it("words_the_host_lines", () => {
    expect(describeMaintenanceLogEvent({ type: "checked", runId: "run-a" })).toBe(
      "Архив проверен: вывозить нечего",
    );
    expect(
      describeMaintenanceLogEvent({
        type: "memory",
        level: "high",
        rss: 3650000000,
        recommendation: "restart-dev-server",
      }),
    ).toBe("Сервер разработки: 3,4 ГБ — нужен перезапуск npm run dev (данные не пострадают)");
    expect(
      describeMaintenanceLogEvent({ type: "memory", level: "high", rss: 2 * 1024 ** 3, recommendation: "possible-leak" }),
    ).toContain("возможна утечка");
    expect(describeMaintenanceLogEvent({ type: "memory", level: "ok", rss: 1, recommendation: null })).toBeNull();
  });
});

describe("shouldLogMaintenanceMemory", () => {
  const high = { level: "high" as const, rss: 3 * 1024 ** 3, recommendation: "restart-dev-server" as const };
  const ok = { level: "ok" as const, rss: 1024 ** 3, recommendation: null };

  it("logs_once_per_new_recommendation", () => {
    expect(shouldLogMaintenanceMemory(null, high)).toBe(true);
    expect(shouldLogMaintenanceMemory(ok, high)).toBe(true);
    expect(shouldLogMaintenanceMemory(high, { ...high, rss: high.rss + 1024 ** 3 })).toBe(false);
    expect(shouldLogMaintenanceMemory(high, ok)).toBe(false);
    expect(shouldLogMaintenanceMemory(null, null)).toBe(false);
  });
});

describe("useMaintenanceFeed", () => {
  const respond = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

  let visibility: DocumentVisibilityState = "visible";

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = "visible";
    vi.spyOn(Document.prototype, "visibilityState", "get").mockImplementation(() => visibility);
  });

  afterEach(() => {
    // Unmount every hook, or its visibility listener outlives the test.
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const flush = async (ms = 0) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it("polls_at_once_then_every_20_s_and_keeps_the_object_stable", async () => {
    const fetchMock = vi.fn(() => respond(statusBody()));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useMaintenanceFeed());
    expect(result.current).toBe(EMPTY_MAINTENANCE_FEED);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual([MAINTENANCE_STATUS_URL, expect.objectContaining({ cache: "no-store" })]);
    const first = result.current;
    expect(first.fill).toBe(0.01);
    expect(first.lastRun?.id).toBe("run-mg3k2a1b-4f09c2");

    await flush(MAINTENANCE_POLL_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await flush(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(first);
  });

  it("backs_off_to_60_s_after_an_error_and_keeps_the_last_values", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => respond(statusBody()))
      .mockImplementationOnce(() => respond({ error: "nope" }, 503))
      .mockImplementation(() => respond(statusBody()));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useMaintenanceFeed());
    await flush();
    await flush(MAINTENANCE_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.online).toBe(false);
    expect(result.current.fill).toBe(0.01);
    await flush(MAINTENANCE_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await flush(MAINTENANCE_ERROR_POLL_MS - MAINTENANCE_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.online).toBe(true);
  });

  it("treats_a_network_failure_or_an_invalid_body_as_an_error", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new TypeError("offline")))
      .mockImplementationOnce(() => respond({ schema: 1 }))
      .mockImplementation(() => respond(statusBody()));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useMaintenanceFeed());
    await flush();
    expect(result.current).toBe(EMPTY_MAINTENANCE_FEED);
    await flush(MAINTENANCE_ERROR_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.online).toBe(false);
    await flush(MAINTENANCE_ERROR_POLL_MS);
    expect(result.current.online).toBe(true);
  });

  it("pauses_while_the_tab_is_hidden", async () => {
    const fetchMock = vi.fn(() => respond(statusBody()));
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useMaintenanceFeed());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await flush(MAINTENANCE_POLL_MS * 5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts_on_unmount_and_polls_no_more", async () => {
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = renderHook(() => useMaintenanceFeed());
    await flush();
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
    await flush(MAINTENANCE_ERROR_POLL_MS * 2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does_nothing_when_disabled", async () => {
    const fetchMock = vi.fn(() => respond(statusBody()));
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useMaintenanceFeed(false));
    await flush(MAINTENANCE_POLL_MS * 3);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
