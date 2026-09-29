import { t } from "@/lib/i18n";

import type { HqArchiveEvent } from "../core/types";

/**
 * The client side of the maintenance service (`server/maintenance/*`).
 *
 * The server measures how much disposable clutter the dev server and the app
 * leave behind (old HMR chunks, test temp folders, voice temp files), cleans it
 * on a schedule, and reports it at `GET /api/maintenance/status`. The HQ shows
 * that as the archive cart by the entrance: it fills up with the clutter, and a
 * run the server calls «cartworthy» sends an agent to push it out.
 *
 * Everything here is pure, so it can be tested without a network or a scene:
 * the response validator, the feed reducer the polling hook uses, the replay
 * guard that keeps a reload from replaying an old trip, the byte formatter and
 * the console lines.
 */

export const MAINTENANCE_STATUS_URL = "/api/maintenance/status";

export type MaintenanceMode = "on" | "report" | "off";
export type MaintenanceService = "starting" | "idle" | "measuring" | "running" | "off";
export type MaintenanceTrigger = "scheduled" | "threshold" | "manual";
export type MaintenanceMemoryLevel = "ok" | "elevated" | "high";
export type MaintenanceRecommendation = null | "restart-dev-server" | "possible-leak";

export type MaintenanceRunAction = {
  target: string;
  op: "truncate" | "remove";
  bytes: number;
  items: number;
};

export type MaintenanceRunError = { target: string; code: string; count: number };

export type MaintenanceRun = {
  id: string;
  trigger: MaintenanceTrigger;
  /** Report mode: nothing was touched, and the run is never cartworthy. */
  dryRun: boolean;
  startedAt: number;
  finishedAt: number;
  freedBytes: number;
  removedFiles: number;
  truncatedFiles: number;
  clutterBefore: number;
  clutterAfter: number;
  /** Decided once, on the server: worth a trip with the cart. The client adds no rule of its own. */
  cartworthy: boolean;
  capped: null | "ops" | "time";
  actions: MaintenanceRunAction[];
  errors: MaintenanceRunError[];
};

export type MaintenanceMemory = {
  rss: number;
  heapUsed: number;
  heapLimit: number;
  external: number;
  arrayBuffers: number;
  trendMbPerHour: number;
  level: MaintenanceMemoryLevel;
  recommendation: MaintenanceRecommendation;
  sampledAt: number;
};

export type MaintenanceStatus = {
  schema: 1;
  mode: MaintenanceMode;
  service: MaintenanceService;
  /** Server clock at response time: ages are measured against it, not the browser's. */
  now: number;
  running: boolean;
  clutter: {
    level: number;
    reclaimableBytes: number;
    reclaimableItems: number;
    fullAtBytes: number;
    /** Null until the server has measured once (60 s after it starts). */
    measuredAt: number | null;
    byTarget: Array<{ id: string; bytes: number; items: number }>;
  };
  weight: Array<{ id: string; bytes: number; items?: number; cap?: true; prunable: false }>;
  memory: MaintenanceMemory;
  schedule: {
    nextMeasureAt: number | null;
    nextScheduledRunAt: number | null;
    threshold: number;
    minGapMs: number;
  };
  lastRun: MaintenanceRun | null;
  recentRuns: MaintenanceRun[];
};

// --- Validation ---------------------------------------------------------------

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** A count or a byte size: finite and not negative. */
const size = (value: unknown): value is number => finite(value) && value >= 0;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === "string" && (allowed as readonly string[]).includes(value);

const MODES = ["on", "report", "off"] as const;
const SERVICES = ["starting", "idle", "measuring", "running", "off"] as const;
const TRIGGERS = ["scheduled", "threshold", "manual"] as const;
const MEMORY_LEVELS = ["ok", "elevated", "high"] as const;
const RECOMMENDATIONS = ["restart-dev-server", "possible-leak"] as const;
const OPS = ["truncate", "remove"] as const;

/** Ids are the server's own (`run-…`); anything longer is not one of them. */
const RUN_ID_MAX = 128;
const SHORT_TEXT_MAX = 64;

