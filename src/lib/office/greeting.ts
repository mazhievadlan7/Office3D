/**
 * What the HQ's autonomous system says when the operator signs in: a
 * greeting by name, today's full date and the time, the unread messages, how
 * the operations stand and the platform's security. It is the platform
 * speaking, not an agent. Pure, so the wording is testable; the screen shows
 * it and speaks it in the system voice (lib/voice/systemVoice.ts).
 */

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
};

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
    name ? `Добро пожаловать, ${name}.` : "Добро пожаловать в штаб.",
    `Сегодня ${spokenDate(input.now, input.timeZone)}. Время — ${time} ${where}.`,
  ];
}

/**
 * The status report that follows once the whole team has loaded: unread
 * news, how the operations stand and the platform's security.
 */
export function hqGreetingStatus(input: HqGreetingInput): string[] {
  const lines = [
    input.unread > 0
      ? `Непрочитанных: ${input.unread} — ${plural(input.unread, "агент ждёт", "агента ждут", "агентов ждут")} вашего ответа.`
      : "Непрочитанных сообщений нет.",
  ];
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
  } else {
    lines.push("Безопасность платформы: доступ защищён, сеанс подтверждён, отклонений нет.");
  }
  return lines;
}

/** The whole greeting, line by line (the opening, then the status). */
export function hqGreetingLines(input: HqGreetingInput): string[] {
  return [...hqGreetingOpening(input), ...hqGreetingStatus(input)];
}
