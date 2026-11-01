import { defineConfig } from "@playwright/test";
import shared from "./playwright.config";

// The test-owned normal CLIs serve their compiled UI. No shared demo/Vite server.
export default defineConfig({
  ...shared,
  projects: shared.projects!.map((project) => ({
    ...project,
    testMatch: `**/backup-restore-backend.${project.name === "api" ? "api" : "ui"}.spec.ts`,
  })),
  webServer: [],
});
