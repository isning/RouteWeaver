// @vitest-environment jsdom
// Finite secondary-query cases through the real workspace; synthetic HTTP only.
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import App from "./App";
const clients: QueryClient[] = [];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const inventory = { users: [], nodes: [], routes: [], revisions: [], capabilities: [] };
beforeAll(async () => { await Promise.all([import("./AccountSecurity"), import("./Notifications"), import("./Admin")]); });
afterEach(() => {
  cleanup(); clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks(); vi.unstubAllGlobals(); history.replaceState(null, "", "/");
});
function mountRead(hash: string, endpoint: string, result: unknown, role = "admin") {
  history.replaceState(null, "", `/#${hash}`);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const state = { reads: 0, result, status: 200, unexpected: [] as string[] };
  let release!: (response: Response) => void;
  const responses: Record<string, unknown> = {
    "/api/auth/me": { user: { id: "reader", name: "Reader", role }, csrfToken: "synthetic" },
    "/api/auth/sessions": [], "/api/admin/accounts": [], "/api/state": inventory,
    "/api/services": [], "/api/settings": {}, "/api/published-routes": [], "/api/audit": [],
    "/api/admin/announcements": [], "/api/me/profiles": [], "/api/me/outputs": [],
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") { state.unexpected.push(`${init.method} ${url}`); throw new Error("Read-only case"); }
    if (url === endpoint) {
      state.reads++;
      if (state.reads === 1) return new Promise<Response>((resolve) => { release = resolve; });
      return json(state.result, state.status);
    }
    if (Object.hasOwn(responses, url)) return json(responses[url]);
    state.unexpected.push(url); throw new Error(`Unexpected secondary read ${url}`);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders><App /></UIProviders></QueryClientProvider>);
  return { state, client, fail: async () => { await act(async () => { release(json({ message: "所选列表暂不可用" }, 503)); }); } };
}

it.each([
  { hash: "account-security", endpoint: "/api/admin/accounts", section: "账号恢复与退役", empty: "没有账号记录。", result: [{ id: "recovered", name: "Recovered account", username: "recovered", role: "user", disabled: false, retired: false }], visible: "Recovered account", tab: "" },
  { hash: "activity", endpoint: "/api/audit", section: "操作审计", empty: "暂无管理操作记录", result: [{ id: "audit-1", actorId: "admin", action: "invite.created", targetId: "invite-recovered", at: "2026-11-01T10:00:00Z" }], visible: "invite-recovered", tab: "" },
  { hash: "notifications", endpoint: "/api/admin/notifications/outbox", section: "通知发送记录", empty: "暂无发送记录", result: [{ eventId: "delivery-1", title: "Recovered delivery", channel: "email", status: "failed", attempts: 1, lastError: "SMTP unavailable", createdAt: "2026-11-01T10:00:00Z" }], visible: "Recovered delivery", tab: "发送记录" },
])("recovers the $section secondary list without presenting pending or failed reads as empty", async ({ hash, endpoint, section, empty, result, visible, tab }) => {
  const task = mountRead(hash, endpoint, result);
  const main = await screen.findByRole("main");
  if (tab) await userEvent.click(await within(main).findByRole("tab", { name: tab }));
  const heading = await within(main).findByRole("heading", { name: section });
  const container = heading.closest<HTMLElement>('section, [data-slot="card"]');
  expect(container).not.toBeNull();
  const region = within(container!);
  expect(region.getByLabelText("正在加载").getAttribute("aria-busy")).toBe("true");
  expect(region.queryByText(empty)).toBeNull();
  await task.fail();
  await region.findByText("所选列表暂不可用");
  expect(region.queryByText(empty)).toBeNull();
  await userEvent.click(region.getByRole("button", { name: "重试" }));
  await region.findByText(visible);
  expect(region.queryByText("所选列表暂不可用")).toBeNull();
  expect(task.state.reads).toBe(2); expect(task.state.unexpected).toEqual([]);
});

const channels = {
  revision: 1, inApp: true, quotaPercent: [80], expiryHours: [24], providerRemainingPercent: [20], repeatHours: 24,
  email: { enabled: false, automatic: false, host: "smtp.example", port: 587, tlsMode: "starttls", username: "", from: "sender@example.test", to: ["owner@example.test"] },
  webhook: { enabled: false, automatic: false, url: "https://example.test/webhook" }, smtpPasswordSet: true, webhookSecretSet: true,
};
it("does not offer invented notification settings during loading or failure and retries to authoritative configuration", async () => {
  const task = mountRead("notifications", "/api/admin/notification-settings", channels);
  const main = await screen.findByRole("main");
  await userEvent.click(await within(main).findByRole("tab", { name: "提醒与渠道" }));
  const panel = await within(main).findByRole("tabpanel", { name: "提醒与渠道" });
  expect(within(panel).getByLabelText("正在加载").getAttribute("aria-busy")).toBe("true");
  expect(within(panel).queryByLabelText("同类提醒最短间隔（小时）")).toBeNull();
  await task.fail();
  await within(panel).findByText("所选列表暂不可用");
  expect(within(panel).queryByLabelText("同类提醒最短间隔（小时）")).toBeNull();
  await userEvent.click(within(panel).getByRole("button", { name: "重试" }));
  const interval = await within(panel).findByLabelText("同类提醒最短间隔（小时）");
  expect((interval as HTMLInputElement).value).toBe("24");
  expect(task.state.reads).toBe(2);
  expect(task.state.unexpected).toEqual([]);
});

it.each(["user", "admin"])("keeps %s service overview unknown until its own read succeeds without hiding independent empty subscriptions", async (role) => {
  const task = mountRead("subscriptions", "/api/me/overview", { user: { id: "reader", name: "Reader" }, status: "paused", quotaBytes: 1024, usage: { rawBytes: 128, weightedBytes: 256 }, routes: [] }, role);
  const main = await screen.findByRole("main");
  await within(main).findByText("暂无订阅");
  expect(within(main).getByLabelText("正在加载").getAttribute("aria-busy")).toBe("true");
  expect(within(main).queryByText("不限额")).toBeNull();
  expect(within(main).queryByRole("heading", { name: "平台服务用量" })).toBeNull();
  await task.fail();
  await within(main).findByText("所选列表暂不可用");
  expect(within(main).getByText("暂无订阅")).toBeTruthy();
  expect(within(main).queryByText("不限额")).toBeNull();
  await userEvent.click(within(main).getByRole("button", { name: "重试" }));
  await within(main).findByRole("heading", { name: "平台服务用量" });
  expect(within(main).getByText("平台服务已暂停")).toBeTruthy();
  expect(within(main).getByText("暂无订阅")).toBeTruthy();
  expect(task.state.reads).toBe(2); expect(task.state.unexpected).toEqual([]);
});
