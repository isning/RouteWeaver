// @vitest-environment jsdom
// Proposed location: web/src/announcement-list-recovery.dom.test.tsx.
// Agreed seam: public NotificationsAdminPage + HTTP fetch boundary.
// Controlled component/HTTP coverage, not native browser or real delivery evidence.
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { NotificationsAdminPage } from "./Notifications";

const clients: QueryClient[] = [];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const announcement = {
  id: "maintenance", title: "晚间维护安排", body: "维护窗口内请暂缓连接变更。",
  audience: "all", userIds: [], enabled: true,
  startsAt: "2026-11-10T10:00:00Z", expiresAt: "2026-11-20T11:00:00Z",
};
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  onlineManager.setOnline(true);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function mount(readAnnouncements: () => Promise<Response>) {
  const unexpected: string[] = [];
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method || "GET";
    if (method === "GET" && url === "/api/admin/announcements") {
      reads++;
      return readAnnouncements();
    }
    if (method === "GET" && url === "/api/state")
      return json({ users: [], nodes: [], routes: [], revisions: [], capabilities: [] });
    if (method === "GET" && url === "/api/admin/notifications/outbox") return json([]);
    unexpected.push(`${method} ${url}`);
    throw new Error(`Unexpected announcement recovery request: ${method} ${url}`);
  }));
  // Production uses 15s staleTime. Zero makes the same tab-return refetch
  // deterministic without introducing an artificial 15-second user-event wait.
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false },
    mutations: { retry: false },
  } });
  clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders><NotificationsAdminPage /></UIProviders></QueryClientProvider>);
  return { client, unexpected, reads: () => reads };
}

it("retains previously loaded announcement titles and schedules when returning to the tab fails to refresh", async () => {
  let nextRead = false;
  let settle!: (response: Response) => void;
  const state = mount(async () => nextRead
    ? new Promise<Response>(resolve => { settle = resolve; })
    : json([announcement]));
  const user = userEvent.setup();
  await screen.findByRole("cell", { name: "晚间维护安排" });
  const before = screen.getByRole("row", { name: /晚间维护安排/ });
  expect(within(before).getByText("2026/11/10 18:00")).toBeTruthy();
  expect(within(before).getByText("2026/11/20 19:00")).toBeTruthy();
  nextRead = true;
  await user.click(screen.getByRole("tab", { name: "发送记录" }));
  await screen.findByRole("heading", { name: "通知发送记录" });
  await user.click(screen.getByRole("tab", { name: "公告" }));
  await waitFor(() => expect(state.reads()).toBe(2));
  expect(screen.getByRole("cell", { name: "晚间维护安排" })).toBeTruthy();
  await act(async () => { settle(json({ message: "公告列表暂不可用" }, 503)); });
  await screen.findByText("公告列表暂不可用");
  // Expected first red: QueryState currently removes this cached row.
  const retained = screen.getByRole("row", { name: /晚间维护安排/ });
  expect(within(retained).getByText("2026/11/10 18:00")).toBeTruthy();
  expect(within(retained).getByText("2026/11/20 19:00")).toBeTruthy();
  expect(screen.queryByText("暂无公告")).toBeNull();
  expect(state.unexpected).toEqual([]);
});


