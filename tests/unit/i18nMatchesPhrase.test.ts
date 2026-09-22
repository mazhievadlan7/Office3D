import { describe, expect, it } from "vitest";

import { matchesPhrase, t } from "@/lib/i18n";

// Code that decides something from one of our own messages after it became
// plain text — an API route choosing 400 over 500, a screen choosing a colour —
// matches the dictionary phrase rather than a copy of its words.
describe("matchesPhrase", () => {
  it("matches_the_phrase_whatever_filled_its_placeholders", () => {
    expect(matchesPhrase(t("libSsh.invalidGatewayUrl", { url: "ws://x:1" }), "libSsh.invalidGatewayUrl")).toBe(true);
    expect(matchesPhrase(t("libOffice.checksFailing", { count: 3 }), "libOffice.checksFailing")).toBe(true);
  });

  it("finds_the_phrase_inside_a_longer_message", () => {
    const wrapped = `Ошибка шлюза: ${t("libSsh.invalidGatewayUrl", { url: "nope" })}`;
    expect(matchesPhrase(wrapped, "libSsh.invalidGatewayUrl")).toBe(true);
  });

  it("does_not_match_a_different_phrase", () => {
    expect(matchesPhrase(t("libOffice.checksPassing", { count: 2 }), "libOffice.checksFailing")).toBe(false);
    expect(matchesPhrase("Permission denied", "libSsh.invalidGatewayUrl")).toBe(false);
  });

  it("treats_the_phrase_text_literally_not_as_a_pattern", () => {
    // The phrase has parentheses and a dot, which must not act as regex syntax.
    expect(matchesPhrase(t("libSsh.commandFailed", { label: "x" }), "libSsh.commandFailed")).toBe(true);
    expect(matchesPhrase("Команда не выполнена x", "libSsh.commandFailed")).toBe(false);
  });
});
