/**
 * What the HQ's autonomous system says when the operator signs in: a
 * greeting by name, today's full date and the time, the unread messages, the
 * task board, how the operations stand and the attacks on the platform since
 * the previous sign-in. It is the platform speaking, not an agent. Pure, so
 * the wording is testable; the screen speaks it in the system voice
 * (lib/voice/systemVoice.ts), with no captions.
 */

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

/** One line on the task board: open, in progress and done. */
export function tasksLine(tasks: HqGreetingTasks): string {
  if (tasks.open + tasks.inProgress + tasks.done === 0) return "Задач на доске нет.";
  return `Задачи: открыто ${tasks.open}, в работе ${tasks.inProgress}, выполнено ${tasks.done}.`;
}

/** One line on the attacks since the previous sign-in. */
export function securityLine(security: HqGreetingSecurity): string {
  const attempts = Math.max(0, Math.floor(security.failedAttempts));
  const blocked = Math.max(0, Math.floor(security.blocked));
  if (attempts === 0 && blocked === 0) return "Попыток несанкционированного доступа не зафиксировано.";
  return `С момента прошлого входа: ${attempts} ${plural(attempts, "попытка", "попытки", "попыток")} несанкционированного доступа, ${blocked} заблокировано.`;
}

const CITY: Record<string, string> = {
  "Europe/Moscow": "по Москве",
};

/** Russian plural for a count: one, few (2-4), many. */
export function plural(count: number, one: string, few: string, many: string): string {
  const n = Math.abs(count) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return many;
  if (n1 > 1 && n1 < 5) return few;
  if (n1 === 1) return one;
  return many;
}

/** «понедельник, 28 сентября 2026 года» in the given zone. */
export function spokenDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("weekday")}, ${part("day")} ${part("month")} ${part("year")} года`;
}

/** What the opening needs: who signed in, now, and the HQ's time zone. */
export type HqGreetingOpeningInput = Pick<HqGreetingInput, "name" | "now" | "timeZone">;

/**
 * The opening, spoken as the camera starts its fly-through: the system on the
 * line, the welcome by name, today's date and the time. It needs no team data.
 */
export function hqGreetingOpening(input: HqGreetingOpeningInput): string[] {
  const time = new Intl.DateTimeFormat("ru-RU", { timeZone: input.timeZone, hour: "2-digit", minute: "2-digit" }).format(input.now);
  const where = CITY[input.timeZone] ?? "по времени штаба";
  const name = input.name.trim();
  return [
    "Система штаба на связи. Доступ подтверждён.",
    name ? `Добро пожаловать в штаб, ${name}.` : "Добро пожаловать в штаб.",
    `Сегодня ${spokenDate(input.now, input.timeZone)}. Время — ${time} ${where}.`,
  ];
}

/**
 * The status report that follows once the whole team has loaded: unread
 * news, the task board, how the operations stand and the platform's security
 * — a lost connection or agents in trouble first, then the attacks since the
 * previous sign-in.
 */
export function hqGreetingStatus(input: HqGreetingInput): string[] {
  const lines = [
    input.unread > 0
      ? `Непрочитанных: ${input.unread} — ${plural(input.unread, "агент ждёт", "агента ждут", "агентов ждут")} вашего ответа.`
      : "Непрочитанных сообщений нет.",
  ];
  if (input.tasks) lines.push(tasksLine(input.tasks));
  const total = input.working + input.idle + input.errors;
  if (total === 0) {
    lines.push("Операции: команда ещё не на месте.");
  } else {
    const parts = [`в работе ${input.working}`, `в ожидании ${input.idle}`];
    if (input.errors > 0) parts.push(`с ошибками ${input.errors}`);
    lines.push(`Операции: ${parts.join(", ")}.`);
  }
  if (!input.connected) {
    lines.push("Безопасность платформы: нет связи со средой выполнения, проверьте подключение.");
  } else if (input.errors > 0) {
    lines.push(
      `Безопасность платформы: доступ защищён, но ${input.errors} ${plural(input.errors, "агент требует", "агента требуют", "агентов требуют")} внимания.`,
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
