import { defineConfig, devices } from "@playwright/test";

// Explicit isolated visual diagnostic. It is not part of the ordinary gate,
// starts no backend, and the spec intercepts all API/external requests.
export default defineConfig({
  testDir: "./tests",
  testMatch: "resource-layout-experiment.spec.ts",
  timeout: 45000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: "../bin/verification/resource-layout-report",
        open: "never",
      },
    ],
    [
      "json",
      { outputFile: "../bin/verification/resource-layout-results.json" },
    ],
  ],
  outputDir: "../bin/verification/resource-layout-results",
  use: {
    ...devices["Desktop Chrome"],
    serviceWorkers: "block",
    trace: "off",
    video: "off",
    screenshot: "off",
    launchOptions: {
      chromiumSandbox: true,
      ...(process.env.ROUTEWEAVER_CHROMIUM
        ? { executablePath: process.env.ROUTEWEAVER_CHROMIUM }
        : {}),
    },
  },
  projects: [
    { name: "baseline", use: { baseURL: "http://127.0.0.1:4181" } },
    { name: "proposal", use: { baseURL: "http://127.0.0.1:4182" } },
  ],
  webServer: ["baseline", "proposal"].map((mode, index) => ({
    command: `ROUTEWEAVER_RESOURCE_LAYOUT=${mode} node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${4181 + index} --strictPort --config tests/resource-layout-experiment.vite.ts`,
    url: `http://127.0.0.1:${4181 + index}`,
    reuseExistingServer: false,
    timeout: 60000,
  })),
});
