// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CollectionPreview } from "./CollectionPreview";
import type { Collection, Preview, Source } from "./types";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const longName = "示例机场及完整来源身份".repeat(12);
const sources: Source[] = [
  { id: "source", name: longName, enabled: true, kind: "text" },
];
const collection: Collection = {
  id: "collection",
  name: "Collection",
  sources: [{ sourceId: "source", steps: [] }],
  steps: [],
};
const preview: Preview = {
  endpoints: [],
  stages: [
    { scope: "raw", sourceId: "source", endpoints: [] },
    {
      scope: "source-result",
      sourceId: "source",
      endpoints: [],
      removedIds: ["removed"],
    },
    { scope: "merged", endpoints: [] },
  ],
};

it("bounds long stage labels to a one-line scrolling rail while preserving the selected full identity above counts", async () => {
  render(
    <CollectionPreview
      value={preview}
      sources={sources}
      collection={collection}
    />,
  );
  const rail = screen.getByRole("tablist", { name: "处理阶段" });
  expect(rail.closest('[data-slot="scroll-area"]')).toBeTruthy();
  expect(rail.classList.contains("flex-nowrap")).toBe(true);
  const tab = within(rail).getByRole("tab", { name: `原始输入 ${longName}` });
  expect(tab.classList.contains("whitespace-nowrap")).toBe(true);
  expect(tab.classList.contains("max-w-64")).toBe(true);
  expect(tab.getAttribute("title")).toBe(`原始输入 ${longName}`);
  await userEvent.click(tab);
  const panel = screen.getByRole("tabpanel", {
    name: `原始输入 ${longName}`,
  });
  expect(
    within(panel).getByRole("heading", { name: `原始输入 ${longName}` }),
  ).toBeTruthy();
  expect(within(panel).getByText("0 个节点")).toBeTruthy();
  expect(panel.closest('[data-slot="scroll-area"]')).toBeNull();
});

it("keeps keyboard traversal and stage identity after additional preview stages arrive", async () => {
  const view = render(
    <CollectionPreview
      value={preview}
      sources={sources}
      collection={collection}
    />,
  );
  const user = userEvent.setup();
  screen.getByRole("tab", { name: "最终结果" }).focus();
  await user.keyboard("{ArrowRight}");
  expect(
    screen
      .getByRole("tab", { name: `原始输入 ${longName}` })
      .getAttribute("aria-selected"),
  ).toBe("true");
  const more: Preview = {
    ...preview,
    stages: [
      ...preview.stages!,
      ...Array.from({ length: 25 }, (_, index) => ({
        scope: "source",
        sourceId: `source-${index}`,
        endpoints: [],
      })),
    ],
  };
  const moreSources = [
    ...sources,
    ...Array.from({ length: 25 }, (_, index) => ({
      id: `source-${index}`,
      name: `来源 ${index}`,
      kind: "text",
      enabled: true,
    })),
  ];
  view.rerender(
    <CollectionPreview
      value={more}
      sources={moreSources}
      collection={collection}
    />,
  );
  expect(screen.getAllByRole("tab")).toHaveLength(29);
  expect(
    screen.getByRole("tabpanel", { name: `原始输入 ${longName}` }),
  ).toBeTruthy();
  await user.keyboard("{End}");
  expect(
    screen.getByRole("tabpanel", { name: "来源处理 来源 24" }),
  ).toBeTruthy();
  await user.keyboard("{Home}");
  expect(screen.getByRole("tabpanel", { name: "最终结果" })).toBeTruthy();
});

