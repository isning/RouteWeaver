// @vitest-environment jsdom
// Public inventory tasks with failures injected only at the HTTP boundary.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { AdminPage } from "./Admin";
import { UserGroups } from "./AccessPolicy";

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
  onlineManager.setOnline(true); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
type Kind = "service" | "group";
function setup(kind: Kind = "service", initialFailure = false) {
  let failed = initialFailure;
  let held: Promise<Response> | undefined;
  let records = Array.from({ length: 25 }, (_, index) => ({
    id: `${kind}-${index}`, name: `Record ${String(index).padStart(2, "0")}`,
    ...(kind === "service" ? { quotaBytes: 0, routeIds: [], onlineIpLimit: 0, connectionLimit: 0, entryRateBps: 0, cycle: { mode: "none", timezone: "UTC+8", anchor: "0001-01-01T00:00:00Z" } } : { serviceId: "plan", priority: 1, memberIds: [] }),
  }));
  const requests: string[] = [];
  const path = kind === "service" ? "/api/services" : "/api/user-groups";
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const target = String(url), method = init?.method || "GET";
    requests.push(`${method} ${target}`);
    if (method !== "GET") throw new Error(`Unexpected write ${method} ${target}`);
    if (target === path) return held ?? (failed ? json({ detail: "Inventory unavailable" }, 503) : json(records));
    if (target === "/api/state") return json({ users: [], nodes: [], routes: [], revisions: [], capabilities: [] });
    if (target === "/api/published-routes") return json([]);
    if (target.startsWith(`/api/access-policy/edit-context/${kind}/`)) {
      const id = target.split("/").at(-1)!;
      const record = records.find(record => record.id === id);
      return json({ target: { kind, id }, record: record ? { [kind]: { ...record, name: "Authoritative record" } } : null,
        precondition: { exists: !!record, revision: "opening-1" } });
    }
    throw new Error(`Unexpected read ${target}`);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders>{kind === "service" ? <AdminPage page="services" /> : <UserGroups users={[]} services={[]} routes={[]} />}</UIProviders></QueryClientProvider>);
  return {
    requests, client, path, kind, response: () => json(records),
    refresh: async () => { await act(async () => { await client.invalidateQueries({ queryKey: [kind === "service" ? "admin-state" : "user-groups"] }); }); },
    fail: () => { failed = true; }, recover: () => { failed = false; held = undefined; }, empty: () => { records = []; },
    hold: () => { let release!: (response: Response) => void; held = new Promise(resolve => { release = resolve; }); return release; },
  };
}

it("retains the searched service page through refresh failure and recovery", async () => {
  const task = setup();
  await screen.findAllByText("Record 00");
  await userEvent.type(screen.getByRole("textbox", { name: "搜索服务方案" }), "Record");
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findAllByText("Record 10");
  task.fail(); await task.refresh();
  await screen.findByText("Inventory unavailable");
  expect(screen.getByRole("textbox", { name: "搜索服务方案" })).toHaveProperty("value", "Record");
  expect(screen.getAllByText("Record 10")).toBeTruthy();
  task.recover(); await task.refresh();
  await waitFor(() => expect(screen.queryByText("Inventory unavailable")).toBeNull());
  expect(screen.getAllByText("Record 10")).toBeTruthy();
  expect(screen.queryByText("Record 00")).toBeNull();
});

it("retains the group page through refresh failure and recovery", async () => {
  const task = setup("group");
  await screen.findAllByText("Record 00");
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findAllByText("Record 10");
  task.fail(); await task.refresh();
  await screen.findByText("Inventory unavailable");
  expect(screen.getAllByText("Record 10")).toBeTruthy();
  task.recover(); await task.refresh();
  await waitFor(() => expect(screen.queryByText("Inventory unavailable")).toBeNull());
  expect(screen.getAllByText("Record 10")).toBeTruthy();
  expect(screen.queryByText("Record 00")).toBeNull();
});

