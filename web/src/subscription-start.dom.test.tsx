// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SubscriptionStart } from "./ui-patterns/subscription-start";
afterEach(cleanup);
it("chooses a connection source before opening its real task", async () => {
  const user = userEvent.setup();
  const onImport = vi.fn(), onConfigure = vi.fn();
  render(<SubscriptionStart {...{ onImport, onConfigure }} />);
  expect(onImport).not.toHaveBeenCalled();
  await user.click(screen.getByRole("radio", { name: /选择可用连接/ }));
  expect(onConfigure).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "继续" }));
  expect(onConfigure).toHaveBeenCalledOnce();
  expect(onImport).not.toHaveBeenCalled();
  expect(screen.queryByText("配置自有服务器")).toBeNull();
});
it("offers existing connections when import and server tasks are unavailable", async () => {
  const user = userEvent.setup();
  const onConfigure = vi.fn();
  render(<SubscriptionStart onConfigure={onConfigure} />);
  expect(screen.getAllByRole("radio")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "继续" }));
  expect(onConfigure).toHaveBeenCalledOnce();
});