it("reports step-input deltas but never treats snapshot summaries as additions, including older responses", async () => {
  const value: Preview = {
    endpoints: [],
    stages: [
      { scope: "raw", endpoints: [], comparison: "snapshot", addedIds: [] },
      {
        scope: "source-result",
        endpoints: [],
        comparison: "snapshot",
        addedIds: [],
      },
      { scope: "merged", endpoints: [] },
      {
        scope: "source",
        sourceId: "source",
        stepId: "rename",
        comparison: "step-input",
        endpoints: [],
        addedIds: [],
        changedIds: ["renamed"],
        removedIds: [],
      },
      {
        scope: "aggregate",
        stepId: "drop",
        endpoints: [],
        removedIds: ["removed"],
        changedIds: [],
      },
    ],
  };
  const recipe: Collection = {
    ...collection,
    sources: [
      {
        sourceId: "source",
        steps: [
          { id: "rename", kind: "rename", enabled: true, template: "Named" },
        ],
      },
    ],
    steps: [{ id: "drop", kind: "drop", enabled: true }],
  };
  render(
    <CollectionPreview value={value} sources={sources} collection={recipe} />,
  );
  const user = userEvent.setup();
  for (const name of ["原始输入", "来源结果", "有序合并"]) {
    await user.click(screen.getByRole("tab", { name }));
    const panel = within(screen.getByRole("tabpanel"));
    expect(panel.getByText("0 个节点")).toBeTruthy();
    expect(panel.queryByText(/新增|移除|修改|相对此步骤输入/)).toBeNull();
  }
  await user.click(screen.getByRole("tab", { name: /第 1 步：重新命名/ }));
  for (const fact of ["0 个节点", "相对此步骤输入", "新增 0 个", "移除 0 个", "修改 1 个"]) expect(within(screen.getByRole("tabpanel")).getByText(fact)).toBeTruthy();
  await user.click(screen.getByRole("tab", { name: /合并后 第 1 步/ }));
  for (const fact of ["0 个节点", "相对此步骤输入", "新增 0 个", "移除 1 个", "修改 0 个"]) expect(within(screen.getByRole("tabpanel")).getByText(fact)).toBeTruthy();
});

it("keeps selected source-step identity through reorder, label changes and an earlier stage removal", async () => {
  const recipe: Collection = {
    ...collection,
    sources: ["alpha", "beta"].map((sourceId) => ({
      sourceId,
      steps: [{ id: "rename", kind: "rename", enabled: true, template: "{name}" }],
    })),
  };
  const feeds: Source[] = ["alpha", "beta"].map((id) => ({ id, name: id, enabled: true, kind: "text" }));
  const alpha = { scope: "source", sourceId: "alpha", stepId: "rename", endpoints: [], changedIds: ["a"] };
  const beta = { scope: "source", sourceId: "beta", stepId: "rename", endpoints: [], changedIds: ["b", "c"] };
  const view = render(<CollectionPreview value={{ stages: [alpha, beta] }} sources={feeds} collection={recipe} />);
  await userEvent.click(screen.getByRole("tab", { name: "beta 第 1 步：重新命名" }));
  const selectedTab = document.activeElement;
  view.rerender(<CollectionPreview value={{ stages: [beta, alpha] }} sources={feeds.map((source) => ({ ...source, name: source.id.toUpperCase() }))} collection={recipe} />);
  expect(screen.getByRole("tab", { name: "BETA 第 1 步：重新命名" })).toBe(selectedTab);
  expect(document.activeElement).toBe(selectedTab);
  expect(within(screen.getByRole("tabpanel")).getByText("修改 2 个")).toBeTruthy();
  view.rerender(<CollectionPreview value={{ stages: [beta] }} sources={feeds} collection={recipe} />);
  expect(screen.getByRole("tab", { name: "beta 第 1 步：重新命名" }).getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(selectedTab);
});

it("returns a removed focused stage to final results and scrolls only to its nearest edges", async () => {
  const scroll = vi.fn();
  const view = render(<CollectionPreview value={preview} sources={sources} collection={collection} />);
  await userEvent.click(screen.getByRole("tab", { name: `原始输入 ${longName}` }));
  const final = screen.getByRole("tab", { name: "最终结果" });
  Object.defineProperty(final, "scrollIntoView", { configurable: true, value: scroll });
  view.rerender(<CollectionPreview value={{ ...preview, stages: preview.stages!.slice(1) }} sources={sources} collection={collection} />);
  expect(screen.getByRole("tabpanel", { name: "最终结果" })).toBeTruthy();
  expect(document.activeElement).toBe(final);
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "nearest", inline: "nearest" });
  view.rerender(<CollectionPreview value={preview} sources={sources} collection={collection} />);
  expect(final.getAttribute("aria-selected")).toBe("true");
  expect(scroll).toHaveBeenCalledTimes(1);
});

