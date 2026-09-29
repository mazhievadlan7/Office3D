import { splitSentences } from "@/lib/voice/speechChunks";
import { briefingParts, briefingScreens, type HqBriefingScreens } from "./briefing";
import { briefingText, planSteps } from "./operation";

/**
 * AM7's briefing as he says it from the tribune, sentence by sentence, and
 * what the video wall shows while each sentence is heard.
 *
 * briefingCues(reply) turns his answer into cues: one sentence each (one
 * request to the speech service each), in the order he says them: anything
 * before the goal, «Цель: …», then the plan — its lead-in, then each step,
 * announced as «Первое: …», «Второе: …». Every cue knows which plan step it
 * is about (the same numbering as the plan screen's list) and whether he
 * turns to show the wall while saying it (the first sentence of the plan and
 * of every step, and anything that mentions the screen).
 *
 * briefingWall(task, reply, cue, hold) is what the three screens show: the
 * task, goal and plan as before, plus the focus of the cue being spoken (the
 * step lit up on the plan, its number and title large on the task screen, its
 * keyword on the banner) and, until the floor has gathered, the hold
 * («ОЖИДАНИЕ КОМАНДЫ…», how many stand at their places). The host moves `cue`
 * when the audio of a sentence actually starts playing, never on a timer.
 *
 * Pure (no DOM, no audio): tested without either.
 */

export type HqBriefingSection = "lead" | "goal" | "plan" | "step";

export type HqBriefingCue = {
  index: number;
  /** What AM7 says (sent to the speech service as it is). */
  speech: string;
  /** The sentence itself, without the «Цель:» / «Первое:» he says before it. */
  text: string;
  section: HqBriefingSection;
  /** The plan step (0-based, as numbered on the plan screen) this sentence is about, or -1. */
  step: number;
  /** Steps in the plan (0 when it is not a list). */
  steps: number;
  /** He turns to the video wall and shows it while saying this. */
  point: boolean;
  /** The first sentence of its section or step. */
  opens: boolean;
};

/** What the screens single out while a cue is heard. */
export type HqBriefingFocus = {
  section: HqBriefingSection;
  step: number;
  steps: number;
  /** The banner's label: «ЦЕЛЬ», «ПЛАН», «ШАГ 2 / 5». */
  label: string;
  /** A few words: the step's title, the goal, the phrase's keyword. */
  title: string;
};

/** The floor still gathering: how many of those expected stand at their places. */
export type HqBriefingHold = { gathered: number; expected: number };

export type HqBriefingWall = HqBriefingScreens & {
  focus?: HqBriefingFocus;
  hold?: HqBriefingHold;
};

const ORDINALS = ["Первое", "Второе", "Третье", "Четвёртое", "Пятое", "Шестое", "Седьмое", "Восьмое", "Девятое", "Десятое"];
/** A sentence that refers to the wall: he shows it while saying it. */
const MENTIONS_WALL = /(экран|на стене|стену|смотрите|посмотрите|видите|на карте|вот здесь|вот тут)/i;
/** «Шаг 2», «этапа 3»: a step named by number in running text. */
const STEP_NAMED = /(?:^|[^а-яё])(?:шаг|этап)[а-яё]*\s*(?:№\s*)?(\d{1,2})/i;
/** The longest title shown for a step or phrase. */
const TITLE_MAX = 48;

