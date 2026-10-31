// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmationProvider } from "@/ui-patterns/confirmations";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function mount() {
  const inventory: Record<string, unknown[]> = {
    "/api/hosts": [
      { id: "host-1", name: "Tokyo server", address: "tokyo.example.com" },
    ],
    "/api/core-instances": [
      {
        id: "core-1",
        hostId: "host-1",
        name: "Tokyo core",
        adapterId: "routeweaver/xray",
        version: "26.3.27",
      },
    ],
    "/api/managed-endpoints": [
      {
        id: "endpoint-1",
        instanceId: "core-1",
        name: "Tokyo entry",
        connection: { protocol: "vless", host: "0.0.0.0", port: 443 },
      },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url) =>
        new Response(JSON.stringify(inventory[String(url)] || []), {
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ConfirmationProvider>
        
          <ServersPage />
        
      </ConfirmationProvider>
    </QueryClientProvider>,
  );
}

it.each([
  ["服务器 1", "tokyo.example.com", "添加服务器", "Tokyo entry"],
  ["核心实例 1", "Tokyo core", "添加核心实例", "Tokyo entry"],
  ["监听端点 1", "Tokyo entry", "添加监听端点", "tokyo.example.com"],
])(
  "associates %s with its actual content and matching add action",
  async (name, content, action, absent) => {
    mount();
    const user = userEvent.setup();
    const tab = await screen.findByRole("tab", { name });
    await user.click(tab);
    const panel = screen.getByRole("tabpanel", { name });
    expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
    expect(tab.getAttribute("aria-controls")).toBe(panel.id);
    // Action-context labels intentionally repeat the target name. Assert the
    // public inventory cell/opener rather than an ambiguous text match.
    const contentElement =
      content === "Tokyo core"
        ? within(panel).getByRole("button", {
            name: "Tokyo core 26.3.27",
          })
        : content === "Tokyo entry"
          ? within(panel).getByRole("cell", { name: content })
          : within(panel).getByText(content);
    expect(contentElement).toBeTruthy();
    expect(within(panel).queryByText(absent)).toBeNull();
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: action }));
    expect(await screen.findByRole("dialog", { name: action })).toBeTruthy();
  },
);

it("keeps keyboard tab navigation connected to the active inventory panel", async () => {
  mount();
  const user = userEvent.setup();
  const hosts = await screen.findByRole("tab", { name: "服务器 1" });
  hosts.focus();
  await user.keyboard("{ArrowRight}{Enter}");
  expect(
    screen
      .getByRole("tab", { name: /核心实例 1$/ })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(
    within(screen.getByRole("tabpanel", { name: /核心实例 1$/ })).getByRole(
      "button",
      { name: "Tokyo core 26.3.27" },
    ),
  ).toBeTruthy();
});
