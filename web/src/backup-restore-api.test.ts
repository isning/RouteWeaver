import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APIError,
  BackupRestoreError,
  installSessionTransport,
  restoreArchive,
} from "./api";
const target = `restore_${"a".repeat(43)}.db`;
const success = { status: "restored", target, activated: false };
const json = (body: unknown, status = 201) =>
  new Response(JSON.stringify(body), { status });
const archive = () => new File(["encrypted-fixture"], "backup.age");
afterEach(() => vi.unstubAllGlobals());
describe("restore result contract", () => {
  it("accepts only the exact published result and posts multipart through session transport", async () => {
    const beforeSend = vi.fn();
    const waitForResponse = vi.fn(async () => {});
    const remove = installSessionTransport({
      beforeRequest: () => ({ beforeSend, waitForResponse }),
      failed: vi.fn(),
    });
    const fetch = vi.fn(async () => json(success));
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(
        restoreArchive({ password: "synthetic" }, archive()),
      ).resolves.toEqual(success);
      expect(waitForResponse).toHaveBeenCalledTimes(2);
      const [url, init] = fetch.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe("/api/admin/backups/restore");
      expect(init.credentials).toBe("same-origin");
      expect(init.body).toBeInstanceOf(FormData);
    } finally {
      remove();
    }
  });
  it.each([
    [success, 200],
    [null, 201],
    [{ ...success, status: "ok" }, 201],
    [{ ...success, activated: true }, 201],
    [{ ...success, target: "../restore_a.db" }, 201],
    [{ ...success, target: "restore_a\\x.db" }, 201],
    [{ ...success, target: "" }, 201],
  ])(
    "treats malformed or wrong-status success as unknown (%j, %i)",
    async (body, status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => json(body, Number(status))),
      );
      await expect(restoreArchive({}, archive())).rejects.toMatchObject({
        outcome: "unknown",
      });
    },
  );
  it.each([400, 401, 403, 409, 413, 429])(
    "preserves authoritative %i and cause",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          json({ detail: "authoritative fixture rejection" }, status),
        ),
      );
      await expect(restoreArchive({}, archive())).rejects.toMatchObject({
        status,
        outcome: "not_published",
        message: "authoritative fixture rejection",
      });
    },
  );
  it.each(["not_published", "uncertain"])(
    "validates server outcome %s",
    async (restoreOutcome) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          json(
            {
              detail: "specific result",
              restoreOutcome,
              activated: false,
              ...(restoreOutcome === "uncertain" ? { target } : {}),
            },
            500,
          ),
        ),
      );
      await expect(restoreArchive({}, archive())).rejects.toMatchObject({
        outcome: restoreOutcome,
        message: "specific result",
      });
    },
  );
  it("does not trust invalid outcome fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          { detail: "bad", restoreOutcome: "not_published", activated: true },
          500,
        ),
      ),
    );
    await expect(restoreArchive({}, archive())).rejects.toMatchObject({
      outcome: "unknown",
    });
  });
  it("never exposes an invalid uncertain target", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          {
            detail: "bad target",
            restoreOutcome: "uncertain",
            activated: false,
            target: "../private.db",
          },
          500,
        ),
      ),
    );
    await expect(restoreArchive({}, archive())).rejects.toMatchObject({
      outcome: "unknown",
      target: undefined,
    });
  });
  it("handles transport, truncated JSON and body-read loss as unknown without retry", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("synthetic disconnect"))
      .mockResolvedValueOnce(new Response('{"status":', { status: 201 }))
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => {
          throw new TypeError("synthetic body loss");
        },
      });
    vi.stubGlobal("fetch", fetch);
    for (let i = 0; i < 3; i++)
      await expect(restoreArchive({}, archive())).rejects.toBeInstanceOf(
        BackupRestoreError,
      );
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("preserves a local pre-send authority refusal without submitting", async () => {
    const remove = installSessionTransport({
      beforeRequest: () => {
        throw new APIError("local login required; not sent", 401);
      },
      failed: vi.fn(),
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(restoreArchive({}, archive())).rejects.toMatchObject({
        status: 401,
        outcome: "not_published",
        message: "local login required; not sent",
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      remove();
    }
  });
  it("rejects a successful response made stale during body reading", async () => {
    const guard = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new APIError("authority changed", 409));
    const remove = installSessionTransport({
      beforeRequest: () => ({ waitForResponse: guard, beforeSend: vi.fn() }),
      failed: vi.fn(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(success)),
    );
    try {
      await expect(restoreArchive({}, archive())).rejects.toMatchObject({
        outcome: "unknown",
      });
    } finally {
      remove();
    }
  });
});

it.each([
  [
    "restore_storage_prepare_failed",
    "无法准备恢复目录。请检查目录权限和可用空间后重试。",
    500,
  ],
  [
    "restore_target_reservation_failed",
    "无法分配恢复目标。请检查恢复目录后重试。",
    500,
  ],
  [
    "restore_publication_failed",
    "未能创建恢复数据库。请检查恢复目录和可用空间后重试。",
    500,
  ],
  [
    "restore_prepublication_cancelled",
    "恢复已停止，尚未创建恢复数据库。请检查备份大小和服务资源后重试。",
    503,
  ],
])(
  "localizes authoritative stage reason %s",
  async (restoreReason, message, status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          {
            detail: "safe server fallback",
            restoreOutcome: "not_published",
            activated: false,
            restoreReason,
          },
          Number(status),
        ),
      ),
    );
    await expect(restoreArchive({}, archive())).rejects.toMatchObject({
      outcome: "not_published",
      message,
    });
  },
);
it.each([
  [403, "not_published", false, "restore_publication_failed", "not_published"],
  [500, "not_published", true, "restore_publication_failed", "unknown"],
  [500, "not_published", false, "constructor", "not_published"],
  [500, "uncertain", false, "restore_publication_failed", "uncertain"],
])(
  "does not overreach reason mapping (%i,%s,%s,%s)",
  async (status, restoreOutcome, activated, restoreReason, outcome) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          {
            detail: "specific server fallback",
            restoreOutcome,
            activated,
            restoreReason,
            target,
          },
          Number(status),
        ),
      ),
    );
    const error = await restoreArchive({}, archive()).catch((error) => error);
    expect(error.outcome).toBe(outcome);
    if (outcome !== "unknown")
      expect(error.message).toBe("specific server fallback");
  },
);
