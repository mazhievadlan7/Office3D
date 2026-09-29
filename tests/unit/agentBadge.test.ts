import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { AgentAvatar } from "@/features/agents/components/AgentAvatar";
import {
  AGENT_BADGE_IMAGE_LARGE,
  AGENT_BADGE_IMAGE_SMALL,
  callsignInitials,
} from "@/lib/avatars/badge";
import {
  AGENT_BADGE_ACCENTS,
  accentForSeed,
  createDefaultAgentAvatarProfile,
  normalizeAgentAvatarProfile,
} from "@/lib/avatars/profile";

afterEach(cleanup);

describe("agent avatar profile", () => {
  it("gives_every_seed_a_stable_accent_from_the_hq_palette", () => {
    for (const seed of ["agent-1", "main", "Ghost", "seed-a", "x"]) {
      expect(AGENT_BADGE_ACCENTS).toContain(accentForSeed(seed));
      expect(accentForSeed(seed)).toBe(accentForSeed(seed));
    }
    const spread = new Set(Array.from({ length: 40 }, (_, i) => accentForSeed(`agent-${i}`)));
    expect(spread.size).toBeGreaterThan(1);
  });

  it("loads_a_profile_saved_with_the_old_human_portrait", () => {
    const old = {
      version: 1,
      seed: "persisted-seed",
      body: { skinTone: "#f7d7c2" },
      hair: { style: "bun", color: "#7c3aed" },
      clothing: {
        topStyle: "hoodie",
        topColor: "#7090ff",
        bottomStyle: "pants",
        bottomColor: "#34d399",
        shoesColor: "#1a1a1a",
      },
      accessories: { glasses: true, headset: false, hatStyle: "cap", backpack: true },
    };
    expect(normalizeAgentAvatarProfile(old, "agent-1")).toEqual({
      version: 2,
      seed: "persisted-seed",
      accent: accentForSeed("persisted-seed"),
    });
  });

  it("keeps_a_chosen_accent_and_drops_an_unknown_one", () => {
    expect(normalizeAgentAvatarProfile({ seed: "s", accent: "amber" }, "a").accent).toBe("amber");
    expect(normalizeAgentAvatarProfile({ seed: "s", accent: "violet" }, "a").accent).toBe(
      accentForSeed("s"),
    );
  });

  it("accepts_a_bare_seed_or_garbage", () => {
    expect(normalizeAgentAvatarProfile("seed-x", "a")).toEqual(createDefaultAgentAvatarProfile("seed-x"));
    expect(normalizeAgentAvatarProfile(42, "agent-2")).toEqual(createDefaultAgentAvatarProfile("agent-2"));
    expect(normalizeAgentAvatarProfile(null, "agent-2").seed).toBe("agent-2");
  });
});

describe("callsignInitials", () => {
  it.each([
    ["Agent One", "AO"],
    ["Ghost", "GH"],
    ["AM7", "AM7"],
    ["APT28", "A28"],
    ["Призрак", "ПР"],
    ["  ", ""],
  ])("%s -> %s", (name, expected) => {
    expect(callsignInitials(name)).toBe(expected);
  });
});

describe("AgentAvatar", () => {
  it("shows_the_hq_badge_with_the_accent_ring_and_callsign_mark", () => {
    const profile = { ...createDefaultAgentAvatarProfile("seed-a"), accent: "amber" as const };
    const { container } = render(
      createElement(AgentAvatar, { seed: "seed-a", name: "Agent One", avatarProfile: profile, size: 52 }),
    );
    const img = screen.getByRole("img", { name: "Аватар: Agent One" });
    expect(img.getAttribute("src")).toBe(AGENT_BADGE_IMAGE_SMALL);
    expect(screen.getByText("AO")).toBeInTheDocument();
    expect((container.firstElementChild as HTMLElement).dataset.accent).toBe("amber");
  });

  it("falls_back_to_the_seed_accent_without_a_profile", () => {
    const { container } = render(createElement(AgentAvatar, { seed: "agent-7", name: "Ghost", size: 42 }));
    expect((container.firstElementChild as HTMLElement).dataset.accent).toBe(accentForSeed("agent-7"));
  });

  it("uses_the_large_render_for_big_badges_and_no_mark_on_tiny_ones", () => {
    render(createElement(AgentAvatar, { seed: "s", name: "Ghost", size: 112 }));
    expect(screen.getByRole("img").getAttribute("src")).toBe(AGENT_BADGE_IMAGE_LARGE);
    cleanup();
    render(createElement(AgentAvatar, { seed: "s", name: "Ghost", size: 22 }));
    expect(screen.queryByText("GH")).toBeNull();
  });

  it("keeps_the_agents_own_picture", () => {
    render(
      createElement(AgentAvatar, {
        seed: "s",
        name: "Ghost",
        avatarProfile: createDefaultAgentAvatarProfile("s"),
        avatarUrl: "https://example.com/ghost.png",
        size: 52,
      }),
    );
    expect(screen.getByRole("img").getAttribute("src")).toBe("https://example.com/ghost.png");
    expect(screen.queryByText("GH")).toBeNull();
  });
});
