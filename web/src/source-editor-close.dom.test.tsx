// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { UIProviders } from "./ui-patterns/providers";
import { TaskDialog, type TaskOverlayProps } from "./ui-patterns/task-overlays";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SourceEditorDialog } from "./SourceEditorDialog";
import { hasUnsavedChanges } from "./navigation";

// Preserve the real rendered TaskDialog. Hold only its public onClosed callback to
// exercise cancellation ownership while the parent still owns this session.
// Native transition/focus geometry remains a separate actual-browser gate.
const closeQueue = vi.hoisted(() => ({ held: [] as Array<() => void> }));
vi.mock("./ui-patterns/task-overlays", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./ui-patterns/task-overlays")>();
  const HeldTaskDialog = (props: TaskOverlayProps) => (
    <actual.TaskDialog
      {...props}
      onClosed={() => {
        if (props.onClosed) closeQueue.held.push(props.onClosed);
      }}
    />
  );
  return { ...actual, TaskDialog: HeldTaskDialog };
});
const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const closed = vi.fn();
  let removeOpener = () => {};
  function Host() {
    const [open, setOpen] = useState(false);
    const [showOpener, setShowOpener] = useState(true);
    removeOpener = () => setShowOpener(false);
    return (
      <>
        {showOpener && (
          <button onClick={() => setOpen(true)}>Open source</button>
        )}
        <button>Newer owner</button>
        <SourceEditorDialog
          open={open}
          onSaved={vi.fn()}
          onClose={(summary) => {
            closed(summary);
            setOpen(false);
          }}
        />
      </>
    );
  }
  return {
    ...render(
      <QueryClientProvider client={client}>
        <UIProviders>
          <Host />
        </UIProviders>
      </QueryClientProvider>,
    ),
    closed,
    removeOpener: () => removeOpener(),
  };
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  closeQueue.held.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Cancellation must not request an API");
    }),
  );
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    original(element),
  );
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(
    function (this: HTMLElement) {
      if (!this.isConnected) return null;
      for (
        let node: HTMLElement | null = this;
        node;
        node = node.parentElement
      ) {
        if (
          getComputedStyle(node).display === "none" ||
          getComputedStyle(node).visibility === "hidden"
        )
          return null;
      }
      return this.parentElement;
    },
  );
  // JSDOM has no boxes: expose only the existing rendered/non-hidden seam.
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    function (this: HTMLElement) {
      return (this.offsetParent
        ? [{ width: 80, height: 32 }]
        : []) as unknown as DOMRectList;
    },
  );
});
afterEach(async () => {
  await act(async () => {
    cleanup();
    clients.splice(0).forEach((client) => client.clear());
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function openSource() {
  const opener = screen.getByRole("button", { name: "Open source" });
  await userEvent.click(opener);
  const element = await screen.findByRole("dialog", { name: "添加订阅来源" });
  return { opener, element, dialog: within(element) };
}
async function cancelSource(dialog: ReturnType<typeof within>, dirty: boolean) {
  if (dirty)
    fireEvent.change(dialog.getByLabelText("来源名称"), {
      target: { value: "Unsaved source" },
    });
  await userEvent.click(dialog.getByRole("button", { name: /取\s*消/ }));
  if (dirty) {
    const review = within(
      await screen.findByRole("alertdialog", {
        name: "放弃尚未保存的来源修改？",
      }),
    );
    await userEvent.click(review.getByRole("button", { name: "放弃修改" }));
  }
  await waitFor(() => expect(closeQueue.held).toHaveLength(1));
}
it.each([false, true])(
  "commits cancellation before animation ends and returns only its exact opener (dirty=%s)",
  async (dirty) => {
    const { closed, removeOpener } = mount();
    const { opener, dialog } = await openSource();
    await cancelSource(dialog, dirty);
    expect(closed).not.toHaveBeenCalled();
    expect(hasUnsavedChanges()).toBe(false);
    await act(async () => closeQueue.held.shift()!());
    expect(closed).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  },
);
it("does not reclaim focus from a newer owner while cancellation is closing", async () => {
  const { closed } = mount();
  const { dialog } = await openSource();
  await cancelSource(dialog, false);
  const newer = screen.getByRole("button", { name: "Newer owner" });
  act(() => newer.focus());
  await act(async () => closeQueue.held.shift()!());
  expect(closed).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(newer);
});
it.each(["inert", "removed"])(
  "leaves an unavailable %s opener to its parent owner",
  async (kind) => {
    const { closed, removeOpener } = mount();
    const { opener, dialog } = await openSource();
    await cancelSource(dialog, false);
    const focus = vi.spyOn(opener, "focus");
    if (kind === "inert") opener.setAttribute("inert", "");
    else act(() => removeOpener());
    await act(async () => closeQueue.held.shift()!());
    expect(closed).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();
  },
);
it("does not complete or restore a departed closing source task", async () => {
  const { closed, unmount } = mount();
  const { opener, dialog } = await openSource();
  await cancelSource(dialog, false);
  const focus = vi.spyOn(opener, "focus");
  unmount();
  const replacement = document.createElement("button");
  document.body.append(replacement);
  replacement.focus();
  await act(async () => closeQueue.held.shift()!());
  expect(closed).not.toHaveBeenCalled();
  expect(focus).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(replacement);
  replacement.remove();
});
