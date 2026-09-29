// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { createMaintenanceService } = await import("../../server/maintenance/index.js");
const { createAccessGate } = await import("../../server/access-gate.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const MiB = 1024 * 1024;
const SECOND = 1000;
const HOUR = 3_600_000;

const request = (method: string, url: string, headers: Record<string, string> = {}, body?: string | Buffer) => {
  const stream = Readable.from(body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)]);
  return Object.assign(stream, { method, url, headers: { host: "localhost:3000", ...headers }, socket: { remoteAddress: "127.0.0.1" } });
};

const response = () => {
  let resolveEnd: (value: void) => void = () => {};
  const ended = new Promise<void>((resolve) => {
    resolveEnd = resolve;
  });
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: "",
    headersSent: false,
    ended,
    setHeader(key: string, value: string) {
      this.headers[key.toLowerCase()] = value;
    },
    end(chunk?: string) {
      this.body = chunk ?? "";
      this.headersSent = true;
      resolveEnd();
    },
  };
  return res;
};

const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

describe("maintenance HTTP", () => {
  let base: string;
  let projectRoot: string;
  let stateDir: string;
  let tmpDir: string;
  let t: number;
  let services: Loose[];

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "maint-http-"));
    projectRoot = path.join(base, "project");
    stateDir = path.join(base, "state");
    tmpDir = path.join(base, "tmp");
    for (const dir of [projectRoot, stateDir, tmpDir]) fs.mkdirSync(dir, { recursive: true });
    t = Date.now();
    services = [];
  });

  afterEach(() => {
    for (const service of services) service.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const make = (env: Record<string, string> = {}) => {
    const service = createMaintenanceService({
      env: env as Loose,
      dev: true,
      projectRoot,
      stateDir,
      tmpDir,
      now: () => t,
      log: () => {},
      readMemory: () => ({ rss: 900 * MiB, heapUsed: 300 * MiB, heapLimit: 4096 * MiB, external: 5, arrayBuffers: 6 }),
    });
    services.push(service);
    return service;
  };

  const call = async (service: Loose, req: Loose) => {
    const res = response();
    const handled = service.handleHttp(req, res);
    if (handled) await res.ended;
    return { handled, res, json: res.body ? JSON.parse(res.body) : null };
  };

  const litter = () => {
    const fd = fs.openSync(path.join(projectRoot, ".next", "dev", "trace"), "w");
    fs.ftruncateSync(fd, 20 * MiB);
    fs.closeSync(fd);
    const voice = path.join(tmpDir, "office3d-voice-abc123");
    fs.mkdirSync(voice);
    fs.writeFileSync(path.join(voice, "clip.webm"), "abcd");
    const old = (t - 2 * HOUR) / 1000;
    fs.utimesSync(path.join(voice, "clip.webm"), old, old);
    fs.utimesSync(voice, old, old);
  };

  it("serves the status with the documented shape and no paths", async () => {
    fs.mkdirSync(path.join(projectRoot, ".next", "dev"), { recursive: true });
    litter();
    const service = make();
    await service.start();
    await service.measure();
    await service.runNow("manual");
    const { handled, res, json } = await call(service, request("GET", "/api/maintenance/status?x=1"));
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-type"]).toContain("application/json");
    expect(Object.keys(json).sort()).toEqual(
      ["clutter", "lastRun", "memory", "mode", "now", "recentRuns", "running", "schedule", "schema", "service", "weight"].sort()
    );
    expect(json).toMatchObject({ schema: 1, mode: "on", service: "idle", now: t, running: false });
    expect(Object.keys(json.clutter).sort()).toEqual(
      ["byTarget", "fullAtBytes", "level", "measuredAt", "reclaimableBytes", "reclaimableItems"].sort()
    );
    expect(json.clutter.byTarget.map((entry: Loose) => entry.id)).toEqual([
      "dev-trace",
      "dev-log",
      "hmr-updates",
      "voice-temp",
      "test-temp",
      "orphan-tmp",
    ]);
    expect(json.memory).toMatchObject({ rss: 900 * MiB, level: "ok", recommendation: null, trendMbPerHour: 0 });
    expect(Object.keys(json.schedule).sort()).toEqual(["minGapMs", "nextMeasureAt", "nextScheduledRunAt", "threshold"]);
    expect(json.lastRun).toMatchObject({
      trigger: "manual",
      freedBytes: 20 * MiB + 4,
      removedFiles: 1,
      truncatedFiles: 1,
      cartworthy: true,
      dryRun: false,
    });
    expect(json.recentRuns).toHaveLength(1);
    for (const entry of json.weight) expect(entry.prunable).toBe(false);

    const body = res.body.toLowerCase();
    const variants = (p: string) => [p, p.replace(/\\/g, "/"), JSON.stringify(p).slice(1, -1)].map((v) => v.toLowerCase());
    for (const secret of [...variants(os.homedir()), ...variants(base), ...variants(fs.realpathSync(base))]) {
      expect(body.includes(secret), secret).toBe(false);
    }
  });

  it("answers HEAD without a body and refuses other methods on status", async () => {
    const service = make();
    const head = await call(service, request("HEAD", "/api/maintenance/status"));
    expect(head.res.statusCode).toBe(200);
    expect(head.res.body).toBe("");
    const post = await call(service, request("POST", "/api/maintenance/status", SAME_ORIGIN));
    expect(post.res.statusCode).toBe(405);
    expect(post.res.headers.allow).toBe("GET, HEAD");
  });

  it("leaves other paths to the next handler", async () => {
    const service = make();
    const res = response();
    expect(service.handleHttp(request("GET", "/api/maintenance"), res)).toBe(false);
    expect(service.handleHttp(request("GET", "/api/maintenance/status/x"), res)).toBe(false);
    expect(service.handleHttp(request("GET", "/office"), res)).toBe(false);
    expect(res.headersSent).toBe(false);
  });

  it("runs only same-origin POSTs, at most once a minute", async () => {
    const service = make();
    await service.start();
    const get = await call(service, request("GET", "/api/maintenance/run", SAME_ORIGIN));
    expect(get.res.statusCode).toBe(405);
    expect(get.res.headers.allow).toBe("POST");

    const bare = await call(service, request("POST", "/api/maintenance/run", {}, '{"trigger":"manual"}'));
    expect(bare.res.statusCode).toBe(403);
    const cross = await call(
      service,
      request("POST", "/api/maintenance/run", { origin: "https://evil.test", "sec-fetch-site": "cross-site" }, "{}")
    );
    expect(cross.res.statusCode).toBe(403);

    const ok = await call(service, request("POST", "/api/maintenance/run", SAME_ORIGIN, '{"trigger":"manual"}'));
    expect(ok.res.statusCode).toBe(200);
    expect(ok.json).toMatchObject({ trigger: "manual", dryRun: false, cartworthy: false });
    expect(Object.keys(ok.json).sort()).toEqual(
      [
        "actions",
        "capped",
        "cartworthy",
        "clutterAfter",
        "clutterBefore",
        "dryRun",
        "errors",
        "finishedAt",
        "freedBytes",
        "id",
        "removedFiles",
        "startedAt",
        "trigger",
        "truncatedFiles",
      ].sort()
    );

    t += 30 * SECOND;
    const limited = await call(
      service,
      request("POST", "/api/maintenance/run", { origin: "http://localhost:3000" }, '{"trigger":"manual"}')
    );
    expect(limited.res.statusCode).toBe(429);
    expect(limited.res.headers["retry-after"]).toBe("30");

    t += 31 * SECOND;
    const again = await call(service, request("POST", "/api/maintenance/run", SAME_ORIGIN));
    expect(again.res.statusCode).toBe(200);
    expect(again.json.id).not.toBe(ok.json.id);
  });

  it("rejects bad bodies and triggers", async () => {
    const service = make();
    await service.start();
    expect((await call(service, request("POST", "/api/maintenance/run", SAME_ORIGIN, "{nope"))).res.statusCode).toBe(400);
    expect(
      (await call(service, request("POST", "/api/maintenance/run", SAME_ORIGIN, '{"trigger":"scheduled"}'))).res.statusCode
    ).toBe(400);
    expect((await call(service, request("POST", "/api/maintenance/run", SAME_ORIGIN, "x".repeat(4096)))).res.statusCode).toBe(
      413
    );
  });

  it("says 409 when maintenance is off", async () => {
    const service = make({ OFFICE3D_MAINTENANCE: "off" });
    await service.start();
    const off = await call(service, request("POST", "/api/maintenance/run", SAME_ORIGIN));
    expect(off.res.statusCode).toBe(409);
    const status = await call(service, request("GET", "/api/maintenance/status"));
    expect(status.json).toMatchObject({ mode: "off", service: "off" });
  });

  it("is served only after the access gate", async () => {
    const service = make();
    const gate = createAccessGate({ token: "maintenance-test-token" });
    const serve = (req: Loose, res: Loose) => {
      if (gate.handleHttp(req, res)) return "gate";
      if (service.handleHttp(req, res)) return "maintenance";
      return "next";
    };
    const res = response();
    expect(serve(request("GET", "/api/maintenance/status"), res)).toBe("gate");
    expect(res.statusCode).toBe(401);

    // And server/index.js asks the gate first, in both server branches.
    const source = fs.readFileSync(fileURLToPath(new URL("../../server/index.js", import.meta.url)), "utf8");
    const gateCalls = [...source.matchAll(/accessGate\.handleHttp\(req, res\)/g)].map((m) => m.index ?? 0);
    const maintenanceCalls = [...source.matchAll(/maintenance\.handleHttp\(req, res\)/g)].map((m) => m.index ?? 0);
    expect(gateCalls).toHaveLength(2);
    expect(maintenanceCalls).toHaveLength(2);
    expect(maintenanceCalls[0]).toBeGreaterThan(gateCalls[0]);
    expect(maintenanceCalls[1]).toBeGreaterThan(gateCalls[1]);
    expect(maintenanceCalls[0]).toBeLessThan(gateCalls[1]);
  });
});
