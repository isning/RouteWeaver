// @vitest-environment jsdom
// Public announcement and inbox views; timestamps come from HTTP fixtures.
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { InboxPage, NotificationsAdminPage } from "./Notifications";
const clients: QueryClient[] = [];
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function mount(page: "inbox" | "announcements", records: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") throw new Error(`Unexpected write: ${url}`);
    if (url === "/api/state") return json({ users: [] });
    if (url === (page === "inbox" ? "/api/me/notifications" : "/api/admin/announcements")) return json(records);
    throw new Error(`Unexpected read: ${url}`);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders>{page === "inbox" ? <InboxPage /> : <NotificationsAdminPage />}</UIProviders></QueryClientProvider>);
}
it("names Beijing time on announcement read columns while the editor still identifies local time", async () => {
  mount("announcements", [{ id: "notice-time", title: "维护时间", body: "维护安排", audience: "all", userIds: [], startsAt: "2026-11-07T10:00:00Z", expiresAt: "2026-11-08T11:00:00Z", enabled: true }]);
  await screen.findByRole("columnheader", { name: "开始时间（北京时间）" });
  expect(screen.getByRole("columnheader", { name: "结束时间（北京时间）" })).toBeTruthy();
  expect(screen.getByRole("cell", { name: "2026/11/07 18:00" })).toBeTruthy();
  expect(screen.getByRole("cell", { name: "2026/11/08 19:00" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "编辑" }));
  const dialog = await screen.findByRole("dialog", { name: "编辑公告" });
  expect(within(dialog).getByLabelText("开始时间（本机时区）")).toBeTruthy();
  expect(within(dialog).getByLabelText("结束时间（本机时区）")).toBeTruthy();
});
it("identifies Beijing time on inbox timestamps and message detail expiry", async () => {
  mount("inbox", [{ eventId: "message-time", title: "维护时间", body: "维护安排", kind: "announcement", createdAt: "2026-11-07T10:00:00Z", expiresAt: "2026-11-08T11:00:00Z", readAt: "2026-11-07T12:00:00Z" }]);
  const message = await screen.findByRole("button", { name: /维护时间.*已读/ });
  expect(within(message).getByText("2026/11/07 18:00（北京时间）")).toBeTruthy();
  expect(message.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-07T10:00:00Z");
  await userEvent.click(message);
  const detail = await screen.findByRole("dialog", { name: "维护时间" });
  expect(within(detail).getByText("2026/11/07 18:00（北京时间）")).toBeTruthy();
  expect(within(detail).getByText("有效至 2026/11/08 19:00（北京时间）")).toBeTruthy();
});
it.each(["0001-01-01T00:00:00Z", "invalid-date"])("does not present an unknown timestamp as a known Beijing time: %s", async createdAt => {
  mount("inbox", [{ eventId: "unknown-time", title: "时间未设置", body: "维护安排", kind: "announcement", createdAt, expiresAt: createdAt, readAt: "2026-11-07T12:00:00Z" }]);
  const message = await screen.findByRole("button", { name: /时间未设置.*已读/ });
  expect(within(message).getByText("未设置")).toBeTruthy();
  expect(message.textContent).not.toContain("北京时间");
  await userEvent.click(message);
  const detail = await screen.findByRole("dialog", { name: "时间未设置" });
  expect(within(detail).getByText("未设置")).toBeTruthy();
  expect(within(detail).getByText("有效至 未设置")).toBeTruthy();
  expect(detail.textContent).not.toContain("北京时间");
});