const shortText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= SHORT_TEXT_MAX;

const nullableTime = (value: unknown): number | null | undefined =>
  value === null ? null : finite(value) ? value : undefined;

const parseRun = (value: unknown): MaintenanceRun | null => {
  if (!isObject(value)) return null;
  const { id, trigger, startedAt, finishedAt, freedBytes, removedFiles, truncatedFiles } = value;
  if (typeof id !== "string" || id.length === 0 || id.length > RUN_ID_MAX) return null;
  if (!oneOf(trigger, TRIGGERS)) return null;
  if (!finite(startedAt) || !finite(finishedAt)) return null;
  if (!size(freedBytes) || !size(removedFiles) || !size(truncatedFiles)) return null;
  if (!finite(value.clutterBefore) || !finite(value.clutterAfter)) return null;
  if (typeof value.cartworthy !== "boolean") return null;
  // Added to the contract after the plan: tolerate a server that predates them.
  if (value.dryRun !== undefined && typeof value.dryRun !== "boolean") return null;
  const dryRun = value.dryRun === true;
  const actions: MaintenanceRunAction[] = [];
  if (Array.isArray(value.actions)) {
    for (const action of value.actions) {
      if (!isObject(action)) continue;
      if (!shortText(action.target) || !oneOf(action.op, OPS)) continue;
      if (!size(action.bytes) || !size(action.items)) continue;
      actions.push({ target: action.target, op: action.op, bytes: action.bytes, items: action.items });
    }
  }
  const errors: MaintenanceRunError[] = [];
  if (Array.isArray(value.errors)) {
    for (const error of value.errors) {
      if (!isObject(error)) continue;
      if (!shortText(error.target) || !shortText(error.code) || !size(error.count)) continue;
      errors.push({ target: error.target, code: error.code, count: error.count });
    }
  }
  return {
    id,
    trigger,
    dryRun,
    startedAt,
    finishedAt,
    freedBytes,
    removedFiles,
    truncatedFiles,
    clutterBefore: clamp01(value.clutterBefore),
    clutterAfter: clamp01(value.clutterAfter),
    // A dry run touched nothing, whatever the flag says.
    cartworthy: value.cartworthy && !dryRun,
    capped: value.capped === "ops" || value.capped === "time" ? value.capped : null,
    actions,
    errors,
  };
};

const parseMemory = (value: unknown): MaintenanceMemory | null => {
  if (!isObject(value)) return null;
  const { rss, heapUsed, heapLimit, external, arrayBuffers, trendMbPerHour, level, sampledAt } = value;
  if (!size(rss) || !size(heapUsed) || !size(heapLimit) || !size(external) || !size(arrayBuffers)) {
    return null;
  }
  if (!finite(trendMbPerHour) || !finite(sampledAt)) return null;
  if (!oneOf(level, MEMORY_LEVELS)) return null;
  const recommendation = value.recommendation;
  if (recommendation !== null && !oneOf(recommendation, RECOMMENDATIONS)) return null;
  return {
    rss,
    heapUsed,
    heapLimit,
    external,
    arrayBuffers,
    trendMbPerHour,
    level,
    recommendation,
    sampledAt,
  };
};

/**
 * Validates a `GET /api/maintenance/status` body (schema 1).
 *
 * Returns null for anything that is not that shape, so a proxy error page or a
 * server from before the service reads as "no data" rather than as a cart run.
 * Unknown fields are ignored, as the contract asks. A malformed `lastRun` fails
 * the whole status: that field decides whether an agent walks off with the cart,
 * so it is not guessed at. Malformed entries of the informational lists
 * (`recentRuns`, `byTarget`, `weight`, run actions) are dropped instead.
 */
