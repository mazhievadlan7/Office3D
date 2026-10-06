/**
 * The FLAT operational roles (TZ §3.1). Knowledge is universal — every operative
 * is a full-profile hacker — so a "role" here is only the WORK a given operative
 * takes on at a moment, never a department, a rank or a knowledge boundary. There
 * is no hierarchy and no floor map: a lead («Главный хакер», AM7) announces the
 * task and allocates operatives, then the operatives self-delegate across these
 * roles and chain their findings toward full control — one organism.
 *
 * This file is pure data + helpers (framework-free, like osint/geo): the model
 * and the demo swarm read it, and the real Execution Plane will too.
 */

/** A momentary role an operative can take. No ranking is implied by the order. */
export type OpsRole =
  | "recon"
  | "web-api"
  | "network"
  | "identity"
  | "cloud"
  | "wireless"
  | "reversing"
  | "osint"
  | "social-eng"
  | "exploitation"
  | "reporting";

/** All flat roles, in a stable presentation order. */
export const OPS_ROLES: readonly OpsRole[] = [
  "recon",
  "osint",
  "web-api",
  "network",
  "identity",
  "cloud",
  "wireless",
  "reversing",
  "social-eng",
  "exploitation",
  "reporting",
] as const;

export type OpsRoleMeta = {
  role: OpsRole;
  /** Full RU label for panels and the trail. */
  label: string;
  /** Short RU tag. */
  short: string;
};

/** RU labels for each flat role. */
export const OPS_ROLE_META: Readonly<Record<OpsRole, OpsRoleMeta>> = {
  recon: { role: "recon", label: "Разведка периметра", short: "разведка" },
  osint: { role: "osint", label: "OSINT-разведка", short: "osint" },
  "web-api": { role: "web-api", label: "Веб и API", short: "веб/api" },
  network: { role: "network", label: "Сетевая проверка", short: "сеть" },
  identity: { role: "identity", label: "Идентификация и доступы", short: "доступы" },
  cloud: { role: "cloud", label: "Облако и контейнеры", short: "облако" },
  wireless: { role: "wireless", label: "Беспроводные сети", short: "wi-fi" },
  reversing: { role: "reversing", label: "Реверс-инжиниринг", short: "реверс" },
  "social-eng": { role: "social-eng", label: "Социальная инженерия", short: "соц-инж" },
  exploitation: { role: "exploitation", label: "Эксплуатация и привилегии", short: "эксплуатация" },
  reporting: { role: "reporting", label: "Отчётность и доказательства", short: "отчёт" },
};

/** Whether a value is a known flat role (default-deny on routing). */
export const isOpsRole = (value: unknown): value is OpsRole =>
  typeof value === "string" && (OPS_ROLES as readonly string[]).includes(value);

/** Human label for a role, safe for any input (for the trail / audit). */
export const roleLabel = (role: string): string =>
  isOpsRole(role) ? OPS_ROLE_META[role].label : String(role);

/** The short RU tag, safe for any input. */
export const roleShort = (role: string): string =>
  isOpsRole(role) ? OPS_ROLE_META[role].short : String(role);
