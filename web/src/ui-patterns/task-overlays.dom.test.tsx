// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { useRef, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskDialog, TaskSheet } from "./task-overlays";
import { ConfirmationProvider, useConfirm, type ConfirmationHandle } from "./confirmations";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function TaskHost({ pending = false, sheet = false }: { pending?: boolean; sheet?: boolean }) {
  const [open, setOpen] = useState(false);
  const Component = sheet ? TaskSheet : TaskDialog;
  return <><button onClick={() => setOpen(true)}>编辑任务</button>
    <Component open={open} onOpenChange={setOpen} title="任务编辑" description="修改草稿" pending={pending}
      footer={<button disabled={pending} onClick={() => setOpen(false)}>完成编辑</button>}>
      <label>名称<input /></label>
    </Component></>;
}
it.each([false, true])("has accessible title and description and returns focus after Escape (sheet=%s)", async (sheet) => {
  render(<TaskHost sheet={sheet} />);
  const opener = screen.getByRole("button", { name: "编辑任务" });
  await userEvent.click(opener);
  const dialog = screen.getByRole("dialog", { name: "任务编辑" });
  expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
  expect(dialog.getAttribute("aria-describedby")!.split(/\s+/).map((id) => document.getElementById(id)?.textContent).filter(Boolean).join(" ")).toBe("修改草稿");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
});
it.each([false, true])("blocks cancellation while pending (sheet=%s)", async (sheet) => {
  render(<TaskHost pending sheet={sheet} />);
  await userEvent.click(screen.getByRole("button", { name: "编辑任务" }));
  const dialog = screen.getByRole("dialog", { name: "任务编辑" });
  expect(dialog.getAttribute("aria-busy")).toBe("true");
  expect(within(dialog).queryByRole("button", { name: "关闭" })).toBeNull();
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("dialog", { name: "任务编辑" })).toBe(dialog);
});
it("keeps sequential focus inside the task dialog", async () => {
  render(<TaskHost />);
  await userEvent.click(screen.getByRole("button", { name: "编辑任务" }));
  const dialog = screen.getByRole("dialog");
  const last = within(dialog).getByRole("button", { name: "完成编辑" });
  last.focus();
  await userEvent.tab();
  expect(dialog.contains(document.activeElement)).toBe(true);
  await userEvent.tab({ shift: true });
  expect(document.activeElement).toBe(last);
});
it("runs the closed handoff after focus has returned to the eligible opener", async () => {
  const onClosed = vi.fn(() => document.activeElement?.textContent);
  function Host() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>打开</button><TaskDialog open={open} onOpenChange={setOpen} title="编辑" onClosed={onClosed}><input aria-label="名称" /></TaskDialog></>;
  }
  render(<Host />); await userEvent.click(screen.getByRole("button", { name: "打开" }));
  await userEvent.click(screen.getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(onClosed).toHaveBeenCalledOnce());
  expect(onClosed.mock.results[0].value).toBe("打开");
});
function ConfirmHost({ onConfirm, onCancel, onClosed }: { onConfirm?: () => unknown | Promise<unknown>; onCancel?: () => void; onClosed?: () => void }) {
  const confirm = useConfirm();
  const handle = useRef<ConfirmationHandle | null>(null);
  return <><button onClick={() => { handle.current = confirm({ title: "放弃修改？", description: "当前草稿尚未保存。", confirmLabel: "放弃修改", cancelLabel: "继续编辑", destructive: true, onConfirm, onCancel, onClosed }); }}>检查关闭</button>
    <button onClick={() => handle.current?.close()}>撤销过时决定</button></>;
}
it("initially focuses the safe cancel action and restores the trigger after cancellation", async () => {
  const onCancel = vi.fn(), onConfirm = vi.fn();
  render(<ConfirmationProvider><ConfirmHost onCancel={onCancel} onConfirm={onConfirm} /></ConfirmationProvider>);
  const opener = screen.getByRole("button", { name: "检查关闭" });
  await userEvent.click(opener);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "继续编辑" })));
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(onCancel).toHaveBeenCalledOnce(); expect(onConfirm).not.toHaveBeenCalled();
  await waitFor(() => expect(document.activeElement).toBe(opener));
});
it("holds an asynchronous decision pending, rejects repeated clicks and Escape, and closes once", async () => {
  let resolve!: () => void;
  const onConfirm = vi.fn(() => new Promise<void>((done) => { resolve = done; })), onClosed = vi.fn();
  render(<ConfirmationProvider><ConfirmHost onConfirm={onConfirm} onClosed={onClosed} /></ConfirmationProvider>);
  await userEvent.click(screen.getByRole("button", { name: "检查关闭" }));
  const accept = screen.getByRole("button", { name: "放弃修改" });
  await userEvent.dblClick(accept);
  expect(onConfirm).toHaveBeenCalledOnce();
  expect(accept).toHaveProperty("disabled", true);
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  await act(async () => resolve());
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(onClosed).toHaveBeenCalledOnce());
});
it("keeps a failed confirmation visible with its error and supports retry", async () => {
  const onConfirm = vi.fn().mockRejectedValueOnce(new Error("保存失败，请重试")).mockResolvedValueOnce(undefined);
  render(<ConfirmationProvider><ConfirmHost onConfirm={onConfirm} /></ConfirmationProvider>);
  await userEvent.click(screen.getByRole("button", { name: "检查关闭" }));
  await userEvent.click(screen.getByRole("button", { name: "放弃修改" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "保存失败，请重试");
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(onConfirm).toHaveBeenCalledTimes(2);
});
it("invalidates a handle without treating it as a user cancellation", async () => {
  const onCancel = vi.fn(), onClosed = vi.fn();
  render(<ConfirmationProvider><ConfirmHost onCancel={onCancel} onClosed={onClosed} /></ConfirmationProvider>);
  await userEvent.click(screen.getByRole("button", { name: "检查关闭" }));
  // Imperative owner invalidation, not a user interaction through the modal mask.
  fireEvent.click(screen.getByText("撤销过时决定"));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(onCancel).not.toHaveBeenCalled();
  await waitFor(() => expect(onClosed).toHaveBeenCalledOnce());
});
it("a nested confirmation releases focus before its parent task closes", async () => {
  const snapshots: string[] = [];
  function Host() {
    const [open, setOpen] = useState(false), confirm = useConfirm();
    return <><button onClick={() => setOpen(true)}>打开编辑器</button><TaskDialog title="编辑器" open={open} onOpenChange={setOpen}>
      <button onClick={() => confirm({ title: "关闭编辑器？", description: "放弃草稿。", confirmLabel: "放弃并关闭", onClosed: () => { snapshots.push(document.activeElement?.textContent || ""); setOpen(false); } })}>请求关闭</button>
    </TaskDialog></>;
  }
  render(<ConfirmationProvider><Host /></ConfirmationProvider>);
  const opener = screen.getByRole("button", { name: "打开编辑器" });
  await userEvent.click(opener); await userEvent.click(screen.getByRole("button", { name: "请求关闭" }));
  await userEvent.click(screen.getByRole("button", { name: "放弃并关闭" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(snapshots).toEqual(["请求关闭"]);
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

it("keeps task and confirmation portals inside the session-owned concealed host", async () => {
  const { PortalHostProvider } = await import("./portal-host");
  function Host() {
    const [container, setContainer] = useState<HTMLDivElement | null>(null);
    return <div data-testid="session"><div ref={setContainer} />{container && <PortalHostProvider container={container}><ConfirmationProvider><TaskHost /><ConfirmHost /></ConfirmationProvider></PortalHostProvider>}</div>;
  }
  render(<Host />);
  const session = screen.getByTestId("session");
  await userEvent.click(screen.getByRole("button", { name: "编辑任务" }));
  expect(session.contains(screen.getByRole("dialog"))).toBe(true);
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("button", { name: "检查关闭" }));
  expect(session.contains(screen.getByRole("alertdialog"))).toBe(true);
  session.setAttribute("inert", "");
  session.setAttribute("aria-hidden", "true");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(document.querySelectorAll("body > [data-task-overlay]")).toHaveLength(0);
});

it("does not restore an old opener over newer focus after the closing state commits", async () => {
  render(<><TaskHost /><button>另一个任务</button></>);
  await userEvent.click(screen.getByRole("button", {name:"编辑任务"}));
  const next = screen.getByText("另一个任务");
  act(() => {
    flushSync(() => fireEvent.click(screen.getByRole("button", {name:"完成编辑"})));
    next.focus();
  });
  await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());
  await act(async () => {});
  expect(document.activeElement).toBe(next);
});

it("keeps the dialog frame non-scrollable and confines scrolling to the task body", async () => {
  render(<TaskHost />);
  await userEvent.click(screen.getByRole("button", { name: "编辑任务" }));
  const dialog = screen.getByRole("dialog");
  const body = dialog.querySelector("[data-task-overlay-body]")!;
  const footer = dialog.querySelector('[data-slot="dialog-footer"]')!;
  // Browser QA covers actual geometry. overflow-hidden still permits focus-driven
  // scrolling of the frame; clip prevents losing the fixed heading and actions.
  expect(dialog.classList.contains("overflow-clip")).toBe(true);
  expect(dialog.classList.contains("overflow-hidden")).toBe(false);
  expect(body.classList.contains("overflow-y-auto")).toBe(true);
  expect(body.classList.contains("min-h-0")).toBe(true);
  expect(footer.classList.contains("mx-0")).toBe(true);
  expect(footer.classList.contains("mb-0")).toBe(true);
  expect(body.contains(footer)).toBe(false);
});
