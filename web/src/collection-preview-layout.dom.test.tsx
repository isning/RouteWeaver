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
  const tab = within(rail).getByRole("tab", { name: `原始输入 · ${longName}` });
  expect(tab.classList.contains("whitespace-nowrap")).toBe(true);
  expect(tab.classList.contains("max-w-64")).toBe(true);
  expect(tab.getAttribute("title")).toBe(`原始输入 · ${longName}`);
  await userEvent.click(tab);
  const panel = screen.getByRole("tabpanel", {
    name: `原始输入 · ${longName}`,
  });
  expect(
    within(panel).getByRole("heading", { name: `原始输入 · ${longName}` }),
  ).toBeTruthy();
  expect(
    within(panel).getByText("0 个节点 · 移除 0 个 · 修改 0 个"),
  ).toBeTruthy();
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
      .getByRole("tab", { name: `原始输入 · ${longName}` })
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
    screen.getByRole("tabpanel", { name: `原始输入 · ${longName}` }),
  ).toBeTruthy();
  await user.keyboard("{End}");
  expect(
    screen.getByRole("tabpanel", { name: "来源处理 · 来源 24" }),
  ).toBeTruthy();
  await user.keyboard("{Home}");
  expect(screen.getByRole("tabpanel", { name: "最终结果" })).toBeTruthy();
});
