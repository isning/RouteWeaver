import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: /published-route-path\.ui\.spec\.ts/,
  timeout: 45000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  outputDir: process.env.RETARGET_BROWSER_OUTPUT,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4173",
    trace: "off",
    screenshot: "off",
    launchOptions: {
      chromiumSandbox: true,
      executablePath: process.env.ROUTEWEAVER_CHROMIUM,
    },
  },
});
