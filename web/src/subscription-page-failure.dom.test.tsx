// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { PageBoundary } from "./PageBoundary";
import { SubscriptionPageLoader } from "./SubscriptionPageLoader";
import { UIProviders } from "./ui-patterns/providers";
import { useUnsavedChanges } from "./navigation";

const moduleGate = vi.hoisted(() => {
  let fail!: (reason: Error) => void;
  const gate = new Promise<never>((_, reject) => {
    fail = reject;
  });
  return { gate, fail, requested: false };
});
vi.mock("./Subscriptions", async () => {
  moduleGate.requested = true;
  return moduleGate.gate;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("contains an active failed chunk, caches its resource error and preserves refresh confirmation without retrying business reads", async () => {
  const user = userEvent.setup();
  const reload = vi.fn();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("[]")),
  );
  function Workspace() {
    const [open, setOpen] = useState(true);
    const [draft, setDraft] = useState("");
    useUnsavedChanges(!!draft);
    return (
      <>
        <input
          aria-label="保留草稿"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button onClick={() => setOpen(!open)}>
          {open ? "打开其他页面" : "返回订阅页"}
        </button>
        <PageBoundary key={open ? "subscriptions" : "other"} reload={reload}>
          {open ? <SubscriptionPageLoader /> : <h1>其他页面</h1>}
        </PageBoundary>
      </>
    );
  }
  render(
    <UIProviders>
      <Workspace />
    </UIProviders>,
  );
  await waitFor(() => expect(moduleGate.requested).toBe(true));
  expect(screen.getByRole("status", { name: "正在打开页面" })).toBeTruthy();
  await user.type(
    screen.getByRole("textbox", { name: "保留草稿" }),
    "Keep this unsent draft",
  );
  await act(async () =>
    moduleGate.fail(new TypeError("synthetic private module URL")),
  );
  await vi.dynamicImportSettled();
  expect(fetch).not.toHaveBeenCalled();
  expect(await screen.findByText("页面资源未能加载")).toBeTruthy();
  expect(screen.queryByRole("status", { name: "正在打开页面" })).toBeNull();
  expect(screen.queryByRole("button", { name: "重新打开页面" })).toBeNull();
  expect(screen.queryByText(/synthetic private/)).toBeNull();
  expect(reload).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "刷新工作空间" }));
  const confirmation = await screen.findByRole("alertdialog", {
    name: "放弃未保存内容并重新打开？",
  });
  const cancel = within(confirmation).getByRole("button", { name: "暂不操作" });
  await waitFor(() => expect(document.activeElement).toBe(cancel));
  await user.click(cancel);
  expect(
    (screen.getByRole("textbox", { name: "保留草稿" }) as HTMLInputElement)
      .value,
  ).toBe("Keep this unsent draft");
  expect(reload).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "打开其他页面" }));
  expect(screen.getByRole("heading", { name: "其他页面" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "返回订阅页" }));
  expect(screen.getByText("页面资源未能加载")).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "刷新工作空间" }));
  await user.click(
    await screen.findByRole("button", { name: "放弃修改并继续" }),
  );
  expect(reload).toHaveBeenCalledOnce();
});
