import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";

export const backupPassword = "synthetic-ops01-backup-passphrase";
export function requireBackupLoopback(baseURL: string | undefined) {
  if (
    !baseURL ||
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)
  )
    throw new Error("Backup journeys require an isolated loopback test server");
}
export async function backupSession(client: APIRequestContext) {
  const me = await client.get("/api/auth/me");
  expect(me.status()).toBe(200);
  return { "X-CSRF-Token": (await me.json()).csrfToken as string };
}
export async function seedBackupSentinel(
  client: APIRequestContext,
  headers: Record<string, string>,
) {
  const id = `backup-${randomUUID()}`;
  const source = {
    id,
    name: "Before backup",
    kind: "text",
    enabled: true,
    content: "socks5://synthetic.example.test:1080#Backup sentinel",
  };
  const created = await client.post("/api/me/sources", {
    headers,
    data: source,
  });
  expect(created.status()).toBe(200);
  return {
    async expectRestoredState(client: APIRequestContext) {
      // This new context has no cookies; restored CLI receives no bootstrap login.
      const login = await client.post("/api/auth/login", {
        data: { username: "routeweaver", password: "local-demo-password" },
      });
      expect(login.status()).toBe(200);
      expect((await login.json()).user.id).toBe("admin");
      const response = await client.get(`/api/me/sources/${id}/reveal`);
      expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject(source);
    },
    async changeAfterBackup() {
      const response = await client.put(`/api/me/sources/${id}`, {
        headers,
        data: { ...source, name: "Live change after backup" },
      });
      expect(response.ok()).toBe(true);
    },
    async expectLiveUnchanged() {
      const response = await client.get(`/api/me/sources/${id}`);
      expect(response.status()).toBe(200);
      expect((await response.json()).name).toBe("Live change after backup");
    },
  };
}
export function archiveUpload(bytes: Buffer, metadata: Record<string, string>) {
  return {
    metadata: JSON.stringify(metadata),
    archive: {
      name: "synthetic-backup.age",
      mimeType: "application/octet-stream",
      buffer: bytes,
    },
  };
}
export function expectFreshRestore(result: {
  status: string;
  activated: boolean;
  target: string;
}) {
  expect(result.status).toBe("restored");
  expect(result.activated).toBe(false);
  expect(result.target).toMatch(/^restore_[A-Za-z0-9_-]+\.db$/);
}
