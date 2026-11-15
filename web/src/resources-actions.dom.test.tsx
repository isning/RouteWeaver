// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { ResourcesPage } from "./Resources";
import type { RuleResource } from "./types";

const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(c => c.clear()); vi.unstubAllGlobals(); });
const resource = (id: string, failed = false): RuleResource => ({
  id, name: id, revision: "1", digest: "test", format: "surge", location: "remote",
  url: "https://example.test/rules", updatePolicy: "follow", visibility: "private",
  acceptedVersion: "v1", canRefresh: true, refreshStatus: failed ? "failed" : "ready",
});
function mount(items: RuleResource[], cached?: RuleResource[]) {
  const reads: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    reads.push(`${init?.method ?? "GET"} ${url}`);
    return new Response(JSON.stringify(items), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  if (cached) client.setQueryData(["resources"], cached);
  render(<QueryClientProvider client={client}><UIProviders><ResourcesPage /></UIProviders></QueryClientProvider>);
  return { client, reads };
}
it("filters real refresh failures, retains repair actions, and resets without mutations", async () => {
  const { reads } = mount([resource("失败规则", true), resource("正常规则")]);
  await screen.findByRole("button", { name: "正常规则" });
  await userEvent.click(screen.getByRole("button", { name: "刷新失败 1" }));
  expect(screen.queryByRole("button", { name: "正常规则" })).toBeNull();
  const row = screen.getByRole("button", { name: "失败规则" }).closest("tr")!;
  expect(within(row).getByRole("button", { name: "替换文件" })).toBeTruthy();
  expect(within(row).getByRole("button", { name: "刷新文件" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "全部 2" }));
  expect(screen.getByRole("button", { name: "正常规则" })).toBeTruthy();
  expect(reads).toEqual(["GET /api/me/resources"]);
});
it("shows a filtered empty state rather than an empty inventory and supports reset", async () => {
  mount([resource("正常规则")]);
  await screen.findByRole("button", { name: "正常规则" });
  await userEvent.click(screen.getByRole("button", { name: "刷新失败 0" }));
  expect(screen.getByRole("heading", { name: "没有刷新失败的规则资源" })).toBeTruthy();
  expect(screen.queryByText("暂无规则资源")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "查看全部" }));
  expect(screen.getByRole("button", { name: "正常规则" })).toBeTruthy();
});
it("rechecks a fresh overview cache and updates failure counts after repair", async () => {
  const { client, reads } = mount([resource("已恢复规则")], [resource("旧失败规则", true)]);
  await screen.findByRole("button", { name: "已恢复规则" });
  expect(screen.getByRole("button", { name: "刷新失败 0" })).toBeTruthy();
  expect(reads).toEqual(["GET /api/me/resources"]);
  await userEvent.click(screen.getByRole("button", { name: "刷新失败 0" }));
  await waitFor(() => expect(client.getQueryState(["resources"])?.fetchStatus).toBe("idle"));
  expect(screen.getByRole("heading", { name: "没有刷新失败的规则资源" })).toBeTruthy();
});
it("keeps the real empty inventory state", async () => {
  mount([]);
  expect(await screen.findByRole("heading", { name: "暂无规则资源" })).toBeTruthy();
  expect(screen.queryByRole("group", { name: "筛选规则资源" })).toBeNull();
});
it("does not call a failed read an empty or healthy resource inventory", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "资源读取失败" }), {
    status: 503, headers: { "Content-Type": "application/json" },
  })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders><ResourcesPage /></UIProviders></QueryClientProvider>);
  expect(await screen.findByText("资源读取失败")).toBeTruthy();
  expect(screen.queryByText("暂无规则资源")).toBeNull();
  expect(screen.queryByText("没有刷新失败的规则资源")).toBeNull();
  expect(screen.queryByRole("group", { name: "筛选规则资源" })).toBeNull();
});
