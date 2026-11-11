// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Tabs, TabsContent, TabsTrigger } from "./components/ui/tabs";
import { ScrollableTabsList } from "./ui-patterns/scrollable-tabs-list";

afterEach(cleanup);
it("keeps keyboard tab selection, disabled skipping and panel relationships in the compact rail", async () => {
  const user = userEvent.setup();
  render(<Tabs defaultValue="one">
    <ScrollableTabsList aria-label="配置内容">
      <TabsTrigger value="one">概览</TabsTrigger>
      <TabsTrigger value="disabled" disabled>不可用</TabsTrigger>
      <TabsTrigger value="three">连接与配置</TabsTrigger>
    </ScrollableTabsList>
    <TabsContent value="one">概览内容</TabsContent>
    <TabsContent value="three">连接内容</TabsContent>
  </Tabs>);
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("tab", {name: "概览"}));
  await user.keyboard("{ArrowRight}");
  const last = screen.getByRole("tab", { name: "连接与配置" });
  expect(document.activeElement).toBe(last);
  expect(last.getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tabpanel").textContent).toBe("连接内容");
  expect(screen.getByRole("tabpanel").id).toBe(last.getAttribute("aria-controls"));
  await user.keyboard("{Home}");
  expect(document.activeElement).toBe(screen.getByRole("tab", {name: "概览"}));
  await user.keyboard("{End}");
  expect(document.activeElement).toBe(last);
});
