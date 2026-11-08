// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { ServerRoutesPage } from "./ServerRoutes";
import { WorkspaceHistoryContext } from "./SubscriptionContext";
import { createWorkspaceHistory, type WorkspaceHistory } from "./workspace-history";
import { hasUnsavedChanges } from "./navigation";
import type { ServerDeployment } from "./types";

const host = { id: "server", name: "Original server", address: "127.0.0.1" };
const instance = { id: "core", hostId: host.id, name: "Original core", adapterId: "routeweaver/xray", version: "26.10.31" };
const listener = { id: "listener", instanceId: instance.id, name: "Selected listener", connection: { protocol: "socks", host: "127.0.0.1", port: 1080, username: "fixture", password: "synthetic-only" } };
const origin = "#routes?entryEndpoint=listener&returnHost=server&returnInstance=core";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
let client: QueryClient;
let controller: WorkspaceHistory;
afterEach(() => {
  cleanup();
  controller?.dispose();
  client?.clear();
  history.replaceState(null, "", "#routes");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(hash = origin, reveal?: () => Promise<Response>) {
  history.replaceState(null, "", hash);
  const requests: string[] = [];
  const saved: ServerDeployment[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = String(url);
    const method = init?.method || "GET";
    requests.push(`${method} ${path}`);
    if (path === "/api/hosts") return json([host]);
    if (path === "/api/core-instances") return json([instance]);
    if (path === "/api/managed-endpoints") return json([{ ...listener, connection: { protocol: "socks", host: "127.0.0.1", port: 1080 } }]);
    if (path === "/api/managed-endpoints/listener/reveal") return reveal ? reveal() : json(listener);
    if (path === "/api/server-deployments" && method === "POST") {
      const value = JSON.parse(String(init?.body)) as ServerDeployment;
      saved.push(value);
      return json(value);
    }
    if (path === "/api/server-deployments" && method === "GET") return json(saved);
    if (path === "/api/links") return json([]);
    if (path.endsWith("/state")) return json({ instanceId: instance.id, phase: "unregistered" });
    return json({ detail: "Unexpected request" }, 503);
  }));
  const decisions: { proceed(): void; cancel(): void }[] = [];
  controller = createWorkspaceHistory({
    isDirty: hasUnsavedChanges,
    confirm: (proceed, cancel) => { decisions.push({ proceed, cancel }); },
    accept: () => {},
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<WorkspaceHistoryContext.Provider value={{ current: controller }}>
    <QueryClientProvider client={client}><UIProviders><ServerRoutesPage /></UIProviders></QueryClientProvider>
  </WorkspaceHistoryContext.Provider>);
  return { requests, decisions };
}

it("starts an unsaved path with only the exact revealed listener and its original server return link", async () => {
  const { requests } = mount();
  const editor = await screen.findByRole("dialog", { name: "新建转发路径" });
  expect(within(editor).getByRole("combobox", { name: "第 1 跳端点" }).textContent).toContain("Selected listener");
  expect(within(editor).getByRole("link", { name: "返回原服务器" }).getAttribute("href")).toBe("#servers?host=server&instance=core");
  expect(within(editor).getByText("从入口服务器直接访问目标")).toBeTruthy();
  expect(hasUnsavedChanges()).toBe(true);
  expect(requests.filter((request) => request.endsWith("/reveal"))).toEqual(["GET /api/managed-endpoints/listener/reveal"]);
  expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
  expect(editor.textContent).not.toContain("synthetic-only");
});

it.each([
  "#routes?entryEndpoint=",
  "#routes?entryEndpoint=missing",
  "#routes?entryEndpoint=listener&entryEndpoint=missing",
  "#routes?entryEndpoint=..%2Fother",
  "#routes?entryEndpoint=listener&deployment=another",
  "#routes?entryEndpoint=listener&returnHost=wrong&returnInstance=core",
  "#routes?entryEndpoint=listener&returnHost=server&returnHost=other",
  "#routes?entryEndpoint=listener&returnInstance=core&returnInstance=other",
])("rejects missing, malformed or conflicting context before any reveal (%s)", async (hash) => {
  const { requests } = mount(hash);
  await screen.findByText(/找不到指定的入口监听|入口监听与原服务器不一致/);
  expect(screen.queryByRole("dialog", { name: "新建转发路径" })).toBeNull();
  expect(requests.some((request) => request.endsWith("/reveal"))).toBe(false);
  expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
});

it("retains the contextual task after a failed reveal and only retries on request", async () => {
  const user = userEvent.setup();
  let failing = true;
  const { requests } = mount(origin, async () => failing ? json({ detail: "Cannot read selected endpoint" }, 503) : json(listener));
  const retry = await screen.findByRole("button", { name: "重新读取入口" });
  expect(screen.queryByRole("dialog", { name: "新建转发路径" })).toBeNull();
  failing = false;
  await user.click(retry);
  await screen.findByRole("dialog", { name: "新建转发路径" });
  expect(requests.filter((request) => request.endsWith("/reveal"))).toHaveLength(2);
  expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
});

it("rejects changed listener ownership rather than using another core from the response", async () => {
  mount(origin, async () => json({ ...listener, instanceId: "another-core" }));
  await screen.findByText("入口监听的所属核心已变化，请返回服务器重新选择。");
  expect(screen.queryByRole("dialog", { name: "新建转发路径" })).toBeNull();
});

it("does not reopen a delayed contextual draft after newer same-page navigation", async () => {
  let release!: (value: Response) => void;
  const delayed = new Promise<Response>((done) => { release = done; });
  mount(origin, () => delayed);
  await screen.findByText("正在读取入口监听…");
  await act(async () => controller.navigate("#routes"));
  await act(async () => release(json(listener)));
  expect(location.hash).toBe("#routes");
  expect(screen.queryByRole("dialog", { name: "新建转发路径" })).toBeNull();
});

it("does not initialize a draft if its registered owner disappears during the reveal", async () => {
  let release!: (value: Response) => void;
  const delayed = new Promise<Response>((done) => { release = done; });
  const { requests } = mount(origin, () => delayed);
  await screen.findByText("正在读取入口监听…");
  await act(async () => {
    client.setQueryData(["infrastructure"], { hosts: [host], instances: [], endpoints: [listener], links: [], deployments: [] });
    // Resolve before React Query's scheduled observer notification: the cache
    // is authoritative even while the previous inventory is still rendered.
    release(json(listener));
  });
  await screen.findByText("入口监听的所属核心已变化，请返回服务器重新选择。");
  expect(screen.queryByRole("dialog", { name: "新建转发路径" })).toBeNull();
  expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
});

it("preserves the selected entry and typed name when dirty navigation is cancelled", async () => {
  const user = userEvent.setup();
  const { decisions, requests } = mount();
  const editor = await screen.findByRole("dialog", { name: "新建转发路径" });
  await user.type(within(editor).getByRole("textbox", { name: "转发路径名称" }), "Keep my path");
  await act(async () => controller.navigate("#routes?entryEndpoint=missing"));
  expect(decisions).toHaveLength(1);
  expect(location.hash).toBe(origin);
  act(() => decisions[0].cancel());
  expect((within(editor).getByRole("textbox", { name: "转发路径名称" }) as HTMLInputElement).value).toBe("Keep my path");
  expect(within(editor).getByRole("combobox", { name: "第 1 跳端点" }).textContent).toContain("Selected listener");
  await act(async () => controller.navigate("#routes?entryEndpoint=missing"));
  expect(decisions).toHaveLength(2);
  await act(async () => decisions[1].proceed());
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建转发路径" })).toBeNull());
  await screen.findByText("找不到指定的入口监听，请返回服务器选择当前可用的端点。");
  expect(requests.filter((request) => request.endsWith("/reveal"))).toHaveLength(1);
});

it("asks before discarding a prefilled draft and consumes its creation link after closing", async () => {
  const user = userEvent.setup();
  mount();
  const editor = await screen.findByRole("dialog", { name: "新建转发路径" });
  await user.click(within(editor).getByRole("button", { name: "关闭" }));
  const confirmation = await screen.findByRole("alertdialog", { name: "放弃尚未保存的转发路径修改？" });
  await user.click(within(confirmation).getByRole("button", { name: "继续编辑" }));
  expect(within(editor).getByRole("combobox", { name: "第 1 跳端点" }).textContent).toContain("Selected listener");
  await user.click(within(editor).getByRole("button", { name: "关闭" }));
  await user.click(within(await screen.findByRole("alertdialog", { name: "放弃尚未保存的转发路径修改？" })).getByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建转发路径" })).toBeNull());
  expect(location.hash).toBe("#routes?returnHost=server&returnInstance=core");
  expect(hasUnsavedChanges()).toBe(false);
});

it("replaces the creation context with the saved deployment identity only after an explicit save", async () => {
  const user = userEvent.setup();
  const { requests } = mount();
  const editor = await screen.findByRole("dialog", { name: "新建转发路径" });
  await user.type(within(editor).getByRole("textbox", { name: "转发路径名称" }), "Saved selected entry");
  expect(requests.some((request) => request.startsWith("POST "))).toBe(false);
  await user.click(within(editor).getByRole("button", { name: "保存草稿" }));
  await screen.findByRole("dialog", { name: "Saved selected entry" });
  const context = new URLSearchParams(location.hash.split("?")[1]);
  expect(context.has("entryEndpoint")).toBe(false);
  expect(context.get("deployment")).toBeTruthy();
  expect(context.get("returnHost")).toBe("server");
  expect(context.get("returnInstance")).toBe("core");
  expect(requests.filter((request) => request.startsWith("POST "))).toEqual(["POST /api/server-deployments"]);
});
