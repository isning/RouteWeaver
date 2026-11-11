import { defineConfig } from "@playwright/test";
import shared from "./playwright.config";
export default defineConfig({
  ...shared,
  projects: shared
    .projects!.filter((project) => project.name === "chromium")
    .map((project) => ({
      ...project,
      testMatch: "**/route-sheet-sample.ui.spec.ts",
    })),
  workers: 1,
  retries: 0,
  webServer: [],
});
