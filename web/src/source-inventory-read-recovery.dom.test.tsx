// @vitest-environment jsdom
// Public source inventory/editor tasks with failures only at the HTTP boundary.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { SourcesPage } from "./Sources";
import { sourceRowAction } from "./test-support/source-row-actions";
import type { Source } from "./types";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const source: Source = {
  id: "known", name: "Known source A", kind: "text", enabled: true,
  revision: "source-1", snapshot: { endpoints: [] },
  candidate: { id: "candidate-1", createdAt: "2026-11-11", diagnostics: [], affected: [],
    diff: { beforeCount: 0, afterCount: 0, added: [], removed: [], renamed: [], connectionChanged: [] } },
};
const clients: QueryClient[] = [];
beforeEach(() => {
  onlineManager.setOnline(true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => original(element));
});
afterEach(() => {
  cleanup(); clients.splice(0).forEach((client) => client.clear());
  onlineManager.setOnline(true);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders><SourcesPage onCreateProfile={vi.fn()} /></UIProviders></QueryClientProvider>);
}

it("retains source search and known identities after failed refresh while independent editing still requires fresh reveal", async () => {
  let rows = [source, { ...source, id: "other", name: "Known source B", candidate: undefined }];
  let failed = false, failReveal = false;
  let held: Promise<Response> | undefined;
  const writes: { path: string; body?: unknown }[] = [];
  const reads: string[] = [];
  const fresh = { ...source, name: "Current source A", revision: "source-2", content: "socks5://current.example:1080#Current" };
  vi.stubGlobal("fetch", vi.fn(async (url, init?: RequestInit) => {
    const path = String(url);
    if (!init?.method) {
      reads.push(path);
      if (path === "/api/me/sources") return held || (failed ? json({ error: "Source list unavailable" }, 503) : json(rows));
      if (path === "/api/me/sources/known/reveal") return failReveal ? json({ error: "Fresh source unavailable" }, 503) : json(fresh);
      if (path === "/api/me/sources/known") return json({ ...fresh, content: undefined });
    }
    if (init?.method === "POST" && path === "/api/me/sources/known/refresh") {
      writes.push({ path }); failed = true; return json(source);
    }
    if (init?.method === "PUT" && path === "/api/me/sources/known") {
      const body = JSON.parse(String(init.body));
      writes.push({ path, body }); failed = true; return json({ ...body, revision: "source-3" });
    }
    throw new Error(`Unexpected request: ${init?.method || "GET"} ${path}`);
  }));
  mount();
  await screen.findByRole("button", { name: /^Known source A 文本导入$/ });
  fireEvent.change(screen.getByRole("textbox", { name: "搜索来源" }), { target: { value: "Known" } });
  await userEvent.click(await sourceRowAction("刷新", "Known source A"));
  await screen.findByText("Source list unavailable");
  expect(screen.getByRole("button", { name: /^Known source A 文本导入$/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Known source B 文本导入$/ })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "搜索来源" })).toHaveProperty("value", "Known");
  expect(screen.getByText("显示上次读取的来源，请重试以核对最新状态。")).toBeTruthy();
  expect(screen.getByRole("button", { name: "应用更新 Known source A" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "查看变化" })).toHaveProperty("disabled", true);
  await userEvent.click(screen.getByRole("button", { name: /^Known source A 文本导入$/ }));
  const detail = within(await screen.findByRole("dialog", { name: "Known source A" }));
  expect(detail.getByText("显示上次读取的来源，请重试以核对最新状态。")).toBeTruthy();
  expect(detail.getByRole("button", { name: "应用更新 Known source A" })).toHaveProperty("disabled", true);
  expect(detail.getByRole("button", { name: "用此来源新建分流配置" })).toHaveProperty("disabled", true);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await userEvent.click(screen.getByRole("button", { name: "更多操作 Known source A" }));
  expect(screen.getByRole("menuitem", { name: "刷新来源 Known source A" }).getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByRole("menuitem", { name: "删除来源" }).getAttribute("aria-disabled")).toBe("true");
  failReveal = true;
  await userEvent.click(screen.getByRole("menuitem", { name: "编辑来源 Known source A" }));
  const editor = within(await screen.findByRole("dialog", { name: "编辑来源" }));
  await editor.findByText("Fresh source unavailable");
  expect(editor.queryByLabelText("来源名称")).toBeNull();
  expect(writes).toHaveLength(1);
  failReveal = false;
  await userEvent.click(editor.getByRole("button", { name: "重试" }));
  expect(await editor.findByLabelText("来源名称")).toHaveProperty("value", "Current source A");
  fireEvent.change(editor.getByLabelText("来源名称"), { target: { value: "Saved new name" } });
  await userEvent.click(editor.getByRole("button", { name: "保存修改" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("button", { name: /^Known source A 文本导入$/ })).toBeTruthy();
  expect(writes).toHaveLength(2);
  expect(writes[1].body).toMatchObject({ id: "known", revision: "source-2", name: "Saved new name", content: fresh.content });
  expect(reads.filter((path) => path.endsWith("/reveal"))).toHaveLength(2);

  fireEvent.change(screen.getByRole("textbox", { name: "搜索来源" }), { target: { value: "no match" } });
  expect(screen.getByText("没有匹配的来源")).toBeTruthy();
  expect(screen.queryByText("暂无订阅来源")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "清除搜索" }));
  expect(screen.getByRole("textbox", { name: "搜索来源" })).toHaveProperty("value", "");
  expect(screen.getByRole("button", { name: /^Known source B 文本导入$/ })).toBeTruthy();
  let finish!: (value: Response) => void;
  held = new Promise<Response>((resolve) => { finish = resolve; });
  act(() => onlineManager.setOnline(false));
  await userEvent.click(screen.getByRole("button", { name: "重试来源列表" }));
  await screen.findByText("等待网络连接后核对来源列表。");
  expect(screen.getByRole("button", { name: "应用更新 Known source A" })).toHaveProperty("disabled", true);
  act(() => onlineManager.setOnline(true));
  await screen.findByText("正在核对来源列表…");
  expect(screen.getByRole("button", { name: "应用更新 Known source A" })).toHaveProperty("disabled", true);
  failed = false; held = undefined; rows = [];
  await act(async () => finish(json(rows)));
  await screen.findByText("暂无订阅来源");
  expect(screen.queryByRole("button", { name: /^Known source A 文本导入$/ })).toBeNull();
  expect(screen.queryByText("Source list unavailable")).toBeNull();
  expect(writes).toHaveLength(2);
});

