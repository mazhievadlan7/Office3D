import { describe, expect, it } from "vitest";

import { plural, pluralForm, pluralize } from "@/lib/i18n/plural";

const FORMS = ["реплика", "реплики", "реплик"] as const;

describe("pluralForm", () => {
  it("picks_one_for_numbers_ending_in_1", () => {
    for (const n of [1, 21, 101, 1001]) expect(pluralForm(n)).toBe(0);
  });

  it("picks_few_for_numbers_ending_in_2_to_4", () => {
    for (const n of [2, 3, 4, 22, 104]) expect(pluralForm(n)).toBe(1);
  });

  it("picks_many_for_everything_else", () => {
    for (const n of [0, 5, 9, 20, 100]) expect(pluralForm(n)).toBe(2);
  });

  it("treats_the_teens_as_many_despite_their_last_digit", () => {
    // 11 ends in 1 and 12 ends in 2, but both take the "many" form. This is
    // the exception an English-shaped rule gets wrong.
    for (const n of [11, 12, 13, 14, 111, 112]) expect(pluralForm(n)).toBe(2);
  });

  it("handles_a_negative_or_fractional_count_without_crashing", () => {
    expect(pluralForm(-1)).toBe(0);
    expect(pluralForm(-5)).toBe(2);
    expect(pluralForm(1.7)).toBe(0);
  });
});

describe("plural and pluralize", () => {
  it("returns_the_form_alone_and_with_the_number", () => {
    expect(plural(1, FORMS)).toBe("реплика");
    expect(plural(3, FORMS)).toBe("реплики");
    expect(plural(11, FORMS)).toBe("реплик");
    expect(pluralize(5, FORMS)).toBe("5 реплик");
    expect(pluralize(1, FORMS)).toBe("1 реплика");
  });
});
