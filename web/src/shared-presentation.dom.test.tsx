// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryState, Section } from "./components";
import { DataTable } from "./DataTable";

afterEach(cleanup);
it.each(["card", "plain"] as const)("preserves a description-only section (%s)", (variant) => {
  render(<Section variant={variant} description="撤销后，原订阅链接将不可用。"><button>撤销订阅</button></Section>);
  expect(screen.getByText("撤销后，原订阅链接将不可用。")).toBeTruthy();
  expect(screen.getByRole("button", { name: "撤销订阅" })).toBeTruthy();
});
it("does not offer an unavailable retry action", () => {
  render(<QueryState error={new Error("没有查看此记录的权限")}><span>记录内容</span></QueryState>);
  expect(screen.getByText("没有查看此记录的权限")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  expect(screen.queryByText("记录内容")).toBeNull();
});
it("keeps a provided recovery action available", async () => {
  const retry = vi.fn();
  render(<QueryState error={new Error("连接暂时中断")} retry={retry}><span>记录内容</span></QueryState>);
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(retry).toHaveBeenCalledOnce();
});
it("distinguishes table loading from a confirmed empty result", () => {
  const { rerender } = render(<DataTable rows={[]} columns={[{ key: "name", title: "名称" }]} loading />);
  expect(screen.getByRole("status").textContent).toBe("正在加载…");
  expect(screen.queryByText("暂无数据")).toBeNull();
  rerender(<DataTable rows={[]} columns={[{ key: "name", title: "名称" }]} />);
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByText("暂无数据")).toBeTruthy();
});
