// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActionButton } from "./ui-patterns/actions";
afterEach(cleanup);
it.each(["disabled", "pending"] as const)(
  "removes the navigation destination of a %s anchor, including context-menu bypass",
  async (state) => {
    const click = vi.fn();
    render(
      <ActionButton {...{ [state]: true }} onClick={click} asChild>
        <a href="#private">Open task</a>
      </ActionButton>,
    );
    const link = screen.getByRole("link", { name: "Open task" });
    expect(link.getAttribute("href")).toBeNull();
    expect(link.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(link);
    expect(click).not.toHaveBeenCalled();
  },
);
it("defaults non-submit task actions to native button semantics", async () => {
  const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
  render(
    <form onSubmit={submit}>
      <ActionButton>Cancel</ActionButton>
    </form>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(submit).not.toHaveBeenCalled();
});
