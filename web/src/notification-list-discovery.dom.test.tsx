// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { NotificationsAdminPage } from "./Notifications";
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); });
const notice = { id: "maintenance", title: "维护安排", body: "周末", audience: "all", userIds: [], enabled: true, startsAt: "2026-11-01T00:00:00Z", expiresAt: "2027-01-01T00:00:00Z" };
function mount() {
  const unexpected: string[] = [];
  const data: Record<string, unknown> = {
    "/api/state": { users: [] },
    "/api/admin/announcements": [notice, { ...notice, id: "admin", title: "管理员提示", body: "凭据轮换", audience: "admins" }],
    "/api/admin/notifications/outbox": [
      { eventId: "email", title: "额度提醒", channel: "email", status: "accepted", attempts: 1, createdAt: "2026-11-16T10:00:00Z" },
      { eventId: "other", title: "其他渠道记录", channel: "future-channel", status: "accepted", attempts: 1, createdAt: "2026-11-16T10:00:00Z" },
      { eventId: "hook", title: "Webhook 测试", channel: "webhook", status: "failed", attempts: 3, createdAt: "2026-11-16T10:00:00Z" },
    ],
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if ((init?.method && init.method !== "GET") || !Object.hasOwn(data, url)) { unexpected.push(url); throw new Error("Unexpected request"); }
    return new Response(JSON.stringify(data[url]), { headers: { "Content-Type": "application/json" } });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders><NotificationsAdminPage /></UIProviders></QueryClientProvider>);
  return unexpected;
}
it("combines announcement audience and content search, then restores all rows without writes", async () => {
  const unexpected = mount();
  await screen.findByRole("cell", { name: "维护安排" });
  const tools = screen.getByRole("search", { name: "查找公告" });
  const search = within(tools).getByRole("searchbox", { name: "搜索公告" });
  await userEvent.click(within(tools).getByRole("button", { name: "管理员" }));
  expect(screen.queryByRole("cell", { name: "维护安排" })).toBeNull();
  await userEvent.type(search, "凭据");
  expect(screen.getByRole("cell", { name: "管理员提示" })).toBeTruthy();
  await userEvent.type(search, "不存在");
  await userEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  expect(screen.getByRole("cell", { name: "维护安排" })).toBeTruthy();
  expect(document.activeElement).toBe(search);
  expect(unexpected).toEqual([]);
});
it("combines delivery channel and title search without issuing delivery requests", async () => {
  const unexpected = mount();
  await userEvent.click(screen.getByRole("tab", { name: "发送记录" }));
  await screen.findByText("额度提醒");
  expect(screen.getByText(/已加载/)).toBeTruthy();
  const tools = screen.getByRole("search", { name: "查找发送记录" });
  const search = within(tools).getByRole("searchbox", { name: "搜索发送记录" });
  await userEvent.click(within(tools).getByRole("button", { name: "Webhook" }));
  expect(screen.queryByText("额度提醒")).toBeNull();
  expect(screen.queryByText("其他渠道记录")).toBeNull();
  await userEvent.type(search, "不存在");
  expect(screen.getByText("没有匹配的发送记录")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  expect(screen.getByText("额度提醒")).toBeTruthy();
  expect(screen.getByText("其他渠道记录")).toBeTruthy();
  expect(document.activeElement).toBe(search);
  expect(unexpected).toEqual([]);
});
