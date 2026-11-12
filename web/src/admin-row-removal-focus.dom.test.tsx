// @vitest-environment jsdom
// Public removal task: real AdminPage, row menu, confirmation, API and query integration.
// Every fetch is intercepted. Only named synthetic in-memory records can be removed.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { AdminPage } from "./Admin";
import { UIProviders } from "./ui-patterns/providers";

type Page = "nodes" | "legacy-routes";
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const variants = [
  { page: "nodes", kind: "nodes", noun: "连接端点", action: "删除端点" },
  { page: "legacy-routes", kind: "routes", noun: "链路配置", action: "删除链路配置" },
] as const;
type Variant = typeof variants[number];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(settle => { resolve = settle; }); return { promise, resolve }; }
function mount(v: Variant, mode: "remove" | "retain" | "fail" = "remove", count = 25) {
  const names = Array.from({ length: count }, (_, i) => ({ id: `fixture-${i}`, name: `Fixture ${String(i).padStart(2, "0")}` }));
  const state = {
    nodes: names.map(n => ({ ...n, protocol: "socks", host: "fixture.example", port: 1080, region: "Test" })),
    routes: names.map(r => ({ ...r, engine: "sing-box", hops: ["fixture-0"], userIds: [] })),
    users: [], revisions: [], capabilities: [],
  };
  const deleted = structuredClone(state);
  if (mode !== "retain") {
    if (v.kind === "nodes") deleted.nodes = deleted.nodes.filter(n => n.id !== "fixture-10");
    else deleted.routes = deleted.routes.filter(r => r.id !== "fixture-10");
  }
  const command = deferred<Response>(), inventory = deferred<Response>();
  const requests: string[] = [], writes: string[] = [], unexpected: string[] = [];
  let stateReads = 0;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = String(url), method = init?.method || "GET", key = `${method} ${path}`;
    requests.push(key);
    if (key === `DELETE /api/${v.kind}/fixture-10`) { writes.push(key); return command.promise; }
    if (method !== "GET") { unexpected.push(key); throw new Error(`No other mutation permitted: ${key}`); }
    if (path === "/api/state") return ++stateReads === 1 ? json(state) : inventory.promise;
    if (["/api/services", "/api/published-routes", "/api/user-groups", "/api/rates"].includes(path)) return json([]);
    unexpected.push(key); throw new Error(`Unexpected request: ${key}`);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  function Harness() {
    const [page, setPage] = useState<Page>(v.page);
    const [version, setVersion] = useState(0);
    return <><button onClick={() => setVersion(version + 1)}>Replace inventory owner</button><button onClick={() => setPage(page === "nodes" ? "legacy-routes" : "nodes")}>Go to other inventory</button><button>Independent newer control</button><AdminPage key={version} page={page} /></>;
  }
  render(<QueryClientProvider client={client}><UIProviders><Harness /></UIProviders></QueryClientProvider>);
  return {
    writes, unexpected, requests, get fetching() { return client.isFetching(); }, get reads() { return stateReads; },
    accept: () => command.resolve(mode === "fail" ? json({ detail: "Synthetic removal rejected" }, 409) : json({ ok: true })),
    reconcile: () => inventory.resolve(json(deleted)),
    rejectInventory: () => inventory.resolve(json({ detail: "Synthetic inventory unavailable" }, 503)),
  };
}
async function openDecision(v: Variant) {
  const user = userEvent.setup();
  const search = await screen.findByRole("textbox", { name: `搜索${v.noun}` });
  await user.type(search, "Fixture");
  await user.click(screen.getByRole("button", { name: "下一页" }));
  const opener = screen.getByRole("button", { name: "更多操作 Fixture 10" });
  act(() => opener.focus());
  await user.keyboard("{Enter}");
  await screen.findByRole("menuitem", { name: `${v.action} Fixture 10` });
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("alertdialog", { name: `${v.action}「Fixture 10」？` });
  await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "保留" })));
  return { user, search, opener, dialog };
}
async function acceptDecision(task: ReturnType<typeof mount>, opened: Awaited<ReturnType<typeof openDecision>>) {
  const { user, dialog } = opened;
  await user.tab(); expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "删除" }));
  await user.keyboard("{Enter}");
  expect(task.writes).toHaveLength(1);
  expect(dialog.getAttribute("aria-busy")).toBe("true");
  await act(async () => task.accept());
}
it.each(variants)("$page: successful removal returns to inventory search before its delayed reread", async v => {
  const task = mount(v); const opened = await openDecision(v);
  await acceptDecision(task, opened);
  await waitFor(() => expect(task.reads).toBe(2));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(opened.opener.isConnected).toBe(true);
  await waitFor(() => expect(document.activeElement).toBe(opened.search));
  await act(async () => task.reconcile());
  await waitFor(() => expect(opened.opener.isConnected).toBe(false));
  expect(document.activeElement).toBe(opened.search);
  expect(opened.search).toHaveProperty("value", "Fixture");
  expect(screen.getByText("第 2 / 3 页")).toBeTruthy();
  expect(task.writes).toEqual([`DELETE /api/${v.kind}/fixture-10`]);
  expect(task.unexpected).toEqual([]);
});
it.each(variants)("$page: cancel keeps the source row and returns focus without a DELETE", async v => {
  const task = mount(v); const opened = await openDecision(v);
  await opened.user.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opened.opener));
  expect(opened.opener.isConnected).toBe(true); expect(task.writes).toEqual([]); expect(task.reads).toBe(1); expect(task.unexpected).toEqual([]);
});