export const parseMaintenanceStatus = (body: unknown): MaintenanceStatus | null => {
  if (!isObject(body) || body.schema !== 1) return null;
  const { mode, service, now, running, clutter, schedule } = body;
  if (!oneOf(mode, MODES) || !oneOf(service, SERVICES)) return null;
  if (!finite(now) || typeof running !== "boolean") return null;

  if (!isObject(clutter)) return null;
  const { level, reclaimableBytes, reclaimableItems, fullAtBytes } = clutter;
  if (!finite(level) || !size(reclaimableBytes) || !size(reclaimableItems) || !size(fullAtBytes)) {
    return null;
  }
  // Absent on a server from before the field was added: take the level as measured.
  const measuredAt = clutter.measuredAt === undefined ? now : nullableTime(clutter.measuredAt);
  if (measuredAt === undefined) return null;
  const byTarget: MaintenanceStatus["clutter"]["byTarget"] = [];
  if (Array.isArray(clutter.byTarget)) {
    for (const entry of clutter.byTarget) {
      if (!isObject(entry) || !shortText(entry.id) || !size(entry.bytes) || !size(entry.items)) continue;
      byTarget.push({ id: entry.id, bytes: entry.bytes, items: entry.items });
    }
  }

  const memory = parseMemory(body.memory);
  if (!memory) return null;

  if (!isObject(schedule)) return null;
  const nextMeasureAt = nullableTime(schedule.nextMeasureAt);
  const nextScheduledRunAt = nullableTime(schedule.nextScheduledRunAt);
  if (nextMeasureAt === undefined || nextScheduledRunAt === undefined) return null;
  if (!finite(schedule.threshold) || !size(schedule.minGapMs)) return null;

  let lastRun: MaintenanceRun | null = null;
  if (body.lastRun !== null && body.lastRun !== undefined) {
    lastRun = parseRun(body.lastRun);
    if (!lastRun) return null;
  }

  const recentRuns: MaintenanceRun[] = [];
  if (Array.isArray(body.recentRuns)) {
    for (const entry of body.recentRuns.slice(0, 10)) {
      const run = parseRun(entry);
      if (run) recentRuns.push(run);
    }
  }

  const weight: MaintenanceStatus["weight"] = [];
  if (Array.isArray(body.weight)) {
    for (const entry of body.weight) {
      if (!isObject(entry) || !shortText(entry.id) || !size(entry.bytes)) continue;
      const item: MaintenanceStatus["weight"][number] = { id: entry.id, bytes: entry.bytes, prunable: false };
      if (size(entry.items)) item.items = entry.items;
      if (entry.cap === true) item.cap = true;
      weight.push(item);
    }
  }

  return {
    schema: 1,
    mode,
    service,
    now,
    running,
    clutter: {
      level: clamp01(level),
      reclaimableBytes,
      reclaimableItems,
      fullAtBytes,
      measuredAt,
      byTarget,
    },
    weight,
    memory,
    schedule: {
      nextMeasureAt,
      nextScheduledRunAt,
      threshold: schedule.threshold,
      minGapMs: schedule.minGapMs,
    },
    lastRun,
    recentRuns,
  };
};

// --- The feed the HQ reads ------------------------------------------------------

/** The last run, as much of it as the HQ needs to decide on a trip. */
export type MaintenanceFeedRun = {
  id: string;
  finishedAt: number;
  freedBytes: number;
  cartworthy: boolean;
  dryRun: boolean;
  /**
   * How long ago the run finished when this client first saw it, by the
   * server's clock (so a wrong browser clock cannot make an old run look new).
   */
  ageMs: number;
};

export type MaintenanceFeedMemory = {
  level: MaintenanceMemoryLevel;
  /** Resident memory of the server process, rounded to 64 MiB so the object only changes when it matters. */
  rss: number;
  recommendation: MaintenanceRecommendation;
};

export type MaintenanceFeed = {
  /**
   * How full the archive is, 0..1 in steps of 0.01. Null until the server has
   * measured once, and while maintenance is off: the cart then keeps whatever
   * it shows rather than emptying and refilling on every page load.
   */
  fill: number | null;
  lastRun: MaintenanceFeedRun | null;
  memory: MaintenanceFeedMemory | null;
  /** The last poll got a valid status. False before the first one and after an error. */
  online: boolean;
};

export const EMPTY_MAINTENANCE_FEED: MaintenanceFeed = Object.freeze({
  fill: null,
  lastRun: null,
  memory: null,
  online: false,
}) as MaintenanceFeed;

