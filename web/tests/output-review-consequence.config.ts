import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch:
    /(?:output-review-consequence|output-recovery|rotation-owner-recovery)\.ui\.spec\.ts/,
  timeout: 45000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  outputDir: process.env.CONSEQUENCE_BROWSER_OUTPUT,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4273",
    trace: "off",
    screenshot: "off",
    video: "off",
    launchOptions: {
      chromiumSandbox: true,
      executablePath: process.env.ROUTEWEAVER_CHROMIUM,
    },
  },
});
