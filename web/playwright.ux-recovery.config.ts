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
        "**/admin-policy-inventory-recovery.ui.spec.ts",
        "**/announcement-list-recovery.ui.spec.ts",
        "**/server-json-recovery.ui.spec.ts",
        "**/workspace-return.ui.spec.ts",
        "**/notification-channel-journey.ui.spec.ts",
        "**/template-target-identity.ui.spec.ts",
        "**/admin-validation-recovery.ui.spec.ts",
        "**/admin-validation-order.ui.spec.ts",
        "**/compact-choice-keyboard.ui.spec.ts",
        "**/multi-choice-reopening.ui.spec.ts",
        "**/fleet-request-recovery.ui.spec.ts",
        "**/group-access-decision.ui.spec.ts",
        "**/route-inventory-recovery.ui.spec.ts",
        "**/admin-settings-isolation.ui.spec.ts",
        "**/entry-route-identity.ui.spec.ts",
        "**/route-account-identity.ui.spec.ts",
        "**/backup-tab-continuity.ui.spec.ts",
        "**/profile-read-recovery.ui.spec.ts",
        "**/users-inventory-read-recovery.ui.spec.ts",
        "**/initial-resource-read-recovery.ui.spec.ts",
        "**/resource-source-inventory-recovery.ui.spec.ts",
        "**/group-priority-draft-continuity.ui.spec.ts",
        "**/usage-reset-ownership.ui.spec.ts",
        "**/diagnostic-target-submit-focus.ui.spec.ts",
      ],
    })),
  workers: 1,
  retries: 0,
});
