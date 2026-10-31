import {
  defineConfig,
  devices,
  type PlaywrightTestConfig,
} from "@playwright/test";

export const controlPlaneServer: Exclude<
  PlaywrightTestConfig["webServer"],
  unknown[] | undefined
> = {
  command:
    "../scripts/go.sh run ./cmd/control-plane --demo --listen 127.0.0.1:8080",
  url: "http://127.0.0.1:8080/healthz",
  // Let the demo process remove its synthetic database on shutdown.
  gracefulShutdown: { signal: "SIGTERM", timeout: 15000 },
  reuseExistingServer: !process.env.CI,
  timeout: 120000,
};

export default defineConfig({
  testDir: "./tests",
  timeout: 45000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "off",
    screenshot: "off",
  },
  projects: [
    { name: "api", testMatch: "**/*.api.spec.ts" },
    {
      name: "chromium",
      testMatch: "**/*.ui.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          chromiumSandbox: true,
          ...(process.env.ROUTEWEAVER_CHROMIUM
            ? { executablePath: process.env.ROUTEWEAVER_CHROMIUM }
            : {}),
        },
      },
    },
  ],
  webServer: [
    controlPlaneServer,
    {
      // Use the installed Vite binary; browser QA needs no package-manager network.
      command:
        "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4173",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
  ],
});
