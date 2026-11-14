// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { PageBoundary } from "./PageBoundary";
import { SubscriptionPageLoader } from "./SubscriptionPageLoader";
import App from "./App";

const moduleGate = vi.hoisted(() => {
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  return { gate, release, requested: false };
});
vi.mock("./Subscriptions", async (original) => {
  moduleGate.requested = true;
  await moduleGate.gate;
  return original<typeof import("./Subscriptions")>();
});
const clients: QueryClient[] = [];
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
function mount(children: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>{children}</UIProviders>
    </QueryClientProvider>,
  );
}
afterEach(async () => {
  cleanup();
  moduleGate.release();
  await vi.dynamicImportSettled();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});
it("owns accessible loading without Suspense, ignores inactive completion and reuses only the loaded module with current view and draft", async () => {
  const user = userEvent.setup();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const reads: string[] = [],
    writes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      (init?.method && init.method !== "GET" ? writes : reads).push(url);
      return json(
        url.endsWith("/overview") ? { status: "active", routes: [] } : url.endsWith("/outputs/independent") ? { items: [] } : [],
      );
    }),
  );
  function Workspace() {
    const [open, setOpen] = useState(true);
    const [view, setView] = useState<"overview" | "outputs">("overview");
    return (
      <>
        <button onClick={() => setOpen(!open)}>
          {open ? "离开订阅页" : "返回订阅页"}
        </button>
        <button
          onClick={() => setView(view === "overview" ? "outputs" : "overview")}
        >
          切换订阅视图
        </button>
        <PageBoundary key={open ? "subscriptions" : "other"}>
          {open ? <SubscriptionPageLoader view={view} /> : <h1>其他页面</h1>}
        </PageBoundary>
      </>
    );
  }
  mount(<Workspace />);
  const loading = screen.getByRole("status", {
    name: "正在打开页面",
  });
  expect(loading.getAttribute("aria-busy")).toBe("true");
  expect(screen.getAllByRole("status", { name: "正在打开页面" })).toHaveLength(
    1,
  );
  expect(
    loading.querySelectorAll('[data-slot="skeleton"]').length,
  ).toBeGreaterThan(0);
  await waitFor(() => expect(moduleGate.requested).toBe(true));
  expect(reads).toEqual([]);
  await user.click(screen.getByRole("button", { name: "切换订阅视图" }));
  await user.click(screen.getByRole("button", { name: "离开订阅页" }));
  await act(async () => {
    moduleGate.release();
    // Join module evaluation, without mounting it, before asserting inactivity.
    await import("./Subscriptions");
  });
  expect(screen.getByRole("heading", { name: "其他页面" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "我的订阅" })).toBeNull();
  expect(reads).toEqual([]);
  await user.click(screen.getByRole("button", { name: "返回订阅页" }));
  expect(screen.queryByRole("status", { name: "正在打开页面" })).toBeNull();
  expect(screen.getByRole("region", { name: "客户端订阅清单" })).toBeTruthy();
  await screen.findByText("暂无订阅", { exact: true });
  await user.click(screen.getByRole("button", { name: "新建分流配置" }));
  const name = await screen.findByRole("textbox", { name: "配置名称" });
  await user.type(name, "Unsent retained draft");
  await user.click(screen.getByRole("button", { name: "切换订阅视图" }));
  expect(
    (screen.getByRole("textbox", { name: "配置名称" }) as HTMLInputElement)
      .value,
  ).toBe("Unsent retained draft");
  expect(writes).toEqual([]);
});
it("a cached public module cannot start business reads while the real session boundary is still checking", async () => {
  // Establish this precondition even when this test is selected on its own.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      json(url.endsWith("/overview") ? { status: "active", routes: [] } : url.endsWith("/outputs/independent") ? { items: [] } : []),
    ),
  );
  const primed = mount(<SubscriptionPageLoader />);
  await act(async () => moduleGate.release());
  await screen.findByText("暂无订阅", { exact: true });
  primed.unmount();
  let release!: (value: Response) => void;
  const auth = new Promise<Response>((done) => {
    release = done;
  });
  const calls: string[] = [];
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      return url.endsWith("/auth/me")
        ? auth
        : json(
            url.endsWith("/overview") ? { status: "active", routes: [] } : url.endsWith("/outputs/independent") ? { items: [] } : [],
          );
    }),
  );
  history.replaceState(null, "", "#subscriptions");
  mount(<App />);
  expect(screen.getByRole("status", { name: "正在确认登录状态" })).toBeTruthy();
  expect(calls).toEqual(["/api/auth/me"]);
  await act(async () =>
    release(
      json({
        user: { id: "synthetic", name: "Synthetic", role: "user" },
        csrfToken: "synthetic-csrf",
      }),
    ),
  );
  await screen.findByText("暂无订阅", { exact: true });
  expect(calls.filter((path) => path.startsWith("/api/me/")).sort()).toEqual([
    "/api/me/outputs",
    "/api/me/outputs",
    "/api/me/outputs/independent",
    "/api/me/overview",
    "/api/me/profiles",
  ]);
});
