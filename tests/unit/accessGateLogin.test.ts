// @vitest-environment node
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const { createAccessGate } = await import("../../server/access-gate.js");

type Gate = ReturnType<typeof createAccessGate>;

const serve = async (gate: Gate) => {
  const server = http.createServer((req, res) => {
    if (gate.handleHttp(req, res)) return;
    res.end("office");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { redirect: "manual", ...init });
  const login = (token: string, next = "/", headers: Record<string, string> = {}) =>
    request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ token, next }).toString(),
    });
  return { server, request, login };
};

const sessionFrom = (response: Response) => {
  const cookie = response.headers.get("set-cookie") ?? "";
  return { cookie, value: /studio_session=([^;]*)/.exec(cookie)?.[1] ?? "" };
};

describe("sign-in page", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  it("signs_in_with_the_token_and_keeps_the_person_in_with_a_signed_session", async () => {
    const { server, request, login } = await serve(createAccessGate({ token: "secret-token" }));
    servers.push(server);

    const page = await request("/office?tab=2");
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/login?next=%2Foffice%3Ftab%3D2");
    const form = await request("/login?next=%2Foffice");
    expect(form.status).toBe(200);
    expect(form.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await form.text()).toContain('name="next" value="/office"');
    expect((await request("/api/studio")).status).toBe(401);

    const wrong = await login("nope", "/office");
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("Неверный токен доступа.");

    const ok = await login("secret-token", "/office");
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/office");
    const session = sessionFrom(ok);
    expect(session.cookie).toMatch(/HttpOnly/);
    expect(session.cookie).toMatch(/SameSite=Lax/);
    expect(session.cookie).not.toMatch(/Secure/);
    // The cookie is a signed expiry, not the token.
    expect(session.value).not.toContain("secret-token");

    const inside = await request("/api/studio", { headers: { Cookie: `studio_session=${session.value}` } });
    expect(await inside.text()).toBe("office");
    expect(createAccessGate({ token: "secret-token" }).allowUpgrade({ headers: { cookie: `studio_session=${session.value}` }, socket: {} })).toBe(true);
    // Another token (after rotating it) no longer accepts the session.
    expect(createAccessGate({ token: "rotated-token" }).allowUpgrade({ headers: { cookie: `studio_session=${session.value}` }, socket: {} })).toBe(false);

    const out = await request("/logout", { method: "POST", headers: { Cookie: `studio_session=${session.value}` } });
    expect(out.status).toBe(303);
    expect(sessionFrom(out).cookie).toMatch(/Max-Age=0/);
  });

  it("never_redirects_off_site_and_marks_the_cookie_secure_behind_https", async () => {
    vi.stubEnv("TRUSTED_PROXY", "1");
    const { server, login } = await serve(createAccessGate({ token: "secret-token" }));
    servers.push(server);
    for (const next of ["//evil.example/x", "https://evil.example", "/\\evil.example", "/login?next=/x"]) {
      const response = await login("secret-token", next, { "X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.7" });
      expect(response.headers.get("location")).toBe("/");
      expect(sessionFrom(response).cookie).toMatch(/Secure/);
    }
  });

  it("counts_wrong_tokens_and_forged_sessions_but_not_expired_ones", async () => {
    let clock = Date.parse("2026-09-24T00:00:00Z");
    const gate = createAccessGate({ token: "secret-token", now: () => clock });
    const { server, request, login } = await serve(gate);
    servers.push(server);

    const session = sessionFrom(await login("secret-token")).value;
    clock += 31 * 86_400_000;
    // Expired: back to the sign-in page, as often as it takes.
    for (let i = 0; i < 12; i++) {
      const response = await request("/", { headers: { Cookie: `studio_session=${session}` } });
      expect(response.status).toBe(303);
    }
    const [payload] = session.split(".");
    for (let i = 0; i < 9; i++) {
      expect((await request("/api/x", { headers: { Cookie: `studio_session=${payload}.forged` } })).status).toBe(401);
    }
    expect((await request("/api/x", { headers: { Cookie: `studio_session=${payload}.forged` } })).status).toBe(429);
    const blocked = await login("secret-token");
    expect(blocked.status).toBe(429);
  });
});
