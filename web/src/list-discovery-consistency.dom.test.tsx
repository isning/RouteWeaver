// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { SourcesPage } from "./Sources";
import { PublishedRoutesPage } from "./PublishedRoutes";
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); });
function mount(ui: React.ReactElement, data: Record<string, unknown>) {
  const unexpected: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if ((init?.method && init.method !== "GET") || !Object.hasOwn(data, url)) { unexpected.push(url); throw new Error("Unexpected request"); }
    return new Response(JSON.stringify(data[url]), { headers: { "Content-Type": "application/json" } });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders>{ui}</UIProviders></QueryClientProvider>);
  return unexpected;
}
it("starts source searches and status changes on the first page even when matches span multiple pages", async () => {
  const data = Array.from({ length: 24 }, (_, i) => ({
    id: `source-${i}`, name: `${i < 12 ? "Target" : "Other"}${i}`, kind: "text", enabled: true,
    revision: "source-1", snapshot: { endpoints: [] },
    candidate: i < 12 ? { id: `candidate-${i}`, createdAt: "2026-11-17", diagnostics: [], affected: [],
      diff: { beforeCount: 0, afterCount: 0, added: [], removed: [], renamed: [], connectionChanged: [] } } : undefined,
  }));
  const unexpected = mount(<SourcesPage />, { "/api/me/sources": data });
  await screen.findByRole("button", { name: "Target0 文本导入" });
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  const search = screen.getByRole("textbox", { name: "搜索来源" });
  await userEvent.type(search, " target ");
  expect(screen.getByRole("button", { name: "Target0 文本导入" })).toBeTruthy();
  await userEvent.clear(search);
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  await userEvent.click(screen.getByRole("button", { name: "有更新" }));
  expect(screen.getByRole("button", { name: "Target0 文本导入" })).toBeTruthy();
  await userEvent.type(search, "missing");
  await userEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  expect(document.activeElement).toBe(search);
  expect(screen.getByRole("button", { name: "Target0 文本导入" })).toBeTruthy();
  expect(unexpected).toEqual([]);
});
it("matches complete displayed route addresses including effective overrides and existing IPv6 formatting", async () => {
  const routes = [
    { id: "office", name: "Office line", publicHost: "draft.example.test", publicPort: 443,
      effective: { publicHost: "live.example.test", publicPort: 8443 } },
    { id: "ipv6", name: "IPv6 line", publicHost: "2001:db8::1", publicPort: 443 },
  ].map(value => ({ deploymentId: "path", endpointIds: [], status: "draft", diagnostics: [], ...value }));
  const unexpected = mount(<PublishedRoutesPage />, {
    "/api/published-routes": routes, "/api/hosts": [], "/api/core-instances": [],
    "/api/managed-endpoints": [], "/api/links": [], "/api/server-deployments": [], "/api/state": { users: [], routes: [] },
  });
  await screen.findByRole("button", { name: "Office line" });
  const search = screen.getByRole("searchbox", { name: "搜索线路" });
  await userEvent.type(search, " LIVE.EXAMPLE.TEST:8443 ");
  expect(screen.getByRole("button", { name: "Office line" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "IPv6 line" })).toBeNull();
  await userEvent.clear(search);
  await userEvent.type(search, "2001:db8::1:443");
  expect(screen.getByRole("button", { name: "IPv6 line" })).toBeTruthy();
  await userEvent.clear(search);
  await userEvent.type(search, "draft.example.test");
  expect(screen.getByRole("button", { name: "Office line" })).toBeTruthy();
  expect(unexpected).toEqual([]);
});
