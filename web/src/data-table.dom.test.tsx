// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createRef } from "react";
import userEvent from "@testing-library/user-event";
import { DataTable, type DataTableHandle } from "./DataTable";

const hint = "向左右滚动查看完整表格";
const observers = new Set<{
  callback: ResizeObserverCallback;
  targets: Set<Element>;
}>();
let viewportWidth = 900;
let contentWidth = 720;

beforeEach(() => {
  viewportWidth = 900;
  contentWidth = 720;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    })),
  });
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    original(element),
  );
  // jsdom has no layout. Only the browser sizing and resize boundary are faked;
  // the shadcn/TanStack table, columns, controls and events remain real.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.matches('[data-slot="table-container"]') ? viewportWidth : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.matches('[data-slot="table-container"]')
        ? Math.max(viewportWidth, contentWidth)
        : 0;
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      targets = new Set<Element>();
      constructor(public callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.targets.add(target);
        observers.add(this);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        observers.delete(this);
      }
    },
  );
});

afterEach(() => {
  cleanup();
  observers.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function resize(width: number) {
  viewportWidth = width;
  for (const viewport of document.querySelectorAll(
    '[data-slot="table-container"]',
  ))
    notifyResize(viewport);
}

function notifyResize(target: Element) {
  act(() => {
    for (const observer of observers) {
      if (observer.targets.has(target))
        observer.callback([], observer as unknown as ResizeObserver);
    }
  });
}

it("shows the scroll hint only while the table overflows, including repeated resize", () => {
  render(
    <>
      <DataTable
        rowKey="id"
        rows={[{ id: "r1", name: "公开线路" }]}
        columns={[{ title: "线路", accessor: "name" }]}
        minWidth={720}
        pageSize={0}
      />
    </>,
  );
  expect(screen.queryByText(hint)).toBeNull();
  resize(254);
  expect(screen.getByText(hint)).toBeTruthy();
  expect(screen.getAllByRole("table")).toHaveLength(1);
  resize(900);
  expect(screen.queryByText(hint)).toBeNull();
  resize(375);
  expect(screen.getAllByText(hint)).toHaveLength(1);
});

it("remeasures changed data and columns without requiring a viewport resize", () => {
  const table = (name: string, details = false) => (
    <DataTable
      rowKey="id"
      rows={[{ id: "r1", name }]}
      columns={[
        { title: "线路", accessor: "name" },
        ...(details ? [{ title: "公开入口", accessor: "name" as const }] : []),
      ]}
      minWidth="max-content"
      pageSize={0}
    />
  );
  const view = render(table("线路 A"));
  expect(screen.queryByText(hint)).toBeNull();
  contentWidth = 1200;
  view.rerender(table("包含较长入口地址的线路 A", true));
  expect(screen.getByText(hint)).toBeTruthy();
  contentWidth = 640;
  view.rerender(table("线路 A"));
  expect(screen.queryByText(hint)).toBeNull();
});

it("does not show a scroll instruction for a hidden or non-scrollable table", () => {
  viewportWidth = 0;
  const table = (scroll?: { x: number }) => (
    <DataTable
      rowKey="id"
      rows={[{ id: "r1", name: "线路 A" }]}
      columns={[{ title: "线路", accessor: "name" }]}
      minWidth={scroll?.x}
      pageSize={0}
    />
  );
  const view = render(table({ x: 720 }));
  expect(screen.queryByText(hint)).toBeNull();
  resize(254);
  expect(screen.getByText(hint)).toBeTruthy();
  contentWidth = 200;
  view.rerender(table());
  expect(screen.queryByText(hint)).toBeNull();
});

it("keeps selection, fixed columns, row actions, focus and pagination when the hint changes", async () => {
  viewportWidth = 254;
  const selected = vi.fn();
  const edit = vi.fn();
  const changed = vi.fn();
  const ref = createRef<DataTableHandle>();
  render(
    <>
      <DataTable
        ref={ref}
        rowKey="id"
        rows={[
          { id: "r1", name: "线路 B" },
          { id: "r2", name: "线路 A" },
        ]}
        selection={{ onChange: selected, pinned: true }}
        columns={[
          {
            title: "线路",
            accessor: "name",
            pin: "left",
            sort: (a, b) => a.name.localeCompare(b.name),
          },
          {
            title: "操作",
            pin: "right",
            render: (_, row) => (
              <button onClick={() => edit(row.id)}>编辑 {row.name}</button>
            ),
          },
        ]}
        minWidth={720}
        pageSize={1}
        onSortingChange={(sorting) => changed("sort", sorting)}
        onPageChange={(page) => changed("page", page)}
      />
    </>,
  );
  expect(screen.getByText(hint)).toBeTruthy();
  const action = screen.getByRole("button", { name: "编辑 线路 B" });
  const table = screen.getByRole("table");
  const viewport = table.parentElement!;
  const checkbox = screen.getAllByRole("checkbox")[1] as HTMLInputElement;
  await userEvent.click(checkbox);
  expect(selected.mock.calls[0][0]).toEqual(["r1"]);
  expect(checkbox.getAttribute("aria-checked")).toBe("true");
  action.focus();
  viewport.scrollLeft = 150;
  resize(900);
  expect(screen.queryByText(hint)).toBeNull();
  expect(document.activeElement).toBe(action);
  expect(screen.getByRole("table")).toBe(table);
  expect(viewport.scrollLeft).toBe(150);
  resize(254);
  expect(screen.getByText(hint)).toBeTruthy();
  expect(checkbox.getAttribute("aria-checked")).toBe("true");
  expect(document.activeElement).toBe(action);
  await userEvent.keyboard("{Enter}");
  expect(edit).toHaveBeenCalledWith("r1");
  expect(ref.current?.nativeElement?.contains(table)).toBe(true);
  expect(typeof ref.current?.scrollTo).toBe("function");

  await userEvent.click(screen.getByRole("button", { name: "线路" }));
  expect(
    [...changed.mock.calls].reverse().find((call) => call[0] === "sort")?.[1],
  ).toEqual([{ id: "name", desc: false }]);
  expect(screen.getByRole("button", { name: "编辑 线路 A" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(changed.mock.calls.at(-1)).toEqual(["page", 2]);
  expect(screen.getByRole("button", { name: "编辑 线路 B" })).toBeTruthy();
  expect(screen.getAllByRole("checkbox")[1].getAttribute("aria-checked")).toBe(
    "true",
  );
});

it("detects the body viewport of a sticky table with a fixed header", () => {
  viewportWidth = 254;
  render(
    <>
      <DataTable
        rowKey="id"
        rows={[{ id: "r1", name: "线路 A" }]}
        columns={[{ title: "线路", accessor: "name" }]}
        minWidth={720}
        maxHeight={180}
        sticky
        pageSize={0}
      />
    </>,
  );
  expect(screen.getAllByText(hint)).toHaveLength(1);
  expect(screen.getByRole("columnheader", { name: "线路" })).toBeTruthy();
  expect(screen.getByRole("cell", { name: "线路 A" })).toBeTruthy();
  resize(900);
  expect(screen.queryByText(hint)).toBeNull();
  resize(254);
  expect(screen.getAllByText(hint)).toHaveLength(1);
});

it("updates the hint when table content changes size independently of its viewport", () => {
  render(
    <DataTable
      rowKey="id"
      rows={[{ id: "r1", name: "线路 A" }]}
      columns={[{ title: "线路", accessor: "name" }]}
      minWidth="max-content"
      pageSize={0}
    />,
  );
  expect(screen.queryByText(hint)).toBeNull();
  contentWidth = 1200;
  notifyResize(screen.getByRole("table"));
  expect(screen.getByText(hint)).toBeTruthy();
  contentWidth = 640;
  notifyResize(screen.getByRole("table"));
  expect(screen.queryByText(hint)).toBeNull();
});

it("hides irrelevant scroll guidance for no rows and restores it when rows return", () => {
  viewportWidth = 254;
  const table = (rows?: { id: string; name: string }[]) => (
    <DataTable
      rowKey="id"
      rows={rows}
      columns={[{ title: "线路", accessor: "name" }]}
      minWidth={720}
      empty="没有匹配的线路"
      pageSize={0}
    />
  );
  const view = render(table());
  expect(screen.getByText("没有匹配的线路")).toBeTruthy();
  expect(screen.queryByText(hint)).toBeNull();
  const originalTable = screen.getByRole("table");
  const rows = [{ id: "r1", name: "线路 A" }];
  view.rerender(table(rows));
  expect(screen.getByText(hint)).toBeTruthy();
  expect(screen.getByRole("cell", { name: "线路 A" })).toBeTruthy();
  view.rerender(table([]));
  expect(screen.getByText("没有匹配的线路")).toBeTruthy();
  expect(screen.queryByText(hint)).toBeNull();
  view.rerender(table(rows));
  expect(screen.getByText(hint)).toBeTruthy();
  expect(screen.getByRole("table")).toBe(originalTable);
});

it("honors controlled sorting, selection and page without mutating the owner's state", async () => {
  const sort = vi.fn(),
    select = vi.fn(),
    page = vi.fn();
  const rows = [
    { id: "b", name: "Beta" },
    { id: "a", name: "Alpha" },
  ];
  const columns = [
    {
      key: "name",
      title: "名称",
      accessor: "name" as const,
      sort: (a: (typeof rows)[0], b: (typeof rows)[0]) =>
        a.name.localeCompare(b.name),
    },
  ];
  const view = render(
    <DataTable
      rows={rows}
      columns={columns}
      rowKey="id"
      pageSize={1}
      page={1}
      onPageChange={page}
      sorting={[]}
      onSortingChange={sort}
      selection={{ selectedKeys: [], onChange: select }}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "名称" }));
  expect(sort).toHaveBeenCalledWith([{ id: "name", desc: false }]);
  expect(screen.getByRole("cell", { name: "Beta" })).toBeTruthy();
  await userEvent.click(screen.getByRole("checkbox", { name: "选择行 b" }));
  expect(select).toHaveBeenCalledWith(["b"], [rows[0]]);
  expect(
    screen
      .getByRole("checkbox", { name: "选择行 b" })
      .getAttribute("aria-checked"),
  ).toBe("false");
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(page).toHaveBeenLastCalledWith(2);
  expect(screen.getByRole("cell", { name: "Beta" })).toBeTruthy();
  view.rerender(
    <DataTable
      rows={rows}
      columns={columns}
      rowKey="id"
      pageSize={1}
      page={2}
      sorting={[{ id: "name", desc: false }]}
      selection={{ selectedKeys: ["b"] }}
    />,
  );
  expect(screen.getByRole("cell", { name: "Beta" })).toBeTruthy();
  expect(
    screen
      .getByRole("checkbox", { name: "选择行 b" })
      .getAttribute("aria-checked"),
  ).toBe("true");
});

it("pins explicit columns and disables unselectable rows while retaining expandable identity", async () => {
  const rows = [
    { id: "a", name: "Alpha" },
    { id: "b", name: "Beta" },
  ];
  const select = vi.fn();
  render(
    <DataTable
      rows={rows}
      rowKey="id"
      selection={{
        onChange: select,
        disabled: (row) => row.id === "b",
        pinned: true,
      }}
      minWidth={720}
      columns={[
        { title: "名称", accessor: "name", pin: "left", width: 180 },
        {
          key: "action",
          title: "操作",
          pin: "right",
          width: 100,
          render: (_, row) => <button>{row.name} 操作</button>,
        },
      ]}
      expandedRow={(row) => <p>{row.name} 详情</p>}
    />,
  );
  expect(
    screen.getByRole("columnheader", { name: "名称" }).style.position,
  ).toBe("sticky");
  expect(screen.getByRole("columnheader", { name: "名称" }).style.left).toBe(
    "40px",
  );
  expect(screen.getByRole("columnheader", { name: "操作" }).style.right).toBe(
    "0px",
  );
  await userEvent.click(
    screen.getByRole("checkbox", { name: "选择本页全部行" }),
  );
  expect(select).toHaveBeenLastCalledWith(["a"], [rows[0]]);
  expect(
    screen.getByRole("checkbox", { name: "选择行 b" }).hasAttribute("disabled"),
  ).toBe(true);
  await userEvent.click(screen.getAllByRole("button", { name: "展开详情" })[0]);
  expect(screen.getByText("Alpha 详情")).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "收起详情" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
});

it("clamps a shortened dataset to a valid page and communicates loading without dropping rows", async () => {
  const rows = [
    { id: "a", name: "Alpha" },
    { id: "b", name: "Beta" },
  ];
  const view = render(
    <DataTable
      rows={rows}
      columns={[{ title: "名称", accessor: "name" }]}
      rowKey="id"
      pageSize={1}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(screen.getByText("Beta")).toBeTruthy();
  view.rerender(
    <DataTable
      rows={[rows[0]]}
      columns={[{ title: "名称", accessor: "name" }]}
      rowKey="id"
      pageSize={1}
      loading
    />,
  );
  expect(screen.getByText("Alpha")).toBeTruthy();
  expect(screen.queryByText("Beta")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("正在加载…");
  expect(
    screen.getByRole("table").closest(".data-table")?.getAttribute("aria-busy"),
  ).toBe("true");
});

it("handles a table with omitted rows and columns without an update loop", () => {
  render(<DataTable />);
  expect(screen.getByText("暂无数据")).toBeTruthy();
  expect(screen.queryByText(hint)).toBeNull();
});

it("detects natural content overflow without a caller-provided minimum width", () => {
  viewportWidth = 254;
  render(
    <DataTable
      rows={[{ id: "a", name: "Long unbroken endpoint address" }]}
      rowKey="id"
      columns={[{ title: "端点", accessor: "name" }]}
    />,
  );
  expect(screen.getByText(hint)).toBeTruthy();
  resize(900);
  expect(screen.queryByText(hint)).toBeNull();
});

it("preserves the exact action element and focused owner when inline columns are rebuilt", async () => {
  const rows = [{ id: "one", name: "Existing row" }];
  const viewFor = (label: string) => (
    <DataTable
      rows={rows}
      rowKey="id"
      columns={[
        { accessor: "name", title: "Name" },
        {
          key: "actions",
          title: "Actions",
          render: () => <button>{label}</button>,
        },
      ]}
    />
  );
  const view = render(viewFor("Edit"));
  const action = screen.getByRole("button", { name: "Edit" });
  action.focus();
  view.rerender(viewFor("Edit retained"));
  expect(screen.getByRole("button", { name: "Edit retained" })).toBe(action);
  expect(action.isConnected).toBe(true);
  expect(document.activeElement).toBe(action);
});

it("keeps a table summary associated with its rows through filtering", () => {
  const view = render(
    <DataTable
      rows={[{ id: "a", name: "来源 A" }]}
      rowKey="id"
      columns={[{ title: "来源", accessor: "name" }]}
      summary="1 个私有来源"
    />,
  );
  const table = screen.getByRole("table");
  const summary = screen.getByText("1 个私有来源");
  expect(table.getAttribute("aria-describedby")).toBe(summary.id);
  expect(
    summary.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  view.rerender(
    <DataTable
      rows={[]}
      rowKey="id"
      columns={[{ title: "来源", accessor: "name" }]}
      summary="没有匹配的来源 · 共 1 个私有来源"
      empty="清除搜索以查看来源"
    />,
  );
  expect(screen.getByText("没有匹配的来源 · 共 1 个私有来源")).toBeTruthy();
  expect(screen.getByText("清除搜索以查看来源")).toBeTruthy();
  expect(screen.getByRole("table")).toBe(table);
});

it("offers a keyboard scroll region only for populated overflowing tables", async () => {
  const viewFor = (rows = [{ id: "a", name: "来源 A" }]) => (
    <DataTable
      rows={rows}
      rowKey="id"
      columns={[{ title: "来源", accessor: "name" }]}
      minWidth={720}
    />
  );
  const view = render(viewFor());
  expect(screen.queryByRole("region", { name: "表格滚动区域" })).toBeNull();
  resize(254);
  const viewport = screen.getByRole("region", { name: "表格滚动区域" });
  expect(viewport.tabIndex).toBe(0);
  expect(
    screen.getByRole("region", { name: "表格滚动区域", description: hint }),
  ).toBe(viewport);
  await userEvent.tab();
  expect(document.activeElement).toBe(viewport);
  resize(900);
  expect(screen.queryByRole("region", { name: "表格滚动区域" })).toBeNull();
  expect(document.activeElement).toBe(viewport);
  resize(254);
  view.rerender(viewFor([]));
  expect(screen.queryByRole("region", { name: "表格滚动区域" })).toBeNull();
  expect(screen.queryByText(hint)).toBeNull();
});
