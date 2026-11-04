// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { useConfirm } from "./ui-patterns/confirmations";
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

it("keeps the pending review opener focusable without allowing another menu action", async () => {
  let finish!: () => void;
  const checking = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const onConfirm = vi.fn();
  function Host() {
    const [loading, setLoading] = useState(false);
    const confirm = useConfirm();
    return (
      <SourceActionMenu
        sourceName="Checked source"
        loading={loading}
        deleteDisabled={loading}
        onDelete={async () => {
          setLoading(true);
          await checking;
          confirm({
            title: "删除来源？",
            description: "删除已检查的来源。",
            confirmLabel: "删除",
            cancelLabel: "保留来源",
            onConfirm,
          });
          setLoading(false);
        }}
      />
    );
  }
  render(
    <UIProviders>
      <Host />
    </UIProviders>,
  );
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", {
    name: "更多操作 Checked source",
  }) as HTMLButtonElement;
  await user.click(trigger);
  await user.click(await screen.findByRole("menuitem", { name: "删除来源" }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  // Native disabled buttons lose focus while the asynchronous reference check runs.
  expect(trigger.disabled).toBe(false);
  expect(trigger.getAttribute("aria-disabled")).toBe("true");
  expect(trigger.getAttribute("aria-busy")).toBe("true");
  expect(document.activeElement).toBe(trigger);
  await user.keyboard("{Enter}");
  await user.click(trigger);
  expect(screen.queryByRole("menu")).toBeNull();
  await act(async () => {
    finish();
  });
  await screen.findByRole("alertdialog", { name: "删除来源？" });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(onConfirm).not.toHaveBeenCalled();
});

it("keeps refresh and edit in the same source menu without invoking deletion", async () => {
  const onRefresh = vi.fn(),
    onEdit = vi.fn(),
    onDelete = vi.fn();
  render(
    <UIProviders>
      <SourceActionMenu
        sourceName="Work source"
        loading={false}
        deleteDisabled={false}
        onDelete={onDelete}
        onRefresh={onRefresh}
        onEdit={onEdit}
      />
    </UIProviders>,
  );
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "更多操作 Work source" });
  await user.click(trigger);
  await user.click(screen.getByRole("menuitem", { name: "刷新 Work source" }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(onRefresh).toHaveBeenCalledOnce();
  expect(onEdit).not.toHaveBeenCalled();
  expect(onDelete).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
  await user.click(trigger);
  await user.click(screen.getByRole("menuitem", { name: "编辑 Work source" }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(onEdit).toHaveBeenCalledOnce();
  expect(onDelete).not.toHaveBeenCalled();
});

it("keeps a paused source editable without allowing refresh", async () => {
  const onRefresh = vi.fn(),
    onEdit = vi.fn();
  render(
    <UIProviders>
      <SourceActionMenu
        sourceName="Paused source"
        loading={false}
        deleteDisabled={false}
        onDelete={() => {}}
        onRefresh={onRefresh}
        refreshDisabled
        onEdit={onEdit}
      />
    </UIProviders>,
  );
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "更多操作 Paused source" }),
  );
  const refresh = screen.getByRole("menuitem", { name: "刷新 Paused source" });
  expect(refresh.getAttribute("aria-disabled")).toBe("true");
  expect(
    screen
      .getByRole("menuitem", { name: "编辑 Paused source" })
      .getAttribute("aria-disabled"),
  ).not.toBe("true");
  await user.click(refresh);
  expect(onRefresh).not.toHaveBeenCalled();
});
