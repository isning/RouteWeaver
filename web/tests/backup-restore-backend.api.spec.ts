import { request as createRequest } from "@playwright/test";
import { test, expect } from "./isolated-control-plane-fixture";
import {
  archiveUpload,
  backupPassword,
  backupSession,
  expectFreshRestore,
  requireBackupLoopback,
  seedBackupSentinel,
} from "./backup-restore-backend";

test("OPS01 real encrypted archive restores only to a fresh inactive database", async ({
  request,
  isolatedControlPlane,
}) => {
  requireBackupLoopback(isolatedControlPlane.url);
  const ui = await request.get("/");
  expect(ui.status()).toBe(200);
  expect(ui.headers()["content-type"]).toContain("text/html");
  const asset = (await ui.text()).match(/src="([^"]+\.js)"/);
  expect(asset).not.toBeNull();
  expect((await request.get(asset![1])).status()).toBe(200);
  const login = await request.post("/api/auth/login", {
    data: { username: "routeweaver", password: "local-demo-password" },
  });
  expect(login.status()).toBe(200);
  const headers = await backupSession(request);
  const sentinel = await seedBackupSentinel(request, headers);
  const download = await request.post("/api/admin/backups", {
    headers,
    data: { password: backupPassword },
  });
  expect(download.status()).toBe(200);
  expect(download.headers()["content-type"]).toContain(
    "application/octet-stream",
  );
  expect(download.headers()["cache-control"]).toBe("no-store");
  const bytes = await download.body();
  expect(bytes.subarray(0, 30).toString()).toContain("age-encryption.org");
  await sentinel.changeAfterBackup();
  const wrong = await request.post("/api/admin/backups/preview", {
    headers,
    multipart: archiveUpload(bytes, { password: "wrong-synthetic-passphrase" }),
  });
  expect(wrong.status()).toBe(400);
  const preview = await request.post("/api/admin/backups/preview", {
    headers,
    multipart: archiveUpload(bytes, { password: backupPassword }),
  });
  expect(preview.status()).toBe(200);
  const body = await preview.json();
  expect(body.restoreAvailable).toBe(true);
  expect(body.impact).toMatchObject({
    mode: "fresh-target",
    replacesLiveStore: false,
    requiresRestart: true,
  });
  const metadata = { password: backupPassword, digest: body.digest };
  const unconfirmed = await request.post("/api/admin/backups/restore", {
    headers,
    multipart: archiveUpload(bytes, metadata),
  });
  expect(unconfirmed.status()).toBe(400);
  const stale = await request.post("/api/admin/backups/restore", {
    headers,
    multipart: archiveUpload(bytes, {
      ...metadata,
      digest: "not-the-reviewed-archive",
      confirmation: "RESTORE TO NEW STORE",
    }),
  });
  expect(stale.status()).toBe(409);
  await sentinel.expectLiveUnchanged();
  const confirmed = { ...metadata, confirmation: "RESTORE TO NEW STORE" };
  const restored = await request.post("/api/admin/backups/restore", {
    headers,
    multipart: archiveUpload(bytes, confirmed),
  });
  expect(restored.status()).toBe(201);
  const result = await restored.json();
  expectFreshRestore(result);
  const target = await isolatedControlPlane.restore(result.target);
  const reader = await createRequest.newContext({ baseURL: target.url });
  try {
    await sentinel.expectRestoredState(reader);
  } finally {
    await reader.dispose();
  }
  await sentinel.expectLiveUnchanged();
  const replay = await request.post("/api/admin/backups/restore", {
    headers,
    multipart: archiveUpload(bytes, confirmed),
  });
  expect(replay.status()).toBe(409);
  await sentinel.expectLiveUnchanged();
});
