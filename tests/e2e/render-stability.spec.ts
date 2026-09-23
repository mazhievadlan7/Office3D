import { expect, test } from "@playwright/test";
import { stubStudioRoute } from "./helpers/studioRoute";

// The office with agents on screen must settle: an effect that re-runs on
// every render (e.g. on a map rebuilt from the clock) used to loop until React
// stopped it with "Maximum update depth exceeded". The loop needs a burst of
// other updates to start, so this guard may miss it on a quiet run — but it
// never fails on code without such a loop.
test.skip(process.env.OFFICE3D_E2E_GATEWAY !== "1", "Requires a reachable gateway-backed office shell.");

// With software WebGL the 3D office actually renders and animates, which is
// what produces the stream of updates a render loop feeds on.
test.use({
  launchOptions: {
    args: ["--use-gl=swiftshader", "--ignore-gpu-blocklist"],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
  },
});

test.beforeEach(async ({ page }) => {
  await stubStudioRoute(page);
  // The full office, as a returning user sees it — the onboarding wizard
  // otherwise covers it and the burst of updates on connect does not happen.
  await page.addInitScript(() => window.localStorage.setItem("office3d:onboarding:completed", "true"));
});

test("settles_without_render_loops_while_agents_work", async ({ page }) => {
  const loops: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("Maximum update depth")) loops.push(message.text());
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "ЧАТ", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "ЧАТ", exact: true }).click();
  const box = page.locator("textarea").first();
  await box.waitFor();
  await box.fill("Привет, как дела?");
  await box.press("Enter");
  await page.waitForTimeout(12_000);
  expect(loops).toEqual([]);
});
