import { describe, expect, it } from "vitest";
import {
  hqGreetingLines,
  hqGreetingOpening,
  hqGreetingStatus,
  plural,
  securityLine,
  spokenDate,
  taskBoardSummary,
} from "@/lib/office/greeting";

const base = {
  name: "Командир",
  now: new Date("2026-09-28T11:05:00Z"),
  timeZone: "Europe/Moscow",
  unread: 0,
  working: 120,
  idle: 178,
  errors: 0,
  connected: true,
};

describe("hqGreetingLines", () => {
  it("is the HQ system greeting by name, with the full date, time, unread, operations and security", () => {
    const lines = hqGreetingLines({ ...base, unread: 3 });
    expect(lines).toEqual([
      "Система штаба на связи. Доступ подтверждён.",
      "Добро пожаловать в штаб, Командир.",
      "Сегодня понедельник, 28 сентября 2026 года. Время — 14:05 по Москве.",
      "Непрочитанных: 3 — агента ждут вашего ответа.",
      "Операции: в работе 120, в ожидании 178.",
      "Безопасность платформы: доступ защищён, сеанс подтверждён, отклонений нет.",
    ]);
    // The platform speaks, not an agent.
    expect(lines.join(" ")).not.toContain("AM7");
  });

  it("names errors and a lost connection instead of claiming all is well", () => {
    expect(hqGreetingLines({ ...base, errors: 2 }).at(-1)).toContain("2 агента требуют внимания");
    expect(hqGreetingLines({ ...base, errors: 2 }).at(-2)).toBe("Операции: в работе 120, в ожидании 178, с ошибками 2.");
    expect(hqGreetingLines({ ...base, connected: false }).at(-1)).toContain("нет связи");
  });

  it("works without a name and without a team", () => {
    const lines = hqGreetingLines({ ...base, name: " ", working: 0, idle: 0 });
    expect(lines[1]).toBe("Добро пожаловать в штаб.");
    expect(lines[3]).toBe("Непрочитанных сообщений нет.");
    expect(lines[4]).toBe("Операции: команда ещё не на месте.");
  });

  it("says the date and time in the HQ's own zone", () => {
    // 23:30 UTC on Sunday is already Monday morning in Tokyo.
    const late = new Date("2026-09-27T23:30:00Z");
    expect(hqGreetingLines({ ...base, now: late, timeZone: "Asia/Tokyo" })[2]).toBe(
      "Сегодня понедельник, 28 сентября 2026 года. Время — 08:30 по времени штаба.",
    );
    expect(spokenDate(late, "Europe/Moscow")).toBe("понедельник, 28 сентября 2026 года");
  });
});

describe("the task board and the attacks", () => {
  it("says how the task board stands: open, in progress, done", () => {
    const lines = hqGreetingLines({ ...base, tasks: { open: 4, inProgress: 2, done: 11 } });
    expect(lines[4]).toBe("Задачи: открыто 4, в работе 2, выполнено 11.");
    expect(lines[5]).toBe("Операции: в работе 120, в ожидании 178.");
    expect(hqGreetingStatus({ ...base, tasks: { open: 0, inProgress: 0, done: 0 } })[1]).toBe("Задач на доске нет.");
  });

  it("counts the board's live cards, blocked and in review as open", () => {
    expect(
      taskBoardSummary([
        { status: "todo" },
        { status: "blocked" },
        { status: "review" },
        { status: "in_progress" },
        { status: "done" },
        { status: "done" },
        { status: "done", isArchived: true },
      ]),
    ).toEqual({ open: 3, inProgress: 1, done: 2 });
  });

  it("reports the attacks since the previous sign-in instead of a generic all-clear", () => {
    const status = hqGreetingStatus({ ...base, security: { failedAttempts: 3, blocked: 1 } });
    expect(status.at(-1)).toBe("С момента прошлого входа: 3 попытки несанкционированного доступа, 1 заблокировано.");
    expect(status.join(" ")).not.toContain("отклонений нет");
    expect(hqGreetingStatus({ ...base, security: { failedAttempts: 0, blocked: 0 } }).at(-1)).toBe(
      "Попыток несанкционированного доступа не зафиксировано.",
    );
    expect(securityLine({ failedAttempts: 1, blocked: 0 })).toContain("1 попытка несанкционированного");
    expect(securityLine({ failedAttempts: 25, blocked: 5 })).toContain("25 попыток несанкционированного доступа, 5 заблокировано.");
  });

  it("still names a lost connection or agents in trouble before the attacks", () => {
    const status = hqGreetingStatus({ ...base, connected: false, security: { failedAttempts: 0, blocked: 0 } });
    expect(status.at(-2)).toContain("нет связи");
    expect(status.at(-1)).toBe("Попыток несанкционированного доступа не зафиксировано.");
  });
});

describe("plural", () => {
  it("picks the Russian form", () => {
    expect([1, 2, 5, 11, 21, 22, 25, 112].map((n) => plural(n, "a", "b", "c"))).toEqual(["a", "b", "c", "c", "a", "b", "c", "c"]);
  });
});

describe("the greeting in two parts", () => {
  it("opens with the welcome, the date and the time, needing no team data", () => {
    expect(hqGreetingOpening({ name: "Командир", now: base.now, timeZone: base.timeZone })).toEqual([
      "Система штаба на связи. Доступ подтверждён.",
      "Добро пожаловать в штаб, Командир.",
      "Сегодня понедельник, 28 сентября 2026 года. Время — 14:05 по Москве.",
    ]);
  });

  it("follows with the status report, and together they make the whole greeting", () => {
    const status = hqGreetingStatus({ ...base, unread: 1, errors: 2 });
    expect(status[0]).toBe("Непрочитанных: 1 — агент ждёт вашего ответа.");
    expect(status).toHaveLength(3);
    expect(status.join(" ")).not.toContain("Командир");
    expect(hqGreetingLines({ ...base, unread: 1, errors: 2 })).toEqual([
      ...hqGreetingOpening(base),
      ...status,
    ]);
  });
});
