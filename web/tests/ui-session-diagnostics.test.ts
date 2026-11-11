import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "vitest";
import {
  diagnosticPayload,
  observeSetupAuth,
  persistSetupDiagnostic,
} from "./ui-session-diagnostics";

test("auth observation only retains operation, normalized method and status and removes listeners", () => {
  const page = new EventEmitter();
  const observation = observeSetupAuth(page as unknown as Page);
  const response = (path: string, method: string, status: number) => ({
    url: () => `http://127.0.0.1${path}?secret=never-record`,
    request: () => ({ method: () => method }),
    status: () => status,
    headers: () => {
      throw Error("must not read headers");
    },
    body: () => {
      throw Error("must not read body");
    },
  });
  page.emit("response", response("/api/auth/login", "POST", 429));
  page.emit("response", response("/api/auth/me", "GET", 401));
  page.emit("response", response("/api/me/outputs", "GET", 200));
  page.emit("requestfailed", {
    url: () => "http://127.0.0.1/api/auth/me",
    method: () => "PRIVATE-METHOD",
  });
  expect(observation.stop()).toEqual([
    { operation: "login", method: "POST", status: 429 },
    { operation: "me", method: "GET", status: 401 },
    { operation: "me", method: "other", status: null },
  ]);
  expect(page.listenerCount("response")).toBe(0);
  expect(page.listenerCount("requestfailed")).toBe(0);
});

test("diagnostics persist before attach, retain repeated stages and omit arbitrary properties", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rw-setup-diagnostics-"));
  const seen: unknown[] = [];
  const info = {
    outputPath: (name: string) => join(directory, name),
    attach: async (_name: string, options: { path?: string }) => {
      seen.push(JSON.parse(await readFile(options.path!, "utf8")));
    },
  } as Pick<TestInfo, "outputPath" | "attach">;
  try {
    const input = {
      kind: "http" as const,
      phase: "cold-workspace" as const,
      events: [
        {
          operation: "me" as const,
          method: "GET" as const,
          status: 503,
          headers: "secret",
        },
      ],
      url: "secret",
      body: "secret",
    };
    await persistSetupDiagnostic(info, input);
    await persistSetupDiagnostic(info, input);
    expect(await readdir(directory)).toEqual([
      "session-setup-cold-workspace-http-1.json",
      "session-setup-cold-workspace-http-2.json",
    ]);
    expect(seen).toEqual(
      Array(2).fill({
        phase: "cold-workspace",
        count: 1,
        events: [{ operation: "me", method: "GET", status: 503 }],
      }),
    );
    expect(JSON.stringify(seen)).not.toContain("secret");
    expect(
      diagnosticPayload({
        kind: "domain",
        worker: 2,
        setup: "reuse-valid-session",
      }),
    ).toEqual({ worker: 2, setup: "reuse-valid-session" });
    expect(
      diagnosticPayload({
        kind: "confirmation",
        phase: "normal-ui-login",
        outcome: "session-error",
        elapsedMs: 40,
        timeoutMs: 18000,
      }),
    ).toEqual({
      setup: "normal-ui-login",
      outcome: "session-error",
      elapsedMs: 40,
      timeoutMs: 18000,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("diagnostic JSON survives attachment failure without retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rw-setup-diagnostics-"));
  let attempts = 0;
  const info = {
    outputPath: (name: string) => join(directory, name),
    attach: async () => {
      attempts++;
      throw Error("reporter unavailable");
    },
  } as Pick<TestInfo, "outputPath" | "attach">;
  try {
    await expect(
      persistSetupDiagnostic(info, {
        kind: "domain",
        worker: 0,
        setup: "normal-ui-login",
      }),
    ).rejects.toThrow("reporter unavailable");
    expect(attempts).toBe(1);
    expect(
      JSON.parse(
        await readFile(join(directory, "session-setup-domain-1.json"), "utf8"),
      ),
    ).toEqual({ worker: 0, setup: "normal-ui-login" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
