import { afterEach, expect, it, vi } from "vitest";
import { postArchive } from "./api";

const previewPath = "/admin/backups/preview";
const reason = "backup_archive_unverified";
const recovery = "备份无法验证。请核对密码，并确认文件完整后重试。";
const archive = () => new File(["synthetic encrypted fixture"], "backup.age");
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
afterEach(() => vi.unstubAllGlobals());

it("gives actionable recovery without deciding whether the password or archive is wrong", async () => {
  const details = {
    reason,
    detail: "backup cannot be authenticated or is incomplete; check the passphrase and file",
  };
  const fetch = vi.fn(async () => json(details, 400));
  vi.stubGlobal("fetch", fetch);
  await expect(postArchive(previewPath, { password: "synthetic-password" }, archive()))
    .rejects.toMatchObject({ status: 400, message: recovery, details });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
  ["/admin/backups", 400, reason],
  ["/admin/backups/restore", 400, reason],
  ["/admin/backups/preview?other", 400, reason],
  [previewPath, 401, reason],
  [previewPath, 403, reason],
  [previewPath, 409, reason],
  [previewPath, 413, reason],
  [previewPath, 429, reason],
  [previewPath, 500, reason],
  [previewPath, 400, "unknown_reason"],
  [previewPath, 400, null],
])("preserves other failures for %s, status %i, reason %s", async (path, status, code) => {
  const details = { reason: code, detail: "specific server rejection" };
  vi.stubGlobal("fetch", vi.fn(async () => json(details, Number(status))));
  await expect(postArchive(String(path), {}, archive())).rejects.toMatchObject({
    status, message: "specific server rejection", details,
  });
});

it("keeps malformed-response and transport-loss recovery separate from archive rejection", async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response("not JSON", { status: 400 }))
    .mockRejectedValueOnce(new TypeError("synthetic disconnect"));
  vi.stubGlobal("fetch", fetch);
  await expect(postArchive(previewPath, {}, archive())).rejects.toMatchObject({
    status: 400, message: "请求失败 (400)，请重试。",
  });
  await expect(postArchive(previewPath, {}, archive())).rejects.toMatchObject({
    status: 0, message: "无法连接服务。请检查网络后重试，当前输入已保留。",
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("retains a successful inspection and its ordered multipart archive", async () => {
  const preview = { digest: "inspected-archive", restoreAvailable: true };
  let sent: RequestInit | undefined;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    sent = init;
    return json(preview, 200);
  }));
  const file = archive();
  await expect(postArchive(previewPath, { password: "synthetic-password" }, file))
    .resolves.toEqual(preview);
  expect(sent?.body).toBeInstanceOf(FormData);
  const body = sent!.body as FormData;
  expect(Array.from(body.keys())).toEqual(["metadata", "archive"]);
  expect(body.get("metadata")).toBe('{"password":"synthetic-password"}');
  expect(body.get("archive")).toBe(file);
  expect(new Headers(sent!.headers).has("Content-Type")).toBe(false);
});
