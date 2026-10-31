import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: /rotation-(?:owner-)?recovery\.ui\.spec\.ts/,
  timeout: 45000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  outputDir: process.env.ROTATION_BROWSER_OUTPUT,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4179",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      chromiumSandbox: true,
      executablePath: process.env.ROUTEWEAVER_CHROMIUM,
    },
  },
  webServer: {
    cwd: new URL("..", import.meta.url).pathname,
    command:
      "node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4179 --strictPort",
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
    timeout: 60000,
  },
});
