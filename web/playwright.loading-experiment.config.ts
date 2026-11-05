import { defineConfig, devices } from "@playwright/test";

// Explicit diagnostic entry point only. No default browser-gate match or live host.
export default defineConfig({
  testDir: "./tests",
  testMatch: "console-loading-experiment.spec.ts",
  timeout: 120000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: "../bin/verification/loading-experiment-report",
        open: "never",
      },
    ],
  ],
  outputDir: "../bin/verification/loading-experiment-results",
  use: {
    ...devices["Desktop Chrome"],
    trace: "off",
    screenshot: "off",
    launchOptions: {
      chromiumSandbox: true,
      ...(process.env.ROUTEWEAVER_CHROMIUM
        ? { executablePath: process.env.ROUTEWEAVER_CHROMIUM }
        : {}),
    },
  },
});
