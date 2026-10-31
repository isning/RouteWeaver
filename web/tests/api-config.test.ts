import { expect, it } from "vitest";
import config from "../playwright.api.config";

it("runs API user tasks directly against the control plane without a browser or Vite server", () => {
  expect(config.use?.baseURL).toBe("http://127.0.0.1:8080");
  expect(config.projects).toEqual([
    { name: "api", testMatch: "**/*.api.spec.ts" },
  ]);
  expect(config.webServer).toHaveLength(1);
  const server = Array.isArray(config.webServer)
    ? config.webServer[0]
    : config.webServer;
  expect(server?.url).toBe("http://127.0.0.1:8080/healthz");
  expect(server?.command).toContain("./cmd/control-plane --demo");
  expect(config.use?.launchOptions).toBeUndefined();
});
