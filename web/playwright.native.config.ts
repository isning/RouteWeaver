import { defineConfig, devices } from "@playwright/test";

// Explicit separate gate. Ordinary UI/API suites never silently skip native work.
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.native.spec.ts",
  timeout: 90000,
  workers: 1,
  fullyParallel: false,
  outputDir: "test-results-native",
  reporter: [
    ["list"],
    ["json", { outputFile: "../bin/verification/browser-native-results.json" }],
  ],
  use: {
    ...devices["Desktop Chrome"],
    trace: "off",
    screenshot: "off",
    video: "off",
    launchOptions: {
      chromiumSandbox: true,
      ...(process.env.ROUTEWEAVER_CHROMIUM
        ? { executablePath: process.env.ROUTEWEAVER_CHROMIUM }
        : {}),
    },
  },
  webServer: [],
});