it("does not describe an initial failed source read as cached inventory or an empty list", async () => {
  let finish!: (value: Response) => void;
  let initial = true;
  vi.stubGlobal("fetch", vi.fn(async () => initial
    ? new Promise<Response>((resolve) => { finish = resolve; }) : json([])));
  mount();
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(screen.queryByText("暂无订阅来源")).toBeNull();
  await act(async () => finish(json({ error: "Initial sources unavailable" }, 503)));
  await screen.findByText("Initial sources unavailable");
  expect(screen.queryByText("显示上次读取的来源，请重试以核对最新状态。")).toBeNull();
  expect(screen.queryByText("暂无订阅来源")).toBeNull();
  initial = false;
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByText("暂无订阅来源");
});

it.each(["changed", "removed"] as const)("reconciles an open cached source sheet when retry confirms the source is %s", async (result) => {
  let failed = false, recovered = false;
  const newer: Source = { ...source, name: "Current source after retry", revision: "source-2", candidate: undefined,
    snapshot: { endpoints: [{ id: "current-node", name: "Current connection", origin: "imported",
      connection: { protocol: "socks", host: "current.example", port: 1080 } }] } };
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init?: RequestInit) => {
    const path = String(url);
    if (!init?.method && path === "/api/me/sources")
      return failed ? json({ error: "Source list unavailable" }, 503)
        : json(recovered ? (result === "changed" ? [newer] : []) : [source]);
    if (init?.method === "POST" && path === "/api/me/sources/known/refresh") {
      writes.push(path); failed = true; return json(source);
    }
    throw new Error(`Unexpected request: ${init?.method || "GET"} ${path}`);
  }));
  mount();
  await screen.findByRole("button", { name: /^Known source A 文本导入$/ });
  await userEvent.click(await sourceRowAction("刷新", "Known source A"));
  await screen.findByText("Source list unavailable");
  await userEvent.click(screen.getByRole("button", { name: /^Known source A 文本导入$/ }));
  const detail = within(await screen.findByRole("dialog", { name: "Known source A" }));
  expect(detail.getByRole("button", { name: "应用更新 Known source A" })).toHaveProperty("disabled", true);
  failed = false; recovered = true;
  await userEvent.click(detail.getByRole("button", { name: "重试来源列表" }));
  await waitFor(() => expect(detail.queryByText("Source list unavailable")).toBeNull());
  expect(detail.queryByRole("button", { name: "应用更新 Known source A" })).toBeNull();
  expect(detail.queryByRole("button", { name: "查看变化" })).toBeNull();
  expect(detail.queryByText("有更新可应用")).toBeNull();
  if (result === "changed") {
    expect(screen.getByRole("dialog", { name: "Current source after retry" })).toBeTruthy();
    expect(detail.getByText("Current connection")).toBeTruthy();
    expect(detail.getByRole("button", { name: "用此来源新建分流配置" })).toHaveProperty("disabled", false);
  } else {
    expect(detail.getByText("此来源已不在当前列表中")).toBeTruthy();
    expect(detail.queryByRole("button", { name: "用此来源新建分流配置" })).toBeNull();
    expect(detail.queryByRole("table")).toBeNull();
  }
  // A later reconnect failure must not restore the originally opened snapshot.
  failed = true;
  act(() => onlineManager.setOnline(false));
  act(() => onlineManager.setOnline(true));
  await detail.findByText("Source list unavailable");
  expect(detail.queryByRole("button", { name: "应用更新 Known source A" })).toBeNull();
  if (result === "changed") {
    expect(screen.getByRole("dialog", { name: "Current source after retry" })).toBeTruthy();
    expect(detail.getByText("Current connection")).toBeTruthy();
    expect(detail.getByRole("button", { name: "用此来源新建分流配置" })).toHaveProperty("disabled", true);
  } else {
    expect(detail.getByText("上次读取时未找到此来源")).toBeTruthy();
    expect(detail.queryByRole("table")).toBeNull();
  }
  expect(writes).toEqual(["/api/me/sources/known/refresh"]);
});

