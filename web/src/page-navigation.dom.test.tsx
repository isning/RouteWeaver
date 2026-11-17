// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { PageNavigation } from "./ui-patterns/page-navigation";

afterEach(cleanup);

it("presents total and current page as separate facts while preserving page controls", () => {
  const onPageChange = vi.fn();
  const { rerender } = render(
    <PageNavigation
      page={1}
      pageSize={10}
      total={23}
      onPageChange={onPageChange}
    />,
  );
  const navigation = within(screen.getByRole("navigation", { name: "分页" }));
  expect(navigation.getByText("共 23 项")).toBeTruthy();
  expect(navigation.getByText("第 1 / 3 页")).toBeTruthy();
  expect(
    navigation.getByRole("button", { name: "上一页" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(navigation.getByRole("button", { name: "下一页" }));
  expect(onPageChange).toHaveBeenLastCalledWith(2);
  rerender(
    <PageNavigation
      page={3}
      pageSize={10}
      total={23}
      onPageChange={onPageChange}
    />,
  );
  expect(navigation.getByText("第 3 / 3 页")).toBeTruthy();
  expect(
    navigation.getByRole("button", { name: "下一页" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(navigation.getByRole("button", { name: "上一页" }));
  expect(onPageChange).toHaveBeenLastCalledWith(2);
  expect(screen.getByRole("navigation").textContent).not.toContain("·");
  rerender(
    <PageNavigation
      page={1}
      pageSize={10}
      total={20}
      onPageChange={onPageChange}
    />,
  );
  expect(navigation.queryByRole("button", { name: "第一页" })).toBeNull();
  expect(navigation.queryByRole("button", { name: "最后一页" })).toBeNull();
});

it("lets a large inventory jump to either end while retaining adjacent-page navigation", async () => {
  const changed = vi.fn();
  function Host() {
    const [page, setPage] = useState(1);
    return (
      <PageNavigation
        page={page}
        pageSize={10}
        total={245}
        onPageChange={(value) => {
          changed(value);
          setPage(value);
        }}
      />
    );
  }
  render(<Host />);
  expect(
    (screen.getByRole("button", { name: "第一页" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "最后一页" }));
  expect(changed).toHaveBeenLastCalledWith(25);
  expect(screen.getByText("第 25 / 25 页")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "最后一页" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "上一页" }));
  expect(changed).toHaveBeenLastCalledWith(24);
  await userEvent.click(screen.getByRole("button", { name: "第一页" }));
  expect(changed).toHaveBeenLastCalledWith(1);
});