it.each(variants)("$page: failed DELETE keeps the confirmation retryable and Cancel returns to its row", async v => {
  const task = mount(v, "fail"); const opened = await openDecision(v);
  await acceptDecision(task, opened);
  await within(opened.dialog).findByText("Synthetic removal rejected");
  expect(screen.getByRole("alertdialog")).toBe(opened.dialog);
  expect(within(opened.dialog).getByRole("button", { name: "删除" })).toHaveProperty("disabled", false);
  expect(task.reads).toBe(1); expect(opened.opener.isConnected).toBe(true);
  await opened.user.click(within(opened.dialog).getByRole("button", { name: "保留" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opened.opener));
  expect(task.writes).toEqual([`DELETE /api/${v.kind}/fixture-10`]); expect(task.unexpected).toEqual([]);
});

for (const mode of ["other-control", "other-control-then-body", "navigation", "new-dialog"] as const) {
  it.each(variants)(`$page: delayed removal does not steal newer ${mode} focus`, async v => {
    const task = mount(v); const opened = await openDecision(v);
    await acceptDecision(task, opened);
    await waitFor(() => expect(task.reads).toBe(2));
    await waitFor(() => expect(document.activeElement).toBe(opened.search));
    let owner: Element;
    if (mode === "navigation") {
      const navigation = screen.getByRole("button", { name: "Go to other inventory" });
      await opened.user.click(navigation);
      await screen.findByRole("textbox", { name: v.page === "nodes" ? "搜索链路配置" : "搜索连接端点" });
      owner = navigation;
    } else if (mode === "new-dialog") {
      const row = screen.getByRole("group", { name: "Fixture 11 的操作" });
      await opened.user.click(within(row).getByRole("button", { name: "编辑" }));
      await screen.findByRole("dialog");
      await waitFor(() => expect(document.activeElement?.closest('[role="dialog"]')).toBeTruthy());
      owner = document.activeElement!;
    } else {
      const newer = screen.getByRole("button", { name: "Independent newer control" });
      await opened.user.click(newer);
      owner = newer;
      if (mode === "other-control-then-body") { act(() => newer.blur()); owner = document.body; }
    }
    expect(document.activeElement).toBe(owner);
    await act(async () => task.reconcile());
    if (mode !== "navigation") await waitFor(() => expect(opened.opener.isConnected).toBe(false));
    expect(document.activeElement).toBe(owner); expect(task.unexpected).toEqual([]);
  });
}


it.each(variants)("$page: successful removal selects stable search even when the reread retains its row", async v => {
  const task = mount(v, "retain"); const opened = await openDecision(v);
  await acceptDecision(task, opened);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opened.search));
  await act(async () => task.reconcile());
  await waitFor(() => expect(task.fetching).toBe(0));
  expect(opened.opener.isConnected).toBe(true); expect(document.activeElement).toBe(opened.search);
  expect(task.writes).toEqual([`DELETE /api/${v.kind}/fixture-10`]); expect(task.unexpected).toEqual([]);
});

