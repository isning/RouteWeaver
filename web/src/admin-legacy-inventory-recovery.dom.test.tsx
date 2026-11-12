// @vitest-environment jsdom
// Real public AdminPage/UIProviders/HTTP code. Synthetic responses only.
// No real network, writes, query-data seeding, production edits or module mocks.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdminPage } from "./Admin";
import { UIProviders } from "./ui-patterns/providers";
import { useState } from "react";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const clients: QueryClient[] = [];
beforeEach(() => { onlineManager.setOnline(true); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); onlineManager.setOnline(true); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const cases = [
  { page: "nodes" as const, label: "连接端点", empty: "暂无连接端点", action: "添加端点", field: "端点名称" },
  { page: "legacy-routes" as const, label: "链路配置", empty: "暂无链路配置", action: "新建链路配置", field: "链路配置名称" },
];
function mount(page: "nodes" | "legacy-routes", initial: "success" | "failed" | "empty" = "success") {
  let failed = initial === "failed";
  let held: Promise<Response> | undefined;
  const records = Array.from({ length: 25 }, (_, i) => ({ id: `record-${i}`, name: `Record ${String(i).padStart(2,"0")}` }));
  let state = {
    users: [], revisions: [],
    nodes: initial === "empty" ? [] : records.map(r => ({ ...r, protocol: "socks", host: "fixture.example.invalid", port: 1080, region: "Fixture region" })),
    routes: initial === "empty" ? [] : records.map(r => ({ ...r, engine: "sing-box", hops: ["record-0"], userIds: [] })),
    capabilities: [{ id: "sing-box", name: "Known core", maxHops: 3, protocols: ["socks"] }],
  };
  const requests: string[] = [], unexpected: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = String(url), method = init?.method || "GET";
    requests.push(`${method} ${path}`);
    if (method !== "GET") { unexpected.push(`${method} ${path}`); throw new Error("This read-only fixture forbids writes"); }
    if (path === "/api/state") return held?.then(response => response.clone()) ?? (failed ? json({ detail: "Synthetic inventory unavailable" }, 503) : json(state));
    if (["/api/services", "/api/published-routes", "/api/user-groups"].includes(path)) return json([]);
    unexpected.push(path); throw new Error(`Unexpected read ${path}`);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client);
  function Harness() {
    const [currentPage, setCurrentPage] = useState<"nodes" | "legacy-routes" | "users">(page);
    return <><button onClick={() => setCurrentPage(currentPage === "nodes" ? "legacy-routes" : "nodes")}>Other inventory</button><button onClick={() => setCurrentPage("users")}>Users inventory</button><AdminPage page={currentPage}/></>;
  }
  render(<QueryClientProvider client={client}><UIProviders><Harness/></UIProviders></QueryClientProvider>);
  return {
    client, requests, unexpected,
    fail: () => { held = undefined; failed = true; }, recover: () => { held = undefined; failed = false; },
    empty: () => { state = { ...state, nodes: [], routes: [] }; }, response: () => json(state),
    refresh: async () => { await act(async () => { await client.invalidateQueries({ queryKey: ["admin-state"] }); }); },
    hold: () => { let resolve!: (r: Response) => void; held = new Promise(r => { resolve = r; }); return resolve; },
  };
}
async function pageTwo(label: string) {
  const user = userEvent.setup(); const search = await screen.findByRole("textbox", { name: `搜索${label}` });
  await user.type(search, "Record"); await user.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByRole("group", { name: "Record 10 的操作" }); await user.click(search); return { user, search };
}
function noWrites(task: ReturnType<typeof mount>) { expect(task.unexpected).toEqual([]); expect(task.requests.every(r => r.startsWith("GET "))).toBe(true); }
for (const c of cases) {
  it(`${c.page}: preserves the searched page and focused search through a failed cached read and recovery`, async () => {
    const task = mount(c.page); const { search, user } = await pageTwo(c.label);
    task.fail(); await task.refresh(); await screen.findByText("Synthetic inventory unavailable");
    expect(search.isConnected).toBe(true); expect(document.activeElement).toBe(search);
    expect(screen.getByText("第 2 / 3 页")).toBeTruthy(); expect(search).toHaveProperty("value", "Record");
    task.recover(); await user.click(screen.getByRole("button", { name: `刷新${c.label}` }));
    await waitFor(() => expect(screen.queryByText("Synthetic inventory unavailable")).toBeNull());
    expect(screen.getByText("第 2 / 3 页")).toBeTruthy(); expect(search).toHaveProperty("value", "Record"); noWrites(task);
  });
}
for (const c of cases) {
  it(`${c.page}: first-error Retry stays focusable through failure and owns only its successful recovery handoff`, async () => {
    const task = mount(c.page, "failed"), user = userEvent.setup(); const retry = await screen.findByRole("button", { name: "重试" });
    let settle = task.hold(); const before = task.requests.filter(r => r === "GET /api/state").length;
    await user.click(retry); await user.keyboard("{Enter} ");
    expect(retry.isConnected).toBe(true); expect(document.activeElement).toBe(retry);
    expect(retry).toHaveProperty("disabled", false); expect(retry.getAttribute("aria-busy")).toBe("true"); expect(retry.getAttribute("aria-disabled")).toBe("true");
    expect(task.requests.filter(r => r === "GET /api/state")).toHaveLength(before + 1);
    await act(async () => settle(json({ detail: "Synthetic retry unavailable" }, 503))); await screen.findByText("Synthetic retry unavailable");
    expect(document.activeElement).toBe(retry); settle = task.hold(); await user.keyboard("{Enter}"); task.recover();
    await act(async () => settle(task.response())); const search = await screen.findByRole("textbox", { name: `搜索${c.label}` });
    await waitFor(() => expect(document.activeElement).toBe(search)); noWrites(task);
  });
  it(`${c.page}: cached refresh keeps one keyboard-owned read through repeated failure and successful recovery`, async () => {
    const task = mount(c.page), { user, search } = await pageTwo(c.label); task.fail(); await task.refresh(); await screen.findByText("Synthetic inventory unavailable");
    const refresh = screen.getByRole("button", { name: `刷新${c.label}` }); let settle = task.hold(); const before = task.requests.filter(r => r === "GET /api/state").length;
    act(() => { refresh.focus(); refresh.click(); refresh.click(); }); await user.keyboard("{Enter} "); await user.click(refresh);
    expect(task.requests.filter(r => r === "GET /api/state")).toHaveLength(before + 1); expect(document.activeElement).toBe(refresh);
    expect(refresh).toHaveProperty("disabled", false); expect(refresh.getAttribute("aria-busy")).toBe("true"); expect(refresh.getAttribute("aria-disabled")).toBe("true");
    await screen.findByText(`正在刷新${c.label}…`); expect(search).toHaveProperty("value", "Record"); expect(screen.getByText("第 2 / 3 页")).toBeTruthy();
    await act(async () => settle(json({ detail: "Synthetic retry unavailable" }, 503))); await screen.findByText("Synthetic retry unavailable");
    expect(document.activeElement).toBe(refresh); settle = task.hold(); await user.keyboard("{Enter}"); task.recover(); await act(async () => settle(task.response()));
    await waitFor(() => expect(screen.queryByText(`正在刷新${c.label}…`)).toBeNull()); expect(document.activeElement).toBe(refresh);
    expect(task.requests.filter(r => r === "GET /api/state")).toHaveLength(before + 2); noWrites(task);
  });
  it(`${c.page}: offline refresh stays owned and does not duplicate reads on activation or reconnect`, async () => {
    const task = mount(c.page), { user } = await pageTwo(c.label); const refresh = screen.getByRole("button", { name: `刷新${c.label}` });
    const before = task.requests.filter(r => r === "GET /api/state").length; const settle = task.hold(); act(() => onlineManager.setOnline(false));
    await user.click(refresh); await screen.findByText(`等待网络连接后刷新${c.label}。`); await user.keyboard("{Enter} ");
    expect(task.requests.filter(r => r === "GET /api/state")).toHaveLength(before); expect(document.activeElement).toBe(refresh); expect(refresh.getAttribute("aria-busy")).toBe("true");
    act(() => onlineManager.setOnline(true)); await waitFor(() => expect(task.requests.filter(r => r === "GET /api/state")).toHaveLength(before + 1));
    await act(async () => settle(task.response())); await waitFor(() => expect(refresh.getAttribute("aria-busy")).not.toBe("true")); expect(document.activeElement).toBe(refresh); noWrites(task);
  });
  it.each([200, 503])(`${c.page}: cached retry leaves a newer creation draft and focus intact after %s`, async (status) => {
    const task = mount(c.page), { user } = await pageTwo(c.label); task.fail(); await task.refresh(); await screen.findByText("Synthetic inventory unavailable");
    const settle = task.hold(); await user.click(screen.getByRole("button", { name: `刷新${c.label}` })); await user.click(screen.getByRole("button", { name: c.action }));
    const field = await screen.findByRole("textbox", { name: c.field }); await user.type(field, "Newer unsaved draft"); task.recover();
    await act(async () => settle(status === 200 ? task.response() : json({ detail: "Synthetic retry unavailable" }, 503)));
    await waitFor(() => expect(screen.queryByText(`正在刷新${c.label}…`)).toBeNull()); expect(document.activeElement).toBe(field); expect(field).toHaveProperty("value", "Newer unsaved draft"); noWrites(task);
  });
  it(`${c.page}: cached empty is not current-empty while refresh is pending, failed or paused`, async () => {
    const task = mount(c.page, "empty"), user = userEvent.setup(); await screen.findByText(c.empty); const refresh = screen.getByRole("button", { name: `刷新${c.label}` });
    const settle = task.hold(); await user.click(refresh); await screen.findByText(`正在刷新${c.label}…`); expect(screen.queryByText(c.empty)).toBeNull();
    await act(async () => settle(json({ detail: "Synthetic retry unavailable" }, 503))); await screen.findByText("Synthetic retry unavailable"); expect(screen.queryByText(c.empty)).toBeNull();
    task.recover(); act(() => onlineManager.setOnline(false)); await user.click(refresh); await screen.findByText(`等待网络连接后刷新${c.label}。`); expect(screen.queryByText(c.empty)).toBeNull();
    act(() => onlineManager.setOnline(true)); await screen.findByText(c.empty); noWrites(task);
  });
}
it.each([200, 503])("nodes: first-error retry does not take a newer independent creation draft after %s", async (status) => {
  const task = mount("nodes", "failed"), user = userEvent.setup(); const retry = await screen.findByRole("button", { name: "重试" }); const settle = task.hold();
  await user.click(retry); await user.click(screen.getByRole("button", { name: "添加端点" })); const name = await screen.findByRole("textbox", { name: "端点名称" }); await user.type(name, "Independent draft");
  task.recover(); await act(async () => settle(status === 200 ? task.response() : json({ detail: "Synthetic retry unavailable" }, 503)));
  expect(document.activeElement).toBe(name); expect(name).toHaveProperty("value", "Independent draft"); noWrites(task);
});
for (const c of cases) {
  it(`${c.page}: fences row name, edit and menu tasks while a cached read is pending or failed`, async () => {
    const task = mount(c.page), { user } = await pageTwo(c.label); const settle = task.hold();
    await user.click(screen.getByRole("button", { name: `刷新${c.label}` }));
    const rowActions = within(screen.getByRole("group", { name: "Record 10 的操作" }));
    expect(rowActions.getByRole("button", { name: "编辑" })).toHaveProperty("disabled", true);
    expect(rowActions.getByRole("button", { name: "更多操作 Record 10" })).toHaveProperty("disabled", true);
    const name = screen.getByRole("button", { name: /^Record 10 / }); expect(name).toHaveProperty("disabled", true);
    if (c.page === "legacy-routes") expect(rowActions.getByRole("button", { name: "校验 Record 10" })).toHaveProperty("disabled", true);
    await user.click(name); await user.click(rowActions.getByRole("button", { name: "编辑" })); expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => settle(json({ detail: "Synthetic retry unavailable" }, 503))); await screen.findByText("Synthetic retry unavailable");
    expect(rowActions.getByRole("button", { name: "编辑" })).toHaveProperty("disabled", true); task.recover();
    await user.click(screen.getByRole("button", { name: `刷新${c.label}` }));
    await waitFor(() => expect(rowActions.getByRole("button", { name: "编辑" })).toHaveProperty("disabled", false));
    await user.click(rowActions.getByRole("button", { name: "编辑" })); expect(await screen.findByRole("textbox", { name: c.field })).toHaveProperty("value", "Record 10"); noWrites(task);
  });
  it(`${c.page}: a menu already open becomes disabled when inventory authority is lost`, async () => {
    const task = mount(c.page), { user } = await pageTwo(c.label); await user.click(screen.getByRole("button", { name: "更多操作 Record 10" }));
    const menuitem = await screen.findByRole("menuitem", { name: `${c.page === "nodes" ? "删除端点" : "删除链路配置"} Record 10` });
    const settle = task.hold(); act(() => { void task.client.invalidateQueries({ queryKey: ["admin-state"] }); });
    await waitFor(() => expect(menuitem.getAttribute("aria-disabled")).toBe("true")); await user.click(menuitem); expect(screen.queryByRole("alertdialog")).toBeNull();
    await act(async () => settle(task.response())); noWrites(task);
  });
  it.each(["pending", "missing"] as const)(`${c.page}: a confirmation rechecks current inventory and target before ${"%s"} DELETE`, async (phase) => {
    const task = mount(c.page), { user } = await pageTwo(c.label); await user.click(screen.getByRole("button", { name: "更多操作 Record 10" }));
    await user.click(await screen.findByRole("menuitem", { name: `${c.page === "nodes" ? "删除端点" : "删除链路配置"} Record 10` }));
    const dialog = await screen.findByRole("alertdialog"); const settle = task.hold();
    act(() => { void task.client.invalidateQueries({ queryKey: ["admin-state"] }); });
    if (phase === "missing") { task.empty(); await act(async () => settle(task.response())); await waitFor(() => expect(screen.queryByText(`正在刷新${c.label}…`)).toBeNull()); }
    await user.click(within(dialog).getByRole("button", { name: "删除" }));
    await within(dialog).findByText("列表已变化，请刷新后重新确认删除。"); expect(screen.getByRole("alertdialog")).toBe(dialog);
    expect(screen.queryByText("已删除")).toBeNull(); noWrites(task);
    if (phase === "pending") await act(async () => settle(task.response()));
  });
  it(`${c.page}: an existing editor keeps its unsaved draft when list readiness is lost`, async () => {
    const task = mount(c.page), { user } = await pageTwo(c.label); await user.click(within(screen.getByRole("group", { name: "Record 10 的操作" })).getByRole("button", { name: "编辑" }));
    const field = await screen.findByRole("textbox", { name: c.field }); await user.clear(field); await user.type(field, "Existing unsaved draft");
    task.fail(); await task.refresh(); await screen.findByText("Synthetic inventory unavailable"); expect(field).toHaveProperty("value", "Existing unsaved draft"); expect(document.activeElement).toBe(field); noWrites(task);
  });
}

