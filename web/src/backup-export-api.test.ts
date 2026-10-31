import { afterEach, expect, it, vi } from "vitest";
import { requestFile } from "./api";

const deadlineMessage =
  "备份创建超时。请检查服务资源和备份时限后重新创建。";
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
afterEach(() => vi.unstubAllGlobals());

it("localizes the authoritative backup export deadline result", async () => {
  const details = {
    reason: "backup_export_deadline_exceeded",
    detail: "Backup creation reached the configured time limit.",
  };
  const fetch = vi.fn(async () => json(details, 503));
  vi.stubGlobal("fetch", fetch);
  await expect(
    requestFile("/admin/backups", { password: "synthetic-backup-password" }),
  ).rejects.toMatchObject({ status: 503, message: deadlineMessage, details });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
  ["/admin/backups/preview", 503, "backup_export_deadline_exceeded"],
  ["/admin/backups/restore", 503, "backup_export_deadline_exceeded"],
  ["/admin/backups?other", 503, "backup_export_deadline_exceeded"],
  ["/admin/backups", 400, "backup_export_deadline_exceeded"],
  ["/admin/backups", 401, "backup_export_deadline_exceeded"],
  ["/admin/backups", 403, "backup_export_deadline_exceeded"],
  ["/admin/backups", 429, "backup_export_deadline_exceeded"],
  ["/admin/backups", 503, "unknown_reason"],
  ["/admin/backups", 503, null],
])(
  "preserves the fallback for path %s, status %i, reason %s",
  async (path, status, reason) => {
    const details = { reason, detail: "specific server rejection" };
    vi.stubGlobal("fetch", vi.fn(async () => json(details, Number(status))));
    await expect(requestFile(String(path), {})).rejects.toMatchObject({
      status,
      message: "specific server rejection",
      details,
    });
  },
);

it("keeps the ordinary malformed-response fallback", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("not JSON", { status: 503 })));
  await expect(requestFile("/admin/backups", {})).rejects.toMatchObject({
    status: 503,
    message: "请求失败 (503)，请重试。",
  });
});

it("does not translate transport loss into a received deadline result", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("synthetic EOF"); }));
  await expect(requestFile("/admin/backups", {})).rejects.toMatchObject({
    status: 0,
    message: "无法连接服务。请检查网络后重试，当前输入已保留。",
  });
});

it("preserves a successful encrypted download", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("encrypted fixture", {
    status: 200,
    headers: { "Content-Type": "application/octet-stream" },
  })));
  const file = await requestFile("/admin/backups", {});
  expect(await file.text()).toBe("encrypted fixture");
});
