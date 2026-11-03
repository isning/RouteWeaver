import { INITIAL_PAGE_READY_TIMEOUT_MS } from "./test-support/functional-dom-contract";
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import Workspace from "./App";
import type { TaskOverlayProps } from "./ui-patterns/task-overlays";

const closeMotion = vi.hoisted(() => ({
  hold: false,
  finish: undefined as TaskOverlayProps["onClosed"],
}));
vi.mock("./ui-patterns/task-overlays", async () => {
  const actual = await vi.importActual<
    typeof import("./ui-patterns/task-overlays")
  >("./ui-patterns/task-overlays");
  return {
    ...actual,
    TaskSheet: (props: TaskOverlayProps) => (
      <actual.TaskSheet
        {...props}
        onClosed={() => {
          if (closeMotion.hold) closeMotion.finish = props.onClosed;
          else props.onClosed?.();
        }}
      />
    ),
  };
});

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
function mount(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>{children}</UIProviders>
    </QueryClientProvider>,
  );
}
function viewport(narrow: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: narrow && query === "(max-width: 760px)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}
beforeEach(() => {
  closeMotion.hold = false;
  closeMotion.finish = undefined;
  // Ant Design test-mode UUIDs collide across nested dialog overlays.
  // Use production-style unique IDs, as in the public-onboarding tests.
  vi.stubEnv("NODE_ENV", "development");
  history.replaceState(null, "", "#subscriptions");
  viewport(false);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    original(element),
  );
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
    vi.fn(async (url) =>
      String(url).endsWith("/auth/me")
        ? json({
            user: { id: "user", name: "User", role: "admin" },
            csrfToken: "csrf",
          })
        : String(url).endsWith("/me/overview")
          ? json({
              status: "active",
              quotaBytes: 1073741824,
              user: { id: "user", name: "User" },
              usage: { rawBytes: 0, weightedBytes: 0 },
              routes: [],
            })
          : String(url).endsWith("/admin/subscription-origin")
            ? json({
                revision: 1,
                configuredRevision: 0,
                draftOrigin: "",
                effectiveRevision: 0,
                effectiveOrigin: "https://example.test",
                defaultOrigin: "https://example.test",
                verificationStatus: "not-required",
                currentLinkExample: "https://example.test/feed/example",
              })
            : String(url).endsWith("/settings")
              ? json({
                  name: "RouteWeaver",
                  registration: "invite",
                  timezone: "UTC+8",
                })
              : String(url).endsWith("/state")
                ? json({
                    settings: {
                      name: "RouteWeaver",
                      registration: "invite",
                      timezone: "UTC+8",
                    },
                    nodes: [],
                    users: [],
                    routes: [],
                    revisions: [],
                    capabilities: [],
                    services: [],
                  })
                : json([]),
    ),
  );
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function mobileTask(page = "resources") {
  viewport(true);
  history.replaceState(null, "", `#${page}`);
  const view = mount(<Workspace />);
  await screen.findByRole(
    "heading",
    {
      name: page === "settings" ? "平台设置" : "规则资源",
      level: 1,
    },
    { timeout: INITIAL_PAGE_READY_TIMEOUT_MS },
  );
  const trigger = screen.getByRole("button", { name: "打开导航" });
  const open = async () => {
    await userEvent.click(trigger);
    return screen.findByRole("navigation", { name: "工作空间导航" });
  };
  return { trigger, open, view };
}
it("abandons an old close callback when its workspace unmounts", async () => {
  const task = await mobileTask();
  const nav = await task.open();
  closeMotion.hold = true;
  await userEvent.click(within(nav).getByRole("button", { name: "订阅来源" }));
  await screen.findByRole("heading", { name: "订阅来源", level: 1 });
  await waitFor(() => expect(closeMotion.finish).toBeTypeOf("function"));
  const oldClose = closeMotion.finish;
  task.view.unmount();
  render(
    <main id="main" tabIndex={-1}>
      Replacement workspace
    </main>,
  );
  expect(document.activeElement).toBe(document.body);
  act(() => oldClose?.());
  expect(document.activeElement).toBe(document.body);
});
it("returns same-page selection to the menu trigger and hides retained navigation", async () => {
  const task = await mobileTask();
  const nav = await task.open();
  await userEvent.click(within(nav).getByRole("button", { name: "规则资源" }));
  await waitFor(() => expect(screen.queryByRole("navigation")).toBeNull());
  expect(document.activeElement).toBe(task.trigger);
  expect(location.hash).toBe("#resources");
});
it("hands an accepted different page to the persistent main target", async () => {
  const task = await mobileTask();
  const nav = await task.open();
  await userEvent.click(within(nav).getByRole("button", { name: "订阅来源" }));
  await screen.findByRole("heading", { name: "订阅来源", level: 1 });
  await waitFor(() => expect(screen.queryByRole("navigation")).toBeNull());
  await waitFor(() =>
    expect(document.activeElement).toBe(document.getElementById("main")),
  );
});
it.each([false, true])(
  "preserves dirty-navigation confirmation ownership when accepted=%s",
  async (accept) => {
    const task = await mobileTask("settings");
    await userEvent.click(await screen.findByRole("button", { name: "编辑平台名称" }));
    const field = await screen.findByLabelText("平台名称");
    fireEvent.change(field, { target: { value: "Retained settings draft" } });
    const nav = await task.open();
    await userEvent.click(within(nav).getByText("订阅素材", { exact: true }));
    const chosen = within(nav).getByRole("button", { name: "规则资源" });
    await userEvent.click(chosen);
    const review = await screen.findByRole("alertdialog", {
      name: "放弃未保存的修改？",
    });
    if (accept) {
      await userEvent.click(
        within(review).getByRole("button", { name: "放弃修改并离开" }),
      );
      await screen.findByRole("heading", { name: "规则资源", level: 1 });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() =>
        expect(document.activeElement).toBe(document.getElementById("main")),
      );
    } else {
      await userEvent.keyboard("{Escape}");
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "放弃未保存的修改？" }),
        ).toBeNull(),
      );
      expect(location.hash).toBe("#settings");
      expect((field as HTMLInputElement).value).toBe("Retained settings draft");
      expect(document.activeElement).toBe(chosen);
      expect(screen.getByRole("navigation")).toBe(nav);
    }
  },
);

it("fills the mobile navigation sheet instead of retaining the desktop sidebar width", async () => {
  const task = await mobileTask();
  const nav = await task.open();
  const sidebar = nav.closest("#workspace-navigation")!;
  expect(sidebar.classList.contains("w-full")).toBe(true);
  expect(sidebar.classList.contains("w-64")).toBe(false);
});

it("uses workspace identity in the mobile top bar and leaves the page title in main", async () => {
  await mobileTask();
  const banner = screen.getByRole("banner", { name: "工作空间" });
  expect(within(banner).getByText("RouteWeaver")).toBeTruthy();
  expect(within(banner).getByRole("button", { name: "打开导航" })).toBeTruthy();
  expect(within(banner).queryByText("规则资源")).toBeNull();
  expect(screen.getByRole("heading", { name: "规则资源", level: 1 })).toBeTruthy();
});
