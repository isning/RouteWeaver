// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { ServerRouteEditor } from "./ServerRoutes";
import type { Infrastructure, ServerDeployment } from "./types";

const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const inventory: Infrastructure = { hosts: [], instances: [], endpoints: [], deployments: [], links: [] };
it.each([null, undefined])("retains the legacy first-hop task for an empty %s program list", (programs) => {
  const initial = {
    id: "empty", name: "Empty path", status: "draft", diagnostics: [],
    ir: { schemaVersion: "1.0", id: "empty", topologyRevision: "one", programs },
  } as unknown as ServerDeployment;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders>
    <ServerRouteEditor initial={initial} inventory={inventory} isNew={false} onClose={() => {}} onSaved={() => true} />
  </UIProviders></QueryClientProvider>);
  expect(screen.getByRole("list", { name: "代理链" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "第 1 跳服务器" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "路径摘要" }).textContent).toContain("客户端 → 选择第一跳 → 目标");
  expect(screen.queryByText("此配置包含独立转发或用户策略，请在转发设置中编辑，避免改写其他去向。")).toBeNull();
});


it("keeps the original chain when a selected listener has moved to a different core before reveal", async () => {
  const inventory: Infrastructure = {
    hosts: ["a", "b", "c"].map(id => ({ id, name: `${id} server`, address: `${id}.example.test` })),
    instances: ["a", "b", "c"].map(id => ({ id: `${id}-core`, hostId: id, adapterId: "routeweaver/xray", version: "26.10.31" })),
    endpoints: ["a", "b", "c"].map(id => ({ id, name: `${id} listener`, instanceId: `${id}-core`, connection: { protocol: "socks", host: "127.0.0.1", port: 1080 } })),
    deployments: [], links: [],
  };
  const initial: ServerDeployment = { id: "mixed", name: "Mixed path", status: "draft", diagnostics: [],
    ir: { schemaVersion: "1.0", id: "mixed", topologyRevision: "one", programs: [{
      instance: inventory.instances[0], listener: inventory.endpoints[0], egress: [], rules: [], resources: [],
      defaultAction: { kind: "direct" }, connectors: [{ id: "proxy-x", connection: { protocol: "socks", host: "proxy.example.test", port: 1080 } }],
    }] } };
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init?: RequestInit) => {
    const path = String(url);
    calls.push(`${init?.method || "GET"} ${path}`);
    return new Response(JSON.stringify(path === "/api/managed-endpoints/b/reveal"
      ? { ...inventory.endpoints[1], instanceId: "c-core" } : { detail: "Unexpected request" }),
      { status: path === "/api/managed-endpoints/b/reveal" ? 200 : 503, headers: { "Content-Type": "application/json" } });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders>
    <ServerRouteEditor initial={initial} inventory={inventory} isNew={false} onClose={() => {}} onSaved={() => true} />
  </UIProviders></QueryClientProvider>);
  const user = userEvent.setup();
  const choose = async (label: string, query: string) => {
    await user.click(screen.getByRole("combobox", { name: label }));
    await user.type(screen.getByRole("combobox", { name: "搜索选项" }), query);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  };
  await user.click(screen.getByRole("button", { name: "添加下一跳" }));
  await choose("第 2 跳服务器", "b server");
  await choose("第 2 跳端点", "b listener");
  expect(await screen.findByText("所选监听的所属核心已变化，请重新选择服务器和端点。")).toBeTruthy();
  expect(screen.getByRole("region", { name: "路径摘要" }).textContent).toContain("a listener → 第 2 跳（待选择） → 目标");
  expect(screen.getByRole("region", { name: "路径摘要" }).textContent).not.toContain("b listener");
  expect(screen.getByRole("combobox", { name: "第 2 跳服务器" }).textContent).toContain("b server");
  expect(screen.getByRole("button", { name: "保存草稿" }).hasAttribute("disabled")).toBe(true);
  expect(calls).toEqual(["GET /api/managed-endpoints/b/reveal"]);
});


