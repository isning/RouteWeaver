// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { PublishOutput } from "./Subscriptions";
import { emptyProfile } from "./model";
import type { Profile } from "./types";

const clients: QueryClient[] = [];
beforeEach(() => {
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
    const style = computed(element);
    if (element.matches('[data-task-overlay="dialog"]'))
      Object.defineProperty(style, "animationName", {
        configurable: true,
        get: () =>
          element.getAttribute("data-state") === "closed"
            ? "publication-exit"
            : "none",
      });
    return style;
  });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("[]", { headers: { "Content-Type": "application/json" } }),
    ),
  );
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const old = { ...emptyProfile(), id: "old", name: "旧任务配置" };
  const draw = (
    profile: Profile | null,
    state: "ready" | "missing" = "ready",
    sessionId = "first",
  ) => (
    <QueryClientProvider client={client}>
      <UIProviders>
        <PublishOutput
          profile={profile}
          profileRead={{ state, retry: vi.fn() }}
          sessionId={sessionId}
          onClose={() => {}}
        />
      </UIProviders>
    </QueryClientProvider>
  );
  const mounted = render(draw(old));
  return {
    old,
    set: (
      profile: Profile | null,
      state: "ready" | "missing" = "ready",
      sessionId = "first",
    ) => mounted.rerender(draw(profile, state, sessionId)),
  };
}
function finishExit(dialog: HTMLElement) {
  const event = new Event("animationend", { bubbles: true });
  Object.defineProperty(event, "animationName", { value: "publication-exit" });
  fireEvent(dialog, event);
}
it("retains task identity and read presentation on inert exit without authorizing a closed submission", async () => {
  const task = mount();
  const dialog = screen.getByRole("dialog", { name: "新增客户端订阅" });
  fireEvent.change(within(dialog).getByLabelText("订阅名称"), {
    target: { value: "自定义名称" },
  });
  task.set(null, "missing");
  expect(dialog.isConnected).toBe(true);
  expect(dialog.getAttribute("data-state")).toBe("closed");
  expect(dialog.hasAttribute("inert")).toBe(true);
  expect(within(dialog).getByText("旧任务配置")).toBeTruthy();
  expect(within(dialog).getByLabelText("订阅名称")).toHaveProperty(
    "value",
    "自定义名称",
  );
  expect(
    within(dialog).queryByText("此分流配置已不在当前可访问范围。"),
  ).toBeNull();
  const check = within(dialog).getByRole("button", { name: "检查发布内容" });
  expect(check).toHaveProperty("disabled", false);
  fireEvent.click(check);
  await waitFor(() => expect(check).toHaveProperty("disabled", false));
  expect(fetch).not.toHaveBeenCalled();
  finishExit(dialog);
  await waitFor(() => expect(dialog.isConnected).toBe(false));
});
it("shows a real open access loss and replaces the exiting presentation on a new session", async () => {
  const task = mount();
  task.set(task.old, "missing");
  expect(screen.getByText("此分流配置已不在当前可访问范围。")).toBeTruthy();
  expect(screen.getByRole("button", { name: "检查发布内容" })).toHaveProperty(
    "disabled",
    true,
  );
  task.set(task.old);
  const closing = screen.getByRole("dialog", { name: "新增客户端订阅" });
  task.set(null, "missing");
  const next = { ...emptyProfile(), id: "next", name: "新任务配置" };
  task.set(next, "ready", "second");
  const reopened = screen.getByRole("dialog", { name: "新增客户端订阅" });
  expect(reopened.hasAttribute("inert")).toBe(false);
  expect(within(reopened).getByText("新任务配置")).toBeTruthy();
  expect(within(reopened).getByLabelText("订阅名称")).toHaveProperty(
    "value",
    "新任务配置",
  );
  finishExit(closing);
  expect(reopened.getAttribute("data-state")).toBe("open");
  expect(within(reopened).queryByText("旧任务配置")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