it("resets a removed selection without stealing editor focus or scrolling, even if the stage returns", async () => {
  const scroll = vi.fn();
  const content = (value: Preview) => <><input aria-label="集合名称" /><CollectionPreview value={value} sources={sources} collection={collection} /></>;
  const view = render(content(preview));
  await userEvent.click(screen.getByRole("tab", { name: `原始输入 ${longName}` }));
  const field = screen.getByRole("textbox", { name: "集合名称" });
  await userEvent.click(field);
  Object.defineProperty(screen.getByRole("tab", { name: "最终结果" }), "scrollIntoView", { configurable: true, value: scroll });
  view.rerender(content({ endpoints: [], stages: [] }));
  expect(screen.getByRole("tabpanel", { name: "最终结果" })).toBeTruthy();
  expect(document.activeElement).toBe(field);
  expect(scroll).not.toHaveBeenCalled();
  view.rerender(content(preview));
  expect(screen.getByRole("tab", { name: "最终结果" }).getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(field);
  expect(scroll).not.toHaveBeenCalled();
});

it("shows one total for each intermediate stage while retaining final totals, paging and step-input changes", async () => {
  const endpoints = Array.from({ length: 9 }, (_, index) => ({
    id: `node-${index}`, name: `Node ${index}`, region: "DE",
    connection: { protocol: "socks", host: "proxy.example.test", port: 1080 },
  }));
  const recipe: Collection = {
    ...collection,
    steps: [{ id: "deduplicate", kind: "deduplicate", enabled: true }],
  };
  render(<CollectionPreview collection={recipe} sources={sources} value={{
    endpoints: endpoints.slice(0, 1),
    stages: [
      { scope: "raw", endpoints },
      { scope: "aggregate", stepId: "deduplicate", endpoints: endpoints.slice(0, 1), comparison: "step-input", removedIds: ["removed"] },
    ],
  }} />);
  const user = userEvent.setup();
  expect(within(screen.getByRole("tabpanel")).getByText(/已加载/).textContent).toBe("已加载 1 项");
  await user.click(screen.getByRole("tab", { name: "原始输入" }));
  let panel = within(screen.getByRole("tabpanel"));
  expect(panel.getByText("9 个节点")).toBeTruthy();
  expect(panel.queryByText(/已加载/)).toBeNull();
  expect(panel.getByText("第 1 / 2 页")).toBeTruthy();
  await user.click(panel.getByRole("button", { name: "下一页" }));
  expect(panel.getByText("Node 8")).toBeTruthy();
  expect(panel.getByText("第 2 / 2 页")).toBeTruthy();
  expect(panel.getByText("9 个节点")).toBeTruthy();
  await user.click(screen.getByRole("tab", { name: "合并后 第 1 步：去除重复连接" }));
  panel = within(screen.getByRole("tabpanel"));
  for (const fact of ["1 个节点", "相对此步骤输入", "新增 0 个", "移除 1 个", "修改 0 个"]) {
    expect(panel.getByText(fact)).toBeTruthy();
  }
  expect(panel.queryByText(/已加载/)).toBeNull();
  await user.click(screen.getByRole("tab", { name: "最终结果" }));
  expect(within(screen.getByRole("tabpanel")).getByText(/已加载/).textContent).toBe("已加载 1 项");
});
