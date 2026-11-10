import { defineConfig } from "@playwright/test";
import shared from "./playwright.config";

// Supplemental review only. Tests own loopback CLIs or a compiled synthetic
// component sampler; do not start the shared demo/Vite servers.
// Focus samples characterize paint, not accessibility acceptance.
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
        "**/focus-components.ui.spec.ts",
      ],
    })),
  workers: 1,
  retries: 0,
  webServer: [],
});
