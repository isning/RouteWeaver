// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { ServersPage } from "./Infrastructure";
let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); history.replaceState(null, "", "#servers"); });
function mount() {
  const unexpected: string[] = [];
  const data: Record<string, unknown> = {
    "/api/hosts": [
      { id: "tokyo", name: "Tokyo server", address: "tokyo.example.test" },
      { id: "osaka", name: "Osaka server", address: "osaka.example.test" },
    ],
    "/api/core-instances": Array.from({ length: 12 }, (_, i) => ({
      id: `core-${i}`, hostId: i ? "osaka" : "tokyo", name: `Core ${i}`, adapterId: "routeweaver/xray", version: "1",
    })),
    "/api/managed-endpoints": [
      { id: "entry", name: "Tokyo entry", instanceId: "core-0", connection: { host: "0.0.0.0", port: 443, protocol: "vless", password: "private-unsearchable" } },
      { id: "exit", name: "Osaka entry", instanceId: "core-1", connection: { host: "127.0.0.1", port: 8443, protocol: "trojan" } },
    ],
    "/api/links": [], "/api/server-deployments": [],
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if ((!init?.method || init.method === "GET") && ["/api/admin/nodes/tokyo/observability", "/api/agent/instances/core-0/state"].includes(url))
      return new Response(JSON.stringify({ error: "No observation fixture" }), { status: 503, headers: { "Content-Type": "application/json" } });
    if ((init?.method && init.method !== "GET") || !Object.hasOwn(data, url)) { unexpected.push(url); throw new Error("Unexpected request"); }
    return new Response(JSON.stringify(data[url]), { headers: { "Content-Type": "application/json" } });
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><UIProviders><ServersPage /></UIProviders></QueryClientProvider>);
  return unexpected;
}
it("finds inventory by visible identity, keeps each tab query and restores keyboard focus", async () => {
  const unexpected = mount();
  const hosts = await screen.findByRole("searchbox", { name: "搜索服务器" });
  await userEvent.type(hosts, " TOKYO.EXAMPLE ");
  expect(screen.queryByRole("button", { name: "Osaka server" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Tokyo server" }));
  await userEvent.click(screen.getByRole("button", { name: "返回服务器清单" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Tokyo server" })));
  await userEvent.click(screen.getByRole("tab", { name: "核心实例 12" }));
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  const cores = screen.getByRole("searchbox", { name: "搜索核心实例" });
  await userEvent.type(cores, "osaka");
  expect(screen.getByRole("button", { name: "Core 1 1" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Core 11 1" })).toBeNull();
  await userEvent.clear(cores);
  await userEvent.type(cores, "tokyo");
  expect(screen.getByRole("button", { name: "Core 0 1" })).toBeTruthy();
  await userEvent.click(screen.getByRole("tab", { name: "监听端点 2" }));
  const endpoints = screen.getByRole("searchbox", { name: "搜索监听端点" });
  await userEvent.type(endpoints, "0.0.0.0:443");
  expect(screen.getByRole("cell", { name: "Tokyo entry" })).toBeTruthy();
  expect(screen.queryByRole("cell", { name: "Osaka entry" })).toBeNull();
  await userEvent.clear(endpoints);
  await userEvent.type(endpoints, "private-unsearchable");
  expect(screen.getByText("没有匹配的监听端点")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "清除搜索" }));
  expect(document.activeElement).toBe(endpoints);
  expect(screen.getByRole("cell", { name: "Osaka entry" })).toBeTruthy();
  await userEvent.click(screen.getByRole("tab", { name: "服务器 2" }));
  expect(screen.getByRole("searchbox", { name: "搜索服务器" })).toHaveProperty("value", " TOKYO.EXAMPLE ");
  expect(unexpected).toEqual([]);
});
