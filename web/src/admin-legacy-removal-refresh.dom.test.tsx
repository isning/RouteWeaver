// @vitest-environment jsdom
// Confirmed-delete cache projection and read recovery only; real UI/API/query code.
// All requests are synthetic. One explicitly named in-memory DELETE is permitted.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { AdminPage } from "./Admin";
import { UIProviders } from "./ui-patterns/providers";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(c => c.clear()); onlineManager.setOnline(true); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const variants = [
  { page: "nodes", kind: "nodes", noun: "连接端点", action: "删除端点" },
  { page: "legacy-routes", kind: "routes", noun: "链路配置", action: "删除链路配置" },
] as const;
type Variant = typeof variants[number];
function mount(v: Variant, count = 25) {
  const id = count === 1 ? "fixture-0" : "fixture-10";
  const names = Array.from({ length: count }, (_, i) => ({ id: `fixture-${i}`, name: `Fixture ${String(i).padStart(2, "0")}` }));
  let state = {
    nodes: names.map(n => ({ ...n, protocol: "socks", host: "fixture.example.invalid", port: 1080, region: "Test" })),
    routes: names.map(r => ({ ...r, engine: "sing-box", hops: ["fixture-0"], userIds: [] })),
    users: [], revisions: [], capabilities: [],
  };
  const command = deferred<Response>();
  const requests: string[] = [], writes: string[] = [], unexpected: string[] = [];
  const reads: { gate: ReturnType<typeof deferred<Response>>; snapshot: typeof state }[] = [];
  let stateCount = 0;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = String(url), method = init?.method || "GET", key = `${method} ${path}`; requests.push(key);
    if (key === `DELETE /api/${v.kind}/${id}`) { writes.push(key); return command.promise.then(r => r.clone()); }
    if (method !== "GET") { unexpected.push(key); throw new Error(`Unexpected write ${key}`); }
    if (path === "/api/state") {
      if (++stateCount === 1) return json(state);
      const read = { gate: deferred<Response>(), snapshot: structuredClone(state) }; reads.push(read); return read.gate.promise.then(r => r.clone());
    }
    if (["/api/services", "/api/published-routes"].includes(path)) return json([]);
    unexpected.push(key); throw new Error(`Unexpected read ${key}`);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client);
  function Harness() {
    const [page, setPage] = useState<"nodes" | "legacy-routes">(v.page);
    return <><button onClick={() => setPage(page === "nodes" ? "legacy-routes" : "nodes")}>Other inventory</button><button>Newer task</button><AdminPage page={page}/></>;
  }
  render(<QueryClientProvider client={client}><UIProviders><Harness/></UIProviders></QueryClientProvider>);
  return { client, id, writes, unexpected, requests, reads,
    accept: () => { state = { ...state, [v.kind]: state[v.kind].filter(row => row.id !== id) }; command.resolve(json({ ok: true })); },
    reject: () => command.resolve(json({ detail: "Synthetic rejected deletion" }, 409)),
    failRead: (index: number) => reads[index].gate.resolve(json({ detail: "Synthetic reconciliation unavailable" }, 503)),
    settleRead: (index: number) => reads[index].gate.resolve(json(reads[index].snapshot)),
  };
}
async function open(v: Variant, task: ReturnType<typeof mount>, count = 25) {
  const user = userEvent.setup(), search = await screen.findByRole("textbox", { name: `搜索${v.noun}` });
  await user.type(search, "Fixture"); if (count > 10) await user.click(screen.getByRole("button", { name: "下一页" }));
  const target = count === 1 ? "Fixture 00" : "Fixture 10";
  await user.click(screen.getByRole("button", { name: `更多操作 ${target}` }));
  await user.click(await screen.findByRole("menuitem", { name: `${v.action} ${target}` })); const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "删除" })); expect(task.writes).toEqual([`DELETE /api/${v.kind}/${task.id}`]);
  return { user, search, target, dialog };
}
function oneDelete(v: Variant, task: ReturnType<typeof mount>) { expect(task.writes).toEqual([`DELETE /api/${v.kind}/${task.id}`]); expect(task.unexpected).toEqual([]); }
for (const v of variants) {
  it(`${v.page}: confirmed deletion removes only its cached row while a failed reread remains retryable`, async () => {
    const task = mount(v), opened = await open(v, task); await act(async () => task.accept());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull()); await waitFor(() => expect(task.reads).toHaveLength(1));
    expect(screen.queryByRole("button", { name: `更多操作 ${opened.target}` })).toBeNull();
    const survivingActions = within(screen.getByRole("group", { name: "Fixture 11 的操作" }));
    expect(survivingActions.getByRole("button", { name: "编辑" })).toHaveProperty("disabled", true);
    expect(survivingActions.getByRole("button", { name: "更多操作 Fixture 11" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: v.kind === "nodes" ? "添加端点" : "新建链路配置" })).toHaveProperty("disabled", false);
    expect(screen.getByText("第 2 / 3 页")).toBeTruthy();
    expect(document.activeElement).toBe(opened.search); await act(async () => task.failRead(0)); await screen.findByText("Synthetic reconciliation unavailable");
    expect(document.activeElement).toBe(opened.search); expect(screen.getByText("已删除")).toBeTruthy(); expect(screen.queryByRole("button", { name: `更多操作 ${opened.target}` })).toBeNull();
    expect(survivingActions.getByRole("button", { name: "编辑" })).toHaveProperty("disabled", true);
    const refresh = screen.getByRole("button", { name: `刷新${v.noun}` }); await opened.user.click(refresh); await opened.user.keyboard("{Enter} ");
    expect(task.reads).toHaveLength(2); await act(async () => task.settleRead(1)); await waitFor(() => expect(screen.queryByText("Synthetic reconciliation unavailable")).toBeNull());
    expect(screen.queryByRole("button", { name: `更多操作 ${opened.target}` })).toBeNull(); expect(document.activeElement).toBe(refresh); oneDelete(v, task);
  });
  it(`${v.page}: deleting the last known row preserves search without claiming confirmed empty before recovery`, async () => {
    const task = mount(v, 1), opened = await open(v, task, 1); await act(async () => task.accept());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull()); await waitFor(() => expect(task.reads).toHaveLength(1));
    expect(screen.queryByRole("button", { name: "更多操作 Fixture 00" })).toBeNull(); expect(screen.queryByText(`暂无${v.noun}`)).toBeNull();
    expect(opened.search.isConnected).toBe(true); expect(document.activeElement).toBe(opened.search);
    await act(async () => task.failRead(0)); await screen.findByText("Synthetic reconciliation unavailable"); expect(screen.queryByText(`暂无${v.noun}`)).toBeNull();
    await opened.user.click(screen.getByRole("button", { name: `刷新${v.noun}` })); await waitFor(() => expect(task.reads).toHaveLength(2)); await act(async () => task.settleRead(1));
    await screen.findByText(`暂无${v.noun}`); oneDelete(v, task);
  });
  it(`${v.page}: a pre-delete read finishing after failed reconciliation cannot reinsert the confirmed deleted row`, async () => {
    const task = mount(v), opened = await open(v, task);
    // The command was already sent while fresh. A new background read may race it.
    act(() => { void task.client.invalidateQueries({ queryKey: ["admin-state"] }); }); await waitFor(() => expect(task.reads).toHaveLength(1));
    await act(async () => task.accept()); await waitFor(() => expect(task.reads).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull()); await act(async () => task.failRead(1));
    await screen.findByText("Synthetic reconciliation unavailable"); await act(async () => task.settleRead(0));
    expect(screen.queryByRole("button", { name: `更多操作 ${opened.target}` })).toBeNull(); expect(screen.getByText("Synthetic reconciliation unavailable")).toBeTruthy();
    expect(document.activeElement).toBe(opened.search); oneDelete(v, task);
  });
  it(`${v.page}: confirmed result updates its own inventory after navigation without taking the newer page's focus`, async () => {
    const task = mount(v), opened = await open(v, task); act(() => fireEvent.click(screen.getByText("Other inventory")));
    const otherNoun = v.page === "nodes" ? "链路配置" : "连接端点"; const otherSearch = screen.getByRole("textbox", { name: `搜索${otherNoun}`, hidden: true });
    const focus = vi.spyOn(otherSearch, "focus"); await act(async () => task.accept()); await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(task.reads).toHaveLength(1)); await act(async () => task.failRead(0)); await screen.findByText("Synthetic reconciliation unavailable");
    expect(focus).not.toHaveBeenCalled();
    // Switching inventories creates its own table page; find the exact target
    // through the public search rather than assuming the old page number.
    await opened.user.clear(otherSearch); await opened.user.type(otherSearch, opened.target);
    expect(screen.getByRole("button", { name: `更多操作 ${opened.target}` })).toBeTruthy();
    await opened.user.click(screen.getByText("Other inventory")); expect(screen.queryByRole("button", { name: `更多操作 ${opened.target}` })).toBeNull(); oneDelete(v, task);
  });
}

