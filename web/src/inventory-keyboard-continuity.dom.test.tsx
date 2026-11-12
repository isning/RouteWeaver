// @vitest-environment jsdom
// Real inventory pages, dialogs and HTTP boundary. No external writes.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdminPage } from "./Admin";
import { UIProviders } from "./ui-patterns/providers";
import { serviceEditFixture } from "./test-support/service-edit-fixture";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mount(page: "services" | "users" | "nodes" | "legacy-routes" = "services") {
  const services = Array.from({ length: 25 }, (_, index) => ({
    id: `plan-${index}`, name: `Plan ${String(index).padStart(2, "0")}`,
    quotaBytes: 0, routeIds: [], onlineIpLimit: 0, connectionLimit: 0, entryRateBps: 0,
    cycle: { mode: "none", timezone: "UTC+8", anchor: "2026-01-01T00:00:00Z" },
  }));
  const users = services.map((plan) => ({ id: plan.id, name: plan.name, enabled: true, quotaBytes: 0, usedBytes: 0 }));
  const routes = services.map(plan => ({ id: plan.id, name: plan.name, engine: "sing-box", hops: ["plan-0"], userIds: [] }));
  const nodes = services.map((plan) => ({ id: plan.id, name: plan.name, protocol: "socks", host: "fixture.example", port: 1080, region: "Test" }));
  let nextRead: Promise<Response> | undefined;
  let contextRead: Promise<Response> | undefined;
  const writes: string[] = [];
  const unexpected: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = String(url), method = init?.method || "GET";
    if (method !== "GET") { writes.push(`${method} ${path}`); throw new Error("Audit is read-only"); }
    if (path === "/api/state") return json({ nodes, users, routes, revisions: [], capabilities: [] });
    if (path === "/api/services") return nextRead ?? json(services);
    if (path === "/api/published-routes" || path === "/api/user-groups" || path === "/api/rates") return json([]);
    if (path.startsWith("/api/access-policy/edit-context/service/")) {
      const service = services.find(plan => path.endsWith(`/${plan.id}`));
      if (!service) throw new Error(`Unexpected service context ${path}`);
      return contextRead ?? json(serviceEditFixture(service).context());
    }
    unexpected.push(path); throw new Error(`Unexpected read ${path}`);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders><AdminPage page={page} /></UIProviders></QueryClientProvider>);
  return { services, writes, unexpected, holdContext: () => {
    let settle!: (response: Response) => void;
    contextRead = new Promise(resolve => { settle = resolve; });
    return (response: Response) => { contextRead = undefined; settle(response); };
  }, hold: () => {
    let settle!: (response: Response) => void;
    nextRead = new Promise(resolve => { settle = resolve; });
    return (response: Response) => { nextRead = undefined; settle(response); };
  } };
}

it.each([["services", "服务方案"], ["users", "用户"], ["nodes", "连接端点"], ["legacy-routes", "链路配置"]] as const)(
  "%s: the empty-result Clear search action returns keyboard focus to its search field",
  async (page, label) => {
    const task = mount(page); const user = userEvent.setup();
    const search = await screen.findByRole("textbox", { name: `搜索${label}` });
    await user.type(search, "Not a matching record");
    await screen.findByText(`没有匹配的${label}`);
    const clear = screen.getByRole("button", { name: "清除搜索" });
    // Reach the actual empty-state recovery action from search using the public Tab sequence.
    for (let tries = 0; tries < 4 && document.activeElement !== clear; tries++) await user.tab();
    expect(document.activeElement).toBe(clear);
    await user.keyboard("{Enter}");
    expect(search).toHaveProperty("value", "");
    expect(screen.queryByText(`没有匹配的${label}`)).toBeNull();
    expect(screen.getByText("第 1 / 3 页")).toBeTruthy();
    expect(task.writes).toEqual([]);
    expect(task.unexpected).toEqual([]);
    expect(document.activeElement).toBe(search);
  },
);

it.each(["retained", "removed", "outside-current-search"] as const)(
  "service: cancellation after pending inventory reconciliation preserves continuity when the original row is %s",
  async (mode) => {
    const task = mount(); const user = userEvent.setup();
    await screen.findByRole("cell", { name: "Plan 00" });
    await user.type(screen.getByRole("textbox", { name: "搜索服务方案" }), "Plan");
    await user.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByRole("cell", { name: "Plan 10" });
    const settle = task.hold();
    await user.click(screen.getByRole("button", { name: "刷新服务方案" }));
    await screen.findByText("正在刷新服务方案…");
    const opener = within(screen.getByRole("group", { name: "Plan 10 的操作" })).getByRole("button", { name: "编辑" });
    await user.click(opener);
    const field = await screen.findByRole("textbox", { name: "服务方案名称" });
    expect(field).toHaveProperty("value", "Plan 10");
    const dialog = screen.getByRole("dialog", { name: "编辑 Plan 10" });
    await user.click(field);
    const refreshed = mode === "removed" ? task.services.filter(plan => plan.id !== "plan-10") : mode === "outside-current-search" ? task.services.map(plan => plan.id === "plan-10" ? { ...plan, name: "Renamed offering" } : plan) : task.services;
    await act(async () => settle(json(refreshed)));
    await waitFor(() => expect(screen.queryByText("正在刷新服务方案…")).toBeNull());
    expect(document.activeElement).toBe(field);
    expect(field).toHaveProperty("value", "Plan 10");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const search = screen.getByRole("textbox", { name: "搜索服务方案" });
    expect(screen.getByText("第 2 / 3 页")).toBeTruthy();
    expect(task.writes).toEqual([]);
    expect(task.unexpected).toEqual([]);
    await waitFor(() => expect(document.activeElement).toBe(mode === "retained" ? opener : search));
  },
);

