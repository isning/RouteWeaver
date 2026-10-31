import { defineConfig } from "@playwright/test";
import shared, { controlPlaneServer } from "./playwright.config";

// API tasks exercise the real control plane directly. They do not need Vite,
// a built frontend, or a browser executable; browser evidence remains separate.
export default defineConfig({
  ...shared,
  use: { ...shared.use, baseURL: "http://127.0.0.1:8080" },
  projects: [{ name: "api", testMatch: "**/*.api.spec.ts" }],
  webServer: [controlPlaneServer],
});
