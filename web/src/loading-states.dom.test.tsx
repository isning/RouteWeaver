// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from "@tanstack/react-query";
import { QueryState } from "./components";
import { SubscriptionsPage } from "./Subscriptions";
import { ServersPage } from "./Infrastructure";
import { UIProviders } from "./ui-patterns/providers";
import { emptyProfile } from "./model";
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});
const client = () => {
  const c = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(c);
  return c;
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
it("keeps a known error actionable even while another dependency is pending", async () => {
  const retry = vi.fn();
  render(
    <UIProviders>
      <QueryState
        loading
        error={new Error("Required read failed")}
        retry={retry}
      >
        <p>Empty</p>
      </QueryState>
    </UIProviders>,
  );
  expect(screen.getByText("Required read failed")).toBeTruthy();
  expect(screen.queryByRole("status", { name: "正在加载" })).toBeNull();
  expect(screen.queryByText("Empty")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(retry).toHaveBeenCalledOnce();
});
it("has one named pending region with hidden decoration and reduced-motion placeholders", () => {
  const view = render(
    <QueryState loading loadingLayout="table">
      <p>Empty</p>
    </QueryState>,
  );
  const pending = screen.getByRole("status", { name: "正在加载" });
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(pending.getAttribute("aria-busy")).toBe("true");
  expect(
    view.container.querySelectorAll('[data-slot="skeleton"]').length,
  ).toBeGreaterThan(1);
  for (const shape of view.container.querySelectorAll(
    '[data-slot="skeleton"]',
  )) {
    expect(shape.getAttribute("aria-hidden")).toBe("true");
    expect(shape.className).toContain("motion-reduce:animate-none");
  }
  expect(screen.queryByText("Empty")).toBeNull();
});
it("keeps available subscription profiles editable while the link read is held then fails", async () => {
  const c = client();
  const profile = {
    ...emptyProfile(),
    id: "profile",
    name: "Available profile",
  };
  c.setQueryData(["profiles"], [profile]);
  let release!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/me/outputs"
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : json({ routes: [] }),
    ),
  );
  render(
    <QueryClientProvider client={c}>
      <UIProviders>
        <SubscriptionsPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  await screen.findByRole("status", { name: "正在加载配置与客户端订阅" });
  expect(
    screen.getByRole("article", { name: "分流配置 Available profile" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "编辑配置" })).toBeTruthy();
  expect(screen.queryByText("暂无订阅")).toBeNull();
  await act(async () => release(json({ message: "Links failed" }, 503)));
  await screen.findByText("暂时无法加载客户端订阅");
  expect(
    screen.getByRole("article", { name: "分流配置 Available profile" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "重新核对订阅" })).toBeTruthy();
});
it.each(["subscriptions", "servers"])(
  "shows offline initial %s reads as waiting, not empty",
  async (page) => {
    onlineManager.setOnline(false);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const c = client();
    render(
      <QueryClientProvider client={c}>
        <UIProviders>
          {page === "servers" ? <ServersPage /> : <SubscriptionsPage />}
        </UIProviders>
      </QueryClientProvider>,
    );
    expect((await screen.findAllByText("等待网络连接")).length).toBeGreaterThan(
      0,
    );
    expect(
      screen.queryByText(page === "servers" ? "暂无服务器" : "暂无订阅"),
    ).toBeNull();
    expect(
      screen.queryByRole("status", { name: "正在加载配置与客户端订阅" }),
    ).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  },
);