function mixedFixture() {
  const inventory: Infrastructure = {
    hosts: ["a", "b"].map(id => ({ id, name: `${id} server`, address: `${id}.example.test` })),
    instances: ["a", "b"].map(id => ({ id: `${id}-core`, hostId: id, adapterId: "routeweaver/xray", version: "26.10.31" })),
    endpoints: ["a", "b"].map(id => ({ id, name: `${id} listener`, instanceId: `${id}-core`, connection: { protocol: "socks", host: "127.0.0.1", port: 1080 } })),
    deployments: [], links: [],
  };
  const initial: ServerDeployment = { id: "mixed", name: "Mixed path", status: "draft", diagnostics: [],
    ir: { schemaVersion: "1.0", id: "mixed", topologyRevision: "one", programs: [{
      instance: inventory.instances[0], listener: inventory.endpoints[0], egress: [], rules: [], resources: [],
      defaultAction: { kind: "forward", ref: "proxy-x" }, connectors: [{ id: "proxy-x", connection: { protocol: "socks", host: "proxy.example.test", port: 1080 } }],
    }] } };
  return { inventory, initial };
}
function mountEditor(initial: ServerDeployment, inventory: Infrastructure) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders>
    <ServerRouteEditor initial={initial} inventory={inventory} isNew={false} onClose={() => {}} onSaved={() => true} />
  </UIProviders></QueryClientProvider>);
}

it("retains the path-level explanation when a supported policy form can repair an invalid default reference", () => {
  const { initial, inventory } = mixedFixture();
  initial.ir.programs[0].defaultAction = { kind: "forward", ref: "missing" };
  mountEditor(initial, inventory);
  expect(screen.getByText("此配置包含独立转发或用户策略，请在转发设置中编辑，避免改写其他去向。")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "代理链" })).toBeNull();
  const repair = screen.getByRole("combobox", { name: "a listener 默认去向" });
  expect(repair.hasAttribute("disabled")).toBe(false);
});

it("waits for a new hop reveal before opening JSON so unchanged JSON cannot discard the new hop", async () => {
  const { initial, inventory } = mixedFixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init?: RequestInit) => {
    const path = String(url);
    calls.push(`${init?.method || "GET"} ${path}`);
    if (path !== "/api/managed-endpoints/b/reveal") return new Response("{}", { status: 503 });
    await gate;
    return new Response(JSON.stringify(inventory.endpoints[1]), { headers: { "Content-Type": "application/json" } });
  }));
  mountEditor(initial, inventory);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "高级：完整服务端意图" }));
  const editJSON = screen.getByRole("button", { name: "编辑服务端意图" });
  await user.click(screen.getByRole("button", { name: "添加下一跳" }));
  const choose = async (label: string, query: string) => {
    await user.click(screen.getByRole("combobox", { name: label }));
    await user.type(screen.getByRole("combobox", { name: "搜索选项" }), query);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  };
  await choose("第 3 跳服务器", "b server");
  await choose("第 3 跳端点", "b listener");
  await waitFor(() => expect(editJSON.hasAttribute("disabled")).toBe(true));
  await user.click(editJSON);
  expect(screen.queryByRole("dialog", { name: "服务端配置意图" })).toBeNull();
  await act(async () => { release(); await gate; });
  await waitFor(() => expect(screen.getByRole("region", { name: "路径摘要" }).textContent).toContain("a listener → proxy-x → b listener → 目标"));
  expect(editJSON.hasAttribute("disabled")).toBe(false);
  await user.click(editJSON);
  const dialog = await screen.findByRole("dialog", { name: "服务端配置意图" });
  const intent = JSON.parse((within(dialog).getByRole("textbox", { name: "服务端配置意图 JSON 文本" }) as HTMLTextAreaElement).value);
  expect(intent.programs.map((program: { listener: { id: string } }) => program.listener.id)).toEqual(["a", "b"]);
  await user.click(within(dialog).getByRole("button", { name: "应用到草稿" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "服务端配置意图" })).toBeNull());
  expect(screen.getByRole("region", { name: "路径摘要" }).textContent).toContain("a listener → proxy-x → b listener → 目标");
  expect(calls).toEqual(["GET /api/managed-endpoints/b/reveal"]);
});


