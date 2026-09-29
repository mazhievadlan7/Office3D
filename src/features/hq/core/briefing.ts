/**
 * What a briefing shows on the video wall's three screens: the task the
 * operator gave (left), the goal (a banner over the map) and AM7's plan
 * (right). AM7 is asked to answer as «Цель: …» then «План: …» (see
 * office.addressAllNoteMain); anything else is split sensibly: the first
 * sentence is the goal, the rest the plan.
 */

export type HqBriefingScreens = {
  task: string;
  goal: string;
  plan: string;
};

/** Longest text each screen takes before it is cut with an ellipsis. */
export const BRIEFING_LIMITS = { task: 280, goal: 160, plan: 700 } as const;

const GOAL_RE = /(?:^|\n|\s)(?:\*\*)?\s*цель\s*(?:\*\*)?\s*[:：—-]\s*/i;
const PLAN_RE = /(?:^|\n|\s)(?:\*\*)?\s*план\s*(?:\*\*)?\s*[:：—-]\s*/i;

function tidy(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[*_`#>]+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit - 1);
  const space = slice.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? slice.slice(0, space) : slice).trimEnd()}…`;
}

/** The first sentence (up to . ! ? or a line break) and the rest. */
function firstSentence(text: string): [string, string] {
  const match = /^([\s\S]+?[.!?])(\s+|$)/.exec(text);
  const line = text.indexOf("\n");
  if (match && (line < 0 || match[1].length <= line)) return [match[1].trim(), text.slice(match[0].length).trim()];
  if (line > 0) return [text.slice(0, line).trim(), text.slice(line + 1).trim()];
  return [text.trim(), ""];
}

export function briefingScreens(task: string, reply: string): HqBriefingScreens {
  const body = tidy(reply);
  let goal = "";
  let plan = "";
  const goalAt = body.search(GOAL_RE);
  const planAt = body.search(PLAN_RE);
  if (goalAt >= 0 || planAt >= 0) {
    if (goalAt >= 0) {
      const start = goalAt + (GOAL_RE.exec(body.slice(goalAt))?.[0].length ?? 0);
      const end = planAt > goalAt ? planAt : body.length;
      goal = body.slice(start, end).trim();
    }
    if (planAt >= 0) {
      const start = planAt + (PLAN_RE.exec(body.slice(planAt))?.[0].length ?? 0);
      const end = goalAt > planAt ? goalAt : body.length;
      plan = body.slice(start, end).trim();
    }
    if (!goal && plan) [goal] = firstSentence(body.slice(0, Math.max(0, planAt)).trim() || plan);
  } else if (body) {
    [goal, plan] = firstSentence(body);
  }
  // Numbered steps on their own lines: "1) a, 2) b" -> "1) a\n2) b".
  plan = plan.replace(/\s+(?=\d+[.)]\s)/g, "\n");
  return {
    task: cut(tidy(task), BRIEFING_LIMITS.task),
    goal: cut(goal.replace(/\s+/g, " "), BRIEFING_LIMITS.goal),
    plan: cut(plan, BRIEFING_LIMITS.plan),
  };
}
