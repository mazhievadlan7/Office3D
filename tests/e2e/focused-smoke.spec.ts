import { expect, test } from "@playwright/test";
import { stubStudioRoute } from "./helpers/studioRoute";

test("loads office shell from root", async ({ page }) => {
  await stubStudioRoute(page);
  await page.goto("/");

  await expect
    .poll(() => new URL(page.url()).pathname)
    .toBe("/office");
  await expect(page.getByRole("button", { name: "Открыть боковую панель штаба" })).toBeVisible();
  await expect(page.getByRole("button", { name: "ЧАТ", exact: true })).toBeVisible();
});
