import { defineConfig } from "@playwright/test";
import { e2eStateDir } from "./tests/e2e/helpers/e2eStateDir";
export default defineConfig({
  testDir: "./tests/e2e",
  // The dev server compiles a route on its first request; the office page
  // alone can take longer than Playwright's 30 s default on a cold start.
  timeout: 90_000,
  // Assertions wait for the page to hydrate and settle, which on a dev server
  // that is compiling other tests' routes at the same time takes more than 5 s.
  expect: { timeout: 20_000 },
  use: {
    baseURL: "http://127.0.0.1:3000",
    navigationTimeout: 60_000,
  },
  webServer: {
    command: "npm run dev",
    port: 3000,
    reuseExistingServer: !process.env.CI,
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: e2eStateDir(),
      NEXT_PUBLIC_GATEWAY_URL: "",
    },
  },
});
