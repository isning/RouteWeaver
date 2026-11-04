// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
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
});
