// @vitest-environment node
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { createSecurityLog, createSecuritySummaryEndpoint, SECURITY_LOG_COUNT_MAX } = await import(
  "../../server/security-log.js"
);
const { createAccessGate } = await import("../../server/access-gate.js");
const { allowHttpOrigin } = await import("../../server/request-guard.js");

type SecurityLog = ReturnType<typeof createSecurityLog>;

const tempDirs: string[] = [];
const tempFile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "office3d-security-"));
  tempDirs.push(dir);
  return path.join(dir, "office3d", "security.json");
};

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("security log", () => {
  it("counts attempts and blocks since the previous sign-in", () => {
    let clock = 1_000;
    const log = createSecurityLog({ file: null, now: () => clock });
    expect(log.summary()).toEqual({ previousLoginAt: null, lastLoginAt: null, failedAttempts: 0, blocked: 0 });

    log.recordFailedAttempt();
    log.recordFailedAttempt();
    log.recordBlocked();
    clock = 2_000;
    log.recordLogin();
    // The first sign-in: everything since the log started.
    expect(log.summary()).toEqual({ previousLoginAt: null, lastLoginAt: 2_000, failedAttempts: 2, blocked: 1 });

    // A quiet period, then the next sign-in reports nothing.
    clock = 3_000;
    log.recordLogin();
    expect(log.summary()).toEqual({ previousLoginAt: 2_000, lastLoginAt: 3_000, failedAttempts: 0, blocked: 0 });

    // Attempts before the next sign-in, and after it, both count "since the previous sign-in".
    log.recordFailedAttempt();
    clock = 4_000;
    log.recordLogin();
    log.recordFailedAttempt();
    log.recordBlocked();
    expect(log.summary()).toEqual({ previousLoginAt: 3_000, lastLoginAt: 4_000, failedAttempts: 2, blocked: 1 });
  });

  it("keeps its counters across restarts in a small file with counts and times only", async () => {
    const file = tempFile();
    const first = createSecurityLog({ file, now: () => 5_000, saveDelayMs: 10_000 });
    first.recordFailedAttempt();
    first.recordBlocked();
    first.recordLogin();
    first.recordFailedAttempt();
    await first.flush();

    const text = fs.readFileSync(file, "utf8");
    expect(text.length).toBeLessThan(512);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["before", "current", "lastLoginAt", "previousLoginAt", "v"]);
    // No temp files left behind.
    expect(fs.readdirSync(path.dirname(file))).toEqual(["security.json"]);

    const second = createSecurityLog({ file, now: () => 6_000 });
    expect(second.summary()).toEqual({ previousLoginAt: null, lastLoginAt: 5_000, failedAttempts: 2, blocked: 1 });
  });

  it("starts from zero on a damaged or foreign file, and caps its counters", () => {
    const file = tempFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    expect(createSecurityLog({ file }).summary().failedAttempts).toBe(0);
    fs.writeFileSync(
      file,
      JSON.stringify({ v: 1, before: { failedAttempts: -5, blocked: "x" }, current: { failedAttempts: 1e20, blocked: 3 } }),
    );
    const log = createSecurityLog({ file });
    expect(log.summary()).toMatchObject({ failedAttempts: SECURITY_LOG_COUNT_MAX, blocked: 3 });
    log.recordFailedAttempt();
    expect(log.summary().failedAttempts).toBe(SECURITY_LOG_COUNT_MAX);
  });
});

const serve = async (gate: ReturnType<typeof createAccessGate>, log: SecurityLog, ownerName = "") => {
  const endpoint = createSecuritySummaryEndpoint({
    securityLog: log,
    gateEnabled: gate.enabled,
    allowOrigin: allowHttpOrigin,
    ownerName,
  });
  const server = http.createServer((req, res) => {
    if (gate.handleHttp(req, res)) return;
    if (endpoint.handleHttp(req, res)) return;
    res.end("office");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (p: string, init: RequestInit = {}) => fetch(`${base}${p}`, { redirect: "manual", ...init });
  const login = (form: Record<string, string>) =>
    request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ next: "/", ...form }).toString(),
    });
  return { request, login };
};

