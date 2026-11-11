import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  test as browserTest,
  type Page,
  type TestInfo,
} from "@playwright/test";
import {
  waitForConfirmedWorkspace,
  WORKSPACE_SETUP_TIMEOUT_MS,
} from "./ui-workspace-confirmation";
vi.mock("@playwright/test", () => ({ test: { info: vi.fn() } }));

test.each(["normal-ui-login", "cold-workspace"] as const)(
  "%s terminal error is persisted without another wait or retry",
  async (phase) => {
    const directory = await mkdtemp(join(tmpdir(), "rw-confirmation-"));
    const attach = vi.fn(async () => {});
    vi.mocked(browserTest.info).mockReturnValue({
      outputPath: (name: string) => join(directory, name),
      attach,
    } as unknown as TestInfo);
    const dispose = vi.fn(async () => {});
    const waitForFunction = vi.fn(async () => ({
      jsonValue: async () => "session-error",
      dispose,
    }));
    try {
      await expect(
        waitForConfirmedWorkspace(
          { waitForFunction } as unknown as Page,
          phase,
        ),
      ).rejects.toThrow(
        `Workspace setup (${phase}) stopped at an explicit session-recovery error; no retry was attempted.`,
      );
      expect(waitForFunction).toHaveBeenCalledTimes(1);
      expect(waitForFunction.mock.calls[0]).toHaveLength(3);
      expect(dispose).toHaveBeenCalledTimes(1);
      const result = JSON.parse(
        await readFile(
          join(directory, "session-setup-confirmation-1.json"),
          "utf8",
        ),
      );
      expect(result).toEqual({
        setup: phase,
        outcome: "session-error",
        elapsedMs: expect.any(Number),
        timeoutMs: WORKSPACE_SETUP_TIMEOUT_MS,
      });
      expect(attach).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
