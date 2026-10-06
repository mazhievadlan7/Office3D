/**
 * Swarm allocation (TZ §14.3 «Swarm», owner 2026-10-07): a lead («Главный хакер»,
 * AM7) announces a task, then allocates N operatives to it — N chosen by the task
 * size — and the operatives take momentary flat ROLES and self-delegate. This
 * module is the pure allocation logic: no timers, no I/O, deterministic for a
 * given task + count, so it is trivially unit-tested.
 *
 * The real runtime will decide N and the callsigns; here a deterministic demo
 * pool fills in, and opsController drives the allocation onto the board + chatter.
 */

import { OPS_ROLES, type OpsRole } from "./roles";
import type { OpsOperative } from "./types";

/** The lead's callsign — the single «Главный хакер» who announces & allocates. */
export const LEAD_CALLSIGN = "AM7";

/** APT-style operative callsigns the demo draws from (fictional handles). */
export const SWARM_CALLSIGNS: readonly string[] = [
  "WRAITH-07",
  "VECTOR-12",
  "GHOST-03",
  "CIPHER-05",
  "RAVEN-09",
  "NOMAD-14",
  "ECHO-02",
  "HYDRA-08",
  "ONYX-11",
  "SABLE-06",
  "ZEPHYR-04",
  "KITE-10",
] as const;

/** Keyword → role hints, so the task text steers which roles the swarm fields. */
const ROLE_HINTS: ReadonlyArray<readonly [RegExp, OpsRole]> = [
  [/развед|recon|периметр|поверхн|скан|порт/i, "recon"],
  [/osint|разведк|открыт|утечк|поддомен/i, "osint"],
  [/веб|web|\bapi\b|прилож|owasp|http|сайт/i, "web-api"],
  [/сет[ьи]|network|шлюз|vpn|firewall|служб/i, "network"],
  [/доступ|идентиф|учётн|identity|парол|ad\b|актив.?директ/i, "identity"],
  [/облак|cloud|k8s|kubernetes|контейнер|s3/i, "cloud"],
  [/wi-?fi|беспровод|wireless|радио/i, "wireless"],
  [/реверс|reverse|бинар|прошивк|malware|вредонос/i, "reversing"],
  [/фишинг|phishing|соц|social|сотрудник|письм/i, "social-eng"],
  [/эксплуат|exploit|привилег|контрол|захват|rce|повышен/i, "exploitation"],
  [/отчёт|отчет|report|доказательств|рекомендац/i, "reporting"],
];

/** The default spread of roles when the task text gives few hints. */
const DEFAULT_ROLE_ORDER: readonly OpsRole[] = [
  "recon",
  "osint",
  "web-api",
  "network",
  "identity",
  "exploitation",
  "cloud",
  "reversing",
  "wireless",
  "social-eng",
  "reporting",
];

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * Recommend how many operatives the task warrants (3..12): a base from the text
 * length plus one per distinct role the task implies. Deterministic.
 */
export const recommendAgentCount = (task: string): number => {
  const words = String(task ?? "").trim().split(/\s+/).filter(Boolean).length;
  const hinted = new Set<OpsRole>();
  for (const [re, role] of ROLE_HINTS) if (re.test(task ?? "")) hinted.add(role);
  const base = 3 + Math.floor(words / 8);
  return clamp(base + hinted.size, 3, 12);
};

/** The ordered set of roles the task implies, always including recon + reporting
 *  and at least one exploitation track (the organism drives toward full control). */
export const rolesForTask = (task: string): OpsRole[] => {
  const chosen: OpsRole[] = [];
  const add = (role: OpsRole) => {
    if (!chosen.includes(role)) chosen.push(role);
  };
  add("recon");
  for (const [re, role] of ROLE_HINTS) if (re.test(task ?? "")) add(role);
  add("exploitation");
  add("reporting");
  // Top up from the default order so a larger swarm has distinct roles to take.
  for (const role of DEFAULT_ROLE_ORDER) add(role);
  return chosen;
};

export type SwarmAllocation = {
  /** The single lead operative. */
  lead: OpsOperative;
  /** All operatives including the lead. */
  operatives: OpsOperative[];
  /** The distinct roles represented, in allocation order. */
  roles: OpsRole[];
  task: string;
  count: number;
};

/**
 * Allocate a swarm for a task. The lead is operative #0 (role = the task's primary
 * role); the remaining operatives are spread across the task's roles round-robin,
 * so every chosen role is covered before any role doubles up. Deterministic.
 */
export const allocateSwarm = (
  task: string,
  agentCount?: number,
  { callsigns = SWARM_CALLSIGNS }: { callsigns?: readonly string[] } = {},
): SwarmAllocation => {
  const count = clamp(Math.floor(agentCount ?? recommendAgentCount(task)), 1, 24);
  const roleOrder = rolesForTask(task);

  const operatives: OpsOperative[] = [];
  const lead: OpsOperative = { callsign: LEAD_CALLSIGN, role: roleOrder[0] ?? "recon", lead: true };
  operatives.push(lead);

  const members = Math.max(0, count - 1);
  for (let i = 0; i < members; i += 1) {
    const role = roleOrder[(i + 1) % roleOrder.length] ?? "recon";
    const callsign = callsigns[i % callsigns.length] ?? `OP-${i + 1}`;
    operatives.push({ callsign, role, lead: false });
  }

  const roles = [...new Set(operatives.map((op) => op.role))].filter((r): r is OpsRole => (OPS_ROLES as readonly string[]).includes(r));
  return { lead, operatives, roles, task, count: operatives.length };
};
