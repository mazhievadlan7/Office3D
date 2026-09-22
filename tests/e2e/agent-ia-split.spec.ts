import { expect, test } from "@playwright/test";
import { stubStudioRoute } from "./helpers/studioRoute";

test.beforeEach(async ({ page }) => {
  await stubStudioRoute(page);
});

test("shows_office_header_controls", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("brain-files-toggle")).toHaveCount(0);
  await expect(page.getByTitle("Настройки голосовых ответов")).toBeVisible();
  await expect(page.getByRole("button", { name: "ЧАТ" })).toBeVisible();
});

test("mobile_header_shows_office_controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.getByTestId("brain-files-toggle")).toHaveCount(0);
  await expect(page.getByTitle("Настройки голосовых ответов")).toBeVisible();
  await expect(page.getByRole("button", { name: "ЧАТ" })).toBeVisible();
});
