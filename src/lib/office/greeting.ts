/**
 * What the HQ's autonomous system says when the operator signs in: a
 * greeting by name, today's full date and the time, the unread messages, the
 * task board, how the operations stand and the attacks on the platform since
 * the previous sign-in. It is the platform speaking, not an agent. Pure, so
 * the wording is testable; the screen speaks it in the system voice
 * (lib/voice/systemVoice.ts), with no captions.
 *
 * Every number is spelled out here (lib/voice/russianNumerals.ts) because it is
 * only ever heard: the date as an ordinal («третье октября две тысячи двадцать
 * шестого года»), the time with its units («шесть часов сорок минут») and each
 * count agreeing with its noun («одна попытка», «две заблокированы»), whatever
 * engine the chosen voice runs on.
 */

import { cardinal, ordinal, plural, spokenClock } from "@/lib/voice/russianNumerals";

export { plural };

/** The task board in three numbers (see taskBoardSummary). */
export type HqGreetingTasks = {
  /** Not started, waiting for review or blocked. */
  open: number;
  inProgress: number;
  done: number;
};

/** Attacks on the platform since the owner's previous sign-in (GET /api/security/summary). */
export type HqGreetingSecurity = {
  failedAttempts: number;
  blocked: number;
};

export type HqGreetingInput = {
  /** Who signed in (STUDIO_OWNER_NAME / STUDIO_LOGIN); empty for no name. */
  name: string;
  /** Now, and the HQ's time zone (IANA). */
  now: Date;
  timeZone: string;
  /** Agents with news the operator has not seen yet. */
  unread: number;
  working: number;
  idle: number;
  errors: number;
  /** The backend connection is up. */
  connected: boolean;
  /** The task board; null or absent when it has not loaded. */
  tasks?: HqGreetingTasks | null;
  /** The server's security counts; null or absent when they could not be read. */
  security?: HqGreetingSecurity | null;
};

/** The board's live (not archived) cards, counted for the greeting. */
export function taskBoardSummary(cards: ReadonlyArray<{ status: string; isArchived?: boolean }>): HqGreetingTasks {
  const tasks: HqGreetingTasks = { open: 0, inProgress: 0, done: 0 };
  for (const card of cards) {
    if (card.isArchived) continue;
    if (card.status === "in_progress") tasks.inProgress += 1;
    else if (card.status === "done") tasks.done += 1;
    else tasks.open += 1;
  }
  return tasks;
}

/** A count that cannot be negative or fractional. */
function count(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * One line on the task board: open, in progress and done, each count agreeing
 * with «задача» («открытых — одна, в работе — две»).
 */
export function tasksLine(tasks: HqGreetingTasks): string {
  const open = count(tasks.open);
  const inProgress = count(tasks.inProgress);
  const done = count(tasks.done);
  if (open + inProgress + done === 0) return "Задач на доске нет.";
  return `Задачи: открытых — ${cardinal(open, "f")}, в работе — ${cardinal(inProgress, "f")}, выполненных — ${cardinal(done, "f")}.`;
}

/** One line on the attacks since the previous sign-in. */
export function securityLine(security: HqGreetingSecurity): string {
  const attempts = count(security.failedAttempts);
  const blocked = count(security.blocked);
  if (attempts === 0 && blocked === 0) return "Попыток несанкционированного доступа не зафиксировано.";
  const tried = `${cardinal(attempts, "f")} ${plural(attempts, "попытка", "попытки", "попыток")}`;
  const stopped =
    blocked === 0
      ? "ни одна не заблокирована"
      : `${cardinal(blocked, "f")} ${plural(blocked, "заблокирована", "заблокированы", "заблокировано")}`;
  return `С момента прошлого входа: ${tried} несанкционированного доступа, ${stopped}.`;
}

const CITY: Record<string, string> = {
  "Europe/Moscow": "по Москве",
};

/** «понедельник, двадцать восьмое сентября две тысячи двадцать шестого года» in the given zone. */
export function spokenDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const day = ordinal(Number(part("day")), "neuter");
  const year = ordinal(Number(part("year")), "genitive");
  // The month comes in the genitive already: «сентября».
  return `${part("weekday")}, ${day} ${part("month")} ${year} года`;
}

/** «четырнадцать часов пять минут» in the given zone (24-hour clock). */
export function spokenTime(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return spokenClock(value("hour") % 24, value("minute"));
}

/** What the opening needs: who signed in, now, and the HQ's time zone. */
export type HqGreetingOpeningInput = Pick<HqGreetingInput, "name" | "now" | "timeZone">;

/**
 * The opening, spoken as the camera starts its fly-through: the system on the
 * line, the welcome by name, today's date and the time. It needs no team data.
 */
export function hqGreetingOpening(input: HqGreetingOpeningInput): string[] {
  const where = CITY[input.timeZone] ?? "по времени штаба";
  const name = input.name.trim();
  return [
    "Система штаба на связи. Доступ подтверждён.",
    name ? `Добро пожаловать в штаб, ${name}.` : "Добро пожаловать в штаб.",
    `Сегодня ${spokenDate(input.now, input.timeZone)}. Время — ${spokenTime(input.now, input.timeZone)} ${where}.`,
  ];
}

/**
 * The status report that follows once the whole team has loaded: unread
 * news, the task board, how the operations stand and the platform's security
 * — a lost connection or agents in trouble first, then the attacks since the
 * previous sign-in.
 */
export function hqGreetingStatus(input: HqGreetingInput): string[] {
  const unread = count(input.unread);
  const working = count(input.working);
  const idle = count(input.idle);
  const errors = count(input.errors);
  const lines = [
    unread > 0
      ? `Непрочитанные сообщения: ${cardinal(unread)} ${plural(unread, "агент ждёт", "агента ждут", "агентов ждут")} вашего ответа.`
      : "Непрочитанных сообщений нет.",
  ];
  if (input.tasks) lines.push(tasksLine(input.tasks));
  if (working + idle + errors === 0) {
    lines.push("Операции: команда ещё не на месте.");
  } else {
    // The counts are agents: masculine («один», «два»).
    const parts = [`в работе — ${cardinal(working)}`, `в ожидании — ${cardinal(idle)}`];
    if (errors > 0) parts.push(`с ошибками — ${cardinal(errors)}`);
    lines.push(`Операции: ${parts.join(", ")}.`);
  }
  if (!input.connected) {
    lines.push("Безопасность платформы: нет связи со средой выполнения, проверьте подключение.");
  } else if (errors > 0) {
    lines.push(
      `Безопасность платформы: доступ защищён, но ${cardinal(errors)} ${plural(errors, "агент требует", "агента требуют", "агентов требуют")} внимания.`,
    );
  } else if (!input.security) {
    lines.push("Безопасность платформы: доступ защищён, сеанс подтверждён, отклонений нет.");
  }
  if (input.security) lines.push(securityLine(input.security));
  return lines;
}

/** The whole greeting, line by line (the opening, then the status). */
export function hqGreetingLines(input: HqGreetingInput): string[] {
  return [...hqGreetingOpening(input), ...hqGreetingStatus(input)];
}
