// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

function mount(overrides: Record<string, unknown[]> = {}) {
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
  Object.assign(inventory, overrides);
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


it("opens a server through an explicit configuration action and shows only the next setup tip", async () => {
  history.replaceState(null, "", "#servers");
  mount();
  const user = userEvent.setup();
  const enter = await screen.findByRole("button", { name: "进入服务器 Tokyo server" });
  expect(screen.getByText("1 个已登记核心")).toBeTruthy();
  expect(screen.getByText("1 个已保存监听")).toBeTruthy();
  expect(screen.getByText("下一步：配置转发路径")).toBeTruthy();
  await user.click(enter);
  expect(screen.queryByRole("list", { name: "服务器配置步骤" })).toBeNull();
  const tip = screen.getByRole("status", { name: "服务器配置提示" });
  expect(within(tip).getByText("设置流量去向")).toBeTruthy();
  expect(within(tip).getByText("监听入口已保存。创建转发路径后，检查并确认应用。")).toBeTruthy();
  expect(within(tip).getByRole("link", { name: "创建转发路径" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "管理监听入口" })).toBeNull();
  expect(screen.queryByRole("button", { name: "查看 Agent 接入" })).toBeNull();
  expect(screen.queryByRole("button", { name: "选择要配置的核心" })).toBeNull();
  expect(screen.getByRole("button", { name: "查看接入与配置" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "返回服务器清单" }));
  expect(await screen.findByRole("button", { name: "进入服务器 Tokyo server" })).toBeTruthy();
});


it("continues from the overview using the exact saved listener and server context", async () => {
  history.replaceState(null, "", "#servers");
  mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "进入服务器 Tokyo server" }));
  const path = screen.getByRole("link", { name: "创建转发路径" });
  expect(path.getAttribute("href")).toBe("#routes?entryEndpoint=endpoint-1&returnHost=host-1&returnInstance=core-1");
  await user.click(screen.getByRole("button", { name: "查看接入与配置" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  const core = screen.getByRole("region", { name: "Tokyo server的Tokyo core" });
  expect(within(core).getByText("Tokyo entry", { exact: true })).toBeTruthy();
  expect(within(core).getByRole("button", { name: "编辑监听端点 Tokyo entry" })).toBeTruthy();
});

it("requires an explicit core choice instead of guessing among multiple cores", async () => {
  history.replaceState(null, "", "#servers");
  mount({ "/api/managed-endpoints": [], "/api/core-instances": [
    { id: "core-1", hostId: "host-1", name: "Tokyo core", adapterId: "routeweaver/xray", version: "26.3.27" },
    { id: "core-2", hostId: "host-1", name: "Second core", adapterId: "routeweaver/xray", version: "26.3.27" },
  ] });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "进入服务器 Tokyo server" }));
  await user.click(screen.getByRole("button", { name: "选择核心与监听" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("tab", { name: "核心与监听" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("heading", { name: "Tokyo core" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Second core" })).toBeTruthy();
});

it("offers scoped listener creation only when the selected core has no listeners", async () => {
  history.replaceState(null, "", "#servers");
  mount({ "/api/managed-endpoints": [] });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "进入服务器 Tokyo server" }));
  expect(screen.queryByRole("button", { name: "管理监听入口" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "设置监听入口" }));
  const editor = await screen.findByRole("dialog", { name: "添加监听端点" });
  expect(within(editor).getByLabelText("所属服务器").textContent).toBe("Tokyo server");
  expect(within(editor).getByLabelText("所属核心").textContent).toBe("Tokyo core");
  await user.click(within(editor).getByRole("button", { name: "取消" }));
  const tip = screen.getByRole("status", { name: "服务器配置提示" });
  expect(within(tip).getByText("添加监听入口")).toBeTruthy();
  expect(within(tip).getByText("核心已登记。选择客户端连接的协议与监听地址。")).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(within(tip).getByRole("button", { name: "设置监听入口" })));
});


it("clears a previously visited core when returning to the listener chooser", async () => {
  history.replaceState(null, "", "#servers");
  mount({
    "/api/core-instances": [
      { id: "core-1", hostId: "host-1", name: "Tokyo core", adapterId: "routeweaver/xray", version: "26.3.27" },
      { id: "core-2", hostId: "host-1", name: "Second core", adapterId: "routeweaver/xray", version: "26.3.27" },
    ],
    "/api/managed-endpoints": [
      { id: "endpoint-1", instanceId: "core-1", name: "Tokyo entry", connection: { protocol: "vless", host: "0.0.0.0", port: 443 } },
      { id: "endpoint-2", instanceId: "core-2", name: "Second entry", connection: { protocol: "vless", host: "0.0.0.0", port: 8443 } },
    ],
  });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "进入服务器 Tokyo server" }));
  await user.click(screen.getAllByRole("button", { name: "查看接入与配置" })[0]);
  expect(screen.getByRole("region", { name: "Tokyo server的Tokyo core" })).toBeTruthy();
  expect(location.hash).toContain("instance=core-1");
  await user.click(screen.getByRole("tab", { name: "概览" }));
  await user.click(screen.getByRole("button", { name: "选择监听入口" }));
  expect(location.hash).toBe("#servers?host=host-1&section=cores");
  expect(screen.queryByRole("region", { name: "Tokyo server的Tokyo core" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Tokyo core" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Second core" })).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "查看接入与配置" })).toHaveLength(2);
  await user.click(screen.getAllByRole("button", { name: "查看接入与配置" })[1]);
  const secondCore = screen.getByRole("region", { name: "Tokyo server的Second core" });
  expect(within(secondCore).getByText("Second entry", { exact: true })).toBeTruthy();
  expect(within(secondCore).queryByText("Tokyo entry", { exact: true })).toBeNull();
  expect(location.hash).toContain("instance=core-2");
});

