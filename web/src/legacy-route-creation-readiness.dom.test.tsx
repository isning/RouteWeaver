// @vitest-environment jsdom
// Legacy link-configuration creation only, not ServerRoutesPage forwarding.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { AdminPage } from "./Admin";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup(page: "legacy-routes" | "nodes" | "users" = "legacy-routes") {
  let failed = false;
  let release!: (response: Response) => void;
  let held: Promise<Response> | undefined = new Promise(resolve => { release = resolve; });
  const state = {
    users: [{ id: "user-one", name: "Known account", enabled: true, quotaBytes: 0, usedBytes: 0 }],
    nodes: [{ id: "node-one", name: "Known endpoint", protocol: "socks", host: "example.invalid", port: 1080 }],
    routes: [], revisions: [],
    capabilities: [
      { id: "xray", name: "Known Xray", protocols: ["socks"], maxHops: 3 },
      { id: "sing-box", name: "Known sing-box", protocols: ["socks"], maxHops: 2 },
    ],
  };
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = String(url), method = init?.method || "GET";
    requests.push(`${method} ${path}`);
    if (method !== "GET") throw new Error(`Unexpected write ${method} ${path}`);
    if (path === "/api/state") return held ?? (failed ? json({ detail: "Inventory unavailable" }, 503) : json(state));
    if (["/api/services", "/api/published-routes", "/api/user-groups"].includes(path)) return json([]);
    throw new Error(`Unexpected read ${path}`);
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><UIProviders><AdminPage page={page} /></UIProviders></QueryClientProvider>);
  return { requests, release, response: () => json(state), recover: () => { held = undefined; failed = false; }, fail: () => { held = undefined; failed = true; } };
}

it("does not queue legacy creation while initial inventory is unavailable, then uses recovered capabilities", async () => {
  const task = setup();
  const user = userEvent.setup();
  const add = screen.getByRole("button", { name: "新建链路配置" });
  expect(add).toHaveProperty("disabled", true);
  await user.click(add);
  task.fail(); await act(async () => task.release(json({ detail: "Inventory unavailable" }, 503)));
  await screen.findByText("Inventory unavailable");
  expect(add).toHaveProperty("disabled", true);
  await user.click(add);
  expect(screen.queryByRole("dialog")).toBeNull();
  task.recover();
  await user.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByRole("textbox", { name: "搜索链路配置", hidden: true });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(add).toHaveProperty("disabled", false);
  await user.click(add);
  const dialog = await screen.findByRole("dialog", { name: "新建链路配置" });
  expect(within(dialog).getByRole("combobox", { name: "配置目标" }).textContent).toContain("Known Xray");
  await user.click(within(dialog).getByRole("combobox", { name: "添加下一跳" }));
  expect(await screen.findByRole("option", { name: "Known endpoint" })).toBeTruthy();
  await user.keyboard("{Escape}");
  await user.click(within(dialog).getByRole("combobox", { name: "可使用此链路配置的用户" }));
  expect(await screen.findByRole("option", { name: "Known account" })).toBeTruthy();
  expect(task.requests.every(request => request.startsWith("GET "))).toBe(true);
});

it("requires an explicit new legacy task after a successful initial held read", async () => {
  const task = setup();
  const add = screen.getByRole("button", { name: "新建链路配置" });
  expect(add).toHaveProperty("disabled", true);
  await userEvent.click(add);
  task.recover(); await act(async () => task.release(task.response()));
  await screen.findByRole("textbox", { name: "搜索链路配置" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(add).toHaveProperty("disabled", false);
  await userEvent.click(add);
  const dialog = await screen.findByRole("dialog", { name: "新建链路配置" });
  expect(within(dialog).getByRole("combobox", { name: "配置目标" }).textContent).toContain("Known Xray");
});

it("allows cached legacy creation and preserves its draft during later inventory recovery and failure", async () => {
  const task = setup();
  const user = userEvent.setup();
  task.recover(); await act(async () => task.release(task.response()));
  await screen.findByRole("textbox", { name: "搜索链路配置" });
  task.fail(); await act(async () => { await client.invalidateQueries({ queryKey: ["admin-state"] }); });
  await screen.findByText("Inventory unavailable");
  const add = screen.getByRole("button", { name: "新建链路配置" });
  expect(add).toHaveProperty("disabled", false);
  await user.click(add);
  const name = await screen.findByRole("textbox", { name: "链路配置名称" });
  await user.type(name, "Unsaved legacy route");
  task.recover(); await act(async () => { await client.invalidateQueries({ queryKey: ["admin-state"] }); });
  await waitFor(() => expect(screen.queryByText("Inventory unavailable")).toBeNull());
  task.fail(); await act(async () => { await client.invalidateQueries({ queryKey: ["admin-state"] }); });
  await screen.findByText("Inventory unavailable");
  expect(screen.getByRole("textbox", { name: "链路配置名称" })).toBe(name);
  expect(name).toHaveProperty("value", "Unsaved legacy route");
  expect(document.activeElement).toBe(name);
  expect(task.requests.every(request => request.startsWith("GET "))).toBe(true);
});

for (const taskName of ["node", "user", "invite"] as const) {
  it.each(["pending", "failed"])(`keeps independent ${taskName} creation available while inventory is %s`, async (phase) => {
    const task = setup(taskName === "node" ? "nodes" : "users");
    if (phase === "failed") {
      task.fail(); await act(async () => task.release(json({ detail: "Inventory unavailable" }, 503)));
      await screen.findByText("Inventory unavailable");
    }
    const label = taskName === "node" ? "添加端点" : taskName === "user" ? "添加用户" : "邀请用户";
    const add = screen.getByRole("button", { name: label });
    expect(add).toHaveProperty("disabled", false);
    await userEvent.click(add);
    expect(await screen.findByRole("dialog", { name: label })).toBeTruthy();
    expect(task.requests.every(request => request.startsWith("GET "))).toBe(true);
  });
}
