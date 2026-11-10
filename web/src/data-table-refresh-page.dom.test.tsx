// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DataTable } from "./DataTable";
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
it("keeps the displayed page after authoritative collection shrink then growth", async () => {
  const rows = Array.from({ length: 21 }, (_, index) => ({
    id: `record-${index + 1}`,
    name: `Record ${index + 1}`,
  }));
  const changed = vi.fn();
  const table = (records: typeof rows) => (
    <DataTable
      rowKey="id"
      rows={records}
      onPageChange={changed}
      columns={[{ title: "Name", accessor: "name" }]}
    />
  );
  const view = render(table(rows));
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(screen.getByText("第 3 / 3 页")).toBeTruthy();
  changed.mockClear();
  // Confirmed removal, with no local search/filter.
  view.rerender(table(rows.slice(0, 20)));
  expect(screen.getByText("第 2 / 2 页")).toBeTruthy();
  expect(screen.getByRole("cell", { name: "Record 11" })).toBeTruthy();
  // A new confirmed record must not resurrect the abandoned page.
  view.rerender(
    table([...rows.slice(0, 20), { id: "new", name: "New record" }]),
  );
  expect(changed).not.toHaveBeenCalled();
  expect(screen.getByText("第 2 / 3 页")).toBeTruthy();
  expect(screen.getByRole("cell", { name: "Record 11" })).toBeTruthy();
});

it("keeps a valid page through a reordered refresh and persists a filter clamp when cleared", async () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    id: String(index),
    name: `Record ${index}`,
  }));
  const table = (records: typeof rows) => (
    <DataTable
      rowKey="id"
      rows={records}
      columns={[{ title: "Name", accessor: "name" }]}
    />
  );
  const view = render(table(rows));
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  view.rerender(table([...rows].reverse()));
  expect(screen.getByText("第 2 / 3 页")).toBeTruthy();
  view.rerender(table(rows.slice(0, 5)));
  expect(screen.queryByRole("navigation", { name: "分页" })).toBeNull();
  view.rerender(table(rows));
  expect(screen.getByText("第 1 / 3 页")).toBeTruthy();
});

it("does not notify or overwrite the controlled page owner when rows shrink", () => {
  const rows = Array.from({ length: 21 }, (_, index) => ({
    id: String(index),
  }));
  const changed = vi.fn();
  const table = (records: typeof rows) => (
    <DataTable
      rowKey="id"
      rows={records}
      page={3}
      onPageChange={changed}
      columns={[{ title: "ID", accessor: "id" }]}
    />
  );
  const view = render(table(rows));
  view.rerender(table(rows.slice(0, 20)));
  expect(screen.getByText("第 2 / 2 页")).toBeTruthy();
  view.rerender(table(rows));
  expect(screen.getByText("第 3 / 3 页")).toBeTruthy();
  expect(changed).not.toHaveBeenCalled();
});

it.each(["loading", "unpaginated"] as const)(
  "does not persist temporary %s page clamping",
  async (mode) => {
    const rows = Array.from({ length: 21 }, (_, index) => ({
      id: String(index),
    }));
    const changed = vi.fn();
    const table = (temporary: boolean) => (
      <DataTable
        rowKey="id"
        rows={temporary && mode === "loading" ? [] : rows}
        loading={temporary && mode === "loading"}
        pageSize={temporary && mode === "unpaginated" ? 0 : 10}
        onPageChange={changed}
        columns={[{ title: "ID", accessor: "id" }]}
      />
    );
    const view = render(table(false));
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    changed.mockClear();
    view.rerender(table(true));
    view.rerender(table(false));
    expect(screen.getByText("第 3 / 3 页")).toBeTruthy();
    expect(changed).not.toHaveBeenCalled();
  },
);
