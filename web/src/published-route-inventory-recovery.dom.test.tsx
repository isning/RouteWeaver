// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { PublishedRoutesPage, type PublishedRoute } from "./PublishedRoutes";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const original: PublishedRoute = {
  id: "line", revisionToken: "revision-one", name: "Office line", deploymentId: "path",
  endpointIds: ["entry", "exit"], publicHost: "office.example", publicPort: 443,
  status: "draft", diagnostics: [],
};
const instance = { id: "core", hostId: "host", name: "Core", adapterId: "routeweaver/managed-xray", version: "26.3.27-rw1" };
const endpoints = ["entry", "exit", "other-entry", "other-exit"].map(id => ({
  id, name: id, instanceId: "core", authentication: "principals",
  connection: { protocol: "vless", host: "0.0.0.0", port: 443 },
}));
const deployments = ["path", "other-path"].map((id, index) => ({
  id, name: id, status: "draft", diagnostics: [],
  ir: { schemaVersion: "1.0", id, topologyRevision: "r1", programs: endpoints.slice(index * 2, index * 2 + 2).map(listener => ({ instance, listener, rules: [], resources: [], egress: [] })) },
}));
const clients: QueryClient[] = [];
const warning = "转发路径信息暂时无法读取，仍可查看线路。新建、编辑和更换出口前请重试。";
function setup(initialFailure = false, extra?: (path: string) => Response | Promise<Response> | undefined) {
  let failed = initialFailure;
  const calls: { path: string; method: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init?: RequestInit) => {
    const path = String(url);
    calls.push({ path, method: init?.method || "GET" });
    const response = extra?.(path);
    if (response) return response;
    if (path.endsWith("/hosts") && failed) return json({ error: "Inventory unavailable" }, 503);
    if (path.endsWith("/resolve")) return json({ ...original, name: "Resolved office line" });
    if (path.endsWith("/published-routes")) return json([original]);
    if (path.endsWith("/server-deployments")) return json(deployments);
    if (path.endsWith("/managed-endpoints")) return json(endpoints);
    if (path.endsWith("/core-instances")) return json([instance]);
    if (path.endsWith("/hosts")) return json([{ id: "host", name: "Host", address: "office.example" }]);
    if (path.endsWith("/state")) return json({ users: [], routes: [], publishedRoutes: [original] });
    return json([]);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders><PublishedRoutesPage /></UIProviders></QueryClientProvider>);
  return { calls, user: userEvent.setup(), fail: (value: boolean) => { failed = value; } };
}
beforeEach(() => {
  history.replaceState(null, "", "#published-routes");
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const originalStyle = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation(element => originalStyle(element));
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function focusPage() {
  await act(async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    window.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    window.dispatchEvent(new Event("visibilitychange"));
  });
}
it.each(["initial", "refresh"])("keeps independently loaded routes browsable after %s inventory failure and restores editing only after retry", async (phase) => {
  const { user, calls, fail } = setup(phase === "initial");
  if (phase === "refresh") {
    await waitFor(() => expect(screen.getByRole("button", { name: "编辑" }).hasAttribute("disabled")).toBe(false));
    fail(true);
    await focusPage();
  }
  await screen.findByText(warning);
  expect(screen.getByText("office.example:443")).toBeTruthy();
  expect(screen.getByRole("button", { name: "配置公开线路" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "配置用户入口" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "编辑" }).hasAttribute("disabled")).toBe(true);
  await user.click(screen.getByRole("button", { name: "Office line" }));
  const detail = within(await screen.findByRole("dialog", { name: "Resolved office line" }));
  expect(detail.getByRole("button", { name: "编辑线路" }).hasAttribute("disabled")).toBe(true);
  expect(detail.getByRole("button", { name: "更换出口" }).hasAttribute("disabled")).toBe(true);
  expect(calls.some(call => call.path.endsWith("/line/resolve"))).toBe(true);
  expect(detail.getByText(warning)).toBeTruthy();
  fail(false);
  await user.click(detail.getByRole("button", { name: "重试读取转发路径" }));
  await waitFor(() => expect(detail.queryByText(warning)).toBeNull());
  expect(detail.getByRole("button", { name: "编辑线路" }).hasAttribute("disabled")).toBe(false);
  expect(detail.getByRole("button", { name: "更换出口" }).hasAttribute("disabled")).toBe(false);
  await user.keyboard("{Escape}");
  expect(screen.getByRole("button", { name: "配置公开线路" }).hasAttribute("disabled")).toBe(false);
  expect(screen.getByRole("button", { name: "编辑" }).hasAttribute("disabled")).toBe(false);
  expect(calls.every(call => call.method === "GET")).toBe(true);
});

it("preserves an open editor and its draft when an inventory focus refresh fails", async () => {
  const { user, calls, fail } = setup();
  await waitFor(() => expect(screen.getByRole("button", { name: "编辑" }).hasAttribute("disabled")).toBe(false));
  await user.click(screen.getByRole("button", { name: "编辑" }));
  const editor = await screen.findByRole("dialog", { name: "编辑 Office line" });
  const input = within(editor).getByRole("textbox", { name: "线路名称" }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "My unfinished line" } });
  fail(true);
  await focusPage();
  await screen.findByText(warning);
  expect(screen.getByRole("dialog", { name: "编辑 Office line" })).toBe(editor);
  expect(input.value).toBe("My unfinished line");
  expect(calls.every(call => call.method === "GET")).toBe(true);
});

