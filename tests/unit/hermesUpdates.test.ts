// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createUpdates } = await import("../../server/hermes/updates.js");
const { createHermesStore } = await import("../../server/hermes/store.js");

class AdapterError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

describe("hermes updates in the office", () => {
  let dir: string;
  let store: Loose;
  let clock: number;
  let status: Loose;
  let requests: Array<{ url: string; init: RequestInit }>;
  let events: Array<{ event: string; payload: Loose }>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "office3d-updates-"));
    store = createHermesStore({ filePath: path.join(dir, "state.json") });
    clock = Date.parse("2026-09-23T10:00:00Z");
    status = { current: "v2026.9.14", latest: "v2026.9.21", newer: ["v2026.9.21"], job: null, checkedAt: "x" };
    requests = [];
    events = [];
  });

  afterEach(async () => {
    await store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const make = (updater: Loose = { url: "http://updater:3020", token: "t".repeat(32) }) =>
    createUpdates({
      updater,
      store,
      AdapterError,
      broadcast: (event: string, payload: Loose) => events.push({ event, payload }),
      now: () => clock,
      fetchImpl: (async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        if (String(url).endsWith("/update")) {
          const tag = JSON.parse(String(init.body)).tag;
          if (tag === "v2099.1.1") return Response.json({ error: "Версии v2099.1.1 нет в реестре образов." }, { status: 400 });
          status = { ...status, job: { id: "upd_1", status: "running", step: "pull", from: status.current, to: tag } };
          return Response.json({ job: status.job }, { status: 202 });
        }
        return Response.json(status);
      }) as Loose,
    });

  it("offers_a_newer_version_and_tells_the_office", async () => {
    const updates = make();
    const view = await updates.handlers["hermes.update.status"]({});
    expect(view).toMatchObject({ available: true, reachable: true, current: "v2026.9.14", latest: "v2026.9.21", offer: true });
    expect(events.at(-1)).toMatchObject({ event: "hermes.update", payload: { offer: true } });
    expect((requests[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${"t".repeat(32)}`);
  });

  it("hides_a_version_for_a_day_on_later", async () => {
    const updates = make();
    await updates.refresh();
    const later = await updates.handlers["hermes.update.later"]({ tag: "v2026.9.21" });
    expect(later).toMatchObject({ offer: false });
    clock += 25 * 60 * 60_000;
    expect(await updates.refresh()).toMatchObject({ offer: true });
  });

  it("starts_an_update_and_reports_it_running", async () => {
    const updates = make();
    const started = await updates.handlers["hermes.update.start"]({ tag: "v2026.9.21" });
    expect(started).toMatchObject({ running: true, offer: false, job: { step: "pull", to: "v2026.9.21" } });
    expect(JSON.parse(String(requests.find((r) => r.url.endsWith("/update"))!.init.body))).toEqual({ tag: "v2026.9.21" });
    updates.close();
  });

  it("does_not_offer_again_a_version_that_was_rolled_back", async () => {
    status = { ...status, job: { id: "upd_9", status: "rolled_back", from: "v2026.9.14", to: "v2026.9.21" } };
    expect(await make().refresh()).toMatchObject({ offer: false });
    status = { ...status, latest: "v2026.9.28", newer: ["v2026.9.28", "v2026.9.21"] };
    expect(await make().refresh()).toMatchObject({ offer: true, latest: "v2026.9.28" });
  });

  it("passes_the_updaters_refusal_on", async () => {
    const updates = make();
    await expect(updates.handlers["hermes.update.start"]({ tag: "v2099.1.1" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      message: "Версии v2099.1.1 нет в реестре образов.",
    });
  });

  it("stays_quiet_without_an_updater_and_reports_an_unreachable_one", async () => {
    expect(await make(null).handlers["hermes.update.status"]({})).toEqual({ available: false });
    await expect(make(null).handlers["hermes.update.start"]({ tag: "v2026.9.21" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const broken = createUpdates({
      updater: { url: "http://updater:3020", token: "t".repeat(32) },
      store,
      AdapterError,
      broadcast: () => {},
      fetchImpl: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as Loose,
    });
    expect(await broken.refresh()).toEqual({ available: true, reachable: false });
  });
});
