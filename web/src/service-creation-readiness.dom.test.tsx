// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { AdminPage } from "./Admin";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
let client: QueryClient;
beforeEach(() => {
  onlineManager.setOnline(true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup(); client?.clear(); onlineManager.setOnline(true);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function setup() {
  let failed = false;
  let release!: (response: Response) => void;
  let held: Promise<Response> | undefined = new Promise(resolve => { release = resolve; });
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = String(url), method = init?.method || "GET";
    requests.push(`${method} ${path}`);
    if (method !== "GET") throw new Error(`Unexpected write ${method} ${path}`);
    if (path === "/api/services") return held ?? (failed ? json({ detail: "Services unavailable" }, 503) : json([]));
    if (path === "/api/state") return json({ users: [], nodes: [], routes: [], revisions: [], capabilities: [] });
    if (path === "/api/published-routes") return json([{ id: "route-one", name: "Available route", status: "published" }]);
    if (path.startsWith("/api/access-policy/edit-context/service/")) return json({
      target: { kind: "service", id: path.split("/").at(-1) }, record: null,
      precondition: { exists: false, revision: "creation-1" },
    });
    throw new Error(`Unexpected read ${path}`);
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><UIProviders><AdminPage page="services" /></UIProviders></QueryClientProvider>);
  return { requests, release, recover: () => { held = undefined; failed = false; }, fail: () => { held = undefined; failed = true; } };
}

it("does not defer initial New clicks until a failed inventory read later recovers", async () => {
  const task = setup();
  const user = userEvent.setup();
  const add = screen.getByRole("button", { name: "新建方案" });
  expect(add).toHaveProperty("disabled", true);
  await user.click(add);
  task.fail();
  await act(async () => task.release(json({ detail: "Services unavailable" }, 503)));
  await screen.findByText("Services unavailable");
  expect(add).toHaveProperty("disabled", true);
  await user.click(add);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(task.requests.some(request => request.includes("/edit-context/"))).toBe(false);
  task.recover();
  await user.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByText("暂无服务方案");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(task.requests.some(request => request.includes("/edit-context/"))).toBe(false);
  expect(add).toHaveProperty("disabled", false);
  await user.click(add);
  expect(await screen.findByRole("textbox", { name: "服务方案名称" })).toHaveProperty("value", "");
  expect(task.requests.filter(request => request.includes("/edit-context/"))).toHaveLength(1);
  expect(task.requests.every(request => request.startsWith("GET "))).toBe(true);
});

it.each([false, true])("requires a new explicit click after initial held inventory settles (offline=%s)", async (offline) => {
  if (offline) act(() => onlineManager.setOnline(false));
  const task = setup();
  const user = userEvent.setup();
  const add = screen.getByRole("button", { name: "新建方案" });
  expect(add).toHaveProperty("disabled", true);
  await user.click(add);
  if (offline) {
    await screen.findByText("等待网络连接");
    expect(task.requests).toEqual([]);
    act(() => onlineManager.setOnline(true));
  }
  task.recover(); await act(async () => task.release(json([])));
  await screen.findByText("暂无服务方案");
  expect(add).toHaveProperty("disabled", false);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(task.requests.some(request => request.includes("/edit-context/"))).toBe(false);
  await user.click(add);
  await screen.findByRole("textbox", { name: "服务方案名称" });
  await user.click(screen.getByRole("combobox", { name: "方案授权线路" }));
  expect(await screen.findByRole("option", { name: "Available route" })).toBeTruthy();
  expect(task.requests.every(request => request.startsWith("GET "))).toBe(true);
});

it("allows explicit creation from cached inventory and keeps the draft during later read failure", async () => {
  const task = setup();
  const user = userEvent.setup();
  task.recover(); await act(async () => task.release(json([])));
  await screen.findByText("暂无服务方案");
  task.fail();
  await act(async () => { await client.invalidateQueries({ queryKey: ["admin-state"] }); });
  await screen.findByText("Services unavailable");
  const add = screen.getByRole("button", { name: "新建方案" });
  expect(add).toHaveProperty("disabled", false);
  await user.click(add);
  const name = await screen.findByRole("textbox", { name: "服务方案名称" });
  await user.type(name, "Unsaved new service");
  task.recover();
  await act(async () => { await client.invalidateQueries({ queryKey: ["admin-state"] }); });
  await waitFor(() => expect(screen.queryByText("Services unavailable")).toBeNull());
  task.fail();
  await act(async () => { await client.invalidateQueries({ queryKey: ["admin-state"] }); });
  await screen.findByText("Services unavailable");
  expect(screen.getByRole("textbox", { name: "服务方案名称" })).toBe(name);
  expect(name).toHaveProperty("value", "Unsaved new service");
  expect(document.activeElement).toBe(name);
  expect(task.requests.filter(request => request.includes("/edit-context/"))).toHaveLength(1);
  expect(task.requests.every(request => request.startsWith("GET "))).toBe(true);
});
