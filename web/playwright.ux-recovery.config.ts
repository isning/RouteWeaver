import { defineConfig } from "@playwright/test";
import shared from "./playwright.config";

// Supplemental recovery feedback only; required full discovery is unchanged.
// Keep shared demo/Vite servers for workspace-return and the admin UI fixtures.
// Isolated specs still own their normal CLI instances and synthetic databases.
export default defineConfig({
  ...shared,
  projects: shared.projects!
    .filter((project) => project.name === "chromium")
    .map((project) => ({
      ...project,
      testMatch: [
        "**/server-json-recovery.ui.spec.ts",
        "**/workspace-return.ui.spec.ts",
        "**/notification-channel-journey.ui.spec.ts",
        "**/template-target-identity.ui.spec.ts",
        "**/admin-validation-recovery.ui.spec.ts",
        "**/admin-validation-order.ui.spec.ts",
        "**/compact-choice-keyboard.ui.spec.ts",
        "**/multi-choice-reopening.ui.spec.ts",
      ],
    })),
  workers: 1,
  retries: 0,
});
