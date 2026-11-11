// @vitest-environment jsdom
// Real inventory/import controls; only HTTP and unavailable browser layout are replaced.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { ResourcesPage } from "./Resources";
import type { RuleResource } from "./types";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const resource: RuleResource = {
  id: "retained", name: "Known rules", format: "mihomo-yaml", behavior: "domain",
  location: "remote", updatePolicy: "pinned", visibility: "private", revision: "1", digest: "a".repeat(64),
  acceptedVersion: "accepted-1", revisionToken: "revision-1", canRefresh: true,
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
  render(<QueryClientProvider client={client}><UIProviders><ResourcesPage /></UIProviders></QueryClientProvider>);
}
const actions = () => within(screen.getByRole("group", { name: "Known rules 的操作" }));

it("retains known rules after a refresh read fails, then reconciles before using a newer replacement revision", async () => {
  let rows = [resource, { ...resource, id: "other", name: "Other rules" }];
  let failed = false;
  let held: Promise<Response> | undefined;
  const writes: { path: string; headers: Headers; body?: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init?: RequestInit) => {
    const path = String(url);
    if (!init?.method && path === "/api/me/resources")
      return held || (failed ? json({ error: "Resource list unavailable" }, 503) : json(rows));
    if (init?.method === "POST" && path === "/api/me/resources/retained/refresh") {
      writes.push({ path, headers: new Headers(init.headers) });
      failed = true;
      return json({});
    }
    if (init?.method === "POST" && path === "/api/me/resources/import") {
      writes.push({ path, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      failed = true;
      return json({ ...resource, acceptedVersion: "accepted-3", revisionToken: "revision-3" });
    }
    throw new Error(`Unexpected request: ${init?.method || "GET"} ${path}`);
  }));
  mount();
  await screen.findByRole("button", { name: "Known rules" });
  await userEvent.click(actions().getByRole("button", { name: "刷新文件" }));
  await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "读取并接纳" }));
  await screen.findByText("Resource list unavailable");
  expect(screen.getByRole("button", { name: "Known rules" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Other rules" })).toBeTruthy();
  expect(screen.getByText("显示上次读取的规则资源，请重试以核对最新状态。")).toBeTruthy();
  expect(screen.queryByText("暂无规则资源")).toBeNull();
  expect(actions().getByRole("button", { name: "替换文件" })).toHaveProperty("disabled", true);
  expect(actions().getByRole("button", { name: "刷新文件" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Known rules" })).toHaveProperty("disabled", true);
  expect(writes).toHaveLength(1);

  let finish!: (value: Response) => void;
  held = new Promise<Response>((resolve) => { finish = resolve; });
  act(() => onlineManager.setOnline(false));
  await userEvent.click(screen.getByRole("button", { name: "重试规则资源" }));
  await screen.findByText("等待网络连接后核对规则资源。");
  expect(actions().getByRole("button", { name: "替换文件" })).toHaveProperty("disabled", true);
  act(() => onlineManager.setOnline(true));
  await screen.findByText("正在核对规则资源…");
  expect(actions().getByRole("button", { name: "替换文件" })).toHaveProperty("disabled", true);
  rows = [{ ...resource, revisionToken: "revision-2" }];
  failed = false; held = undefined;
  await act(async () => finish(json(rows)));
  await waitFor(() => expect(actions().getByRole("button", { name: "替换文件" })).toHaveProperty("disabled", false));
  expect(screen.queryByRole("button", { name: "Other rules" })).toBeNull();
  await userEvent.click(actions().getByRole("button", { name: "替换文件" }));
  const editor = within(await screen.findByRole("dialog", { name: "替换 Known rules" }));
  await userEvent.upload(editor.getByLabelText("选择规则文件"), new File(["payload:\n  - example.test\n"], "rules.yaml"));
  await userEvent.click(editor.getByRole("button", { name: "导入并保存文件" }));
  await screen.findByText("Resource list unavailable");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("button", { name: "Known rules" })).toBeTruthy();
  expect(writes).toHaveLength(2);
  expect(writes[1].headers.get("If-Match")).toBe("revision-2");
  expect(writes[1].body).toMatchObject({ resource: { id: "retained", name: "Known rules" } });
  rows = []; failed = false;
  await userEvent.click(screen.getByRole("button", { name: "重试规则资源" }));
  await screen.findByText("暂无规则资源");
  expect(screen.queryByRole("button", { name: "Known rules" })).toBeNull();
  expect(screen.queryByText("Resource list unavailable")).toBeNull();
  expect(writes).toHaveLength(2);
});

it("does not describe an initial failed read as cached inventory or an empty list", async () => {
  let finish!: (value: Response) => void;
  let initial = true;
  vi.stubGlobal("fetch", vi.fn(async () => initial
    ? new Promise<Response>((resolve) => { finish = resolve; }) : json([])));
  mount();
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(screen.queryByText("暂无规则资源")).toBeNull();
  await act(async () => finish(json({ error: "Initial resources unavailable" }, 503)));
  await screen.findByText("Initial resources unavailable");
  expect(screen.queryByText("显示上次读取的规则资源，请重试以核对最新状态。")).toBeNull();
  expect(screen.queryByText("暂无规则资源")).toBeNull();
  initial = false;
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByText("暂无规则资源");
});
