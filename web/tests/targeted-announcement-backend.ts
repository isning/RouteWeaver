import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
import { demoPassword, initialPassword, signInAPI } from "./account-security-backend";

export const recipientName = "同名维护接收人";
export const announcementTitle = "指定账号维护安排";
export const announcementBody = "请在维护结束后检查连接。本公告仅发送给已选择的账号。";
export interface AnnouncementInboxItem {
  eventId: string;
  announcementId: string;
  title: string;
  body: string;
  readAt?: string;
}

// Provision only synthetic identities through normal public invitations. The
// announcement, audience selection and acknowledgement are authored in the UI.
export async function targetedAnnouncementFixture(
  admin: APIRequestContext,
  intended: APIRequestContext,
  excluded: APIRequestContext,
) {
  const session = await signInAPI(admin, "routeweaver", demoPassword);
  const headers = { "X-CSRF-Token": session.csrfToken };
  const accounts = [];
  for (const client of [intended, excluded]) {
    const username = `notice-${randomUUID()}`;
    const invitation = await admin.post("/api/invites", {
      headers,
      data: { name: recipientName, role: "user", expiresInHours: 1 },
    });
    expect(invitation.status()).toBe(201);
    const accepted = await client.post("/api/auth/accept-invite", {
      data: { token: (await invitation.json()).token, username, password: initialPassword },
    });
    expect(accepted.ok()).toBe(true);
    const { user } = await accepted.json();
    expect(user.id.length).toBeLessThanOrEqual(64);
    accounts.push({ id: user.id as string, username, name: recipientName });
  }
  expect(accounts[0].id).not.toBe(accounts[1].id);
  const settings = await (await admin.get("/api/admin/notification-settings")).json();
  expect(settings.email.enabled).toBe(false);
  expect(settings.webhook.enabled).toBe(false);
  expect(settings.email.automatic).toBe(false);
  expect(settings.webhook.automatic).toBe(false);
  const inbox = async (client: APIRequestContext): Promise<AnnouncementInboxItem[]> => {
    const response = await client.get("/api/me/notifications");
    expect(response.status()).toBe(200);
    return response.json();
  };
  const announcements = async () => {
    const response = await admin.get("/api/admin/announcements");
    expect(response.status()).toBe(200);
    return response.json();
  };
  return { intended: accounts[0], excluded: accounts[1], inbox, announcements };
}
