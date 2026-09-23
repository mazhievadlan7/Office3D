import { expect, test } from "@playwright/test";
import { stubStudioRoute } from "./helpers/studioRoute";

// Settings sit under the connect screen when no gateway answers; run with
// OFFICE3D_E2E_GATEWAY=1 and a gateway on ws://localhost:18789
// (npm run demo-gateway is enough).
test.skip(
  process.env.OFFICE3D_E2E_GATEWAY !== "1",
  "Requires a reachable gateway-backed office shell."
);

test.beforeEach(async ({ page }) => {
  await stubStudioRoute(page);
});

test("office settings panel reflects current gateway state", async ({ page }) => {
  await page.goto("/");

  // Connecting re-renders the office and closes an open panel, so the
  // settings are opened only once the gateway has answered.
  await expect(page.getByTitle(/\(Подключено\)$/)).toBeVisible({ timeout: 60_000 });
  await page.getByTitle("Настройки голосовых ответов").click();
  await expect(page.getByRole("button", { name: "Отключить шлюз" })).toBeVisible();
  await expect(page.getByText("Переключите активный бэкенд и обновите его сохранённые адрес и токен.")).toBeVisible();
});
