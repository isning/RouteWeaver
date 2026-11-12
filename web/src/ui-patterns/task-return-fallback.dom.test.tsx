// @vitest-environment jsdom
// Public overlay lifecycle; geometry is supplied only for scroll-ownership guards.
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { TaskDialog, TaskSheet } from "./task-overlays";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
type DestinationState = "ready" | "absent" | "hidden" | "inert" | "aria-hidden" | "disabled" | "aria-disabled" | "display-none" | "visibility-hidden";
function Host({ showOpener = true, fallback = true, destinationState = "ready", concealed = false, conditional = false, destinationVersion = 1, resolve, claimed = false, openerState = "ready" }: {
  showOpener?: boolean; fallback?: boolean; destinationState?: DestinationState; concealed?: boolean; conditional?: boolean;
  destinationVersion?: number; resolve?: () => void; claimed?: boolean; openerState?: "ready" | "disabled" | "hidden" | "aria-disabled";
}) {
  const [open, setOpen] = useState(false), [nextOpen, setNextOpen] = useState(false);
  const destination = useRef<HTMLInputElement>(null);
  const Component = conditional ? TaskSheet : TaskDialog;
  return <>
    <section hidden={concealed}>
      {showOpener && <button disabled={openerState === "disabled"} hidden={openerState === "hidden"} aria-disabled={openerState === "aria-disabled" || undefined} onClick={() => setOpen(true)}>编辑原记录</button>}
      {destinationState !== "absent" && <div hidden={destinationState === "hidden"} inert={destinationState === "inert" || undefined} aria-hidden={destinationState === "aria-hidden" || undefined}>
        <input key={destinationVersion} aria-label={`搜索方案 ${destinationVersion}`} ref={destination}
          disabled={destinationState === "disabled"} aria-disabled={destinationState === "aria-disabled" || undefined}
          style={{ display: destinationState === "display-none" ? "none" : undefined, visibility: destinationState === "visibility-hidden" ? "hidden" : undefined }} />
      </div>}
    </section>
    <button onClick={() => setOpen(true)}>重新编辑任务</button>
    <button onClick={() => setNextOpen(true)}>其他任务</button>
    {(!conditional || open) && <Component open={open} onOpenChange={setOpen} title="原任务"
      returnFocusFallback={fallback ? () => { resolve?.(); return destination.current; } : undefined}
      onCloseAutoFocus={claimed ? event => event.preventDefault() : undefined}>
      <input aria-label="当前草稿" />
      <button onClick={() => setOpen(false)}>取消原任务</button>
    </Component>}
    <TaskDialog open={nextOpen} onOpenChange={setNextOpen} title="新任务"><input aria-label="新草稿" /></TaskDialog>
  </>;
}
async function openTask() { await userEvent.click(screen.getByRole("button", { name: "编辑原记录" })); await screen.findByRole("dialog", { name: "原任务" }); }
async function closeTask() { await userEvent.click(screen.getByRole("button", { name: "取消原任务" })); await waitFor(() => expect(screen.queryByRole("dialog", { name: "原任务" })).toBeNull()); await act(async () => {}); }

it.each([false, true])("returns a departed opener to the explicitly supplied scope destination (conditional sheet=%s)", async conditional => {
  const view = render(<Host conditional={conditional} />); await openTask();
  view.rerender(<Host conditional={conditional} showOpener={false} />);
  await closeTask();
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "搜索方案 1" }));
});

it("prefers the still-connected original opener without resolving a fallback", async () => {
  const resolve = vi.fn(); render(<Host resolve={resolve} />);
  const opener = screen.getByRole("button", { name: "编辑原记录" });
  await openTask(); await closeTask();
  expect(document.activeElement).toBe(opener); expect(resolve).not.toHaveBeenCalled();
});

it("resolves the scope destination at dismissal rather than retaining an obsolete input", async () => {
  const view = render(<Host />); const old = screen.getByRole("textbox", { name: "搜索方案 1" }); await openTask();
  view.rerender(<Host showOpener={false} destinationVersion={2} />); await closeTask();
  expect(old.isConnected).toBe(false);
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "搜索方案 2" }));
});

it.each(["absent", "hidden", "inert", "aria-hidden", "disabled", "aria-disabled", "display-none", "visibility-hidden"] as const)(
  "does not focus an inactive %s destination", async destinationState => {
    const view = render(<Host />); const destination = screen.getByRole("textbox", { name: "搜索方案 1" });
    const focus = vi.spyOn(destination, "focus"); await openTask();
    view.rerender(<Host showOpener={false} destinationState={destinationState} />); await closeTask();
    expect(focus).not.toHaveBeenCalled(); expect(document.activeElement).not.toBe(destination);
  },
);

