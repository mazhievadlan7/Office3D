import { HQ_ROLE_FAMILY_COUNT } from "@/features/hq/core/roles";

/**
 * The apps a desk monitor can show, in atlas layer order (screenPaint.ts has
 * a painter for each), and which apps each role family works in.
 */
export const HQ_SCREEN_APPS = [
  "code_ts",
  "code_py",
  "term_build",
  "term_ops",
  "logs",
  "metrics",
  "sql",
  "notebook",
  "research",
  "papers",
  "design",
  "cluster",
  "tests",
  "kanban",
  "chat",
  "docs",
  "network",
  "worldops",
  "alert",
  "lock",
] as const;

export type HqScreenApp = (typeof HQ_SCREEN_APPS)[number];

export const APP_LAYER = Object.fromEntries(HQ_SCREEN_APPS.map((name, i) => [name, i])) as Record<HqScreenApp, number>;

/** Candidates per monitor, picked per desk by its seed. */
const CANDIDATES = 4;

type Trio = readonly [left: readonly HqScreenApp[], centre: readonly HqScreenApp[], right: readonly HqScreenApp[]];

// Index = HQ_ROLE_FAMILY value (core/roles.ts).
const FAMILY_APPS: readonly Trio[] = [
  // generic
  [["logs", "chat", "kanban", "metrics"], ["code_ts", "metrics", "docs", "research"], ["network", "worldops", "term_build", "sql"]],
  // research
  [["papers", "docs", "chat", "research"], ["research", "papers", "notebook", "research"], ["notebook", "worldops", "research", "papers"]],
  // builder
  [["term_build", "term_build", "tests", "logs"], ["code_ts", "code_py", "code_ts", "code_ts"], ["logs", "docs", "network", "term_build"]],
  // analyst / data
  [["sql", "metrics", "sql", "worldops"], ["notebook", "sql", "metrics", "notebook"], ["worldops", "notebook", "network", "metrics"]],
  // design
  [["kanban", "research", "chat", "design"], ["design", "design", "design", "docs"], ["chat", "design", "kanban", "research"]],
  // devops
  [["logs", "metrics", "logs", "network"], ["cluster", "term_ops", "cluster", "metrics"], ["network", "term_ops", "logs", "cluster"]],
  // qa
  [["logs", "kanban", "tests", "logs"], ["tests", "code_ts", "tests", "tests"], ["term_build", "tests", "logs", "kanban"]],
  // writer / planner / support
  [["chat", "research", "kanban", "chat"], ["docs", "kanban", "chat", "docs"], ["kanban", "worldops", "chat", "docs"]],
];

/** What a desk shows while its agent is idle: a calm centre screen, locked sides. */
const IDLE_CENTRE: readonly HqScreenApp[] = ["chat", "kanban", "metrics", "lock"];

/** GLSL source of the lookup tables, for the monitor shader. */
export function screenAppsGlsl(): string {
  const table: number[] = [];
  for (let f = 0; f < HQ_ROLE_FAMILY_COUNT; f++) {
    for (let m = 0; m < 3; m++) {
      const list = FAMILY_APPS[f][m];
      for (let k = 0; k < CANDIDATES; k++) table.push(APP_LAYER[list[k % list.length]]);
    }
  }
  const idle = IDLE_CENTRE.map((name) => APP_LAYER[name]);
  return /* glsl */ `
const int HQ_APP_TABLE[${table.length}] = int[${table.length}](${table.join(", ")});
const int HQ_APP_IDLE[${idle.length}] = int[${idle.length}](${idle.join(", ")});
const int HQ_APP_ALERT = ${APP_LAYER.alert};
const int HQ_APP_LOGS = ${APP_LAYER.logs};
const int HQ_APP_LOCK = ${APP_LAYER.lock};
int hqAppFor(int family, int monitor, int pick) {
  return HQ_APP_TABLE[(family * 3 + monitor) * ${CANDIDATES} + pick];
}
`;
}

/** Packs a desk's status (-1 empty, else HQ_STATUS_CODE) and role family into one float. */
export function packDeskState(status: number, family: number): number {
  return status < 0 ? -1 : status + 8 * family;
}

/** GLSL: unpacks packDeskState into (status, family). */
export const UNPACK_DESK_STATE_GLSL = /* glsl */ `
vec2 hqUnpackDesk(float packed) {
  float family = floor((packed + 1.0) / 8.0);
  return vec2(packed - 8.0 * family, family);
}
`;