it.each([["services", "服务方案"], ["users", "用户"], ["nodes", "连接端点"], ["legacy-routes", "链路配置"]] as const)(
  "%s: existing inline clear control is a passing comparison for focus and repeated recovery",
  async (page, label) => {
    const task = mount(page); const user = userEvent.setup();
    const search = await screen.findByRole("textbox", { name: `搜索${label}` });
    for (let attempt = 0; attempt < 2; attempt++) {
      await user.type(search, "No match");
      await screen.findByText(`没有匹配的${label}`);
      await user.tab();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "清除搜索输入" }));
      await user.keyboard("{Enter}");
      expect(search).toHaveProperty("value", "");
      expect(document.activeElement).toBe(search);
      expect(screen.getByText("第 1 / 3 页")).toBeTruthy();
    }
    expect(task.writes).toEqual([]); expect(task.unexpected).toEqual([]);
  },
);

it.each(["loading", "failed"] as const)("service: returns an unavailable row's %s opening task to inventory search", async phase => {
  const task = mount(); const user = userEvent.setup();
  await screen.findByRole("cell", { name: "Plan 00" });
  const search = screen.getByRole("textbox", { name: "搜索服务方案" });
  await user.type(search, "Plan");
  await user.click(screen.getByRole("button", { name: "下一页" }));
  const settleInventory = task.hold(), settleContext = task.holdContext();
  await user.click(screen.getByRole("button", { name: "刷新服务方案" }));
  await user.click(within(screen.getByRole("group", { name: "Plan 10 的操作" })).getByRole("button", { name: "编辑" }));
  const dialog = await screen.findByRole("dialog", { name: "编辑 Plan 10" });
  expect(within(dialog).queryByRole("textbox", { name: "服务方案名称" })).toBeNull();
  await act(async () => settleInventory(json(task.services.filter(plan => plan.id !== "plan-10"))));
  await waitFor(() => expect(screen.queryByText("正在刷新服务方案…")).toBeNull());
  if (phase === "failed") {
    await act(async () => settleContext(json({ message: "Opening context unavailable" }, 503)));
    await within(dialog).findByText("Opening context unavailable");
  }
  await user.click(within(dialog).getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(search));
  if (phase === "loading") {
    await act(async () => settleContext(json(serviceEditFixture(task.services[10]).context())));
    expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(search);
  }
  expect(search).toHaveProperty("value", "Plan"); expect(screen.getByText("第 2 / 3 页")).toBeTruthy();
  expect(task.writes).toEqual([]); expect(task.unexpected).toEqual([]);
});

it("service: preserves the newer draft and cancelled-discard owner before an explicit discard returns to search", async () => {
  const task = mount(); const user = userEvent.setup();
  await screen.findByRole("cell", { name: "Plan 00" });
  const search = screen.getByRole("textbox", { name: "搜索服务方案" });
  await user.type(search, "Plan"); await user.click(screen.getByRole("button", { name: "下一页" }));
  const settle = task.hold(); await user.click(screen.getByRole("button", { name: "刷新服务方案" }));
  await user.click(within(screen.getByRole("group", { name: "Plan 10 的操作" })).getByRole("button", { name: "编辑" }));
  const field = await screen.findByRole("textbox", { name: "服务方案名称" });
  await user.clear(field); await user.type(field, "My retained draft");
  await act(async () => settle(json(task.services.map(plan => plan.id === "plan-10" ? { ...plan, name: "Renamed offering" } : plan))));
  await waitFor(() => expect(screen.queryByText("正在刷新服务方案…")).toBeNull());
  expect(field).toHaveProperty("value", "My retained draft"); expect(document.activeElement).toBe(field);
  const cancel = within(screen.getByRole("dialog")).getByRole("button", { name: "取消" });
  await user.click(cancel);
  const confirmation = await screen.findByRole("alertdialog");
  await user.click(within(confirmation).getByRole("button", { name: "继续编辑" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(cancel));
  expect(field).toHaveProperty("value", "My retained draft");
  await user.click(cancel); await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(search));
  expect(search).toHaveProperty("value", "Plan"); expect(screen.getByText("第 2 / 3 页")).toBeTruthy();
  expect(task.writes).toEqual([]); expect(task.unexpected).toEqual([]);
});
