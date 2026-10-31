// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { SourceActionMenu } from "./SourceActionMenu";

// JSDOM supplies no ResizeObserver. Geometry and real focus are verified by
// source-action-menu.ui.spec.ts; these tests cover the public menu contract.
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

it("labels its source menu, closes on selection, and delegates only the review action", async () => {
  const onDelete = vi.fn();
  render(
    <UIProviders>
      <SourceActionMenu
        sourceName="Work source"
        loading={false}
        deleteDisabled={false}
        onDelete={onDelete}
      />
    </UIProviders>,
  );
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "更多操作 Work source" });
  expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(trigger.hasAttribute("aria-controls")).toBe(false);
  await user.click(trigger);
  const menu = await screen.findByRole("menu", {
    name: "更多操作 Work source",
  });
  expect(trigger.getAttribute("aria-controls")).toBe(menu.id);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(onDelete).not.toHaveBeenCalled();
  await user.click(screen.getByRole("menuitem", { name: "删除来源" }));
  await waitFor(() =>
    expect(screen.queryByRole("menu", { hidden: true })).toBeNull(),
  );
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(trigger.hasAttribute("aria-controls")).toBe(false);
  expect(onDelete).toHaveBeenCalledOnce();
});

it("preserves the disabled deletion guard while another review is pending", async () => {
  const onDelete = vi.fn();
  render(
    <UIProviders>
      <SourceActionMenu
        sourceName="Work source"
        loading={false}
        deleteDisabled
        onDelete={onDelete}
      />
    </UIProviders>,
  );
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "更多操作 Work source" }),
  );
  const remove = await screen.findByRole("menuitem", { name: "删除来源" });
  expect(remove.getAttribute("aria-disabled")).toBe("true");
  await user.click(remove);
  expect(onDelete).not.toHaveBeenCalled();
});

it("keeps the row available while open and releases Tab to native page traversal", async () => {
  const onDelete = vi.fn();
  render(
    <UIProviders>
      <button>Before source action</button>
      <SourceActionMenu
        sourceName="Keyboard source"
        loading={false}
        deleteDisabled={false}
        onDelete={onDelete}
      />
      <button>After source action</button>
    </UIProviders>,
  );
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", {
    name: "更多操作 Keyboard source",
  });
  await user.click(trigger);
  const item = await screen.findByRole("menuitem", { name: "删除来源" });
  expect(screen.getByRole("button", { name: "更多操作 Keyboard source" })).toBe(
    trigger,
  );
  item.focus();
  const tab = new KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    item.dispatchEvent(tab);
  });
  expect(tab.defaultPrevented).toBe(false);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(document.activeElement).toBe(trigger);
  expect(onDelete).not.toHaveBeenCalled();
});
