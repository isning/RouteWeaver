// @vitest-environment jsdom
// Public confirmation and task lifecycle. No application or focus internals mocked.
import { flushSync } from "react-dom";
import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ConfirmationProvider, useConfirm, type ConfirmationHandle } from "./confirmations";
import { TaskDialog } from "./task-overlays";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
type Destination = "ready" | "null" | "absent" | "hidden" | "inert" | "aria-hidden" | "disabled" | "aria-disabled" | "display-none" | "visibility-hidden";
function Host({ enabled = true, destination = "ready", version = 1, onConfirm, onResolve, onClosed, restoreFocus = true }: {
  enabled?: boolean; destination?: Destination; version?: number;
  onConfirm?: () => unknown | Promise<unknown>; onResolve?: () => void; onClosed?: () => void; restoreFocus?: boolean;
}) {
  const confirm = useConfirm();
  const target = useRef<HTMLInputElement>(null), handle = useRef<ConfirmationHandle | null>(null);
  const [newTask, setNewTask] = useState(false);
  return <>
    <button onClick={() => { handle.current = confirm({ title: "Remove fixture?", description: "Remove only the synthetic fixture.", confirmLabel: "Remove", cancelLabel: "Keep", onConfirm, onClosed, restoreFocus,
      returnFocusOnSuccess: enabled ? () => { onResolve?.(); return destination === "null" ? null : target.current; } : undefined,
    }); }}>Open removal</button>
    {destination !== "absent" && <div hidden={destination === "hidden"} inert={destination === "inert" || undefined} aria-hidden={destination === "aria-hidden" || undefined}>
      <input key={version} ref={target} aria-label={`Inventory search ${version}`} disabled={destination === "disabled"} aria-disabled={destination === "aria-disabled" || undefined}
        style={{ display: destination === "display-none" ? "none" : undefined, visibility: destination === "visibility-hidden" ? "hidden" : undefined }} />
    </div>}
    <button onClick={() => handle.current?.close()}>Invalidate decision</button>
    <button onClick={() => setNewTask(true)}>Newer task</button>
    <button>Newer control</button>
    <TaskDialog title="New editor" open={newTask} onOpenChange={setNewTask}><input aria-label="New draft" /></TaskDialog>
  </>;
}
const host = (props: Parameters<typeof Host>[0] = {}) => <ConfirmationProvider><Host {...props} /></ConfirmationProvider>;
async function open() {
  const user = userEvent.setup(), opener = screen.getByRole("button", { name: "Open removal" });
  await user.click(opener);
  const dialog = await screen.findByRole("alertdialog", { name: "Remove fixture?" });
  await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Keep" })));
  return { user, opener, dialog };
}
async function complete(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await act(async () => {});
}

it("selects the explicit destination only after the command succeeds and before the closed handoff", async () => {
  const command = deferred(), resolve = vi.fn(), onClosed = vi.fn(() => document.activeElement);
  render(host({ onConfirm: () => command.promise, onResolve: resolve, onClosed }));
  const { user, dialog } = await open(); const search = screen.getByLabelText("Inventory search 1");
  await user.click(within(dialog).getByRole("button", { name: "Remove" }));
  expect(dialog.getAttribute("aria-busy")).toBe("true"); expect(resolve).not.toHaveBeenCalled();
  await act(async () => command.resolve());
  await waitFor(() => expect(onClosed).toHaveBeenCalledOnce());
  expect(document.activeElement).toBe(search); expect(onClosed.mock.results[0].value).toBe(search); expect(resolve).toHaveBeenCalledOnce();
});

it("keeps unrelated successful confirmations on their original opener", async () => {
  const resolve = vi.fn(); render(host({ enabled: false, onResolve: resolve }));
  const { user, opener } = await open(); await complete(user);
  expect(document.activeElement).toBe(opener); expect(resolve).not.toHaveBeenCalled();
});

it.each(["Keep", "Escape"] as const)("does not consult the completed destination after %s cancellation", async mode => {
  const resolve = vi.fn(), command = vi.fn(); render(host({ onResolve: resolve, onConfirm: command }));
  const { user, opener } = await open();
  if (mode === "Keep") await user.keyboard("{Enter}"); else await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(resolve).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled();
});

