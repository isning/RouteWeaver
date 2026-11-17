// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { DiagnosticsPanel } from "./Diagnostics";
let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); });
it("finds local test history without writes and retains details when a status update leaves the filter", async () => {
  const target = { id: "target", nodeId: "host", name: "Target", url: "https://example.test/probe", methods: ["connectivity"] };
  const jobs = Array.from({ length: 12 }, (_, i) => ({
    id: `job-${i}`, targetId: target.id, instanceId: "core", scope: { nodeId: "host", instanceId: "core" },
    target: { ...target, name: `Target ${i}` }, kind: "connectivity", pathMode: "node_direct",
    maxBytes: 0, timeoutSeconds: 10, requestedAt: "2026-11-17T00:00:00Z", expiresAt: "2026-11-17T00:02:00Z",
    direction: "node_to_target", estimatedMaxBytes: 0, costBasis: "application_payload",
    status: i < 7 ? "succeeded" : i === 11 ? "future-state" : "failed",
  }));
  const unexpected: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const data: Record<string, unknown> = {
      "/api/admin/diagnostic-targets": [target],
      "/api/admin/diagnostic-jobs": [...jobs, { ...jobs[0], id: "other-host", target: { ...target, name: "Private elsewhere" }, scope: { nodeId: "other", instanceId: "other" } }],
    };
    if ((init?.method && init.method !== "GET") || !Object.hasOwn(data, url)) { unexpected.push(url); throw new Error("Unexpected request"); }
    return new Response(JSON.stringify(data[url]), { headers: { "Content-Type": "application/json" } });
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><UIProviders><DiagnosticsPanel host={{ id: "host", name: "Host", address: "example.test" }} instances={[]} /></UIProviders></QueryClientProvider>);
  await screen.findByText("Target 0");
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  const tools = screen.getByRole("search", { name: "查找测试记录" });
  await userEvent.click(within(tools).getByRole("combobox", { name: "筛选测试状态" }));
  await userEvent.click(screen.getByRole("option", { name: "测试完成" }));
  expect(screen.getByText("Target 0")).toBeTruthy();
  const search = within(tools).getByRole("searchbox", { name: "搜索测试记录" });
  await userEvent.type(search, " target 0 ");
  expect(screen.getAllByRole("button", { name: "查看测试结果" })).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "查看测试结果" }));
  const details = within(screen.getByRole("dialog", { name: "测试详情" }));
  jobs[0].status = "failed";
  await userEvent.click(details.getByRole("button", { name: "刷新结果" }));
  await details.findByText("测试失败");
  expect(details.getByText("Target 0")).toBeTruthy();
  await userEvent.click(details.getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(document.activeElement).toBe(search));
  expect(screen.getByText("没有匹配的测试记录")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  expect(document.activeElement).toBe(search);
  await userEvent.click(within(tools).getByRole("combobox", { name: "筛选测试状态" }));
  await userEvent.click(screen.getByRole("option", { name: "future-state" }));
  expect(screen.getByText("Target 11")).toBeTruthy();
  await userEvent.type(search, " 连通性 ");
  expect(screen.getByText("Target 11")).toBeTruthy();
  await userEvent.clear(search);
  await userEvent.type(search, "服务器直连");
  expect(screen.getByText("Target 11")).toBeTruthy();
  await userEvent.clear(search);
  await userEvent.type(search, "Private elsewhere");
  expect(screen.getByText("没有匹配的测试记录")).toBeTruthy();
  expect(unexpected).toEqual([]);
});