it.each(variants)("$page: already-ready inventory removes the row without losing the completed action destination", async v => {
  const task = mount(v); const opened = await openDecision(v);
  await act(async () => task.reconcile());
  await acceptDecision(task, opened);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(opened.opener.isConnected).toBe(false));
  await waitFor(() => expect(document.activeElement).toBe(opened.search));
  expect(task.writes).toEqual([`DELETE /api/${v.kind}/fixture-10`]); expect(task.unexpected).toEqual([]);
});

it.each(variants)("$page: removal of the only row on the last page preserves search and accessible pagination", async v => {
  const task = mount(v, "remove", 11); const opened = await openDecision(v);
  expect(screen.getByText("第 2 / 2 页")).toBeTruthy();
  await acceptDecision(task, opened);
  await waitFor(() => expect(document.activeElement).toBe(opened.search));
  await act(async () => task.reconcile());
  await waitFor(() => expect(opened.opener.isConnected).toBe(false));
  await screen.findByRole("button", { name: "更多操作 Fixture 00" });
  expect(screen.queryByRole("button", { name: "下一页" })).toBeNull();
  expect(document.activeElement).toBe(opened.search);
  expect(task.writes).toEqual([`DELETE /api/${v.kind}/fixture-10`]); expect(task.unexpected).toEqual([]);
});

for (const timing of ["before-close", "after-close"] as const) {
  it.each(variants)(`$page: inventory failure ${timing} does not turn a successful removal into a failed or pending command`, async v => {
    const task = mount(v); const opened = await openDecision(v);
    if (timing === "before-close") await act(async () => task.rejectInventory());
    await acceptDecision(task, opened);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    if (timing === "after-close") {
      await waitFor(() => expect(document.activeElement).toBe(opened.search));
      const newer = screen.getByRole("button", { name: "Independent newer control" });
      await opened.user.click(newer);
      await act(async () => task.rejectInventory());
      await screen.findByText("Synthetic inventory unavailable");
      expect(document.activeElement).toBe(newer);
    } else await screen.findByText("Synthetic inventory unavailable");
    expect(screen.getByText("已删除")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).not.toBe(opened.opener);
    expect(task.writes).toEqual([`DELETE /api/${v.kind}/fixture-10`]); expect(task.unexpected).toEqual([]);
  });
}

for (const transition of ["other-page", "away-and-back", "replacement-owner"] as const) {
  it.each(variants)(`$page: late command success cannot select search after ${transition}`, async v => {
    const task = mount(v); const opened = await openDecision(v);
    await opened.user.tab(); await opened.user.keyboard("{Enter}");
    expect(task.writes).toHaveLength(1);
    // Model an owner-driven navigation/remount through AdminPage's public props,
    // not an impossible pointer interaction through a pending modal mask.
    if (transition === "replacement-owner") {
      act(() => fireEvent.click(screen.getByText("Replace inventory owner")));
    } else {
      act(() => fireEvent.click(screen.getByText("Go to other inventory")));
      if (transition === "away-and-back") act(() => fireEvent.click(screen.getByText("Go to other inventory")));
    }
    const currentSearch = screen.getByLabelText(transition === "other-page" ? (v.page === "nodes" ? "搜索链路配置" : "搜索连接端点") : `搜索${v.noun}`);
    const focus = vi.spyOn(currentSearch, "focus");
    await act(async () => task.accept());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(focus).not.toHaveBeenCalled();
    const newer = screen.getByRole("button", { name: "Independent newer control" });
    await opened.user.click(newer); act(() => newer.blur());
    await act(async () => task.reconcile());
    await waitFor(() => expect(task.fetching).toBe(0));
    expect(document.activeElement).toBe(document.body); expect(focus).not.toHaveBeenCalled();
    expect(task.writes).toEqual([`DELETE /api/${v.kind}/fixture-10`]); expect(task.unexpected).toEqual([]);
  });
}
