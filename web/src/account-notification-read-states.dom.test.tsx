// @vitest-environment jsdom
// Entry/session-list and announcement-list HTTP states; no account mutations.
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import App from "./App";
const clients: QueryClient[] = [];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
beforeAll(async () => { await Promise.all([import("./AccountSecurity"), import("./Notifications"), import("./Security")]); });
afterEach(() => {
  cleanup(); clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks(); vi.unstubAllGlobals(); history.replaceState(null, "", "/");
});
it.each([
  { role: "user", required: false, hash: "inbox", title: "消息", endpoint: "/api/me/notifications", empty: "暂无消息" },
  { role: "admin", required: false, hash: "inbox", title: "消息", endpoint: "/api/me/notifications", empty: "暂无消息" },
  { role: "user", required: false, hash: "account-security", title: "账号安全", endpoint: "/api/auth/sessions", empty: "没有有效会话。" },
  { role: "admin", required: false, hash: "account-security", title: "账号安全", endpoint: "/api/auth/sessions", empty: "没有有效会话。" },
  { role: "user", required: true, hash: "subscriptions", title: "账号安全", endpoint: "/api/auth/sessions", empty: "没有有效会话。" },
  { role: "admin", required: false, hash: "notifications", title: "公告与通知", endpoint: "/api/admin/announcements", empty: "暂无公告" },
])("shows $role $hash (password required: $required) loading and recoverable failure before empty", async ({ role, required, hash, title, endpoint, empty }) => {
  history.replaceState(null, "", `/#${hash}`);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  let release!: (response: Response) => void;
  let reads = 0;
  const unexpected: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") { unexpected.push(`${init.method} ${url}`); throw new Error("Read-only case"); }
    if (url === "/api/auth/me") return json({ user: { id: "reader", name: "Reader", role, passwordChangeRequired: required }, csrfToken: "synthetic" });
    if (url === endpoint) {
      reads++;
      if (reads === 1) return new Promise<Response>((resolve) => { release = resolve; });
      return json([]);
    }
    if (url === "/api/admin/accounts") return json([]);
    if (url === "/api/state") return json({ users: [], nodes: [], routes: [], revisions: [], capabilities: [] });
    unexpected.push(url); throw new Error(`Unexpected read ${url}`);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders><App /></UIProviders></QueryClientProvider>);
  const main = await screen.findByRole("main");
  await within(main).findByRole("heading", { name: title, level: 1 });
  const section = hash === "inbox" ? main : within(main).getByRole("heading", { name: endpoint === "/api/auth/sessions" ? "登录会话" : "服务公告" }).closest<HTMLElement>('[data-slot="card"]')!;
  expect(within(section).getByLabelText("正在加载").getAttribute("aria-busy")).toBe("true");
  expect(within(main).queryByText(empty)).toBeNull();
  await act(async () => { release(json({ message: "列表读取暂不可用" }, 503)); });
  await within(main).findByText("列表读取暂不可用");
  expect(within(main).queryByText(empty)).toBeNull();
  await userEvent.click(within(section).getByRole("button", { name: "重试" }));
  await within(main).findByText(empty);
  expect(within(main).queryByText("列表读取暂不可用")).toBeNull();
  if (required) {
    expect(within(main).getByText("请先更换临时密码")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "我的订阅" })).toBeNull();
  }
  expect(reads).toBe(2); expect(unexpected).toEqual([]);
});