it("refuses to remove an opaque program from the legacy ordered workspace", async () => {
  const { initial, inventory } = mixedFixture();
  delete initial.ir.programs[0].connectors;
  delete initial.ir.programs[0].defaultAction;
  Object.assign(initial.ir.programs[0], { futurePolicy: { keep: "opaque program data" } });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  mountEditor(initial, inventory);
  const user = userEvent.setup();
  expect(screen.getByRole("list", { name: "代理链" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "第 1 跳更多操作" }));
  expect(screen.getByRole("menuitem", { name: "移除第 1 跳" }).getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByText("此服务器仍保存连接器或独立设置，请先在转发设置中处理，再移除服务器。")).toBeTruthy();
  await user.keyboard("{Escape}");
  expect(screen.getByRole("region", { name: "路径摘要" }).textContent).toContain("a listener → 目标");
  await user.click(screen.getByRole("button", { name: "高级：完整服务端意图" }));
  await user.click(screen.getByRole("button", { name: "编辑服务端意图" }));
  const dialog = await screen.findByRole("dialog", { name: "服务端配置意图" });
  const intent = JSON.parse((within(dialog).getByRole("textbox", { name: "服务端配置意图 JSON 文本" }) as HTMLTextAreaElement).value);
  expect(intent.programs[0].futurePolicy).toEqual({ keep: "opaque program data" });
  expect(fetch).not.toHaveBeenCalled();
});

it("returns from connection editing to the expanded hop and its parameter button", async () => {
  const { initial, inventory } = mixedFixture();
  mountEditor(initial, inventory);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "配置第 2 跳 proxy-x" }));
  await user.click(screen.getByRole("button", { name: "编辑第 2 跳外部代理连接参数" }));
  const connection = await screen.findByRole("dialog", { name: "编辑连接参数" });
  await user.click(within(connection).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑连接参数" })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "编辑第 2 跳外部代理连接参数" })));
  expect(screen.getByRole("button", { name: "配置第 2 跳 proxy-x" }).getAttribute("aria-expanded")).toBe("true");
});

it("uses the same collapsed chain overview for a legacy managed-only path without external proxies", async () => {
  const { initial, inventory } = mixedFixture();
  delete initial.ir.programs[0].defaultAction;
  delete initial.ir.programs[0].connectors;
  mountEditor(initial, inventory);
  const user = userEvent.setup();
  const hop = screen.getByRole("button", { name: "配置第 1 跳 a listener" });
  expect(hop.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("combobox", { name: "第 1 跳端点" })).toBeNull();
  await user.click(hop);
  expect(screen.getByRole("combobox", { name: "第 1 跳端点" }).textContent).toContain("a listener");
  await user.click(screen.getByRole("button", { name: "第 1 跳更多操作" }));
  expect(screen.getByRole("menuitem", { name: "在第 1 跳后插入下一跳" })).toBeTruthy();
});

it("keeps unsaved path edits when footer cancellation is declined", async () => {
  const { initial, inventory } = mixedFixture();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  mountEditor(initial, inventory);
  const user = userEvent.setup();
  const editor = screen.getByRole("dialog", { name: "编辑 Mixed path" });
  const path = within(editor).getByRole("region", { name: "路径编排" });
  expect(within(path).getByRole("list", { name: "代理链" })).toBeTruthy();
  const name = within(editor).getByRole("textbox", { name: "转发路径名称" });
  await user.clear(name);
  await user.type(name, "Updated path");
  await user.click(within(editor).getByRole("button", { name: "取消", exact: true }));
  const confirmation = await screen.findByRole("alertdialog", { name: "放弃尚未保存的转发路径修改？" });
  await user.click(within(confirmation).getByRole("button", { name: "继续编辑" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect((name as HTMLInputElement).value).toBe("Updated path");
  expect(within(editor).getByRole("region", { name: "路径摘要" }).textContent).toContain("a listener → proxy-x → 目标");
  expect(fetch).not.toHaveBeenCalled();
});
