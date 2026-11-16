// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { InboxPage } from "./Notifications";
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); });
it("finds unread messages by title or body and recovers from no matches without marking anything read", async () => {
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") { writes.push(url); throw new Error("Unexpected write"); }
    if (url !== "/api/me/notifications") throw new Error(`Unexpected read ${url}`);
    return new Response(JSON.stringify([
      { eventId: "old", title: "维护安排", body: "周末维护", createdAt: "2026-11-15T10:00:00Z", readAt: "2026-11-15T11:00:00Z" },
      { eventId: "quota", title: "额度提醒", body: "流量已使用 80%", createdAt: "2026-11-16T10:00:00Z" },
      { eventId: "expiry", title: "服务到期", body: "续期安排", createdAt: "2026-11-16T09:00:00Z" },
    ]), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders><InboxPage /></UIProviders></QueryClientProvider>);
  await screen.findByRole("button", { name: /维护安排/ });
  const toolbar = screen.getByRole("search", { name: "筛选消息" });
  await userEvent.click(within(toolbar).getByRole("button", { name: "未读 2" }));
  expect(screen.queryByRole("button", { name: /维护安排/ })).toBeNull();
  const search = within(toolbar).getByRole("searchbox", { name: "搜索消息" });
  await userEvent.type(search, "80%");
  expect(screen.getByRole("button", { name: /额度提醒/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /服务到期/ })).toBeNull();
  await userEvent.clear(search); await userEvent.type(search, "不存在");
  expect(screen.getByRole("heading", { name: "没有匹配的消息" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  expect(screen.getByRole("button", { name: /维护安排/ })).toBeTruthy();
  expect(document.activeElement).toBe(search);
  expect(writes).toEqual([]);
});
