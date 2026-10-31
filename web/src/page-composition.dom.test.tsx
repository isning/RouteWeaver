// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { PageHeader, Section } from "./components";
import { Button } from "./components/ui/button";

afterEach(cleanup);

it("composes a list section without another card around its table", () => {
  const { container } = render(
    <Section variant="plain" title="连接端点" description="按名称查找" extra={<Button>添加端点</Button>}>
      <table aria-label="连接端点列表"><tbody><tr><td>London</td></tr></tbody></table>
    </Section>,
  );
  expect(screen.getByRole("heading", { name: "连接端点", level: 2 })).toBeTruthy();
  expect(screen.getByRole("button", { name: "添加端点" })).toBeTruthy();
  expect(screen.getByRole("table", { name: "连接端点列表" })).toBeTruthy();
  expect(container.querySelector('[data-slot="card"]')).toBeNull();
});

it("retains explicit card sections for grouped content", () => {
  const { container } = render(<Section title="基本设置"><p>设置内容</p></Section>);
  expect(container.querySelector('[data-slot="card"]')).not.toBeNull();
  expect(screen.getByRole("heading", { name: "基本设置", level: 2 })).toBeTruthy();
});

it("keeps the page title, context and primary task together", () => {
  render(<PageHeader title="连接端点" description="管理连接参数" action={<Button>添加端点</Button>} />);
  const heading = screen.getByRole("heading", { name: "连接端点", level: 1 });
  const header = heading.closest("header")!;
  expect(within(header).getByText("管理连接参数")).toBeTruthy();
  expect(within(header).getByRole("button", { name: "添加端点" })).toBeTruthy();
});
