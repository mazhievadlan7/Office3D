import { describe, expect, it } from "vitest";
import {
  hqGreetingLines,
  hqGreetingOpening,
  hqGreetingStatus,
  plural,
  securityLine,
  spokenDate,
  spokenTime,
  taskBoardSummary,
} from "@/lib/office/greeting";
import { cardinal, ordinal, spokenClock } from "@/lib/voice/russianNumerals";

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
      "Сегодня понедельник, двадцать восьмое сентября две тысячи двадцать шестого года. Время — четырнадцать часов пять минут по Москве.",
      "Непрочитанные сообщения: три агента ждут вашего ответа.",
      "Операции: в работе — сто двадцать, в ожидании — сто семьдесят восемь.",
      "Безопасность платформы: доступ защищён, сеанс подтверждён, отклонений нет.",
    ]);
    // The platform speaks, not an agent.
    expect(lines.join(" ")).not.toContain("AM7");
  });

  it("names errors and a lost connection instead of claiming all is well", () => {
    expect(hqGreetingLines({ ...base, errors: 2 }).at(-1)).toContain("но два агента требуют внимания");
    expect(hqGreetingLines({ ...base, errors: 2 }).at(-2)).toBe("Операции: в работе — сто двадцать, в ожидании — сто семьдесят восемь, с ошибками — два.");
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
      "Сегодня понедельник, двадцать восьмое сентября две тысячи двадцать шестого года. Время — восемь часов тридцать минут по времени штаба.",
    );
    expect(spokenDate(late, "Europe/Moscow")).toBe("понедельник, двадцать восьмое сентября две тысячи двадцать шестого года");
  });
});

describe("the task board and the attacks", () => {
  it("says how the task board stands: open, in progress, done", () => {
    const lines = hqGreetingLines({ ...base, tasks: { open: 4, inProgress: 2, done: 11 } });
    expect(lines[4]).toBe("Задачи: открытых — четыре, в работе — две, выполненных — одиннадцать.");
    expect(lines[5]).toBe("Операции: в работе — сто двадцать, в ожидании — сто семьдесят восемь.");
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
    expect(status.at(-1)).toBe("С момента прошлого входа: три попытки несанкционированного доступа, одна заблокирована.");
    expect(status.join(" ")).not.toContain("отклонений нет");
    expect(hqGreetingStatus({ ...base, security: { failedAttempts: 0, blocked: 0 } }).at(-1)).toBe(
      "Попыток несанкционированного доступа не зафиксировано.",
    );
    expect(securityLine({ failedAttempts: 1, blocked: 0 })).toContain("одна попытка несанкционированного доступа, ни одна не заблокирована.");
    expect(securityLine({ failedAttempts: 25, blocked: 5 })).toContain("двадцать пять попыток несанкционированного доступа, пять заблокировано.");
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
      "Сегодня понедельник, двадцать восьмое сентября две тысячи двадцать шестого года. Время — четырнадцать часов пять минут по Москве.",
    ]);
  });

  it("follows with the status report, and together they make the whole greeting", () => {
    const status = hqGreetingStatus({ ...base, unread: 1, errors: 2 });
    expect(status[0]).toBe("Непрочитанные сообщения: один агент ждёт вашего ответа.");
    expect(status).toHaveLength(3);
    expect(status.join(" ")).not.toContain("Командир");
    expect(hqGreetingLines({ ...base, unread: 1, errors: 2 })).toEqual([
      ...hqGreetingOpening(base),
      ...status,
    ]);
  });
});

