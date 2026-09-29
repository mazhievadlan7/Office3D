import { briefingScreens } from "./briefing";

/**
 * The "operation" the video wall tracks after a briefing (design_wall.md): the
 * task AM7 set, the goal, the plan's steps and how far the floor has got — but
 * only from real events. Progress on a step moves only when the lead agent
 * says so in words ("Шаг 2 — выполнен", "Этап 3/5: в работе", a checklist);
 * the team bar counts only agents that actually started, replied or errored.
 * Nothing here advances on a timer: elapsed time is shown as a clock, never as
 * progress.
 *
 * Pure and serialisable (no three.js, no DOM, no React): the reducer runs in a
 * hook's ref, its snapshot is posted to the painting worker, and it is tested
 * without a canvas. `planSteps` and `briefingText` live here too (moved from
 * screenBriefing.ts, which re-exports them) so the wall's text parsing has one
 * home.
 */

// --- text helpers (moved from screenBriefing.ts) ------------------------------------------------

/**
 * A briefing's text as the wall shows it: line breaks kept, blank lines,
 * runs of spaces and Markdown emphasis (the answer may come from a model)
 * dropped.
 */
export function briefingText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\*\*|__|`/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*#{1,6}\s+/, "").replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** A plan written as a list: any lead-in before it, and its steps without their numbers or bullets. */
export type PlanSteps = { intro: string; steps: string[] };

/** A list item at the start of a line: "1.", "2)", "3:", "Шаг 4.", or a bullet. */
const STEP_MARK = /^(?:шаг\s*)?(?:\d{1,2}\s*[.):]|[-–—•*·▪])\s+/i;
/** A number marking a step inside running text: "… 2) …", "…; 3. …". */
const INLINE_MARK = /(?:^|[\s;,])(\d{1,2})[.)]\s+/g;
/** A lead-in that only says "plan" («План:», «План действий:») repeats the panel's own title. */
const PLAN_ONLY = /^(?:наш\s+|мой\s+)?план(?:\s+действий)?$/i;

/**
 * The plan's steps when it is written as a list, one item a line ("1. …",
 * "2) …", "- …") or numbered inline in one run of text ("1) … 2) … 3) …",
 * numbers in order from 1), or null when it is plain prose. Two items at
 * least make a list.
 */
export function planSteps(plan: string): PlanSteps | null {
  const lines = briefingText(plan).split("\n").filter(Boolean);
  const introOf = (text: string) => {
    const intro = text.replace(/[\s:–—-]+$/, "").trim();
    return PLAN_ONLY.test(intro) ? "" : intro;
  };
  if (lines.filter((line) => STEP_MARK.test(line)).length >= 2) {
    const lead: string[] = [];
    const steps: string[] = [];
    for (const line of lines) {
      if (STEP_MARK.test(line)) steps.push(line.replace(STEP_MARK, "").trim());
      else if (steps.length > 0) steps[steps.length - 1] = `${steps[steps.length - 1]} ${line}`.trim();
      else lead.push(line);
    }
    return { intro: introOf(lead.join(" ")), steps: steps.filter(Boolean) };
  }
  const text = lines.join(" ");
  const marks: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(INLINE_MARK)) {
    if (Number(match[1]) !== marks.length + 1) continue;
    const at = match.index ?? 0;
    marks.push({ start: at + match[0].indexOf(match[1]), end: at + match[0].length });
  }
  if (marks.length < 2) return null;
  const steps = marks.map((mark, i) =>
    text
      .slice(mark.end, i + 1 < marks.length ? marks[i + 1].start : text.length)
      .replace(/[\s;,]+$/, "")
      .trim(),
  );
  return { intro: introOf(text.slice(0, marks[0].start)), steps: steps.filter(Boolean) };
}

// --- step marks --------------------------------------------------------------------------------

export type HqOperationStepState = "pending" | "active" | "done" | "blocked";

/** A step reference and the state the lead's words put it in. */
export type HqStepMark = { index: number; state: HqOperationStepState };

/** A step number at the head of a clause: "Шаг 2", "Этап 3/5", "[x] 2", "✅ 2.", "1)". */
function stepNumber(clause: string): number | null {
  let m = /(?:шаг|этап|step)\s*№?\s*(\d{1,2})/i.exec(clause);
  if (m) return Number(m[1]);
  m = /^[-*>\s]*(?:\[[ xх✓✔]\]|✅|✔|☑)\s*(\d{1,2})\b/.exec(clause);
  if (m) return Number(m[1]);
  m = /^[-*>\s]*(\d{1,2})\s*(?:\/\s*\d{1,2})?\s*[).:—-]/.exec(clause);
  if (m) return Number(m[1]);
  return null;
}

// \b works only around Latin \w, never around Cyrillic, so those words are matched plainly.
const BLOCKED_RE = /блок|стоп|сорв|провал|не\s+удал|ошиб|\bfail|\berror\b/i;
const ACTIVE_RE = /в\s*работе|в\s*процессе|присту|начал|ид[её]т|выполня|прогресс|progress|\bwip\b|делаем|делаю/i;
const DONE_RE = /выполн|готов|сделан|заверш|закрыт|\bdone\b|✅|✔|☑|\[[xх✓]\]/i;

/** The state a clause names for a step, or null when it names none. */
function stepState(clause: string): HqOperationStepState | null {
  if (BLOCKED_RE.test(clause)) return "blocked";
  if (ACTIVE_RE.test(clause)) return "active";
  if (DONE_RE.test(clause)) return "done";
  return null;
}

/**
 * The step-state marks in one of the lead agent's messages: "Шаг 2 — выполнен",
 * "Этап 3/5: в работе", "Шаг 4: блок", checklists "[x] 2" / "✅ 2.", and several
 * in one line ("шаг 1 выполнен, шаг 2 в работе"). Only references in 1..stepCount
 * count; the last state named for a step wins. No number, no state — nothing.
 */
export function parseStepMarks(text: string, stepCount: number): HqStepMark[] {
  if (stepCount <= 0) return [];
  const byIndex = new Map<number, HqOperationStepState>();
  const clauses = text
    .replace(/\r/g, "")
    .split(/[\n;]+|,\s*(?=(?:шаг|этап|step|\[|✅|✔|☑|\d))/i);
  for (const raw of clauses) {
    const clause = raw.trim();
    if (!clause) continue;
    const n = stepNumber(clause);
    if (n === null) continue;
    const index = n - 1;
    if (index < 0 || index >= stepCount) continue;
    const state = stepState(clause);
    if (!state) continue;
    byIndex.set(index, state);
  }
  return [...byIndex.entries()].map(([index, state]) => ({ index, state })).sort((a, b) => a.index - b.index);
}

// --- the operation -----------------------------------------------------------------------------

export type HqOperationStep = { readonly text: string; readonly state: HqOperationStepState };
/** AM7's own state, from the lead agent's status. */
export type HqOperationLead = "working" | "idle" | "error";
/** The overall status shown on the west wing. */
export type HqOperationOverall = "waiting" | "live" | "blocked" | "done";
/**
 * The wall's lifetime for the operation. `live` and `complete` come from the
 * reducer; `stale` (20 min without events) and `handoff` (the 1.5 s final
 * frame) are set by the hook that owns the timers.
 */
export type HqOperationState = "live" | "complete" | "stale" | "handoff";

/** How many crew agents were addressed and how many have reacted so far. */
export type HqOperationTeam = {
  readonly addressed: number;
  readonly started: number;
  readonly replied: number;
  readonly errors: number;
};

/** A journal line: a fact from the tracker, never the content of an agent's run. */
export type HqOperationLogKind = "begin" | "started" | "replied" | "error" | "step-done" | "step-active" | "step-blocked" | "complete";
export type HqOperationLogEntry = { readonly at: number; readonly who: string; readonly kind: HqOperationLogKind; readonly step?: number };

/** The tracked operation, as the reducer keeps it and the wall paints it. */
export type HqOperation = {
  /** Identity: the briefing's id. A new briefing begins a new operation. */
  readonly id: string;
  readonly task: string;
  readonly goal: string;
  readonly steps: readonly HqOperationStep[];
  /** Index of the step marked «в работе», or -1 when none is. */
  readonly activeStep: number;
  readonly team: HqOperationTeam;
  readonly lead: HqOperationLead;
  readonly overall: HqOperationOverall;
  /** Newest last; at most LOG_MAX kept. */
  readonly log: readonly HqOperationLogEntry[];
  readonly startedAt: number;
  readonly lastEventAt: number;
  readonly state: HqOperationState;
};

export type HqOperationEvent =
  | { type: "begin"; id: string; task: string; goal?: string; crew: number; lead: string; at: number }
  | { type: "plan"; text: string; who: string; at: number }
  | { type: "leadMessage"; text: string; who: string; at: number }
  | { type: "agentStarted"; who: string; isLead?: boolean; at: number }
  | { type: "agentReplied"; who: string; isLead?: boolean; at: number }
  | { type: "agentError"; who: string; isLead?: boolean; at: number }
  | { type: "complete"; at: number }
  | { type: "dismiss"; at: number };

/** Lines of journal kept. */
export const OP_LOG_MAX = 8;
/** «ЗАДАЧА ЗАВЕРШЕНА» holds this long after completion before the hand-off. */
export const OP_COMPLETE_MS = 45_000;
/** No real event for this long: the wall hands the task back to the panels (kept in memory). */
export const OP_STALE_MS = 20 * 60_000;
/** The final «ЗАВЕРШЕНО · передача на панели» frame before the panels return. */
export const OP_HANDOFF_MS = 1_500;

/** True when a live operation has seen no real event for OP_STALE_MS. */
export function isOperationStale(op: HqOperation, now: number): boolean {
  return op.state === "live" && now - op.lastEventAt >= OP_STALE_MS;
}

/** The step index marked active (first one), or -1. */
function activeOf(steps: readonly HqOperationStep[]): number {
  return steps.findIndex((s) => s.state === "active");
}

/** The overall status, from real signals only. */
function overallOf(op: {
  state: HqOperationState;
  steps: readonly HqOperationStep[];
  team: HqOperationTeam;
  lead: HqOperationLead;
}): HqOperationOverall {
  if (op.state === "complete") return "done";
  if (op.lead === "error" || op.steps.some((s) => s.state === "blocked")) return "blocked";
  if (op.steps.length > 0 && op.steps.every((s) => s.state === "done")) return "done";
  if (op.lead === "working" || op.team.started > 0 || op.steps.some((s) => s.state !== "pending")) return "live";
  return "waiting";
}

/** Recomputes the derived fields (active step, overall) and trims the log. */
function settle(op: HqOperation): HqOperation {
  const log = op.log.length > OP_LOG_MAX ? op.log.slice(op.log.length - OP_LOG_MAX) : op.log;
  const activeStep = activeOf(op.steps);
  const overall = overallOf(op);
  if (log === op.log && activeStep === op.activeStep && overall === op.overall) return op;
  return { ...op, log, activeStep, overall };
}

function withLog(op: HqOperation, entry: HqOperationLogEntry): HqOperation {
  return { ...op, log: [...op.log, entry] };
}

function bump(op: HqOperation, key: keyof HqOperationTeam): HqOperationTeam {
  return { ...op.team, [key]: Math.min(op.team.addressed, op.team[key] + 1) };
}

/**
 * The operation after `event`. Progress on the plan comes only from the lead's
 * words (`plan`, `leadMessage` → parseStepMarks); the team counters only from
 * agents that really started, replied or errored. `begin` starts a fresh one,
 * `dismiss` clears it.
 */
export function operationReducer(op: HqOperation | null, event: HqOperationEvent): HqOperation | null {
  if (event.type === "begin") {
    return settle({
      id: event.id,
      task: event.task,
      goal: event.goal ?? "",
      steps: [],
      activeStep: -1,
      team: { addressed: Math.max(0, event.crew), started: 0, replied: 0, errors: 0 },
      lead: "working",
      overall: "waiting",
      log: [{ at: event.at, who: event.lead, kind: "begin" }],
      startedAt: event.at,
      lastEventAt: event.at,
      state: "live",
    });
  }
  if (!op) return op;
  if (event.type === "dismiss") return null;

  switch (event.type) {
    case "plan": {
      const parsed = briefingScreens(op.task, event.text);
      const list = planSteps(parsed.plan);
      const steps: HqOperationStep[] = list ? list.steps.map((text) => ({ text, state: "pending" })) : [];
      return settle({
        ...op,
        goal: parsed.goal || op.goal,
        steps: steps.length > 0 ? steps : op.steps,
        lastEventAt: event.at,
      });
    }
    case "leadMessage": {
      const marks = parseStepMarks(event.text, op.steps.length);
      let next: HqOperation = { ...op, lastEventAt: event.at };
      if (marks.length > 0) {
        const steps = op.steps.slice();
        for (const mark of marks) {
          steps[mark.index] = { ...steps[mark.index], state: mark.state };
          const kind: HqOperationLogKind = mark.state === "done" ? "step-done" : mark.state === "blocked" ? "step-blocked" : "step-active";
          next = withLog({ ...next, steps }, { at: event.at, who: event.who, kind, step: mark.index + 1 });
        }
      }
      return settle(next);
    }
    case "agentStarted":
      if (event.isLead) return settle({ ...op, lead: op.lead === "error" ? "error" : "working", lastEventAt: event.at });
      return settle(withLog({ ...op, team: bump(op, "started"), lastEventAt: event.at }, { at: event.at, who: event.who, kind: "started" }));
    case "agentReplied":
      if (event.isLead) return settle({ ...op, lead: op.lead === "error" ? "error" : "idle", lastEventAt: event.at });
      return settle(withLog({ ...op, team: bump(op, "replied"), lastEventAt: event.at }, { at: event.at, who: event.who, kind: "replied" }));
    case "agentError":
      if (event.isLead) return settle(withLog({ ...op, lead: "error", lastEventAt: event.at }, { at: event.at, who: event.who, kind: "error" }));
      return settle(withLog({ ...op, team: bump(op, "errors"), lastEventAt: event.at }, { at: event.at, who: event.who, kind: "error" }));
    case "complete":
      if (op.state === "complete") return op;
      return settle(withLog({ ...op, state: "complete", lastEventAt: event.at }, { at: event.at, who: "", kind: "complete" }));
    default:
      return op;
  }
}

/**
 * A sample operation for the free, TTS-less wall preview
 * (window.__hqOperationPreview in development, screenHub.ts). Real data always
 * comes through the reducer; this only feeds the painters. `rev` is arbitrary.
 */
export function demoOperation(overrides: Partial<HqOperation> = {}): HqOperation & { rev: number } {
  const now = Date.now();
  const base: HqOperation = {
    id: "preview",
    task: "Проверить внешний периметр демо-стенда: сервисы, открытые порты и забытые поддомены",
    goal: "Карта внешней поверхности с приоритетами",
    steps: [
      { text: "Разведка поддоменов и сертификатов", state: "done" },
      { text: "Сканирование открытых портов", state: "active" },
      { text: "Сверка найденного со скоупом", state: "pending" },
      { text: "Отчёт с приоритетами", state: "pending" },
    ],
    activeStep: 1,
    team: { addressed: 12, started: 9, replied: 5, errors: 1 },
    lead: "working",
    overall: "live",
    log: [
      { at: now - 120_000, who: "AM7", kind: "begin" },
      { at: now - 90_000, who: "Ирис", kind: "started" },
      { at: now - 60_000, who: "AM7", kind: "step-done", step: 1 },
      { at: now - 40_000, who: "Ирис", kind: "replied" },
      { at: now - 20_000, who: "Корвус", kind: "error" },
      { at: now - 10_000, who: "AM7", kind: "step-active", step: 2 },
    ],
    startedAt: now - 120_000,
    lastEventAt: now - 10_000,
    state: "live",
  };
  return { ...base, ...overrides, rev: now };
}
