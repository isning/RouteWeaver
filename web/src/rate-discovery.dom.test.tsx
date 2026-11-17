// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { RateSettings } from "./Rates";
import type { RouteRecord } from "./types";
let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); });
it("finds rate versions by route without losing missing routes or calling writes", async () => {
  const rates = Array.from({ length: 15 }, (_, i) => ({
    id: `rate-${i}`, routeId: i < 8 ? "office" : i < 14 ? "travel" : "removed-route",
    micros: (i + 1) * 1000000, effectiveAt: "2026-01-01T00:00:00Z",
  }));
  const unexpected: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== "/api/rates" || (init?.method && init.method !== "GET")) { unexpected.push(url); throw new Error("Unexpected request"); }
    return new Response(JSON.stringify(rates), { headers: { "Content-Type": "application/json" } });
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><UIProviders><RateSettings routes={[
    { id: "office", name: "Office route" }, { id: "travel", name: "Travel route" },
  ] as RouteRecord[]} /></UIProviders></QueryClientProvider>);
  await screen.findByRole("cell", { name: "1×" });
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  const tools = screen.getByRole("search", { name: "查找倍率记录" });
  const search = within(tools).getByRole("searchbox", { name: "搜索倍率记录" });
  await userEvent.type(search, " OFFICE ");
  expect(screen.getByRole("cell", { name: "1×" })).toBeTruthy();
  await userEvent.clear(search);
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  await userEvent.click(within(tools).getByRole("combobox", { name: "筛选倍率线路" }));
  await userEvent.click(screen.getByRole("option", { name: "Office route" }));
  expect(screen.getByRole("cell", { name: "1×" })).toBeTruthy();
  await userEvent.type(search, "missing");
  expect(screen.getByText("没有匹配的倍率记录")).toBeTruthy();
  expect(screen.queryByText("未设置倍率版本的线路按 1× 扣量")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  expect(document.activeElement).toBe(search);
  await userEvent.click(within(tools).getByRole("combobox", { name: "筛选倍率线路" }));
  await userEvent.click(screen.getByRole("option", { name: "removed-route" }));
  await userEvent.type(search, " REMOVED-ROUTE ");
  expect(screen.getByRole("cell", { name: "15×" })).toBeTruthy();
  expect(screen.queryByText("当前生效")).toBeNull();
  expect(unexpected).toEqual([]);
});
