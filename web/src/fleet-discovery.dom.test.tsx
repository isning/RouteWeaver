// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { FleetPage, FleetPlanForm } from "./Fleet";
import { renderFleetSession } from "./test-support/fleet-session";
import type { Infrastructure } from "./types";
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); });
function mount(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  return renderFleetSession(ui, content => render(<QueryClientProvider client={client}><UIProviders>{content}</UIProviders></QueryClientProvider>));
}
it("finds tasks by path and status, resets pagination and preserves unknown statuses", async () => {
  const unexpected: string[] = [];
  const batches = Array.from({ length: 22 }, (_, i) => ({ id: `task-${i}`, action: "start", status: i < 12 ? "failed" : "future-state", deploymentId: `path-${i}`, targets: [], affectedUsers: 0, createdAt: "2026-11-16T00:00:00Z" }));
  const data: Record<string, unknown> = {
    "/api/admin/fleet-batches": batches, "/api/hosts": [], "/api/core-instances": [], "/api/managed-endpoints": [], "/api/links": [],
    "/api/server-deployments": batches.map((b, i) => ({ id: b.deploymentId, name: `Office Path ${i}`, ir: { programs: [] } })),
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if ((init?.method && init.method !== "GET") || !Object.hasOwn(data, url)) { unexpected.push(url); throw new Error("Unexpected request"); }
    return new Response(JSON.stringify(data[url]), { headers: { "Content-Type": "application/json" } });
  }));
  await mount(<FleetPage />);
  await screen.findByRole("cell", { name: "Office Path 0" });
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(screen.getByRole("cell", { name: "Office Path 20" })).toBeTruthy();
  const tools = screen.getByRole("search", { name: "查找执行任务" });
  await userEvent.click(within(tools).getByRole("combobox", { name: "筛选任务状态" }));
  await userEvent.click(screen.getByRole("option", { name: "失败" }));
  expect(screen.getByRole("cell", { name: "Office Path 0" })).toBeTruthy();
  const search = within(tools).getByRole("searchbox", { name: "搜索执行任务" });
  await userEvent.type(search, " office path 0 ");
  expect(screen.getByRole("cell", { name: "Office Path 0" })).toBeTruthy();
  await userEvent.type(search, "missing");
  await userEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  expect(document.activeElement).toBe(search);
  await userEvent.type(search, "task-20");
  expect(screen.getByRole("cell", { name: "Office Path 20" })).toBeTruthy();
  expect(screen.getByRole("cell", { name: "future-state" })).toBeTruthy();
  expect(unexpected).toEqual([]);
});
it("filters plan instances from the first page without changing selected targets", async () => {
  const instances = Array.from({ length: 18 }, (_, i) => ({ id: `core-${i}`, name: `Office core ${i}`, hostId: "host", adapterId: "routeweaver/xray", version: "26.3.27" }));
  const inventory = { hosts: [{ id: "host", name: "Host", address: "example.test" }], instances, endpoints: [], links: [],
    deployments: [{ id: "path", name: "Office path", ir: { programs: instances.map(instance => ({ instance })) } }] } as unknown as Infrastructure;
  const unexpected: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { unexpected.push(url); throw new Error("Unexpected request"); }));
  await mount(<FleetPlanForm inventory={inventory} history={[]} initialDeploymentId="path" initialTargetIds={["core-0"]} onClose={() => {}} onCreated={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(screen.getByRole("checkbox", { name: "选择实例 Office core 16" })).toBeTruthy();
  const search = screen.getByRole("textbox", { name: "筛选批量变更实例" });
  await userEvent.type(search, " office ");
  expect(screen.getByRole("checkbox", { name: "选择实例 Office core 0" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText("已选择 1 个实例")).toBeTruthy();
  expect(unexpected).toEqual([]);
});
