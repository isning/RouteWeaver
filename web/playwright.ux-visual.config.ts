import { defineConfig } from "@playwright/test";
import shared from "./playwright.config";

// Supplemental review only. Each selected test owns its normal loopback CLI
// and compiled production UI; do not start the shared demo/Vite servers.
export default defineConfig({
  ...shared,
  projects: shared.projects!
    .filter((project) => project.name === "chromium")
    .map((project) => ({
      ...project,
      testMatch: [
        "**/server-path-workspace.ui.spec.ts",
        "**/forwarding-setup-backend.ui.spec.ts",
        "**/invitation-subscription.ui.spec.ts",
        "**/service-focus-paint.ui.spec.ts",
      ],
    })),
  workers: 1,
  retries: 0,
  webServer: [],
});
