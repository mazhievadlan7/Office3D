import { describe, expect, it, vi } from "vitest";

import { claimHqGreeting, hqGreetingClaimed, tryStartAudio } from "@/lib/office/hqEntry";
import { parseSecuritySummary } from "@/lib/office/securitySummary";

type FakeContext = { state: AudioContextState; resume: () => Promise<void> };

describe("entering the HQ", () => {
  it("starts at once when the audio already runs", async () => {
    const resume = vi.fn(async () => {});
    expect(await tryStartAudio({ state: "running", resume } as FakeContext)).toBe(true);
    expect(resume).not.toHaveBeenCalled();
  });

  it("starts without the entry screen when the browser lets the audio resume", async () => {
    const ctx: FakeContext = {
      state: "suspended",
      resume: async () => {
        ctx.state = "running";
      },
    };
    expect(await tryStartAudio(ctx, 50)).toBe(true);
  });

  it("asks for a click when the browser keeps resume() pending (no gesture after a reload)", async () => {
    const ctx: FakeContext = { state: "suspended", resume: () => new Promise<void>(() => {}) };
    expect(await tryStartAudio(ctx, 20)).toBe(false);
    // A refusal that rejects is a refusal too; no audio at all is no sound.
    expect(await tryStartAudio({ state: "suspended", resume: () => Promise.reject(new Error("no")) } as FakeContext, 20)).toBe(false);
    expect(await tryStartAudio(null)).toBe(false);
  });

  it("greets once per page load, so a remount never plays the greeting over itself", () => {
    const page = {};
    expect(hqGreetingClaimed(page)).toBe(false);
    expect(claimHqGreeting(page)).toBe(true);
    expect(claimHqGreeting(page)).toBe(false);
    expect(hqGreetingClaimed(page)).toBe(true);
    // A reload is a new page: it greets again.
    expect(claimHqGreeting({})).toBe(true);
  });

  it("reads the name to greet from the security summary", () => {
    const summary = { access: "session", previousLoginAt: null, failedAttempts: 0, blocked: 0 };
    expect(parseSecuritySummary({ ...summary, ownerName: " Командир " })?.ownerName).toBe("Командир");
    expect(parseSecuritySummary(summary)?.ownerName).toBe("");
    expect(parseSecuritySummary({ ...summary, ownerName: 42 })?.ownerName).toBe("");
  });
});