const RSS_STEP = 64 * 1024 * 1024;

/**
 * The feed after a good poll. Returns `previous` itself when nothing the HQ
 * uses changed, and keeps each part's identity when that part did not change,
 * so effects keyed on `feed.lastRun` or `feed.memory` fire only on real news.
 */
export const nextMaintenanceFeed = (
  previous: MaintenanceFeed,
  status: MaintenanceStatus,
): MaintenanceFeed => {
  const fill =
    status.mode === "off" || status.clutter.measuredAt === null
      ? null
      : Math.round(clamp01(status.clutter.level) * 100) / 100;

  const run = status.lastRun;
  let lastRun = previous.lastRun;
  if (!run) {
    lastRun = null;
  } else if (!lastRun || lastRun.id !== run.id) {
    lastRun = {
      id: run.id,
      finishedAt: run.finishedAt,
      freedBytes: run.freedBytes,
      cartworthy: run.cartworthy,
      dryRun: run.dryRun,
      ageMs: Math.max(0, status.now - run.finishedAt),
    };
  }

  const rss = Math.round(status.memory.rss / RSS_STEP) * RSS_STEP;
  let memory = previous.memory;
  if (
    !memory ||
    memory.level !== status.memory.level ||
    memory.recommendation !== status.memory.recommendation ||
    memory.rss !== rss
  ) {
    memory = { level: status.memory.level, rss, recommendation: status.memory.recommendation };
  }

  if (
    previous.online &&
    previous.fill === fill &&
    previous.lastRun === lastRun &&
    previous.memory === memory
  ) {
    return previous;
  }
  return { fill, lastRun, memory, online: true };
};

/** The feed after a failed poll: the last known values stay, only `online` drops. */
export const markMaintenanceFeedOffline = (previous: MaintenanceFeed): MaintenanceFeed =>
  previous.online ? { ...previous, online: false } : previous;

// --- Replay guard ---------------------------------------------------------------

export const ARCHIVE_SEEN_STORAGE_KEY = "office3d.hq.archive.seenRunId";

/** A run that finished longer ago than this is history, not news: no trip for it. */
export const ARCHIVE_RUN_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * What the HQ does about a run it has just been told about:
 * - `trip`: an agent pushes the cart out (`sim.startArchiveRun`);
 * - `checked`: the console says the archive was checked and nothing needed taking out;
 * - `ignore`: nothing (already seen, too old, a dry run, or unknown whether seen).
 */
export type ArchiveRunDecision = "trip" | "checked" | "ignore";

type SeenStorage = Pick<Storage, "getItem" | "setItem">;

export type ArchiveRunGuard = {
  /** Decides once per run id and marks the run seen. */
  admit: (run: MaintenanceFeedRun | null) => ArchiveRunDecision;
};

const browserStorage = (): SeenStorage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

/**
 * Keeps a reload, a second tab or a laptop waking up from replaying a trip.
 *
 * A run makes a trip only if it is not already seen **and** finished at most
 * 10 minutes ago; either way it is marked seen. The mark lives in localStorage
 * so every tab of this browser shares it, and it is re-read on each decision
 * for the same reason. When storage is unavailable (private mode, blocked site
 * data), the first run this page sees is taken as already seen: it may well
 * have been shown before the reload, and a missed trip costs less than a
 * repeated one.
 */
export const createArchiveRunGuard = (
  storage: SeenStorage | null = browserStorage(),
): ArchiveRunGuard => {
  let memorySeen: string | null = null;
  let first = true;

  const readSeen = (): { ok: boolean; id: string | null } => {
    if (!storage) return { ok: false, id: null };
    try {
      return { ok: true, id: storage.getItem(ARCHIVE_SEEN_STORAGE_KEY) };
    } catch {
      return { ok: false, id: null };
    }
  };

  const writeSeen = (id: string): boolean => {
    if (!storage) return false;
    try {
      storage.setItem(ARCHIVE_SEEN_STORAGE_KEY, id);
      return true;
    } catch {
      return false;
    }
  };

  return {
    admit(run) {
      if (!run) return "ignore";
      const wasFirst = first;
      first = false;
      const stored = readSeen();
      if (run.id === memorySeen || run.id === stored.id) return "ignore";
      memorySeen = run.id;
      const persisted = writeSeen(run.id);
      if (!stored.ok || !persisted) {
        if (wasFirst) return "ignore";
      }
      if (run.dryRun || run.ageMs > ARCHIVE_RUN_MAX_AGE_MS) return "ignore";
      return run.cartworthy ? "trip" : "checked";
    },
  };
};

