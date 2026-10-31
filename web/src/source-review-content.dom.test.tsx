// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SourceUpdateReview } from "./SourceUpdateReview";
import type { Source } from "./types";

const clients: QueryClient[] = [];
const source: Source = {
  id: "content-review",
  name: "Synthetic import",
  kind: "text",
  enabled: true,
  revision: "review-r1",
  candidate: {
    id: "candidate-one",
    createdAt: "2026-10-23",
    diff: {
      beforeCount: 0,
      afterCount: 1,
      added: [{ id: "endpoint-one", name: "London" }],
      removed: [],
      renamed: [],
      connectionChanged: [],
    },
    affected: [],
    diagnostics: [
      {
        code: "connection-extraction",
        message:
          "Only connection options are imported; routing, DNS, groups, providers and other full-configuration settings are not migrated.",
      },
      {
        code: "non-connection-outbound",
        message:
          "A policy or built-in outbound was not imported as a connection option.",
        ...{ index: 2 },
      },
      {
        code: "non-connection-outbound",
        message:
          "A policy or built-in outbound was not imported as a connection option.",
        ...{ index: 3 },
      },
      { code: "future-check", message: "Review this newly supported setting" },
      "Another import warning",
    ],
  },
};
function mount(value = source) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <SourceUpdateReview source={value} onClose={vi.fn()} />
      </UIProviders>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    original(element),
  );
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("groups only known extraction limits, keeps repeated omissions and other warnings, and states the first-import decision", async () => {
  mount();
  const dialog = await screen.findByRole("dialog", { name: "查看导入变化" });
  expect(within(dialog).getAllByText("仅导入连接选项")).toHaveLength(1);
  expect(within(dialog).getAllByRole("alert")).toHaveLength(3);
  expect(
    within(dialog).getByText("分流、DNS、分组等其他配置不会导入。"),
  ).toBeTruthy();
  expect(
    within(dialog).getByText("内置直连、拦截或策略分组不会作为连接选项导入。"),
  ).toBeTruthy();
  expect(within(dialog).getByText("（2 条提示）")).toBeTruthy();
  expect(within(dialog).getByText("原始条目：第 2、3 项")).toBeTruthy();
  expect(within(dialog).getAllByText("导入需注意")).toHaveLength(2);
  expect(
    within(dialog).getByText("Review this newly supported setting"),
  ).toBeTruthy();
  expect(within(dialog).getByText("Another import warning")).toBeTruthy();
  expect(
    within(dialog).getByText("应用后，这些选项可用于配置和预览。"),
  ).toBeTruthy();
  expect(
    within(dialog).getByText("现有草稿中的选择不自动替换，已发布订阅不更新。"),
  ).toBeTruthy();
  expect(
    within(dialog).getByText("来源输入已保存；不导入或稍后处理也会保留。"),
  ).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "应用更新" })).toBeTruthy();
  expect(
    within(dialog).getByRole("button", { name: "忽略本次更新" }),
  ).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "稍后处理" })).toBeTruthy();
});

it("keeps diagnostic locations without exposing known-code raw input, and treats an accepted empty snapshot as an update", async () => {
  mount({
    ...source,
    snapshot: { endpoints: [] },
    candidate: {
      ...source.candidate!,
      diagnostics: [
        {
          code: "non-connection-outbound",
          message:
            "Input https://person:synthetic-secret@example.invalid/feed?token=synthetic-token omitted",
          ...{ index: 4 },
        },
        {
          code: "non-connection-outbound",
          message: 'Input {"password":"synthetic-password"} omitted',
          ...{ index: 5 },
        },
        {
          code: "future-check",
          message: "Check this original entry",
          ...{ index: 9 },
        },
        {
          code: "another-check",
          message: "Check this original line",
          ...{ line: 7 },
        },
        "Repeated import warning",
        "Repeated import warning",
      ],
    },
  });
  const dialog = await screen.findByRole("dialog", { name: "查看变化" });
  expect(within(dialog).getAllByRole("alert")).toHaveLength(5);
  expect(within(dialog).getByText("原始条目：第 4、5 项")).toBeTruthy();
  expect(dialog.textContent).not.toContain("synthetic-secret");
  expect(dialog.textContent).not.toContain("synthetic-token");
  expect(dialog.textContent).not.toContain("synthetic-password");
  expect(
    within(dialog).getByText("第 9 项：Check this original entry"),
  ).toBeTruthy();
  expect(
    within(dialog).getByText("第 7 行：Check this original line"),
  ).toBeTruthy();
  expect(within(dialog).getAllByText("Repeated import warning")).toHaveLength(
    2,
  );
  expect(
    within(dialog).getByText("应用后，配置和预览将使用新选项。"),
  ).toBeTruthy();
  expect(
    within(dialog).queryByText("来源输入已保存；不导入或稍后处理也会保留。"),
  ).toBeNull();
  expect(within(dialog).getByRole("button", { name: "应用更新" })).toBeTruthy();
  expect(
    within(dialog).getByRole("button", { name: "忽略本次更新" }),
  ).toBeTruthy();
});