it("keeps keyboard retry focus, deduplicates requests and starts editing only from recovered data", async () => {
  let hold = false;
  let settle!: (response: Response) => void;
  const state = mount(async () => hold ? new Promise(resolve => { settle = resolve; }) : json([announcement]));
  const user = userEvent.setup();
  await screen.findByRole("cell", { name: announcement.title });
  hold = true;
  const refresh = screen.getByRole("button", { name: "刷新公告" });
  refresh.focus(); await user.keyboard("{Enter}");
  expect((screen.getByRole("button", { name: "编辑" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => settle(json({ message: "读取失败" }, 503)));
  await screen.findByText("读取失败");
  expect((screen.getByRole("button", { name: "编辑" }) as HTMLButtonElement).disabled).toBe(true);
  await user.keyboard("{Enter}{Enter}"); await user.dblClick(refresh);
  expect(state.reads()).toBe(3);
  expect(document.activeElement).toBe(refresh);
  expect(refresh.getAttribute("aria-busy")).toBe("true");
  expect(screen.queryByText("读取失败")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => settle(json([{ ...announcement, title: "更新的维护安排", body: "最新正文" }])));
  await screen.findByRole("cell", { name: "更新的维护安排" });
  expect(document.activeElement).toBe(refresh);
  await user.click(screen.getByRole("button", { name: "编辑" }));
  const dialog = await screen.findByRole("dialog", { name: "编辑公告" });
  expect((within(dialog).getByLabelText("公告正文") as HTMLTextAreaElement).value).toBe("最新正文");
  expect(state.unexpected).toEqual([]);
});

it("keeps initial unknown distinct from a cached empty collection through retry", async () => {
  let settle!: (response: Response) => void;
  const state = mount(() => new Promise(resolve => { settle = resolve; }));
  const user = userEvent.setup();
  expect(screen.queryByText("暂无公告")).toBeNull();
  await act(async () => settle(json({ message: "首次读取失败" }, 503)));
  await screen.findByText("首次读取失败");
  expect(screen.queryByText("暂无公告")).toBeNull();
  await user.click(screen.getByRole("button", { name: "重试" }));
  await act(async () => settle(json([])));
  await screen.findByText("暂无公告");
  await user.click(screen.getByRole("button", { name: "刷新公告" }));
  expect(screen.getByText("暂无公告")).toBeTruthy();
  await act(async () => settle(json({ message: "空列表刷新失败" }, 503)));
  await screen.findByText("空列表刷新失败");
  expect(screen.getByText("暂无公告")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "刷新公告" }));
  expect(screen.queryByText("空列表刷新失败")).toBeNull();
  await act(async () => settle(json([])));
  await waitFor(() => expect(screen.getByRole("button", { name: "刷新公告" }).getAttribute("aria-busy")).not.toBe("true"));
  expect(state.reads()).toBe(4);
  expect(state.unexpected).toEqual([]);
});

it("keeps a paused refresh focusable and resumes one read without allowing stale Edit", async () => {
  let hold = false;
  let settle!: (response: Response) => void;
  const state = mount(async () => hold ? new Promise(resolve => { settle = resolve; }) : json([announcement]));
  const user = userEvent.setup();
  await screen.findByRole("cell", { name: announcement.title });
  hold = true;
  act(() => onlineManager.setOnline(false));
  const refresh = screen.getByRole("button", { name: "刷新公告" });
  refresh.focus(); await user.keyboard("{Enter}{Enter}");
  await screen.findByText(/等待网络连接，仍显示上次读取的公告/);
  expect(state.reads()).toBe(1);
  expect(document.activeElement).toBe(refresh);
  expect((screen.getByRole("button", { name: "编辑" }) as HTMLButtonElement).disabled).toBe(true);
  act(() => onlineManager.setOnline(true));
  await waitFor(() => expect(state.reads()).toBe(2));
  await act(async () => settle(json([announcement])));
  await waitFor(() => expect((screen.getByRole("button", { name: "编辑" }) as HTMLButtonElement).disabled).toBe(false));
  expect(document.activeElement).toBe(refresh);
  expect(state.unexpected).toEqual([]);
});

it.each(["create", "edit"] as const)("preserves a newer %s draft and its focus when a background list read fails", async (mode) => {
  let hold = false;
  let settle!: (response: Response) => void;
  const state = mount(async () => hold ? new Promise(resolve => { settle = resolve; }) : json([announcement]));
  const user = userEvent.setup();
  await screen.findByRole("cell", { name: announcement.title });
  hold = true;
  if (mode === "create") {
    await user.click(screen.getByRole("button", { name: "刷新公告" }));
    await user.click(screen.getByRole("button", { name: "创建公告" }));
  } else {
    await user.click(screen.getByRole("button", { name: "编辑" }));
    act(() => { void state.client.invalidateQueries({ queryKey: ["announcements"] }); });
  }
  const dialog = await screen.findByRole("dialog", { name: mode === "create" ? "创建公告" : "编辑公告" });
  const title = within(dialog).getByLabelText("公告标题") as HTMLInputElement;
  const body = within(dialog).getByLabelText("公告正文") as HTMLTextAreaElement;
  await user.clear(title); await user.type(title, "独立草稿");
  await user.clear(body); await user.type(body, "我正在编辑的正文");
  await act(async () => settle(json({ message: "后台读取失败" }, 503)));
  await screen.findByText("后台读取失败");
  expect(title.value).toBe("独立草稿"); expect(body.value).toBe("我正在编辑的正文");
  expect(document.activeElement).toBe(body);
  expect((within(dialog).getByRole("button", { name: "保存并安排发布" }) as HTMLButtonElement).disabled).toBe(false);
  expect(state.unexpected).toEqual([]);
});