it("does not return a departed task to its now-concealed inventory scope", async () => {
  const view = render(<Host />); const destination = screen.getByRole("textbox", { name: "搜索方案 1" });
  const focus = vi.spyOn(destination, "focus"); await openTask();
  view.rerender(<Host showOpener={false} concealed />); await closeTask();
  expect(focus).not.toHaveBeenCalled(); expect(document.activeElement).not.toBe(destination);
});

it.each(["nonmodal", "dialog"] as const)("leaves a newer %s task in control of focus", async mode => {
  const view = render(<Host conditional />); const destination = screen.getByRole("textbox", { name: "搜索方案 1" });
  const focus = vi.spyOn(destination, "focus"); await openTask();
  view.rerender(<Host conditional showOpener={false} />);
  const next = screen.getByText("其他任务");
  act(() => {
    flushSync(() => fireEvent.click(screen.getByRole("button", { name: "取消原任务" })));
    if (mode === "dialog") flushSync(() => fireEvent.click(next)); else next.focus();
  });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "原任务" })).toBeNull()); await act(async () => {});
  if (mode === "dialog") expect(screen.getByRole("dialog", { name: "新任务" }).contains(document.activeElement)).toBe(true);
  else expect(document.activeElement).toBe(next);
  expect(focus).not.toHaveBeenCalled();
});

it("does not claim an explicitly handled close event", async () => {
  const resolve = vi.fn(); const view = render(<Host resolve={resolve} claimed />); await openTask();
  view.rerender(<Host showOpener={false} resolve={resolve} claimed />); await closeTask();
  expect(resolve).not.toHaveBeenCalled();
});

it("does not introduce a fallback for unrelated tasks", async () => {
  const view = render(<Host fallback={false} />); const destination = screen.getByRole("textbox", { name: "搜索方案 1" });
  const focus = vi.spyOn(destination, "focus"); await openTask();
  view.rerender(<Host fallback={false} showOpener={false} />); await closeTask();
  expect(focus).not.toHaveBeenCalled(); expect(document.activeElement).not.toBe(destination);
});

it("does nothing while the original task is closed", async () => {
  const resolve = vi.fn(); const view = render(<Host resolve={resolve} />);
  view.rerender(<Host showOpener={false} resolve={resolve} />);
  await userEvent.click(screen.getByRole("button", { name: "其他任务" })); await act(async () => {});
  expect(screen.getByRole("dialog", { name: "新任务" }).contains(document.activeElement)).toBe(true);
  expect(resolve).not.toHaveBeenCalled();
});

it("does not reclaim focus after the same task reopens during dismissal", async () => {
  const view = render(<Host />); const destination = screen.getByRole("textbox", { name: "搜索方案 1" });
  const focus = vi.spyOn(destination, "focus"); await openTask(); view.rerender(<Host showOpener={false} />);
  act(() => {
    flushSync(() => fireEvent.click(screen.getByRole("button", { name: "取消原任务" })));
    flushSync(() => fireEvent.click(screen.getByText("重新编辑任务")));
  });
  await act(async () => {});
  expect(screen.getByRole("dialog", { name: "原任务" }).contains(document.activeElement)).toBe(true);
  expect(focus).not.toHaveBeenCalled();
});

it("does not scroll the fallback after its focus handler opens a replacement task", async () => {
  const view = render(<Host conditional />); const destination = screen.getByRole("textbox", { name: "搜索方案 1" });
  const scroll = vi.fn(); vi.spyOn(destination, "scrollIntoView").mockImplementation(scroll);
  vi.spyOn(destination, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 44));
  await openTask(); view.rerender(<Host conditional showOpener={false} />);
  destination.addEventListener("focus", () => { flushSync(() => fireEvent.click(screen.getByText("其他任务"))); }, { once: true });
  await closeTask();
  expect(screen.getByRole("dialog", { name: "新任务" }).contains(document.activeElement)).toBe(true);
  expect(scroll).not.toHaveBeenCalled();
});

it.each(["disabled", "hidden", "aria-disabled"] as const)("uses the scoped fallback when the still-mounted original opener becomes %s", async openerState => {
  const view = render(<Host />); const opener = screen.getByRole("button", { name: "编辑原记录" });
  await openTask(); view.rerender(<Host openerState={openerState} />); await closeTask();
  expect(opener.isConnected).toBe(true);
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "搜索方案 1" }));
});
