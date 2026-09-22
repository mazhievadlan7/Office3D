import { describe, expect, it } from "vitest";

import { formatDurationShort } from "@/lib/text/duration";

describe("formatDurationShort", () => {
  it("uses_russian_units", () => {
    expect(formatDurationShort(45)).toBe("45 с");
    expect(formatDurationShort(200)).toBe("3 мин 20 с");
    expect(formatDurationShort(7500)).toBe("2 ч 5 мин");
  });

  it("drops_a_zero_remainder", () => {
    expect(formatDurationShort(120)).toBe("2 мин");
    expect(formatDurationShort(3600)).toBe("1 ч");
  });

  it("never_goes_negative", () => {
    expect(formatDurationShort(-5)).toBe("0 с");
  });
});
