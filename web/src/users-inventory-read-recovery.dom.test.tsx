// @vitest-environment jsdom
// Real Users page and table; failures injected only at the HTTP boundary.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { AdminPage } from "./Admin";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const clients: QueryClient[] = [];
beforeEach(() => {
  onlineManager.setOnline(true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup(); clients.splice(0).forEach(client => client.clear());
  onlineManager.setOnline(true);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function setup(initialFailure = false) {
  let failed = initialFailure;
  let held: Promise<Response> | undefined;
  let users = Array.from({ length: 25 }, (_, index) => ({
    id: `user-${index}`, name: `Member ${String(index).padStart(2, "0")}`,
    enabled: true, quotaBytes: 0, usedBytes: 0,
  }));
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = String(url), method = init?.method || "GET";
    requests.push(`${method} ${path}`);
    if (method !== "GET") throw new Error(`Unexpected write ${method} ${path}`);
    if (path === "/api/state") return json({ users, nodes: [], routes: [], revisions: [], capabilities: [] });
    if (path === "/api/services") return held ?? (failed ? json({ detail: "Services unavailable" }, 503) : json([]));
    if (path === "/api/published-routes" || path === "/api/user-groups") return json([]);
    if (path === "/api/access-policy/edit-context/entitlement/user-10") return new Promise<Response>(() => {});
    if (path === "/api/users/user-10/entries") return json([]);
    if (path === "/api/users/user-10/effective-policy") return json({ userId: "user-10", routeIds: [], status: "active" });
    throw new Error(`Unexpected read ${path}`);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders><AdminPage page="users" /></UIProviders></QueryClientProvider>);
  return {
    requests, client,
    fail: () => { failed = true; },
    recover: () => { failed = false; held = undefined; },
    empty: () => { users = []; },
    hold: () => { let release!: (response: Response) => void; held = new Promise(resolve => { release = resolve; }); return release; },
  };
}

it("retains the searched page after a dependent read fails and fences row tasks until recovery", async () => {
  const task = setup();
  await screen.findByRole("button", { name: "Member 00" });
  await userEvent.type(screen.getByRole("textbox", { name: "搜索用户" }), "Member");
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByRole("button", { name: "Member 10" });
  task.fail();
  await act(async () => { await task.client.invalidateQueries({ queryKey: ["admin-state"] }); });
  await screen.findByText("Services unavailable");
  expect((screen.getByRole("textbox", { name: "搜索用户" }) as HTMLInputElement).value).toBe("Member");
  expect(screen.getByRole("button", { name: "Member 10" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Member 00" })).toBeNull();
  await screen.findByText("暂时无法核对用户");
  expect((screen.getByRole("button", { name: "Member 10" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Member 00" })).toBeNull();
  const actions = within(screen.getByRole("group", { name: "Member 10 的操作" }));
  expect((actions.getByRole("button", { name: "平台入口" }) as HTMLButtonElement).disabled).toBe(true);
  expect((actions.getByRole("button", { name: "更多操作 Member 10" }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(actions.getByRole("button", { name: "平台入口" }));
  expect(task.requests.some(request => request.includes("/entries"))).toBe(false);
  const release = task.hold();
  await userEvent.click(screen.getByRole("button", { name: "重试用户列表" }));
  await screen.findByText("正在核对用户…");
  expect((actions.getByRole("button", { name: "平台入口" }) as HTMLButtonElement).disabled).toBe(true);
  task.recover();
  await act(async () => { release(json([])); });
  await waitFor(() => expect((screen.getByRole("button", { name: "Member 10" }) as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(screen.getByRole("button", { name: "Member 10" }));
  expect(await screen.findByRole("dialog", { name: "编辑用户" })).toBeTruthy();
  await userEvent.click(within(screen.getByRole("dialog", { name: "编辑用户" })).getByRole("button", { name: "取消" }));
  await userEvent.click(actions.getByRole("button", { name: "平台入口" }));
  expect(await screen.findByRole("dialog", { name: "Member 10 的平台入口" })).toBeTruthy();
  expect(task.requests).toContain("GET /api/users/user-10/entries");
  expect(task.requests.every(request => request.startsWith("GET "))).toBe(true);
});

it("keeps initial failure unknown and only shows authoritative empty users after retry", async () => {
  const task = setup(true);
  await screen.findByText("暂时无法加载");
  expect(screen.queryByText("暂无用户")).toBeNull();
  expect(screen.queryByRole("textbox", { name: "搜索用户" })).toBeNull();
  task.recover(); task.empty();
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByText("暂无用户")).toBeTruthy();
});

it("keeps cached zero users unknown while offline until the inventory is reconciled", async () => {
  const task = setup();
  await screen.findByRole("button", { name: "Member 00" });
  task.empty();
  await act(async () => { await task.client.invalidateQueries({ queryKey: ["admin-state"] }); });
  await screen.findByText("暂无用户");
  act(() => onlineManager.setOnline(false));
  act(() => { void task.client.invalidateQueries({ queryKey: ["admin-state"] }); });
  await screen.findByText("等待网络连接后核对用户。");
  expect(screen.queryByText("暂无用户")).toBeNull();
  act(() => onlineManager.setOnline(true));
  expect(await screen.findByText("暂无用户")).toBeTruthy();
});

it("disables an already-open row menu when the inventory read loses authority", async () => {
  const task = setup();
  await screen.findByRole("button", { name: "Member 00" });
  await userEvent.click(screen.getByRole("button", { name: "更多操作 Member 00" }));
  await screen.findByRole("menuitem", { name: "编辑用户" });
  task.fail();
  await act(async () => { await task.client.invalidateQueries({ queryKey: ["admin-state"] }); });
  await screen.findByText("暂时无法核对用户");
  const edit = screen.getByRole("menuitem", { name: "编辑用户" });
  expect(edit.getAttribute("aria-disabled")).toBe("true");
  await userEvent.click(edit);
  expect(screen.queryByRole("dialog", { name: "编辑用户" })).toBeNull();
  expect(task.requests.every(request => request.startsWith("GET "))).toBe(true);
});

it("opens the recovered page-two user's own authorization context without writes", async () => {
  const task = setup();
  await screen.findByRole("button", { name: "Member 00" });
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByRole("button", { name: "Member 10" });
  task.fail();
  await act(async () => { await task.client.invalidateQueries({ queryKey: ["admin-state"] }); });
  await screen.findByText("暂时无法核对用户");
  task.recover();
  await userEvent.click(screen.getByRole("button", { name: "重试用户列表" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "更多操作 Member 10" }) as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(screen.getByRole("button", { name: "更多操作 Member 10" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "授权与续期" }));
  expect(await screen.findByRole("dialog", { name: "Member 10 的服务授权" })).toBeTruthy();
  await waitFor(() => expect(task.requests).toContain("GET /api/access-policy/edit-context/entitlement/user-10"));
  expect(task.requests.filter(request => request.includes("/access-policy/edit-context/"))).toEqual([
    "GET /api/access-policy/edit-context/entitlement/user-10",
  ]);
  expect(task.requests.every(request => request.startsWith("GET "))).toBe(true);
});