it("shows routes while initial inventory is pending without enabling inventory-dependent actions", async () => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  const { user } = setup(false, path => path.endsWith("/hosts") ? pending : undefined);
  const opener = await screen.findByRole("button", { name: "Office line" });
  expect(screen.getByText("正在核对转发路径，完成后可新建、编辑或更换出口。")).toBeTruthy();
  expect(screen.getByRole("button", { name: "编辑" }).hasAttribute("disabled")).toBe(true);
  await user.click(opener);
  const detail = within(await screen.findByRole("dialog", { name: "Resolved office line" }));
  expect(detail.getByText("正在核对转发路径，完成后可新建、编辑或更换出口。")).toBeTruthy();
  expect(detail.getByRole("button", { name: "编辑线路" }).hasAttribute("disabled")).toBe(true);
  await act(async () => finish(json([])));
  await waitFor(() => expect(detail.getByRole("button", { name: "编辑线路" }).hasAttribute("disabled")).toBe(false));
});

it("keeps the route list's own failed refresh blocking and retries that list independently", async () => {
  let listFails = false;
  const { user } = setup(false, path => path.endsWith("/published-routes") && listFails ? json({ error: "Routes unavailable" }, 503) : undefined);
  await screen.findByRole("button", { name: "Office line" });
  listFails = true;
  await focusPage();
  await screen.findByText("Routes unavailable");
  expect(screen.queryByRole("button", { name: "Office line" })).toBeNull();
  expect(screen.queryByText(warning)).toBeNull();
  listFails = false;
  await user.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByRole("button", { name: "Office line" });
});

it("treats missing inventory as unknown for a selected user's entry and permits preparation after recovery", async () => {
  const { user, fail, calls } = setup(true, path => {
    if (path.endsWith("/state")) return json({ users: [{ id: "alice", name: "Alice", status: "active" }], routes: [], publishedRoutes: [original] });
    if (path.endsWith("/effective-policy")) return json({ userId: "alice", status: "active", routeIds: ["line"], provenance: { routes: "direct" } });
  });
  await screen.findByText(warning);
  await user.click(screen.getByRole("button", { name: "Office line" }));
  const detail = within(await screen.findByRole("dialog", { name: "Resolved office line" }));
  await user.click(await detail.findByRole("combobox", { name: "线路使用用户" }));
  await user.click(await screen.findByRole("option", { name: "Alice" }));
  await detail.findByText("已获准使用此线路");
  await detail.findByText("尚未准备此用户的独立入口");
  expect(detail.queryByText("此入口暂不能分配独立用户")).toBeNull();
  const prepare = detail.getByRole("button", { name: "准备独立入口" });
  expect(prepare.hasAttribute("disabled")).toBe(true);
  await user.click(prepare);
  expect(screen.queryByRole("dialog", { name: "配置「Resolved office line」的用户入口" })).toBeNull();
  fail(false);
  await user.click(detail.getByRole("button", { name: "重试读取转发路径" }));
  await waitFor(() => expect(prepare.hasAttribute("disabled")).toBe(false));
  expect(detail.queryByText("此入口暂不能分配独立用户")).toBeNull();
  await user.click(prepare);
  const editor = within(await screen.findByRole("dialog", { name: "配置「Resolved office line」的用户入口" }));
  expect(editor.queryByText("此入口暂不能分配独立用户")).toBeNull();
  expect(calls.every(call => call.method === "GET")).toBe(true);
});