const sameOrigin = (cookie: string) => ({ Cookie: cookie, "Sec-Fetch-Site": "same-origin" });

describe("the access gate and GET /api/security/summary", () => {
  it("counts wrong sign-ins and the lockout, and reports them to the owner after sign-in", async () => {
    let clock = Date.parse("2026-09-28T10:00:00Z");
    const log = createSecurityLog({ file: null, now: () => clock });
    const gate = createAccessGate({ token: "secret-token", login: "owner", securityLog: log });
    const { request, login } = await serve(gate, log);

    // Signed out: the summary is behind the gate.
    expect((await request("/api/security/summary")).status).toBe(401);

    // The owner's first sign-in, then a later one after someone tried their luck.
    expect((await login({ login: "owner", token: "secret-token" })).status).toBe(303);
    clock += 3_600_000;
    for (let i = 0; i < 10; i++) expect([401, 429]).toContain((await login({ login: "admin", token: `guess-${i}` })).status);
    // Locked out: still an attempt, and the lockout itself is logged once.
    expect((await login({ login: "owner", token: "secret-token" })).status).toBe(429);
    expect(log.summary()).toMatchObject({ failedAttempts: 11, blocked: 1 });
  });

  it("answers the signed-in owner with the counts since the previous sign-in, nothing else", async () => {
    let clock = Date.parse("2026-09-28T10:00:00Z");
    const log = createSecurityLog({ file: null, now: () => clock });
    const gate = createAccessGate({ token: "secret-token", securityLog: log });
    const { request, login } = await serve(gate, log, "  Командир  ");

    await login({ token: "secret-token" });
    clock += 60_000;
    await login({ token: "wrong" });
    await login({ token: "wrong again" });
    clock += 60_000;
    const ok = await login({ token: "secret-token" });
    const cookie = /studio_session=[^;]*/.exec(ok.headers.get("set-cookie") ?? "")?.[0] ?? "";
    expect(cookie).not.toBe("");

    const response = await request("/api/security/summary", { headers: sameOrigin(cookie) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      access: "session",
      ownerName: "Командир",
      previousLoginAt: "2026-09-28T10:00:00.000Z",
      failedAttempts: 2,
      blocked: 0,
    });

    // Cross-site pages and other methods are refused.
    const crossSite = await request("/api/security/summary", {
      headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    const post = await request("/api/security/summary", { method: "POST", headers: sameOrigin(cookie) });
    expect(post.status).toBe(405);
  });

  it("does not count a stale session cookie as an attack", async () => {
    const log = createSecurityLog({ file: null });
    const gate = createAccessGate({ token: "new-token", securityLog: log });
    const { request } = await serve(gate, log);
    const stale = `studio_session=${Buffer.from(JSON.stringify({ v: 1, exp: Date.now() + 1e6 })).toString("base64url")}.old`;
    expect((await request("/", { headers: { Cookie: stale } })).status).toBe(303);
    expect(log.summary().failedAttempts).toBe(0);
    // A wrong token offered in the legacy cookie is a guess.
    expect((await request("/", { headers: { Cookie: "studio_access=guess" } })).status).toBe(303);
    expect(log.summary().failedAttempts).toBe(1);
  });

  it("answers on the owner's own machine when there is no access token", async () => {
    const log = createSecurityLog({ file: null });
    const gate = createAccessGate({ token: "", securityLog: log });
    const { request } = await serve(gate, log);
    const response = await request("/api/security/summary", { headers: { "Sec-Fetch-Site": "same-origin" } });
    expect(await response.json()).toEqual({ access: "local", ownerName: "", previousLoginAt: null, failedAttempts: 0, blocked: 0 });
  });
});
