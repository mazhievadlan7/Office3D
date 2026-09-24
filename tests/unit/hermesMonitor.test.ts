// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const { createAlerter, resolveAlertConfig } = await import("../../server/hermes/alerts.js");
const { createMonitor } = await import("../../server/hermes/monitor.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const memoryStore = () => {
  let organization: Record<string, unknown> = {};
  return {
    getOrganization: () => organization,
    updateOrganization: async (patch: Record<string, unknown>) => {
      organization = { ...organization, ...patch };
    },
  };
};

describe("alert channels", () => {
  it("reads_the_channels_and_says_what_is_wrong", () => {
    expect(resolveAlertConfig({})).toMatchObject({ ntfy: null, email: null, heartbeatUrl: "", problems: [] });
    const full = resolveAlertConfig({
      ALERT_NTFY_URL: "https://ntfy.sh/office3d-secret-topic/",
      ALERT_SMTP_URL: "smtps://me%40gmail.com:app-pass@smtp.gmail.com:465",
      ALERT_EMAIL_TO: "me@gmail.com, second@example.com",
      ALERT_HEARTBEAT_URL: "https://hc-ping.com/uuid",
    });
    expect(full).toMatchObject({
      ntfy: { url: "https://ntfy.sh/office3d-secret-topic" },
      email: { to: ["me@gmail.com", "second@example.com"], from: "me@gmail.com" },
      heartbeatUrl: "https://hc-ping.com/uuid",
      problems: [],
    });
    const broken = resolveAlertConfig({ ALERT_NTFY_URL: "ftp://x", ALERT_SMTP_URL: "smtps://a:b@c:465" });
    expect(broken.problems).toEqual(["ALERT_NTFY_URL must be an http(s) URL.", "ALERT_EMAIL_TO is needed with ALERT_SMTP_URL."]);
    expect(broken.email).toBeNull();
  });

  it("sends_on_every_channel_and_reports_the_one_that_failed", async () => {
    const requests: Array<{ url: string; init: Loose }> = [];
    const fetchImpl = vi.fn(async (url: string, init: Loose) => {
      requests.push({ url, init });
      return { ok: !url.includes("broken"), status: url.includes("broken") ? 500 : 200 } as Response;
    });
    const sendMail = vi.fn(async () => ({}));
    const alerter = createAlerter({
      config: resolveAlertConfig({
        ALERT_NTFY_URL: "https://ntfy.sh/topic",
        ALERT_NTFY_TOKEN: "tk",
        ALERT_SMTP_URL: "smtps://me%40gmail.com:pw@smtp.gmail.com:465",
        ALERT_EMAIL_TO: "me@gmail.com",
        ALERT_HEARTBEAT_URL: "https://hc-ping.com/uuid",
      }),
      fetchImpl: fetchImpl as Loose,
      createTransport: () => ({ sendMail }),
    });
    const result = await alerter.send({ title: "Проблема: Hermes", body: "не отвечает", level: "problem" });
    expect(result).toEqual({ sent: ["ntfy", "email"], failed: [] });
    const push = requests[0];
    expect(push.url).toBe("https://ntfy.sh/topic");
    expect(push.init.headers).toMatchObject({ Priority: "high", Authorization: "Bearer tk" });
    // Non-ASCII titles travel encoded.
    expect(Buffer.from(push.init.headers.Title.slice(10, -2), "base64").toString("utf8")).toBe("Проблема: Hermes");
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "me@gmail.com", subject: "Office3D: Проблема: Hermes", text: "не отвечает" }));

    await alerter.heartbeat(true);
    await alerter.heartbeat(false);
    expect(requests.slice(-2).map((request) => request.url)).toEqual(["https://hc-ping.com/uuid", "https://hc-ping.com/uuid/fail"]);

    sendMail.mockRejectedValueOnce(new Error("535 auth failed"));
    const partial = await alerter.send({ title: "x", body: "y" });
    expect(partial).toEqual({ sent: ["ntfy"], failed: [{ channel: "email", error: "535 auth failed" }] });
  });
});