const labels = {
  service: { refresh: "刷新服务方案", empty: "暂无服务方案", pending: "正在刷新服务方案…", paused: "等待网络连接后刷新服务方案。", field: "服务方案名称" },
  group: { refresh: "刷新用户组", empty: "暂无用户组", pending: "正在刷新用户组…", paused: "等待网络连接后刷新用户组。", field: "用户组名称" },
};
for (const kind of ["service", "group"] as const) {
  const label = labels[kind];
  it(`${kind}: keeps first-read failure unknown until authoritative empty recovery`, async () => {
    const task = setup(kind, true);
    await screen.findByText("Inventory unavailable");
    expect(screen.queryByText(label.empty)).toBeNull();
    task.empty(); task.recover();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText(label.empty);
    expect(screen.getByRole("button", { name: label.refresh })).toBeTruthy();
  });

  it(`${kind}: distinguishes cached empty from failed, pending and offline reconciliation`, async () => {
    const task = setup(kind);
    await screen.findAllByText("Record 00");
    task.empty(); await task.refresh();
    await screen.findByText(label.empty);
    task.fail(); await task.refresh();
    await screen.findByText("Inventory unavailable");
    expect(screen.queryByText(label.empty)).toBeNull();
    const release = task.hold();
    await userEvent.click(screen.getByRole("button", { name: label.refresh }));
    await screen.findByText(label.pending);
    expect(screen.queryByText(label.empty)).toBeNull();
    task.recover(); await act(async () => release(task.response()));
    await screen.findByText(label.empty);
    act(() => onlineManager.setOnline(false));
    await userEvent.click(screen.getByRole("button", { name: label.refresh }));
    await screen.findByText(label.paused);
    expect(screen.queryByText(label.empty)).toBeNull();
    expect(screen.getByRole("button", { name: label.refresh }).getAttribute("aria-disabled")).toBe("true");
    act(() => onlineManager.setOnline(true));
    await screen.findByText(label.empty);
  });

  it(`${kind}: retains refresh focus across repeated failures and recovery with one pending read`, async () => {
    const task = setup(kind);
    const user = userEvent.setup();
    await screen.findAllByText("Record 00");
    await user.click(screen.getByRole("button", { name: "下一页" }));
    task.fail(); await task.refresh();
    const refresh = screen.getByRole("button", { name: label.refresh });
    const before = task.requests.filter(request => request === `GET ${task.path}`).length;
    let release = task.hold();
    act(() => { refresh.focus(); refresh.click(); refresh.click(); });
    await screen.findByText(label.pending);
    expect(refresh).toHaveProperty("disabled", false);
    expect(refresh.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(refresh);
    await user.keyboard("{Enter} "); await user.click(refresh);
    expect(task.requests.filter(request => request === `GET ${task.path}`)).toHaveLength(before + 1);
    expect(screen.getAllByText("Record 10")).toBeTruthy();
    await act(async () => release(json({ detail: "Still unavailable" }, 503)));
    await screen.findByText("Still unavailable");
    expect(document.activeElement).toBe(refresh);
    release = task.hold();
    await user.keyboard("{Enter}");
    await screen.findByText(label.pending);
    task.recover(); await act(async () => release(task.response()));
    await waitFor(() => expect(screen.queryByText(label.pending)).toBeNull());
    expect(document.activeElement).toBe(refresh);
    expect(refresh.getAttribute("aria-disabled")).not.toBe("true");
    expect(screen.getAllByText("Record 10")).toBeTruthy();
    expect(task.requests.filter(request => request === `GET ${task.path}`)).toHaveLength(before + 2);
    expect(task.requests.every(request => request.startsWith("GET "))).toBe(true);
  });

  it(`${kind}: opens authoritative row context while inventory is stale and preserves the newer draft and focus`, async () => {
    const task = setup(kind);
    const user = userEvent.setup();
    await screen.findAllByText("Record 00");
    await user.click(screen.getByRole("button", { name: "下一页" }));
    task.fail(); await task.refresh();
    const release = task.hold();
    await user.click(screen.getByRole("button", { name: label.refresh }));
    const actions = within(screen.getByRole("group", { name: "Record 10 的操作" }));
    await user.click(actions.getByRole("button", { name: kind === "service" ? "编辑" : "编辑 Record 10" }));
    const input = await screen.findByRole("textbox", { name: label.field });
    expect(input).toHaveProperty("value", "Authoritative record");
    expect(task.requests.filter(request => request.includes("/edit-context/"))).toEqual([`GET /api/access-policy/edit-context/${kind}/${kind}-10`]);
    await user.clear(input); await user.type(input, "My unsaved draft");
    task.recover(); await act(async () => release(task.response()));
    await waitFor(() => expect(screen.queryByText(label.pending)).toBeNull());
    expect(document.activeElement).toBe(input);
    expect(input).toHaveProperty("value", "My unsaved draft");
    task.fail(); await task.refresh();
    await screen.findByText("Inventory unavailable");
    expect(screen.getByRole("textbox", { name: label.field })).toBe(input);
    expect(input).toHaveProperty("value", "My unsaved draft");
    expect(document.activeElement).toBe(input);
    expect(task.requests.every(request => request.startsWith("GET "))).toBe(true);
  });
}

it.each(["service", "group"] as const)("%s: initial offline inventory is unknown, then loads without inventing empty data", async (kind) => {
  act(() => onlineManager.setOnline(false));
  const task = setup(kind);
  await screen.findByText("等待网络连接");
  expect(screen.queryByText(labels[kind].empty)).toBeNull();
  expect(task.requests).toEqual([]);
  act(() => onlineManager.setOnline(true));
  await screen.findAllByText("Record 00");
});

it("leaves a newer service search in place when refresh settles", async () => {
  const task = setup();
  const user = userEvent.setup();
  await screen.findAllByText("Record 00");
  task.fail(); await task.refresh();
  const release = task.hold();
  await user.click(screen.getByRole("button", { name: "刷新服务方案" }));
  const search = screen.getByRole("textbox", { name: "搜索服务方案" });
  await user.type(search, "Record 14");
  task.recover(); await act(async () => release(task.response()));
  await waitFor(() => expect(screen.queryByText("正在刷新服务方案…")).toBeNull());
  expect(document.activeElement).toBe(search);
  expect(search).toHaveProperty("value", "Record 14");
  expect(screen.getAllByText("Record 14")).toBeTruthy();
  expect(screen.queryByText("Record 00")).toBeNull();
});