for (const v of variants) {
  it.each(["held", "offline"] as const)(`${v.page}: confirmed deletion retains an intervening failed read until authoritative ${"%s"} recovery`, async phase => {
    const task = mount(v), opened = await open(v, task);
    act(() => { void task.client.invalidateQueries({ queryKey: ["admin-state"] }); }); await waitFor(() => expect(task.reads).toHaveLength(1));
    await act(async () => task.failRead(0)); await screen.findByText("Synthetic reconciliation unavailable");
    if (phase === "offline") act(() => onlineManager.setOnline(false));
    await act(async () => task.accept()); await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await screen.findByText(phase === "offline" ? `等待网络连接后刷新${v.noun}。` : `正在刷新${v.noun}…`);
    expect(screen.getByText("Synthetic reconciliation unavailable")).toBeTruthy(); expect(screen.getByText("已删除")).toBeTruthy();
    expect(screen.queryByRole("button", { name: `更多操作 ${opened.target}` })).toBeNull();
    expect(within(screen.getByRole("group", { name: "Fixture 11 的操作" })).getByRole("button", { name: "编辑" })).toHaveProperty("disabled", true);
    if (phase === "offline") { expect(task.reads).toHaveLength(1); act(() => onlineManager.setOnline(true)); }
    await waitFor(() => expect(task.reads).toHaveLength(2)); await act(async () => task.settleRead(1));
    await waitFor(() => expect(screen.queryByText("Synthetic reconciliation unavailable")).toBeNull()); oneDelete(v, task);
  });
}
