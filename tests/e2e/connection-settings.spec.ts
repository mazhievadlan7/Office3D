import { expect, test } from "@playwright/test";
import { stubStudioRoute } from "./helpers/studioRoute";

// Without a reachable gateway the office shows the connect screen over
// everything, settings included; run with OFFICE3D_E2E_GATEWAY=1 and a gateway
// on ws://localhost:18789 (npm run demo-gateway is enough).
test.skip(
  process.env.OFFICE3D_E2E_GATEWAY !== "1",
  "Requires a reachable gateway-backed office shell."
);

test("voice reply settings persist to the studio settings API", async ({ page }) => {
  await stubStudioRoute(page);

  await page.goto("/");
  // Connecting re-renders the office and closes an open panel, so the
  // settings are opened only once the gateway has answered.
  await expect(page.getByTitle(/\(Подключено\)$/)).toBeVisible({ timeout: 60_000 });
  await page.getByTitle("Настройки голосовых ответов").click();
  await expect(page.getByRole("switch", { name: "Голосовые ответы" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Голосовые ответы" })).toBeEnabled();

  const requestPromise = page.waitForRequest((req) => {
    if (!req.url().includes("/api/studio") || req.method() !== "PUT") {
      return false;
    }
    const payload = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
    const voiceReplies = (payload.voiceReplies ?? {}) as Record<string, { enabled?: boolean }>;
    return Object.values(voiceReplies).some((entry) => entry.enabled === true);
  });
  await page.getByRole("switch", { name: "Голосовые ответы" }).click();
  const request = await requestPromise;

  const payload = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
  const voiceReplies = (payload.voiceReplies ?? {}) as Record<string, { enabled?: boolean }>;
  expect(Object.keys(voiceReplies).length).toBeGreaterThan(0);
  expect(Object.values(voiceReplies).some((entry) => entry.enabled === true)).toBe(true);
});
