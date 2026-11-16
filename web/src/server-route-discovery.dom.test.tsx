// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ServerRoutesPage } from "./ServerRoutes";
import { UIProviders } from "./ui-patterns/providers";
let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); });
it("combines draft status with trimmed search and restores the list without writes", async () => {
  const unexpected: string[] = [];
  const data: Record<string, unknown> = {
    "/api/hosts": [], "/api/core-instances": [], "/api/managed-endpoints": [], "/api/links": [],
    "/api/server-deployments": [
      { id: "saved", name: "日常路径", ir: { programs: [] }, diagnostics: [], updatedAt: "2026-11-16T00:00:00Z" },
      { id: "review", name: "待调整路径", ir: { programs: [] }, diagnostics: ["检查配置"], updatedAt: "2026-11-16T00:00:00Z" },
    ],
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if ((init?.method && init.method !== "GET") || !Object.hasOwn(data, url)) { unexpected.push(url); throw new Error("Unexpected request"); }
    return new Response(JSON.stringify(data[url]), { headers: { "Content-Type": "application/json" } });
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><UIProviders><ServerRoutesPage /></UIProviders></QueryClientProvider>);
  await screen.findByRole("button", { name: "日常路径" });
  const tools = screen.getByRole("search", { name: "查找转发路径" });
  await userEvent.click(within(tools).getByRole("button", { name: "需要调整" }));
  expect(screen.queryByRole("button", { name: "日常路径" })).toBeNull();
  const search = within(tools).getByRole("searchbox", { name: "搜索转发路径" });
  await userEvent.type(search, " 待调整 ");
  expect(screen.getByRole("button", { name: "待调整路径" })).toBeTruthy();
  await userEvent.type(search, "不存在");
  await userEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  expect(screen.getByRole("button", { name: "日常路径" })).toBeTruthy();
  expect(document.activeElement).toBe(search);
  expect(unexpected).toEqual([]);
});
