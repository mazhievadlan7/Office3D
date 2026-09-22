import { expect, test } from "@playwright/test";
import { stubStudioRoute } from "./helpers/studioRoute";

test.beforeEach(async ({ page }) => {
  await stubStudioRoute(page);
});

test("office settings panel reflects current gateway state", async ({ page }) => {
  await page.goto("/");

  await page.getByTitle("Настройки голосовых ответов").click();
  await expect(page.getByRole("button", { name: "Отключить шлюз" })).toBeVisible();
  await expect(page.getByText("Current studio connection and endpoint details.")).toBeVisible();
});
