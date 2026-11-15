// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Overview } from "./types";
import { OverviewActions } from "./OverviewActions";
vi.mock("./api", () => ({ list: vi.fn(), request: vi.fn() }));
import { list, request } from "./api";
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function mount(
  data: Record<string, unknown>,
  fail?: string,
  overview?: Overview,
  platformRoutesComplete = false,
  summaryItems: unknown[] = [],
) {
  vi.mocked(list).mockImplementation(async (path) => {
    if (path === fail) throw Error("unavailable");
    return (data[path] ?? []) as never;
  });
  vi.mocked(request).mockResolvedValue({
    asOf: "2026-11-15T08:00:00Z",
    items: summaryItems,
    partial: false,
    platformRoutesComplete,
    platformRouteIds: ["platform-route"],
  });
  const go = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <OverviewActions
        go={go}
        overview={overview}
        now={Date.parse("2026-11-15T08:00:00Z")}
      />
    </QueryClientProvider>,
  );
  return go;
}
it("opens one source review without applying its candidate; paused sources and stale errors are not incidents", async () => {
  const go = mount({
    "/me/sources": [
      {
        id: "s/1",
        name: "东京",
        enabled: true,
        refreshStatus: "review-required",
        candidate: { id: "c1" },
      },
      { id: "s2", name: "暂停", enabled: false, refreshStatus: "failed" },
      {
        id: "s3",
        name: "正常",
        enabled: true,
        refreshStatus: "accepted",
        lastError: "old",
      },
    ],
  });
  fireEvent.click(await screen.findByRole("button", { name: "查看变化" }));
  expect(go).toHaveBeenCalledWith("#sources?source=s%2F1&review=1");
  expect(screen.queryByText("暂停 更新失败")).toBeNull();
  expect(screen.queryByText("正常 更新失败")).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
});
it("keeps intentional drafts separate and never turns revoked outputs into publish tasks", async () => {
  mount({
    "/me/profiles": [
      { id: "draft", name: "草稿" },
      { id: "revoked", name: "已撤销" },
    ],
    "/me/outputs": [{ id: "o", profileId: "revoked", status: "revoked" }],
  });
  expect(await screen.findByText("1 份草稿")).toBeTruthy();
  expect(screen.queryByText(/尚未发布/)).toBeNull();
  expect(screen.queryByRole("heading", { name: /需要你处理/ })).toBeNull();
});
it("shows partial read failure instead of declaring all clear", async () => {
  mount({}, "/me/sources");
  expect(
    await screen.findByText("部分待办未能更新，已有结果可能过时。"),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
});
it("deduplicates candidate plus failure by source and links a failed rule to its review", async () => {
  const go = mount({
    "/me/sources": [
      {
        id: "s",
        name: "来源",
        enabled: true,
        refreshStatus: "failed",
        candidate: { id: "c" },
      },
    ],
    "/me/resources": [
      {
        id: "r",
        name: "规则",
        canRefresh: true,
        refreshStatus: "failed",
        acceptedVersion: "v1",
      },
    ],
  });
  fireEvent.click(await screen.findByRole("button", { name: "检查规则" }));
  expect(go).toHaveBeenCalledWith("#resources?resource=r");
  expect(screen.getAllByRole("button", { name: "检查来源" })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "查看变化" })).toBeNull();
  expect(screen.getByText("仍使用上次接纳的规则。")).toBeTruthy();
});

const quotaOverview = {
  status: "active",
  quotaBytes: 1000,
  remainingBytes: 50,
  accountingPending: false,
  user: { id: "u", name: "u", enabled: true, quotaBytes: 1000, usedBytes: 950 },
  usage: { rawBytes: 950, weightedBytes: 950 },
  routes: [{ id: "platform-route", name: "线路" }],
  entitlement: { expiresAt: "2026-11-16T08:00:00Z" },
} satisfies Overview;
it("only shows quota and expiry tasks with complete published platform eligibility", async () => {
  mount({}, undefined, quotaOverview, true);
  expect(await screen.findByText("平台流量剩余不足 10%")).toBeTruthy();
  expect(screen.getByText("平台服务即将到期")).toBeTruthy();
});
it("does not infer platform quota tasks from incomplete publication inventory", async () => {
  mount({}, undefined, quotaOverview, false);
  await waitFor(() => expect(screen.queryByText("正在读取待办…")).toBeNull());
  expect(screen.queryByText("平台流量剩余不足 10%")).toBeNull();
  expect(screen.queryByText("平台服务即将到期")).toBeNull();
});

it("matches the warm attention panel and gives real task kinds distinct decorative icons", async () => {
  const go = mount(
    {
      "/me/sources": [
        { id: "s", name: "来源", enabled: true, refreshStatus: "failed" },
      ],
      "/me/resources": [
        { id: "r", name: "规则", canRefresh: true, refreshStatus: "failed" },
      ],
    },
    undefined,
    quotaOverview,
    true,
    [
      {
        id: "output:o",
        kind: "output-changed",
        title: "有改动待发布",
        description: "查看变化",
        href: "#subscriptions?output=o",
        priority: "normal",
      },
      {
        id: "output:repair",
        kind: "output-reference-missing",
        title: "订阅需要修复",
        description: "重新选择线路",
        href: "#subscriptions?output=repair",
        priority: "high",
      },
    ],
  );
  await screen.findByText("平台流量剩余不足 10%");
  const panel = screen.getByRole("region", { name: /需要你处理/ });
  expect(panel.className).toContain("bg-amber-50/60");
  expect(panel.className).toContain("border-amber-200");
  expect(panel.className).toContain("dark:bg-amber-950/20");
  expect(panel.className).toContain("dark:border-amber-900/60");
  const list = panel.querySelector("ul")!;
  expect(list.className).toContain("divide-amber-200/70");
  fireEvent.click(screen.getByRole("button", { name: /展开其余/ }));
  for (const [title, icon] of [
    ["来源 更新失败", "lucide-file-input"],
    ["规则 更新失败", "lucide-file-warning"],
    ["平台流量剩余不足 10%", "lucide-gauge"],
    ["平台服务即将到期", "lucide-clock-3"],
    ["有改动待发布", "lucide-circle-alert"],
    ["订阅需要修复", "lucide-wrench"],
  ]) {
    const svg = screen.getByText(title).closest("li")!.querySelector("svg")!;
    expect(svg.classList.contains(icon)).toBe(true);
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.classList.contains("text-amber-600")).toBe(true);
    expect(svg.classList.contains("dark:text-amber-400")).toBe(true);
  }
  fireEvent.click(
    screen.getByText("有改动待发布").closest("li")!.querySelector("button")!,
  );
  expect(go).toHaveBeenCalledWith("#subscriptions?output=o");
});