describe("the greeting says every number in words, in the right form", () => {
  const opening = (iso: string, timeZone = "UTC") => hqGreetingOpening({ name: "", now: new Date(iso), timeZone })[2];

  it.each([
    ["2026-10-01T09:00:00Z", "четверг, первое октября две тысячи двадцать шестого года"],
    ["2026-10-02T09:00:00Z", "пятница, второе октября две тысячи двадцать шестого года"],
    ["2026-10-03T09:00:00Z", "суббота, третье октября две тысячи двадцать шестого года"],
    ["2026-10-21T09:00:00Z", "среда, двадцать первое октября две тысячи двадцать шестого года"],
    ["2026-10-31T09:00:00Z", "суббота, тридцать первое октября две тысячи двадцать шестого года"],
    ["2026-09-29T09:00:00Z", "вторник, двадцать девятое сентября две тысячи двадцать шестого года"],
    ["2000-01-11T09:00:00Z", "вторник, одиннадцатое января двухтысячного года"],
    ["2030-08-23T09:00:00Z", "пятница, двадцать третье августа две тысячи тридцатого года"],
  ])("dates %s as an ordinal day and a genitive year", (iso, spoken) => {
    expect(spokenDate(new Date(iso), "UTC")).toBe(spoken);
  });

  it.each([
    ["00:00", "ноль часов ровно"],
    ["01:05", "один час пять минут"],
    ["06:40", "шесть часов сорок минут"],
    ["12:21", "двенадцать часов двадцать одна минута"],
    ["02:01", "два часа одна минута"],
    ["04:22", "четыре часа двадцать две минуты"],
    ["21:02", "двадцать один час две минуты"],
    ["23:59", "двадцать три часа пятьдесят девять минут"],
  ])("says %s as hours and minutes", (clock, spoken) => {
    expect(opening(`2026-10-04T${clock}:00Z`)).toBe(
      `Сегодня воскресенье, четвёртое октября две тысячи двадцать шестого года. Время — ${spoken} по времени штаба.`,
    );
    expect(spokenTime(new Date(`2026-10-04T${clock}:00Z`), "UTC")).toBe(spoken);
  });

  it.each([
    [0, 1, "одна попытка несанкционированного доступа, ни одна не заблокирована."],
    [1, 1, "одна попытка несанкционированного доступа, одна заблокирована."],
    [2, 2, "две попытки несанкционированного доступа, две заблокированы."],
    [5, 5, "пять попыток несанкционированного доступа, пять заблокировано."],
    [11, 11, "одиннадцать попыток несанкционированного доступа, одиннадцать заблокировано."],
    [21, 21, "двадцать одна попытка несанкционированного доступа, двадцать одна заблокирована."],
    [22, 22, "двадцать две попытки несанкционированного доступа, двадцать две заблокированы."],
    [25, 25, "двадцать пять попыток несанкционированного доступа, двадцать пять заблокировано."],
    [101, 101, "сто одна попытка несанкционированного доступа, сто одна заблокирована."],
    [111, 111, "сто одиннадцать попыток несанкционированного доступа, сто одиннадцать заблокировано."],
  ])("counts %i blocked of %i attempts in agreement", (blocked, attempts, spoken) => {
    expect(securityLine({ failedAttempts: attempts, blocked })).toBe(`С момента прошлого входа: ${spoken}`);
  });

  it.each([
    [1, "один агент ждёт", "одна", "один агент требует"],
    [2, "два агента ждут", "две", "два агента требуют"],
    [5, "пять агентов ждут", "пять", "пять агентов требуют"],
    [11, "одиннадцать агентов ждут", "одиннадцать", "одиннадцать агентов требуют"],
    [21, "двадцать один агент ждёт", "двадцать одна", "двадцать один агент требует"],
    [22, "двадцать два агента ждут", "двадцать две", "двадцать два агента требуют"],
    [101, "сто один агент ждёт", "сто одна", "сто один агент требует"],
  ])("agrees %i with агент and задача", (n, waiting, tasks, needing) => {
    const status = hqGreetingStatus({ ...base, unread: n, errors: n, tasks: { open: n, inProgress: 0, done: n } });
    expect(status[0]).toBe(`Непрочитанные сообщения: ${waiting} вашего ответа.`);
    expect(status[1]).toBe(`Задачи: открытых — ${tasks}, в работе — ноль, выполненных — ${tasks}.`);
    expect(status.at(-1)).toBe(`Безопасность платформы: доступ защищён, но ${needing} внимания.`);
  });

  it("leaves no digit or Latin letter for the voice engine to guess at", () => {
    for (const n of [0, 1, 2, 5, 11, 21, 22, 25, 101, 111]) {
      const text = hqGreetingLines({
        ...base,
        now: new Date(Date.UTC(2026, 0, 1 + n, n % 24, (n * 7) % 60)),
        unread: n,
        working: n,
        idle: n,
        errors: n,
        connected: n % 2 === 0,
        tasks: { open: n, inProgress: n, done: n },
        security: { failedAttempts: n, blocked: n },
      }).join(" ");
      expect(text).not.toMatch(/[0-9A-Za-z]/);
      // ё stays ё: the stress model reads «всё/ещё/подтверждён» from it.
      expect(text).toContain("подтверждён");
    }
  });
});

describe("Russian numerals", () => {
  it("agree a count with the noun's gender", () => {
    expect([1, 2, 21, 22, 1000, 1001, 2002].map((n) => cardinal(n, "f"))).toEqual([
      "одна",
      "две",
      "двадцать одна",
      "двадцать две",
      "тысяча",
      "тысяча одна",
      "две тысячи две",
    ]);
    expect(cardinal(1, "n")).toBe("одно");
    expect(cardinal(0)).toBe("ноль");
    expect(cardinal(1_250_000)).toBe("миллион двести пятьдесят тысяч");
  });

  it("decline only the last word of an ordinal", () => {
    expect([1, 3, 4, 7, 8, 10, 20, 30, 40, 90].map((n) => ordinal(n, "neuter"))).toEqual([
      "первое",
      "третье",
      "четвёртое",
      "седьмое",
      "восьмое",
      "десятое",
      "двадцатое",
      "тридцатое",
      "сороковое",
      "девяностое",
    ]);
    expect([1999, 2000, 2001, 2026, 2100, 2300].map((n) => ordinal(n, "genitive"))).toEqual([
      "тысяча девятьсот девяносто девятого",
      "двухтысячного",
      "две тысячи первого",
      "две тысячи двадцать шестого",
      "две тысячи сотого",
      "две тысячи трёхсотого",
    ]);
  });

  it("read the clock", () => {
    expect(spokenClock(1, 1)).toBe("один час одна минута");
    expect(spokenClock(3, 0)).toBe("три часа ровно");
  });
});