describe("deployment monitor", () => {
  const setup = () => {
    let clock = Date.parse("2026-09-24T10:00:00Z");
    let hermesUp = true;
    const events: Loose[] = [];
    const sent: Loose[] = [];
    const beats: boolean[] = [];
    const broadcasts: Loose[] = [];
    const monitor = createMonitor({
      checks: [
        { id: "hermes", label: "Hermes", run: async () => (hermesUp ? { ok: true, detail: "версия 0.21.4" } : { ok: false, detail: "connection refused" }) },
        { id: "disk", label: "Место на диске", run: async () => ({ ok: true, detail: "свободно 40 ГБ" }) },
      ],
      events: async () => events,
      alerter: {
        send: async (message: Loose) => {
          sent.push(message);
          return { sent: ["ntfy"], failed: [] };
        },
        heartbeat: async (ok: boolean) => {
          beats.push(ok);
        },
        channels: () => ["ntfy"],
        hasHeartbeat: true,
      },
      store: memoryStore(),
      broadcast: (event: string, payload: Loose) => broadcasts.push({ event, payload }),
      now: () => clock,
    });
    return {
      monitor,
      sent,
      beats,
      events,
      broadcasts,
      advance: (ms: number) => (clock += ms),
      setHermes: (up: boolean) => (hermesUp = up),
    };
  };

  it("alerts_on_a_confirmed_problem_reminds_and_says_when_it_recovers", async () => {
    const t = setup();
    const first = await t.monitor.tick();
    expect(first).toMatchObject({ ok: true, channels: ["ntfy"], heartbeat: true });
    expect(t.sent).toEqual([]);

    t.setHermes(false);
    t.advance(60_000);
    const once = await t.monitor.tick();
    // One failure is not yet a problem.
    expect(once.checks[0]).toMatchObject({ status: "checking", detail: "connection refused" });
    expect(t.sent).toEqual([]);
    t.advance(60_000);
    const twice = await t.monitor.tick();
    expect(twice).toMatchObject({ ok: false, checks: [{ id: "hermes", status: "problem" }, { id: "disk", status: "ok" }] });
    expect(t.sent).toEqual([expect.objectContaining({ level: "problem", title: "Проблема: Hermes" })]);

    // No repeat every minute; a reminder after 12 hours.
    t.advance(60_000);
    await t.monitor.tick();
    expect(t.sent).toHaveLength(1);
    t.advance(12 * 60 * 60_000);
    await t.monitor.tick();
    expect(t.sent.at(-1)).toMatchObject({ title: "Всё ещё: Hermes" });

    t.setHermes(true);
    t.advance(60_000);
    await t.monitor.tick();
    expect(t.sent.at(-1)).toMatchObject({ level: "recovered", title: "Hermes — снова в порядке" });
    expect(t.broadcasts.map((entry) => entry.payload.checks[0].status)).toEqual(["ok", "checking", "problem", "ok"]);
  });

  it("sends_each_event_once_and_pings_the_dead_mans_switch", async () => {
    const t = setup();
    t.events.push({ key: "update:u1:rolled_back", title: "Обновление Hermes", body: "откат" });
    await t.monitor.tick();
    t.advance(60_000);
    await t.monitor.tick();
    expect(t.sent.filter((message) => message.title === "Обновление Hermes")).toHaveLength(1);

    // Heartbeat every five minutes, with the current verdict.
    expect(t.beats).toEqual([true]);
    t.setHermes(false);
    for (let i = 0; i < 5; i++) {
      t.advance(60_000);
      await t.monitor.tick();
    }
    expect(t.beats).toEqual([true, false]);
  });

  it("answers_the_office_and_sends_a_test_alert", async () => {
    const t = setup();
    expect(await t.monitor.handlers["system.health"]({})).toMatchObject({ checkedAt: null, checks: [{ status: "unknown" }, { status: "unknown" }] });
    expect(await t.monitor.handlers["system.health"]({ refresh: true })).toMatchObject({ ok: true });
    expect(await t.monitor.handlers["system.testAlert"]()).toMatchObject({ sent: ["ntfy"], channels: ["ntfy"] });
    expect(t.sent.at(-1)).toMatchObject({ level: "info", title: "Проверка оповещений" });
  });
});
