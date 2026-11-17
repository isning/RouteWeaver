// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdminPage } from "./Admin";
import { UIProviders } from "./ui-patterns/providers";
let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); });
for (const page of ["users", "services"] as const) {
  it(`starts a trimmed ${page} search on its first page and clears back to the input`, async () => {
    const rows = Array.from({ length: 24 }, (_, i) => ({
      id: String(i), name: `${i < 12 ? "Target" : "Other"}${i}`, enabled: true,
      quotaBytes: 0, usedBytes: 0, rateBytesPerSecond: 0,
    }));
    const unexpected: string[] = [];
    const data: Record<string, unknown> = {
      "/api/state": { users: rows, nodes: [], routes: [], revisions: [], capabilities: [], services: rows },
      "/api/rates": [], "/api/services": rows, "/api/published-routes": [], "/api/user-groups": [],
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method && init.method !== "GET") || !Object.hasOwn(data, url)) { unexpected.push(url); throw new Error("Unexpected request"); }
      return new Response(JSON.stringify(data[url]), { headers: { "Content-Type": "application/json" } });
    }));
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><UIProviders><AdminPage page={page} /></UIProviders></QueryClientProvider>);
    await screen.findAllByText("Target0", { exact: true });
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.queryAllByText("Target0", { exact: true })).toHaveLength(0);
    const search = screen.getByRole("textbox", { name: page === "users" ? "搜索用户" : "搜索服务方案" });
    await userEvent.type(search, " tArGeT ");
    expect(screen.getAllByText("Target0", { exact: true }).length).toBeGreaterThan(0);
    await userEvent.type(search, "missing");
    await userEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(screen.getAllByText("Target0", { exact: true }).length).toBeGreaterThan(0);
    expect(document.activeElement).toBe(search);
    expect(unexpected).toEqual([]);
  });
}
