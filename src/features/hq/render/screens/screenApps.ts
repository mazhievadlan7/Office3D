import { HQ_ROLE_FAMILY_COUNT } from "@/features/hq/core/roles";

/**
 * The apps a desk monitor can show, in atlas layer order (screenPaint.ts has
 * a painter for each), and which of them a desk puts up for each kind of
 * operation. Everyone on the floor is an operational hacker: the "family"
 * slot of a desk (core/roles.ts) names the kind of operation its hacker runs
 * (recon, web and API, identity, cloud, network, reverse, reporting), not a
 * department.
 *
 * The centre monitor follows the hacker's state, with no per-frame cost (the
 * shader already switches on the desk status it unpacks):
 * - working (on an operation, or on the cyber-range, which is entered from
 *   the hacker's own desk): a Kali root terminal session (the table's centre
 *   column holds only Kali sessions);
 * - idle: code, logs or dashboards (IDLE_CENTRE), or the lock screen;
 * - error: the alert screen.
 * Side monitors are dashboards, logs, code and notes, never a Kali session,
 * so the terminal on the centre screen reads as "on an operation".
 */
export const HQ_SCREEN_APPS = [
  "code_ts",
  "code_py",
  "kali_recon",
  "kali_web",
  "logs",
  "metrics",
  "sql",
  "notebook",
  "research",
  "papers",
  "findings",
  "cluster",
  "kali_range",
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

/** The Kali root terminal sessions: what a hacker on an operation (or the range) has on the centre monitor. */
export const HQ_KALI_APPS: readonly HqScreenApp[] = ["kali_recon", "kali_web", "kali_range"];

/** Candidates per monitor, picked per desk by its seed. */
const CANDIDATES = 4;

type Trio = readonly [left: readonly HqScreenApp[], centre: readonly HqScreenApp[], right: readonly HqScreenApp[]];

// Index = the desk's operation kind (HQ_ROLE_FAMILY value, core/roles.ts).
// Centre: Kali sessions only (weighted to the operation's own kind of work).
const OPERATION_APPS: readonly Trio[] = [
  // 0: general operations (the HQ's own work)
  [["logs", "chat", "kanban", "metrics"], ["kali_recon", "kali_web", "kali_range", "kali_recon"], ["network", "worldops", "findings", "docs"]],
  // 1: recon of the authorized scope
  [["network", "research", "chat", "notebook"], ["kali_recon", "kali_recon", "kali_range", "kali_recon"], ["worldops", "network", "findings", "papers"]],
  // 2: web and API
  [["logs", "code_ts", "findings", "chat"], ["kali_web", "kali_web", "kali_recon", "kali_web"], ["code_ts", "docs", "logs", "findings"]],
  // 3: identity and access (and exploitation of findings in scope)
  [["sql", "logs", "findings", "metrics"], ["kali_web", "kali_recon", "kali_web", "kali_range"], ["findings", "notebook", "sql", "chat"]],
  // 4: cloud
  [["cluster", "metrics", "logs", "worldops"], ["kali_recon", "kali_web", "kali_recon", "kali_range"], ["network", "cluster", "findings", "metrics"]],
  // 5: network
  [["network", "metrics", "logs", "cluster"], ["kali_recon", "kali_recon", "kali_web", "kali_range"], ["network", "logs", "worldops", "findings"]],
  // 6: reverse engineering and the lab sandbox
  [["code_py", "notebook", "logs", "papers"], ["kali_range", "kali_range", "kali_recon", "kali_range"], ["code_py", "findings", "research", "logs"]],
  // 7: reporting
  [["findings", "docs", "chat", "kanban"], ["kali_web", "kali_recon", "kali_range", "kali_web"], ["docs", "findings", "kanban", "research"]],
];

/** What a desk's centre monitor shows while its hacker is idle: code, logs or dashboards (or it locks). */
const IDLE_CENTRE: readonly HqScreenApp[] = ["code_ts", "logs", "metrics", "lock"];

/** GLSL source of the lookup tables, for the monitor shader. */
export function screenAppsGlsl(): string {
  const table: number[] = [];
  for (let f = 0; f < HQ_ROLE_FAMILY_COUNT; f++) {
    for (let m = 0; m < 3; m++) {
      const list = OPERATION_APPS[f][m];
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

/** Packs a desk's status (-1 empty, else HQ_STATUS_CODE) and operation kind (role family) into one float. */
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