/** Ends the sentence with a stop, for the speech service's intonation. */
function closed(text: string): string {
  const t = text.replace(/[\s,;:–—-]+$/, "").trim();
  if (!t) return "";
  return /[.!?…]["»”)\]]*$/.test(t) ? t : `${t}.`;
}

/** «Карта периметра» -> «карта периметра»; an acronym («DNS», «AD») keeps its case. */
function lowerFirst(text: string): string {
  if (!text || /^\p{Lu}{2}/u.test(text)) return text;
  return text[0].toLowerCase() + text.slice(1);
}

function upperFirst(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * A step's (or a phrase's) title: its first clause — up to a colon, a dash, a
 * bracket, or a comma when the clause runs long — at most TITLE_MAX
 * characters, cut on a word.
 */
export function stepTitle(text: string): string {
  let t = briefingText(text).replace(/\n/g, " ").trim();
  t = t.split(/\s*[:(]\s*|\s+[—–-]\s+/)[0] ?? t;
  if (t.length > TITLE_MAX) {
    const comma = t.indexOf(",");
    if (comma > 8) t = t.slice(0, comma);
  }
  t = t.replace(/[\s.,;:!?…]+$/, "");
  if (t.length > TITLE_MAX) {
    const slice = t.slice(0, TITLE_MAX - 1);
    const space = slice.lastIndexOf(" ");
    t = `${(space > TITLE_MAX * 0.5 ? slice.slice(0, space) : slice).trimEnd()}…`;
  }
  return upperFirst(t);
}

/** The plan step (0-based) a sentence names by number, or -1. */
function namedStep(sentence: string, steps: number): number {
  const match = STEP_NAMED.exec(sentence);
  if (!match) return -1;
  const n = Number(match[1]) - 1;
  return n >= 0 && (steps === 0 || n < steps) ? n : -1;
}

/** AM7's answer as the sentences he says, in order, each with what it is about. */
export function briefingCues(reply: string): HqBriefingCue[] {
  const { lead, goal, between, plan, goalNamed } = briefingParts(reply);
  const cues: HqBriefingCue[] = [];
  const push = (
    sentence: string,
    prefix: string,
    section: HqBriefingSection,
    step: number,
    steps: number,
    point: boolean,
    opens: boolean,
  ) => {
    const text = closed(sentence);
    if (!text) return;
    const speech = prefix ? `${prefix} ${lowerFirst(text)}` : text;
    cues.push({ index: cues.length, speech, text, section, step, steps, point: point || MENTIONS_WALL.test(text), opens });
  };
  const list = plan ? planSteps(plan) : null;
  const steps = list?.steps.length ?? 0;

  for (const sentence of splitSentences(lead)) push(sentence, "", "lead", namedStep(sentence, steps), steps, false, false);

  // The goal, unless it is only the plan's first sentence (said with the plan).
  const goalText = goal.replace(/\s+/g, " ").trim();
  const goalIsPlan = goalText && plan.replace(/\s+/g, " ").trim().startsWith(goalText);
  if (goalText && !goalIsPlan) {
    splitSentences(goalText).forEach((sentence, i) => push(sentence, i === 0 && goalNamed ? "Цель:" : "", "goal", -1, steps, false, i === 0));
  }
  for (const sentence of splitSentences(between)) push(sentence, "", "lead", namedStep(sentence, steps), steps, false, false);

  if (list) {
    const intro = splitSentences(list.intro);
    intro.forEach((sentence, i) => push(sentence, i === 0 && !/план/i.test(sentence) ? "План:" : "", "plan", -1, steps, i === 0, i === 0));
    list.steps.forEach((step, k) => {
      const ordinal = `${ORDINALS[k] ?? `Шаг ${k + 1}`}:`;
      splitSentences(step).forEach((sentence, i) => {
        const prefix = i > 0 ? "" : k === 0 && intro.length === 0 ? `План. ${ordinal}` : ordinal;
        push(sentence, prefix, "step", k, steps, i === 0, i === 0);
      });
    });
  } else if (plan) {
    splitSentences(plan).forEach((sentence, i) =>
      push(sentence, i === 0 && !/план/i.test(sentence) ? "План:" : "", "plan", namedStep(sentence, 0), 0, i === 0, i === 0),
    );
  }
  return cues;
}

/** What the wall singles out while `cue` is heard (null: nothing, the usual briefing screens). */
export function cueFocus(cue: HqBriefingCue | undefined, goal: string): HqBriefingFocus | null {
  if (!cue) return null;
  const speech = cue.text;
  switch (cue.section) {
    case "goal":
      return { section: "goal", step: -1, steps: cue.steps, label: "ЦЕЛЬ", title: goal };
    case "step":
      return { section: "step", step: cue.step, steps: cue.steps, label: `ШАГ ${cue.step + 1} / ${cue.steps}`, title: stepTitle(speech) };
    case "plan":
      if (cue.step >= 0) return { section: "step", step: cue.step, steps: cue.steps, label: `ШАГ ${cue.step + 1}`, title: stepTitle(speech) };
      return { section: "plan", step: -1, steps: cue.steps, label: "ПЛАН", title: stepTitle(speech) };
    default:
      return cue.step >= 0 ? { section: "step", step: cue.step, steps: cue.steps, label: `ШАГ ${cue.step + 1}`, title: stepTitle(speech) } : null;
  }
}

/**
 * The video wall during a briefing: the task, goal and plan, the focus of
 * cue `cue` (-1: none) of AM7's answer, and the hold while the floor gathers.
 * A step's title on the task screen is the step as the plan screen lists it.
 */
export function briefingWall(task: string, reply: string, cue: number, hold: HqBriefingHold | null, cues?: readonly HqBriefingCue[]): HqBriefingWall {
  const screens = briefingScreens(task, reply);
  const wall: HqBriefingWall = { ...screens };
  if (hold) wall.hold = { gathered: hold.gathered, expected: hold.expected };
  if (cue >= 0) {
    const list = cues ?? briefingCues(reply);
    const focus = cueFocus(list[cue], screens.goal);
    if (focus) {
      if (focus.section === "step" && focus.step >= 0) {
        const shown = screens.plan ? planSteps(screens.plan) : null;
        const step = shown?.steps[focus.step];
        if (step) focus.title = stepTitle(step);
      }
      wall.focus = focus;
    }
  }
  return wall;
}
