// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EmptyState } from "./components";
import { ServersPage } from "./Infrastructure";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((media) => ({
      matches: false,
      media,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  const original = window.getComputedStyle;
  window.getComputedStyle = (element) => original(element);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("renders an empty-state fact without an empty explanatory paragraph", () => {
  const { container } = render(<EmptyState title="暂无对象" />);
  expect(screen.getByRole("heading", { name: "暂无对象" })).toBeTruthy();
  expect(container.querySelector("p")).toBeNull();
});

it("keeps a necessary empty-state prerequisite visible", () => {
  render(
    <EmptyState title="暂无线路" description="需先建立服务器转发路径。" />,
  );
  expect(screen.getByText("需先建立服务器转发路径。")).toBeTruthy();
});

it("discloses registration-only scope at server creation, without saving on open", async () => {
  const fetchMock = vi.fn(
    async () =>
      new Response("[]", {
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <UIProviders>
        <ServersPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  const panel = await screen.findByRole("tabpanel", { name: "服务器 0" });
  await user.click(within(panel).getByRole("button", { name: "添加服务器" }));
  const dialog = await screen.findByRole("dialog", { name: "添加服务器" });
  expect(
    within(dialog).getByText("将服务器信息登记到控制平面；服务器连接与配置需另行操作。"),
  ).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: /保\s*存/ })).toBeTruthy();
  expect(
    fetchMock.mock.calls.every(
      (call) =>
        !((call as unknown[])[1] as RequestInit | undefined)?.method ||
        ((call as unknown[])[1] as RequestInit).method === "GET",
    ),
  ).toBe(true);
});
