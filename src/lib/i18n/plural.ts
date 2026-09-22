/**
 * Russian plural forms.
 *
 * Russian has three, not two: 1 реплика, 2 реплики, 5 реплик. English-shaped
 * code that appends "s" produces text a native reader trips over on every
 * count, so this is not a nicety — it is the difference between the interface
 * reading as written in Russian and as translated from English.
 *
 * The rule is the standard one: forms are [one, few, many].
 *   one  — ends in 1, except 11            (1, 21, 101 реплика)
 *   few  — ends in 2..4, except 12..14     (2, 23, 104 реплики)
 *   many — everything else                 (0, 5, 11, 25 реплик)
 */

export type PluralForms = readonly [one: string, few: string, many: string];

export const pluralForm = (count: number): 0 | 1 | 2 => {
  const n = Math.abs(Math.trunc(count));
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 2;
  const mod10 = n % 10;
  if (mod10 === 1) return 0;
  if (mod10 >= 2 && mod10 <= 4) return 1;
  return 2;
};

/** Picks the right form. Does not include the number; the caller places it. */
export const plural = (count: number, forms: PluralForms): string =>
  forms[pluralForm(count)];

/** The common case: "5 реплик". */
export const pluralize = (count: number, forms: PluralForms): string =>
  `${count} ${plural(count, forms)}`;
