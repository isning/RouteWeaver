import { defineConfig } from "@playwright/test";
import shared from "./playwright.config";

// Test-owned normal loopback CLI and compiled UI; no shared demo or browser for API.
export default defineConfig({
  ...shared,
  projects: shared.projects!.map((project) => ({
    ...project,
    testMatch: `**/service-center-backend.${project.name === "api" ? "api" : "ui"}.spec.ts`,
  })),
  webServer: [],
});
