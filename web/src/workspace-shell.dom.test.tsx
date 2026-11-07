// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import type { ReactNode } from "react";
import { useUnsavedChanges } from "./navigation";
beforeAll(async () => {
  // This shell-navigation case does not measure Vite cold compilation. Keep
  // module preparation outside RTL’s user-visible heading deadline; controlled
  // pending/rejected imports are exercised in page-recovery.dom.test.tsx.
  await import("./Infrastructure");
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn(() => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {},
    })),
  });
  const original = window.getComputedStyle;
  window.getComputedStyle = (element) => original(element);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, "", "#profiles");
});
function mount(role = "admin", hash = "#profiles", owners?: ReactNode) {
  history.replaceState(null, "", hash);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
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
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).endsWith("/auth/me")
              ? { user: { id: "u", name: "Demo", role }, csrfToken: "test" }
              : [],
          ),
          { headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <UIProviders>
        
          <App />
          {owners}
        
      </UIProviders>
    </QueryClientProvider>,
  );
}
it("keeps subscription and network scopes in one navigation without a personal/admin mode switch", async () => {
  mount();
  const nav = await screen.findByRole("navigation", { name: "工作空间导航" });
  expect(within(nav).getByText("订阅与分流")).toBeTruthy();
  expect(within(nav).getByText("网络资源")).toBeTruthy();
  expect(screen.queryByRole("radio", { name: "管理" })).toBeNull();
  // Everyday subscription and network destinations are visible without opening a category.
  expect(within(nav).getByRole("button", { name: "我的订阅" })).toBeTruthy();
  expect(within(nav).getByRole("button", { name: "连接端点" })).toBeTruthy();
  await userEvent.click(within(nav).getByRole("button", { name: "服务器" }));
  await screen.findByRole("heading", { name: "服务器", level: 1 });
  expect(location.hash).toBe("#servers");
  expect(
    within(nav)
      .getByRole("button", { name: "服务器" })
      .getAttribute("aria-current"),
  ).toBe("page");
  expect(within(nav).getByText("订阅与分流")).toBeTruthy();
});
it.each([
  "published-routes",
  "routes",
  "servers",
  "fleet",
  "users",
  "services",
  "activity",
  "settings",
  "nodes",
  "legacy-routes",
  "notifications",
])(
  "denies the administrator-only #%s route to a regular account without requesting its data",
  async (route) => {
    mount("user", `#${route}`);
    const nav = await screen.findByRole("navigation", { name: "工作空间导航" });
    expect(within(nav).queryByText("网络资源")).toBeNull();
    expect(within(nav).queryByText("用户与权限")).toBeNull();
    expect(await screen.findByText("需要管理员权限")).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([
      "/api/auth/me",
    ]);
  },
);

it("hides each breadcrumb ancestor together with its separator on narrow screens", async () => {
  mount();
  await screen.findByRole("navigation", { name: "工作空间导航" });
  const breadcrumb = document.querySelector(".breadcrumb")!;
  const root = breadcrumb.querySelector(".breadcrumb-root")!;
  const scope = breadcrumb.querySelector(".breadcrumb-scope")!;
  // JSDOM cannot evaluate Tailwind media queries; assert the responsive grouping
  // contract here, with actual narrow-viewport appearance covered by browser QA.
  for (const [ancestor, breakpoint] of [[root, "sm"], [scope, "md"]] as const) {
    expect(ancestor.classList.contains("hidden")).toBe(true);
    expect(ancestor.classList.contains(`${breakpoint}:inline-flex`)).toBe(true);
    expect(ancestor.querySelector('[aria-hidden="true"]')?.textContent).toBe("/");
  }
  expect(breadcrumb.querySelectorAll(':scope > [aria-hidden="true"]')).toHaveLength(0);
  expect(breadcrumb.querySelector("strong")?.textContent).toBe("我的订阅");
});

it("keeps discovery groups collapsible without hiding the current destination permanently", async () => {
  mount();
  const nav = await screen.findByRole("navigation", { name: "工作空间导航" });
  const group = within(nav).getByRole("button", { name: "网络资源" });
  expect(group.getAttribute("aria-expanded")).toBe("true");
  await userEvent.click(group);
  expect(within(nav).queryByRole("button", { name: "连接端点" })).toBeNull();
  await userEvent.click(group);
  expect(within(nav).getByRole("button", { name: "连接端点" })).toBeTruthy();
});

it("keeps category groups compact without reducing their control height", async () => {
  mount();
  const nav = await screen.findByRole("navigation", { name: "工作空间导航" });
  expect(nav.classList.contains("space-y-0")).toBe(true);
  const category = within(nav).getByRole("button", { name: "网络资源" });
  expect(category.classList.contains("h-8")).toBe(true);
  expect(category.closest('[data-sidebar="group"]')?.classList.contains("py-1")).toBe(true);
});

it("shows every active departure consequence and keeps navigation cancelable", async () => {
  function Owners() {
    useUnsavedChanges(true, "出口变更可能已保存。离开会丢失核对信息。");
    useUnsavedChanges(true, "离开不会取消接入凭据操作。");
    useUnsavedChanges(true);
    return null;
  }
  mount("admin", "#profiles", <Owners />);
  const user = userEvent.setup();
  const nav = await screen.findByRole("navigation", { name: "工作空间导航" });
  await user.click(within(nav).getByRole("button", { name: "服务器" }));
  const dialog = await screen.findByRole("alertdialog", { name: "离开当前页面？" });
  expect(dialog.textContent).toContain("出口变更可能已保存。离开会丢失核对信息。");
  expect(dialog.textContent).toContain("离开不会取消接入凭据操作。");
  expect(dialog.textContent).toContain("离开会放弃尚未保存的内容。");
  await user.click(within(dialog).getByRole("button", { name: "留在当前页面" }));
  expect(location.hash).toBe("#profiles");
  await user.click(within(nav).getByRole("button", { name: "服务器" }));
  const confirmed = await screen.findByRole("alertdialog", { name: "离开当前页面？" });
  await user.click(within(confirmed).getByRole("button", { name: "仍然离开" }));
  await screen.findByRole("heading", { name: "服务器", level: 1 });
  expect(location.hash).toBe("#servers");
});
