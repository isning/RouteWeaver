// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdminPage } from "./Admin";
import { UIProviders } from "./ui-patterns/providers";
let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); });
it("finds audit actions and actors across pages and restores unknown actions without writes", async () => {
  const unexpected: string[] = [];
  const records = Array.from({ length: 24 }, (_, i) => ({
    id: `audit-${i}`, actorId: i < 12 ? "Operator-A" : "Operator-B",
    action: i < 12 ? "fleet.stop.queued" : "future.action", targetId: `target-${i}`,
    at: "2026-11-17T00:00:00Z",
  }));
  const data: Record<string, unknown> = {
    "/api/state": { users: [], nodes: [], routes: [], revisions: [], capabilities: [] },
    "/api/services": [], "/api/published-routes": [], "/api/audit": records,
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if ((init?.method && init.method !== "GET") || !Object.hasOwn(data, url)) { unexpected.push(url); throw new Error("Unexpected request"); }
    return new Response(JSON.stringify(data[url]), { headers: { "Content-Type": "application/json" } });
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><UIProviders><AdminPage page="activity" /></UIProviders></QueryClientProvider>);
  await screen.findByRole("cell", { name: "target-0" });
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(screen.queryByRole("cell", { name: "target-0" })).toBeNull();
  const toolbar = screen.getByRole("search", { name: "查找操作审计" });
  const search = within(toolbar).getByRole("searchbox", { name: "搜索操作审计" });
  await userEvent.type(search, " operator-a ");
  expect(screen.getByRole("cell", { name: "target-0" })).toBeTruthy();
  await userEvent.clear(search);
  await userEvent.click(within(toolbar).getByRole("combobox", { name: "筛选审计操作" }));
  await userEvent.click(screen.getByRole("option", { name: "future.action" }));
  expect(screen.getByRole("cell", { name: "target-12" })).toBeTruthy();
  expect(screen.queryByRole("cell", { name: "target-0" })).toBeNull();
  await userEvent.type(search, "不存在");
  await userEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  expect(screen.getByRole("cell", { name: "target-0" })).toBeTruthy();
  expect(document.activeElement).toBe(search);
  expect(unexpected).toEqual([]);
});