it.each(["ordinary", "older-read"] as const)("keeps a confirmed application result when list reconciliation fails with %s ordering", async (ordering) => {
  let applied = false, recovered = false;
  let finishApply!: () => void;
  let finishOldRead: ((value: Response) => void) | undefined;
  const accepted: Source = { ...source, revision: "accepted-2", candidate: undefined,
    snapshot: { endpoints: [{ id: "accepted-node", name: "Applied connection", origin: "imported",
      connection: { protocol: "socks", host: "accepted.example", port: 1080 } }] } };
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init?: RequestInit) => {
    const path = String(url);
    if (!init?.method && path === "/api/me/sources") {
      if (ordering === "older-read" && writes.length && !applied)
        return new Promise<Response>((resolve) => { finishOldRead = resolve; });
      return applied && !recovered ? json({ error: "Source list unavailable" }, 503)
        : json(recovered ? [] : [source]);
    }
    if (init?.method === "POST" && path === "/api/me/sources/known/apply") {
      writes.push(JSON.parse(String(init.body)));
      return new Promise<Response>((resolve) => { finishApply = () => {
        applied = true;
        resolve(json({ ...accepted, application: { candidateId: "candidate-1", sourceRevision: "accepted-2", affected: [] } }));
      }; });
    }
    throw new Error(`Unexpected request: ${init?.method || "GET"} ${path}`);
  }));
  mount();
  await userEvent.click(await screen.findByRole("button", { name: /^Known source A 文本导入$/ }));
  const detail = within(await screen.findByRole("dialog", { name: "Known source A" }));
  await userEvent.click(detail.getByRole("button", { name: "应用更新 Known source A" }));
  await waitFor(() => expect(finishApply).toBeTypeOf("function"));
  if (ordering === "older-read") {
    act(() => onlineManager.setOnline(false));
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(finishOldRead).toBeTypeOf("function"));
  }
  await act(async () => finishApply());
  await detail.findByText("Source list unavailable");
  if (finishOldRead) await act(async () => finishOldRead!(json([source])));
  expect(detail.queryByRole("button", { name: "应用更新 Known source A" })).toBeNull();
  expect(detail.queryByText("有更新可应用")).toBeNull();
  expect(detail.getByText("Applied connection")).toBeTruthy();
  expect(detail.getByRole("button", { name: "用此来源新建分流配置" })).toHaveProperty("disabled", true);
  expect(writes).toEqual([{ candidateId: "candidate-1", sourceRevision: "source-1" }]);
  recovered = true;
  await userEvent.click(detail.getByRole("button", { name: "重试来源列表" }));
  await detail.findByText("此来源已不在当前列表中");
  expect(detail.queryByText("Applied connection")).toBeNull();
  expect(detail.queryByRole("button", { name: "用此来源新建分流配置" })).toBeNull();
  expect(writes).toHaveLength(1);
});
