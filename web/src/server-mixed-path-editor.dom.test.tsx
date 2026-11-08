// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
