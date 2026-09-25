/**
 * Role families for what an agent's monitors show. Roles arrive as free text
 * (English ids like "Builder", or labels like «Разработка»), so they are
 * matched by keyword; anything unknown is the generic family 0.
 */
export const HQ_ROLE_FAMILY = {
  generic: 0,
  research: 1,
  builder: 2,
  analyst: 3,
  design: 4,
  devops: 5,
  qa: 6,
  writer: 7,
} as const;

export type HqRoleFamily = (typeof HQ_ROLE_FAMILY)[keyof typeof HQ_ROLE_FAMILY];

export const HQ_ROLE_FAMILY_COUNT = 8;

const RULES: ReadonlyArray<readonly [RegExp, HqRoleFamily]> = [
  [/devops|ops\b|infra|sre|platform|девопс|инфра/i, HQ_ROLE_FAMILY.devops],
  [/\bqa\b|test|тест|качеств/i, HQ_ROLE_FAMILY.qa],
  [/research|исслед|science|учён/i, HQ_ROLE_FAMILY.research],
  [/build|dev|engineer|code|разраб|програм|инженер/i, HQ_ROLE_FAMILY.builder],
  [/analy|data|аналит|данн/i, HQ_ROLE_FAMILY.analyst],
  [/design|дизайн|ux|ui\b/i, HQ_ROLE_FAMILY.design],
  [/writ|plan|support|текст|план|поддерж|content|manager|менедж/i, HQ_ROLE_FAMILY.writer],
];

export function hqRoleFamily(role: string | null | undefined): HqRoleFamily {
  if (!role) return HQ_ROLE_FAMILY.generic;
  for (const [pattern, family] of RULES) if (pattern.test(role)) return family;
  return HQ_ROLE_FAMILY.generic;
}
