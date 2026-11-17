// @vitest-environment jsdom
import { createRef, useState, type FormEvent } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResourceToolbar, SearchField, ToolbarFilter, QuickFilters } from "./ui-patterns/resource-toolbar";

afterEach(cleanup);

it("lets users clear search with the keyboard, returns focus and never submits the surrounding form", async () => {
  const submit = vi.fn((event: FormEvent) => event.preventDefault());
  const ref = createRef<HTMLInputElement>();
  function InventorySearch() {
    const [value, setValue] = useState("");
    return <form onSubmit={submit}>
      <ResourceToolbar label="查找用户" search={
        <SearchField ref={ref} aria-label="搜索用户" value={value} onValueChange={setValue} />
      } summary={<span role="status">{value ? "1 个匹配" : "共 2 个用户"}</span>} />
    </form>;
  }
  const user = userEvent.setup();
  render(<InventorySearch />);
  const toolbar = screen.getByRole("search", { name: "查找用户" });
  const input = within(toolbar).getByRole("textbox", { name: "搜索用户" });
  expect(ref.current).toBe(input);
  expect(within(toolbar).queryByRole("button", { name: "清除搜索输入" })).toBeNull();
  await user.type(input, "办公");
  expect(within(toolbar).getByRole("status").textContent).toBe("1 个匹配");
  await user.tab();
  expect(document.activeElement).toBe(within(toolbar).getByRole("button", { name: "清除搜索输入" }));
  await user.keyboard("{Enter}");
  expect((input as HTMLInputElement).value).toBe("");
  expect(document.activeElement).toBe(input);
  expect(within(toolbar).getByRole("status").textContent).toBe("共 2 个用户");
  expect(submit).not.toHaveBeenCalled();
  await user.type(input, "备用");
  expect((input as HTMLInputElement).value).toBe("备用");
});

it("preserves native Tab order and explicit labels when search has filters", async () => {
  const user = userEvent.setup();
  render(<ResourceToolbar label="筛选执行范围" search={
    <SearchField aria-label="搜索实例" value="" onValueChange={() => {}} />
  } filters={<ToolbarFilter label="服务器分组" controlId="server-group">
    <select id="server-group" defaultValue="all"><option value="all">所有分组</option></select>
  </ToolbarFilter>} summary={<span>共 2 个实例</span>} />);
  const toolbar = screen.getByRole("search", { name: "筛选执行范围" });
  await user.tab();
  expect(document.activeElement).toBe(within(toolbar).getByRole("textbox", { name: "搜索实例" }));
  await user.tab();
  expect(document.activeElement).toBe(within(toolbar).getByRole("combobox", { name: "服务器分组" }));
  expect(within(toolbar).getByText("共 2 个实例")).toBeTruthy();
  expect(screen.queryByRole("toolbar")).toBeNull();
});

it("disables both editing and clearing without discarding the existing search", async () => {
  const onValueChange = vi.fn();
  const user = userEvent.setup();
  render(<SearchField aria-label="搜索用户" value="办公" onValueChange={onValueChange} disabled />);
  const input = screen.getByRole("textbox", { name: "搜索用户" }) as HTMLInputElement;
  const clear = screen.getByRole("button", { name: "清除搜索输入" }) as HTMLButtonElement;
  expect(input.disabled).toBe(true);
  expect(clear.disabled).toBe(true);
  await user.click(clear);
  await user.type(input, "备用");
  expect(onValueChange).not.toHaveBeenCalled();
  expect(input.value).toBe("办公");
});

it("uses one exclusive quick-filter state and never submits its surrounding form", async () => {
  const submit = vi.fn((event: FormEvent) => event.preventDefault());
  function Filters() {
    const [value, setValue] = useState("all");
    return <form onSubmit={submit}><QuickFilters label="列表状态" value={value} onValueChange={setValue}
      options={[{ value: "all", label: "全部", count: 12 }, { value: "failed", label: "失败", count: 2 }]} /></form>;
  }
  render(<Filters />);
  const group = screen.getByRole("group", { name: "列表状态" });
  const all = within(group).getByRole("button", { name: "全部 12" });
  const failed = within(group).getByRole("button", { name: "失败 2" });
  expect(all.getAttribute("aria-pressed")).toBe("true");
  await userEvent.click(failed);
  expect(all.getAttribute("aria-pressed")).toBe("false");
  expect(failed.getAttribute("aria-pressed")).toBe("true");
  expect(failed.getAttribute("data-variant")).toBe("secondary");
  expect(all.getAttribute("data-variant")).toBe("ghost");
  expect(submit).not.toHaveBeenCalled();
});

// Structure contract only: browser tests own widths, wrapping and geometry.
it("marks labeled fields without marking compact choices as field layouts", () => {
  const search = <SearchField aria-label="搜索" value="" onValueChange={() => {}} />;
  const { rerender } = render(<ResourceToolbar label="结构检查" search={search} filters={<>
    <ToolbarFilter label="分组" controlId="layout-group"><select id="layout-group"><option>全部分组</option></select></ToolbarFilter>
    <ToolbarFilter label="标签" controlId="layout-tag"><select id="layout-tag"><option>全部标签</option></select></ToolbarFilter>
  </>} />);
  const toolbar = screen.getByRole("search", { name: "结构检查" });
  const fields = toolbar.querySelectorAll('[data-slot="toolbar-filter"]');
  expect(fields).toHaveLength(2);
  expect(fields[0].parentElement).toBe(fields[1].parentElement);
  expect(fields[0].parentElement?.parentElement).toBe(toolbar);
  expect(within(fields[0] as HTMLElement).getByRole("combobox", { name: "分组" })).toBeTruthy();
  expect(within(fields[1] as HTMLElement).getByRole("combobox", { name: "标签" })).toBeTruthy();
  rerender(<ResourceToolbar label="结构检查" search={search} filters={<QuickFilters label="状态" value="all" onValueChange={() => {}} options={[{ value: "all", label: "全部" }]} />} />);
  expect(toolbar.querySelector('[data-slot="toolbar-filter"]')).toBeNull();
  expect(within(toolbar).getByRole("button", { name: "全部" })).toBeTruthy();
  rerender(<ResourceToolbar label="结构检查" search={search} filters={<button type="button">刷新</button>} />);
  expect(toolbar.querySelector('[data-slot="toolbar-filter"]')).toBeNull();
  expect(within(toolbar).getByRole("button", { name: "刷新" })).toBeTruthy();
});
