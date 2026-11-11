import { defineConfig } from "@playwright/test";
import shared from "./playwright.config";
export default defineConfig({
  ...shared,
  projects: shared
    .projects!.filter((p) => p.name === "chromium")
    .map((p) => ({ ...p, testMatch: "**/theme.ui.spec.ts" })),
  use: { ...shared.use, baseURL: "http://127.0.0.1:4198" },
  webServer: {
    command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4198",
    url: "http://127.0.0.1:4198",
    reuseExistingServer: false,
  },
});
