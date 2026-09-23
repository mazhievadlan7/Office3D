import { defineConfig } from "@playwright/test";
import { e2eStateDir } from "./tests/e2e/helpers/e2eStateDir";

export default defineConfig({
  testDir: "./tests/e2e",
  use: {
    baseURL: "http://127.0.0.1:3100",
  },
  webServer: {
    command: "PORT=3100 npm run dev",
    port: 3100,
    reuseExistingServer: !process.env.CI,
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: e2eStateDir(),
      NEXT_PUBLIC_GATEWAY_URL: "",
    },
  },
});
