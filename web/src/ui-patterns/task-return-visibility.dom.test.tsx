// @vitest-environment jsdom
// Public overlay dismissal with supplied browser geometry. Native CI owns actual
// scrolling, focus-ring pixels and unchanged diagnostic full-visibility checks.
import { flushSync } from "react-dom";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskDialog, TaskSheet } from "./task-overlays";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function Host({ sheet = false, showOpener = true }: { sheet?: boolean; showOpener?: boolean }) {
  const [open, setOpen] = useState(false);
  const Component = sheet ? TaskSheet : TaskDialog;
  return <>{showOpener && <button onClick={() => setOpen(true)}>编辑任务</button>}
    <button>另一个任务</button>
    <Component open={open} onOpenChange={setOpen} title="任务编辑">
      <input aria-label="名称" />
      <button onClick={() => setOpen(false)}>完成编辑</button>
    </Component></>;
}

it("recovers the returned opener whose bottom focus ring is clipped at the viewport edge", async () => {
  vi.stubGlobal("innerWidth", 1440); vi.stubGlobal("innerHeight", 640);
  render(<Host />);
  const opener = screen.getByRole("button", { name: "编辑任务" });
  const scroll = vi.fn();
  Object.defineProperty(opener, "scrollIntoView", { configurable: true, value: scroll });
  vi.spyOn(opener, "getBoundingClientRect").mockReturnValue(new DOMRect(795.5, 596.25, 106, 44));
  await userEvent.click(opener);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(scroll).toHaveBeenCalledOnce();
  expect(scroll).toHaveBeenCalledWith({ block: "center", inline: "center", behavior: "instant" });
});

function observeScroll(opener: HTMLElement, rect: DOMRect) {
  const scroll = vi.fn();
  Object.defineProperty(opener, "scrollIntoView", { configurable: true, value: scroll });
  vi.spyOn(opener, "getBoundingClientRect").mockReturnValue(rect);
  return scroll;
}

it.each([false, true])("leaves a safely visible returned opener and its scroll position alone (sheet=%s)", async (sheet) => {
  render(<Host sheet={sheet} />);
  const opener = screen.getByRole("button", { name: "编辑任务" });
  const scroll = observeScroll(opener, new DOMRect(100, 100, 106, 44));
  await userEvent.click(opener);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(scroll).not.toHaveBeenCalled();
});

it.each([
  ["top", 100, 2], ["left", 2, 100], ["right", 1333, 100], ["bottom ring", 100, 594],
] as const)("recovers the %s focus-ring edge on sheet dismissal", async (_, x, y) => {
  vi.stubGlobal("innerWidth", 1440); vi.stubGlobal("innerHeight", 640);
  render(<Host sheet />);
  const opener = screen.getByRole("button", { name: "编辑任务" });
  const scroll = observeScroll(opener, new DOMRect(x, y, 106, 44));
  await userEvent.click(opener);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(scroll).toHaveBeenCalledOnce();
  expect(scroll).toHaveBeenCalledWith({ block: "center", inline: "center", behavior: "instant" });
});

it("does not scroll a departed opener after its task closes", async () => {
  const view = render(<Host />);
  const opener = screen.getByRole("button", { name: "编辑任务" });
  const scroll = observeScroll(opener, new DOMRect(0, 0, 106, 44));
  await userEvent.click(opener);
  view.rerender(<Host showOpener={false} />);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await act(async () => {});
  expect(opener.isConnected).toBe(false);
  expect(document.activeElement).not.toBe(opener);
  expect(scroll).not.toHaveBeenCalled();
});

it("does not scroll or focus an old opener over a newer interaction after dismissal commits", async () => {
  render(<Host />);
  const opener = screen.getByRole("button", { name: "编辑任务" });
  const scroll = observeScroll(opener, new DOMRect(0, 0, 106, 44));
  await userEvent.click(opener);
  const next = screen.getByText("另一个任务");
  act(() => {
    flushSync(() => fireEvent.click(screen.getByRole("button", { name: "完成编辑" })));
    next.focus();
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await act(async () => {});
  expect(document.activeElement).toBe(next);
  expect(scroll).not.toHaveBeenCalled();
});

it("does not scroll the old opener when a focus handler hands off to another control", async () => {
  render(<Host />);
  const opener = screen.getByRole("button", { name: "编辑任务" });
  const scroll = observeScroll(opener, new DOMRect(0, 0, 106, 44));
  await userEvent.click(opener);
  const next = screen.getByText("另一个任务");
  opener.addEventListener("focus", () => next.focus(), { once: true });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(next));
  expect(scroll).not.toHaveBeenCalled();
});

it("does not scroll an opener that reopens its task during focus return", async () => {
  render(<Host />);
  const opener = screen.getByRole("button", { name: "编辑任务" });
  const scroll = observeScroll(opener, new DOMRect(0, 0, 106, 44));
  await userEvent.click(opener);
  opener.addEventListener("focus", () => {
    flushSync(() => fireEvent.click(opener));
  }, { once: true });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  await waitFor(() => expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true));
  expect(scroll).not.toHaveBeenCalled();
});