it.each(["cancel", "retry"] as const)("retains a failed command and its %s outcome independently of success focus", async next => {
  const resolve = vi.fn(), command = vi.fn().mockRejectedValueOnce(new Error("Synthetic rejection")).mockResolvedValueOnce(undefined);
  render(host({ onResolve: resolve, onConfirm: command }));
  const { user, opener } = await open();
  await user.click(screen.getByRole("button", { name: "Remove" }));
  await screen.findByText("Synthetic rejection"); expect(resolve).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Remove" })).toHaveProperty("disabled", false);
  if (next === "cancel") {
    await user.click(screen.getByRole("button", { name: "Keep" }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(resolve).not.toHaveBeenCalled(); expect(command).toHaveBeenCalledOnce();
  } else {
    await complete(user); expect(document.activeElement).toBe(screen.getByLabelText("Inventory search 1"));
    expect(resolve).toHaveBeenCalledOnce(); expect(command).toHaveBeenCalledTimes(2);
  }
});

it.each(["null", "absent", "hidden", "inert", "aria-hidden", "disabled", "aria-disabled", "display-none", "visibility-hidden"] as const)(
  "an explicit %s destination never falls back to the completed action's old opener", async destination => {
    const resolve = vi.fn(); render(host({ destination, onResolve: resolve }));
    const { user, opener } = await open();
    const openerFocus = vi.spyOn(opener, "focus");
    await complete(user);
    expect(document.activeElement).not.toBe(opener); expect(openerFocus).not.toHaveBeenCalled(); expect(resolve).toHaveBeenCalledOnce();
    const search = screen.queryByLabelText("Inventory search 1"); if (search) expect(document.activeElement).not.toBe(search);
  },
);

it("resolves the current destination after a search replacement", async () => {
  const view = render(host()); const { user } = await open();
  const old = screen.getByLabelText("Inventory search 1");
  view.rerender(host({ version: 2 }));
  await complete(user);
  expect(old.isConnected).toBe(false); expect(document.activeElement).toBe(screen.getByLabelText("Inventory search 2"));
});

it("does not consult or focus the destination when close restoration is explicitly claimed", async () => {
  const resolve = vi.fn(); render(host({ onResolve: resolve, restoreFocus: false }));
  const { user, opener } = await open(); await complete(user);
  expect(resolve).not.toHaveBeenCalled(); expect(document.activeElement).not.toBe(opener); expect(document.activeElement).not.toBe(screen.getByLabelText("Inventory search 1"));
});

it.each(["nonmodal", "dialog"] as const)("preserves newer %s focus established as the old decision leaves the DOM", async mode => {
  const resolve = vi.fn(); render(host({ onResolve: resolve }));
  const { user, dialog } = await open();
  const search = screen.getByLabelText("Inventory search 1"), destinationFocus = vi.spyOn(search, "focus");
  const newer = screen.getByText(mode === "dialog" ? "Newer task" : "Newer control");
  let moved = false;
  // Observe the public dismissal boundary, before the primitive's delayed
  // close-auto-focus release. A newer user task owns this intervening focus.
  const observer = new MutationObserver(() => {
    if (dialog.isConnected || moved) return;
    moved = true; observer.disconnect();
    if (mode === "dialog") flushSync(() => fireEvent.click(newer)); else newer.focus();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  try {
    await complete(user); expect(moved).toBe(true);
    if (mode === "dialog") expect(screen.getByRole("dialog", { name: "New editor" }).contains(document.activeElement)).toBe(true);
    else expect(document.activeElement).toBe(newer);
    expect(destinationFocus).not.toHaveBeenCalled();
  } finally { observer.disconnect(); }
});

it("does not select success focus when a pending decision was invalidated before its late result", async () => {
  const command = deferred(), resolve = vi.fn(), closed = vi.fn(); render(host({ onConfirm: () => command.promise, onResolve: resolve, onClosed: closed }));
  const { user } = await open(); await user.click(screen.getByRole("button", { name: "Remove" }));
  act(() => fireEvent.click(screen.getByText("Invalidate decision")));
  await waitFor(() => expect(closed).toHaveBeenCalledOnce());
  const newer = screen.getByRole("button", { name: "Newer control" }); await user.click(newer);
  await act(async () => command.resolve());
  expect(document.activeElement).toBe(newer); expect(resolve).not.toHaveBeenCalled(); expect(closed).toHaveBeenCalledOnce();
});

it("does not let a closed pending decision's completion claim a replacement decision", async () => {
  const command = deferred(), resolve = vi.fn(); render(host({ onConfirm: () => command.promise, onResolve: resolve }));
  const { user } = await open(); await user.click(screen.getByRole("button", { name: "Remove" }));
  act(() => fireEvent.click(screen.getByText("Invalidate decision")));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await user.click(screen.getByRole("button", { name: "Open removal" }));
  const newDialog = await screen.findByRole("alertdialog");
  await waitFor(() => expect(newDialog.contains(document.activeElement)).toBe(true));
  const owner = document.activeElement;
  await act(async () => command.resolve());
  expect(screen.getByRole("alertdialog")).toBe(newDialog); expect(document.activeElement).toBe(owner); expect(resolve).not.toHaveBeenCalled();
});

it("ignores late completion after the confirmation provider and owner unmount", async () => {
  const command = deferred(), resolve = vi.fn(); const view = render(host({ onConfirm: () => command.promise, onResolve: resolve }));
  const { user } = await open(); await user.click(screen.getByRole("button", { name: "Remove" }));
  view.rerender(<button>New workspace</button>);
  const newer = screen.getByRole("button", { name: "New workspace" }); await user.click(newer);
  await act(async () => command.resolve());
  expect(document.activeElement).toBe(newer); expect(resolve).not.toHaveBeenCalled();
});
