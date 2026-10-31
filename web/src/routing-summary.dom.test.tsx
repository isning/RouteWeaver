// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RoutingReview, RoutingSummaryView } from "./RoutingSummary";
import type { RoutingSummary } from "./types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const advanced = (
  kind: "group" | "endpoint" | "direct" | "reject",
  label?: string,
): RoutingSummary => ({
  version: 1,
  kind: "advanced",
  advanced: {
    defaultAction: { kind, ...(label ? { label } : {}) },
    ruleCount: 4,
    groupCount: 2,
    nodeCount: 3,
  },
});

it("reads frozen advanced intent without fetching a feed or offering an editor", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(<RoutingSummaryView summary={advanced("group", "已发布策略组")} />);
  expect(screen.getByText("由策略组「已发布策略组」决定")).toBeTruthy();
  expect(screen.getByText("4 条分流规则 · 2 个策略组 · 3 个节点")).toBeTruthy();
  expect(screen.getByText(/不表示客户端当前选中的节点/)).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.queryByText(/在完整配置中查看/)).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps all scope caveats in one initially closed, keyboard-focusable disclosure", async () => {
  const user = userEvent.setup();
  render(<RoutingSummaryView summary={advanced("group", "已发布策略组")} />);
  const trigger = screen.getByText("摘要说明");
  const details = trigger.closest("details")!;
  expect(trigger.tagName).toBe("SUMMARY");
  expect(details.open).toBe(false);
  expect(
    within(details).getByText(
      "规则数不含默认处理及规则文件内条目；节点数是配置包含数量，不代表在线状态。",
    ),
  ).toBeTruthy();
  expect(
    within(details).getByText(
      "策略组按其配置决定流量去向，不表示客户端当前选中的节点。",
    ),
  ).toBeTruthy();
  await user.tab();
  expect(document.activeElement).toBe(trigger);
  await user.click(trigger);
  expect(details.open).toBe(true);
  await user.click(trigger);
  expect(details.open).toBe(false);
  expect(screen.getByText("由策略组「已发布策略组」决定")).toBeTruthy();
  expect(screen.getByText("4 条分流规则 · 2 个策略组 · 3 个节点")).toBeTruthy();
});

it.each([
  ["direct", undefined, "直连"],
  ["reject", undefined, "拒绝连接"],
  ["endpoint", "发布时节点名称", "节点「发布时节点名称」"],
] as const)(
  "describes the %s default action without inventing a group selection",
  (kind, label, text) => {
    render(<RoutingSummaryView summary={advanced(kind, label)} />);
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByText(/由策略组/)).toBeNull();
  },
);

it("keeps unavailable legacy details separate from a detailed pending publication", () => {
  render(
    <RoutingReview
      published={{ version: 1, kind: "advanced" }}
      candidate={advanced("group", "待发布策略组")}
    />,
  );
  const published = screen.getByRole("heading", {
    name: "已发布",
  }).parentElement!;
  const candidate = screen.getByRole("heading", {
    name: "待发布",
  }).parentElement!;
  expect(
    within(published).getByText("这份高级配置暂无可用的分流详情。"),
  ).toBeTruthy();
  expect(within(published).queryByText(/待发布策略组/)).toBeNull();
  expect(
    within(candidate).getByText("由策略组「待发布策略组」决定"),
  ).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});

it("does not substitute current candidate details for the frozen published summary", () => {
  render(
    <RoutingReview
      published={advanced("group", "旧策略组")}
      candidate={advanced("reject")}
    />,
  );
  const change = screen.getByText("未匹配规则的流量").parentElement!;
  expect(within(change).getAllByRole("term")).toHaveLength(1);
  const values = within(change).getByRole("definition");
  const published = within(values).getByText("已发布").parentElement!;
  const candidate = within(values).getByText("待发布").parentElement!;
  expect(within(published).getByText("由策略组「旧策略组」决定")).toBeTruthy();
  expect(within(published).queryByText("拒绝连接")).toBeNull();
  expect(within(candidate).getByText("拒绝连接")).toBeTruthy();
  expect(within(candidate).queryByText(/旧策略组/)).toBeNull();
});

it.each([
  ["native-override", "使用原生配置覆盖，无法提供可靠的分流摘要。"],
  ["nodes-only", "纯节点订阅，不包含分流规则。"],
] as const)(
  "keeps %s routing opaque even when extraneous advanced details exist",
  (kind, text) => {
    render(
      <RoutingSummaryView
        summary={{ ...advanced("group", "不能显示"), kind }}
      />,
    );
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByText(/不能显示/)).toBeNull();
    expect(screen.queryByText(/条分流规则/)).toBeNull();
  },
);

it("preserves basic frozen labels and the unavailable fallback", () => {
  const { rerender } = render(
    <RoutingSummaryView
      summary={{
        version: 1,
        kind: "basic",
        chatGPT: { endpointId: "old", label: "旧线路" },
        default: { endpointId: "other", label: "其他线路" },
      }}
    />,
  );
  expect(screen.getByText("旧线路")).toBeTruthy();
  expect(screen.getByText("其他线路")).toBeTruthy();
  rerender(<RoutingSummaryView />);
  expect(screen.getByText("这份订阅暂无可用的分流摘要。")).toBeTruthy();
});