// --- Memory line ----------------------------------------------------------------

/**
 * Whether the console should say something about the server's memory: once
 * each time the recommendation changes to a new non-null one. Rss moving within
 * the same level stays quiet.
 */
export const shouldLogMaintenanceMemory = (
  previous: MaintenanceFeedMemory | null,
  next: MaintenanceFeedMemory | null,
): next is MaintenanceFeedMemory & { recommendation: NonNullable<MaintenanceRecommendation> } =>
  Boolean(next?.recommendation) && next?.recommendation !== previous?.recommendation;

// --- Words ------------------------------------------------------------------------

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

let oneDecimal: Intl.NumberFormat | null = null;
let wholeNumber: Intl.NumberFormat | null = null;

const formatOneDecimal = (value: number) => {
  oneDecimal ??= new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return oneDecimal.format(value);
};

const formatWhole = (value: number) => {
  wholeNumber ??= new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
  return wholeNumber.format(value);
};

/**
 * A byte size in Russian with a decimal comma: «512 КБ», «51,2 МБ», «3,4 ГБ».
 *
 * Binary units under their usual Russian names, as a file manager shows them.
 * Under a megabyte it counts whole kilobytes, and never shows «0 КБ» for
 * something that is not empty.
 */
export const formatBytesRu = (bytes: number): string => {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  const kib = value / KIB;
  if (Math.round(kib) < 1000) {
    const whole = value > 0 ? Math.max(1, Math.round(kib)) : 0;
    return t("hqArchive.sizeKb", { value: formatWhole(whole) });
  }
  const mib = value / MIB;
  if (Math.round(mib * 10) / 10 < 1000) {
    return t("hqArchive.sizeMb", { value: formatOneDecimal(mib) });
  }
  return t("hqArchive.sizeGb", { value: formatOneDecimal(value / GIB) });
};

/**
 * Everything the HQ tells the console about the archive: the cart's own events
 * from the simulation, plus the two the host adds (a run with nothing to take
 * out, and the server's memory).
 */
export type HqMaintenanceLogEvent =
  | HqArchiveEvent
  | { type: "checked"; runId: string }
  | {
      type: "memory";
      level: MaintenanceMemoryLevel;
      rss: number;
      recommendation: MaintenanceRecommendation;
    };

/** The console line for an event, or null for the ones that stay quiet (the cart parking). */
export const describeMaintenanceLogEvent = (event: HqMaintenanceLogEvent): string | null => {
  switch (event.type) {
    case "taken":
      return t("hqArchive.taken", { name: event.name });
    case "paused":
      return t("hqArchive.paused", { name: event.name });
    case "resumed":
      return t("hqArchive.resumed", { name: event.name });
    case "reassigned":
      return t("hqArchive.reassigned", { name: event.name, prev: event.previousName ?? "—" });
    case "handover":
      return t("hqArchive.done", { name: event.name, freed: formatBytesRu(event.freedBytes) });
    case "auto":
      return t("hqArchive.auto", { freed: formatBytesRu(event.freedBytes) });
    case "checked":
      return t("hqArchive.checked");
    case "memory":
      if (event.recommendation === "restart-dev-server") {
        return t("hqArchive.memory", { rss: formatBytesRu(event.rss) });
      }
      if (event.recommendation === "possible-leak") {
        return t("hqArchive.memoryLeak", { rss: formatBytesRu(event.rss) });
      }
      return null;
    case "parked":
      return null;
    default:
      return null;
  }
};
