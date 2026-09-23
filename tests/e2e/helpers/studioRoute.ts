import type { Page, Route, Request } from "@playwright/test";
import {
  mergeStudioSettings,
  normalizeStudioSettings,
  sanitizeStudioSettings,
  type StudioSettings,
  type StudioSettingsPatch,
} from "@/lib/studio/settings";

/**
 * Whatever part of the settings a test wants to start from; the rest is
 * filled in the way the real /api/studio fills it.
 */
export type StudioSettingsFixture = Record<string, unknown>;

/**
 * An in-memory /api/studio for the browser tests.
 *
 * It runs the same normalize, merge and sanitize functions as the real route
 * (src/app/api/studio/route.ts) rather than a hand-written copy of them. The
 * copy this replaces knew only the fields that existed when it was written;
 * once settings grew per-gateway office and voice-reply preferences, the
 * office read them from its response, found nothing, and failed to load.
 */
const createStudioRoute = (initial: StudioSettingsFixture = {}) => {
  let settings: StudioSettings = normalizeStudioSettings(initial);

  const respond = (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ settings: sanitizeStudioSettings(settings), localGatewayDefaults: null }),
    });

  return async (route: Route, request: Request) => {
    if (request.method() === "GET") {
      await respond(route);
      return;
    }
    if (request.method() !== "PUT") {
      await route.fallback();
      return;
    }
    const patch = JSON.parse(request.postData() ?? "{}") as StudioSettingsPatch;
    settings = mergeStudioSettings(settings, patch);
    await respond(route);
  };
};

// The key useOnboardingState reads (src/features/onboarding/useOnboardingState.ts).
const ONBOARDING_COMPLETED_KEY = "office3d:onboarding:completed";

/**
 * Starts the browser as someone who has already been through the first-run
 * wizard. A fresh browser otherwise opens the wizard over the office, and a
 * test that clicks anything in the office clicks the wizard's backdrop.
 */
export const skipOnboarding = async (page: Page) => {
  await page.addInitScript((key) => {
    window.localStorage.setItem(key, "true");
  }, ONBOARDING_COMPLETED_KEY);
};

export const stubStudioRoute = async (
  page: Page,
  initial: StudioSettingsFixture = {},
  options: { onboarding?: boolean } = {}
) => {
  if (!options.onboarding) await skipOnboarding(page);
  await page.route("**/api/studio", createStudioRoute(initial));
};
