// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi, type TestContext } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ServerRoutesPage } from "./ServerRoutes";
import { UIProviders } from "./ui-patterns/providers";
import { holdPopoverExit } from "./test-support/hold-popover-exit";
import { ownedClickScenario } from "./test-support/owned-click-scenario";
import type { CoreInstance, HostRecord, ManagedEndpoint } from "./types";

const host: HostRecord = { id: "first-host", name: "首次服务器", address: "127.0.0.1" };
const core: CoreInstance = { id: "first-core", hostId: host.id, name: "受管核心", adapterId: "routeweaver/managed-xray", version: "26.3.27-rw1" };
const endpoint: ManagedEndpoint = { id: "first-listener", instanceId: core.id, name: "用户入口", authentication: "principals", connection: { protocol: "vless", host: "0.0.0.0", port: 23456 } };
const clients: QueryClient[] = [];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  history.replaceState(null, "", "#routes");
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  history.replaceState(null, "", "#routes");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function startSelection(context: TestContext) {
  const owner = ownedClickScenario(context);
  const user = userEvent.setup();
  let deliver!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { deliver = resolve; });
  context.onTestFinished(() => deliver(json({ error: "Retired test response" }, 503)));
  const reveals: string[] = [];
  const mutations: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init?: RequestInit) => {
    const path = String(url);
    if (init?.method && init.method !== "GET") mutations.push(`${init.method} ${path}`);
    if (path === `/api/managed-endpoints/${endpoint.id}/reveal`) {
      reveals.push(endpoint.id);
      return pending;
    }
    const data: Record<string, unknown> = {
      "/api/hosts": [host], "/api/core-instances": [core],
      "/api/managed-endpoints": [endpoint], "/api/links": [], "/api/server-deployments": [],
    };
    if (!(path in data)) throw new Error(`Unexpected request: ${path}`);
    return json(data[path]);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders><ServerRoutesPage /></UIProviders></QueryClientProvider>);
  const heading = screen.getByRole("heading", { name: "转发路径", level: 1 }).closest("header")!;
  await owner.click(() => within(heading).getByRole("button", { name: "新建转发路径" }));
  const dialog = await screen.findByRole("dialog", { name: "新建转发路径" });
  owner.assertActive();
  const editor = within(dialog);
  const server = editor.getByRole("combobox", { name: "入口服务器" });
  await owner.click(() => server);
  await owner.click(() => screen.getByRole("option", { name: host.name }));
  await waitFor(() => expect(document.activeElement).toBe(server));
  owner.assertActive();
  const finishExit = holdPopoverExit();
  const entry = editor.getByRole("combobox", { name: "入口端点" });
  await owner.click(() => entry);
  const closing = document.getElementById(entry.getAttribute("aria-controls")!)!;
  const search = screen.getByRole("combobox", { name: "搜索选项" });
  await waitFor(() => expect(document.activeElement).toBe(search));
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByRole("option").textContent).toContain(endpoint.name);
  owner.assertActive();
  await user.keyboard("{Enter}");
  owner.assertActive();
  await waitFor(() => expect(reveals).toEqual([endpoint.id]));
  owner.assertActive();
  expect(entry.getAttribute("aria-expanded")).toBe("false");
  return { owner, user, editor, entry, closing, finishExit, deliver, mutations };
}

it.each(["before", "after"] as const)("keeps first-entry keyboard continuation when reveal arrives %s picker exit", async (timing, context) => {
  const task = await startSelection(context);
  if (timing === "after") {
    task.finishExit(task.closing);
    await waitFor(() => expect(document.activeElement).toBe(task.entry));
  }
  task.owner.assertActive();
  await act(async () => task.deliver(json(endpoint)));
  task.owner.assertActive();
  const selected = task.editor.getByRole("combobox", { name: "第 1 跳端点" });
  expect(selected.textContent).toContain("用户入口");
  expect(task.editor.getByRole("combobox", { name: "第 1 跳服务器" }).textContent).toBe(host.name);
  expect(task.entry.isConnected).toBe(false);
  expect(screen.queryByRole("listbox", { hidden: true })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(selected));
  task.owner.assertActive();
  await task.user.tab();
  task.owner.assertActive();
  expect(document.activeElement).toBe(task.editor.getByRole("button", { name: "移除第 1 跳" }));
  expect(task.mutations).toEqual([]);
});

it("does not reclaim a newer field focus when the first-entry reveal finishes", async (context) => {
  const task = await startSelection(context);
  const name = task.editor.getByRole("textbox", { name: "转发路径名称" });
  await task.owner.click(() => name);
  task.finishExit(task.closing);
  await act(async () => task.deliver(json(endpoint)));
  task.owner.assertActive();
  expect(task.editor.getByRole("combobox", { name: "第 1 跳端点" }).textContent).toContain(endpoint.name);
  expect(document.activeElement).toBe(name);
  await task.user.keyboard("保留焦点");
  task.owner.assertActive();
  expect(document.activeElement).toBe(name);
  expect(name).toHaveProperty("value", "保留焦点");
  expect(task.mutations).toEqual([]);
});

it("keeps the original entry picker when reveal fails instead of focusing an invented hop", async (context) => {
  const task = await startSelection(context);
  task.finishExit(task.closing);
  await waitFor(() => expect(document.activeElement).toBe(task.entry));
  task.owner.assertActive();
  await act(async () => task.deliver(json({ error: "Endpoint reveal unavailable" }, 503)));
  task.owner.assertActive();
  expect(task.editor.queryByRole("combobox", { name: "第 1 跳端点" })).toBeNull();
  expect(task.editor.getByText("Endpoint reveal unavailable", { exact: true })).toBeTruthy();
  expect(task.entry.isConnected).toBe(true);
  expect(document.activeElement).toBe(task.entry);
  expect(task.mutations).toEqual([]);
});

it("does not take focus from a newer discard decision when the first-entry reveal finishes", async (context) => {
  const task = await startSelection(context);
  await task.owner.click(() => task.editor.getByRole("button", { name: "关闭" }));
  const decision = screen.getByRole("alertdialog", { name: "放弃尚未保存的转发路径修改？" });
  const keepEditing = within(decision).getByRole("button", { name: "继续编辑" });
  await waitFor(() => expect(document.activeElement).toBe(keepEditing));
  task.owner.assertActive();
  task.finishExit(task.closing);
  await act(async () => task.deliver(json(endpoint)));
  task.owner.assertActive();
  expect(task.entry.isConnected).toBe(false);
  expect(document.activeElement).toBe(keepEditing);
  expect(task.mutations).toEqual([]);
});
