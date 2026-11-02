import { chromium, defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

// The web desk smoke: dist-web/ served at /desk/ai/app/ with the development
// bridge in front of an isolated fixture host (fake Claude, temporary HOME).
// Run with `npm run test:web-desk`, which builds the host and dist-web first.
const PORT = 1442;

// Prefer Playwright's Chromium; use the installed Chrome when this
// Playwright version's browser has not been downloaded.
const bundledChromium = existsSync(chromium.executablePath());

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  workers: 1,
  timeout: 90_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: "chromium",
    ...(bundledChromium ? {} : { channel: "chrome" }),
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node scripts/web-desk/serve.mjs --fixture --port ${PORT} --host-port 3791`,
    cwd: "../..",
    url: `http://127.0.0.1:${PORT}/desk/ai/app/`,
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