it("a first-error retry explicitly started on a newer inventory owns that inventory's recovery", async () => {
  const task = mount("nodes", "failed"), user = userEvent.setup(); await screen.findByRole("button", { name: "重试" });
  await user.click(screen.getByText("Other inventory")); const retry = screen.getByRole("button", { name: "重试" }); const settle = task.hold();
  await user.click(retry); task.recover(); await act(async () => settle(task.response()));
  const search = await screen.findByRole("textbox", { name: "搜索链路配置" }); await waitFor(() => expect(document.activeElement).toBe(search)); noWrites(task);
});
it.each(["other-page", "away-and-back"] as const)("an older first-error retry cannot take inventory search focus after %s owner navigation", async transition => {
  const task = mount("nodes", "failed"), user = userEvent.setup(); const retry = await screen.findByRole("button", { name: "重试" }); const settle = task.hold();
  await user.click(retry); act(() => fireEvent.click(screen.getByText("Other inventory")));
  if (transition === "away-and-back") act(() => fireEvent.click(screen.getByText("Other inventory")));
  task.recover(); await act(async () => settle(task.response()));
  const search = await screen.findByRole("textbox", { name: transition === "away-and-back" ? "搜索连接端点" : "搜索链路配置" });
  expect(document.activeElement).not.toBe(search); noWrites(task);
});
for (const c of cases) {
  it(`${c.page}: a same-event read change fences old row callbacks before disabled rendering catches up`, async () => {
    const task = mount(c.page); await pageTwo(c.label); const edit = within(screen.getByRole("group", { name: "Record 10 的操作" })).getByRole("button", { name: "编辑" });
    const validate = c.page === "legacy-routes" ? screen.getByRole("button", { name: "校验 Record 10" }) : null; const settle = task.hold();
    act(() => { void task.client.invalidateQueries({ queryKey: ["admin-state"] }); edit.click(); validate?.click(); });
    expect(screen.queryByRole("dialog")).toBeNull(); noWrites(task); await act(async () => settle(task.response()));
  });
}
for (const c of cases) {
  it.each([200, 503])(`${c.page}: refresh settlement leaves the newer search value and focus after %s`, async (status) => {
    const task = mount(c.page), { user, search } = await pageTwo(c.label); task.fail(); await task.refresh(); await screen.findByText("Synthetic inventory unavailable");
    const settle = task.hold(); await user.click(screen.getByRole("button", { name: `刷新${c.label}` }));
    await user.clear(search); await user.type(search, "Record 14"); task.recover();
    await act(async () => settle(status === 200 ? task.response() : json({ detail: "Synthetic retry unavailable" }, 503)));
    await waitFor(() => expect(screen.queryByText(`正在刷新${c.label}…`)).toBeNull());
    expect(document.activeElement).toBe(search); expect(search).toHaveProperty("value", "Record 14"); expect(screen.getByRole("group", { name: "Record 14 的操作" })).toBeTruthy(); noWrites(task);
  });
  it(`${c.page}: an unsubmitted confirmation cannot send a command after its page owner changed`, async () => {
    const task = mount(c.page), { user } = await pageTwo(c.label); await user.click(screen.getByRole("button", { name: "更多操作 Record 10" }));
    await user.click(await screen.findByRole("menuitem", { name: `${c.page === "nodes" ? "删除端点" : "删除链路配置"} Record 10` }));
    const dialog = await screen.findByRole("alertdialog"); act(() => fireEvent.click(screen.getByText("Other inventory")));
    await user.click(within(dialog).getByRole("button", { name: "删除" })); await within(dialog).findByText("列表已变化，请刷新后重新确认删除。");
    expect(screen.getByRole("alertdialog")).toBe(dialog); expect(screen.queryByText("已删除")).toBeNull(); noWrites(task);
  });
}

it("a successful shared read on another AdminPage clears historical failure before a newer pending return", async () => {
  // Public page-prop lifecycle only. Normal App PageBoundary navigation remounts.
  const task = mount("nodes"), { user } = await pageTwo("连接端点"); task.fail(); await task.refresh(); await screen.findByText("Synthetic inventory unavailable");
  await user.click(screen.getByText("Users inventory")); task.recover(); await task.refresh();
  await waitFor(() => expect(screen.queryByText("Synthetic inventory unavailable")).toBeNull());
  const settle = task.hold(); act(() => { void task.client.invalidateQueries({ queryKey: ["admin-state"] }); });
  await user.click(screen.getByText("Other inventory")); await screen.findByText("正在刷新连接端点…");
  expect(screen.queryByText("Synthetic inventory unavailable")).toBeNull(); await act(async () => settle(task.response())); noWrites(task);
});
