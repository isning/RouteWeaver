// @vitest-environment jsdom
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmationProvider } from "@/ui-patterns/confirmations";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ServersPage } from "./Infrastructure";
import type { CoreInstance, HostRecord, ManagedEndpoint } from "./types";
import { ownedClickScenario } from "./test-support/owned-click-scenario";

const hosts: HostRecord[] = [
  { id: "host-fra", name: "Frankfurt", address: "fra.example.com" },
  { id: "host-tyo", name: "Tokyo", address: "tyo.example.com" },
  { id: "host-empty", name: "Empty server", address: "empty.example.com" },
];
const instances: CoreInstance[] = [
  {
    id: "core-fra-1",
    hostId: "host-fra",
    name: "FRA primary",
    adapterId: "routeweaver/sing-box",
    version: "1.14.3",
  },
  {
    id: "core-tyo-1",
    hostId: "host-tyo",
    name: "Tokyo primary",
    adapterId: "routeweaver/xray",
    version: "26.3.27",
  },
  {
    id: "core-tyo-2",
    hostId: "host-tyo",
    name: "Tokyo secondary",
    adapterId: "routeweaver/xray",
    version: "26.3.27",
  },
];
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function inventoryAPI({
  cores = instances,
  endpoints = [],
  observationError = false,
}: {
  cores?: CoreInstance[];
  endpoints?: ManagedEndpoint[];
  observationError?: boolean;
} = {}) {
  const currentCores = [...cores];
  const currentHosts = [...hosts];
  const writes: { path: string; value: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (init?.method === "POST" || init?.method === "PUT") {
        const value = JSON.parse(init.body);
        writes.push({ path, value });
        if (path === "/api/core-instances" && init.method === "POST")
          currentCores.push(value as CoreInstance);
        if (path === "/api/hosts" && init.method === "POST")
          currentHosts.push(value as HostRecord);
        return json(value);
      }
      if (path.endsWith("/reveal"))
        return json(endpoints.find((e) => path.includes(e.id)));
      if (path === "/api/hosts") return json(currentHosts);
      if (path === "/api/core-instances") return json(currentCores);
      if (path === "/api/managed-endpoints") return json(endpoints);
      if (path.includes("/observability"))
        return observationError
          ? json({ error: "资源数据暂时不可用" }, 503)
          : json({ config: {} });
      return json([]);
    }),
  );
  return writes;
}
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ConfirmationProvider>
        <ServersPage />
      </ConfirmationProvider>
    </QueryClientProvider>,
  );
}
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
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
  window.getComputedStyle = (element) => original(element);
});
// rc-util deliberately reuses "test-id" in test mode, breaking nested dialog labels.
// Exercise the production-style unique React IDs for the drawer/editor journey.
beforeEach(() => vi.stubEnv("NODE_ENV", "development"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("infrastructure creation user tasks", () => {
  it.each([
    { adapterId: "routeweaver/sing-box", label: "sing-box", version: "1.14.4" },
    { adapterId: "routeweaver/xray", label: "Xray", version: "26.10.31" },
    {
      adapterId: "routeweaver/managed-xray",
      label: "受管 Xray · 平台服务入口",
      version: "26.3.27-rw1",
    },
  ])(
    "creates $adapterId with its current independent version",
    async ({ adapterId, label, version }) => {
      const writes = inventoryAPI();
      mount();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Tokyo" }));
      await user.click(
        within(screen.getByRole("dialog", { name: "Tokyo" })).getByRole(
          "button",
          { name: "添加核心" },
        ),
      );
      const editor = within(
        await screen.findByRole("dialog", { name: "添加核心实例" }),
      );
      if (adapterId !== "routeweaver/sing-box") {
        await user.click(editor.getByLabelText("核心家族"));
        await user.click(
          await screen.findByText(label, { selector: "[cmdk-item] span" }),
        );
      }
      expect(editor.getByLabelText("核心版本").textContent).toContain(version);
      await user.click(editor.getByRole("button", { name: /保\s*存/ }));
      await waitFor(() => expect(writes).toHaveLength(1));
      expect(writes[0].value).toMatchObject({
        adapterId,
        version,
        hostId: "host-tyo",
      });
    },
  );

  it.each(
    [
      {
        name: "FRA primary",
        version: "1.14.3",
        adapterId: "routeweaver/sing-box",
      },
      {
        name: "Tokyo primary",
        version: "26.3.27",
        adapterId: "routeweaver/xray",
      },
    ].flatMap((core) => [
      { ...core, reselectFamily: false, interaction: "editing its name" },
      { ...core, reselectFamily: true, interaction: "reselecting its family" },
    ]),
  )(
    "preserves $name's saved version when $interaction",
    async ({ name, version, adapterId, reselectFamily }) => {
      const writes = inventoryAPI();
      mount();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("tab", { name: "核心实例 3" }));
      await user.click(
        await screen.findByRole("button", { name: `编辑 ${name}` }),
      );
      const editor = within(
        await screen.findByRole("dialog", { name: "编辑核心实例" }),
      );
      expect(editor.getByLabelText("核心版本").textContent).toContain(version);
      if (reselectFamily) {
        await user.click(editor.getByLabelText("核心家族"));
        const label = adapterId === "routeweaver/xray" ? "Xray" : "sing-box";
        await user.click(
          await screen.findByText(label, { selector: "[cmdk-item] span" }),
        );
        expect(editor.getByLabelText("核心版本").textContent).toContain(
          version,
        );
      }
      await user.clear(editor.getByLabelText("实例名称"));
      await user.type(editor.getByLabelText("实例名称"), `${name} renamed`);
      await user.click(editor.getByRole("button", { name: /保\s*存/ }));
      await waitFor(() => expect(writes).toHaveLength(1));
      expect(writes[0].value).toMatchObject({
        adapterId,
        version,
        name: `${name} renamed`,
      });
    },
  );

  it("does not warn after restoring an existing server name to its saved value", async () => {
    inventoryAPI();
    mount();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "编辑服务器 Frankfurt" }),
    );
    const editor = within(
      await screen.findByRole("dialog", { name: "编辑服务器" }),
    );
    await user.clear(editor.getByLabelText("服务器名称"));
    await user.type(editor.getByLabelText("服务器名称"), "Temporary");
    await user.clear(editor.getByLabelText("服务器名称"));
    await user.type(editor.getByLabelText("服务器名称"), "Frankfurt");
    await user.click(editor.getByRole("button", { name: /取\s*消/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("放弃尚未保存的配置修改？")).toBeNull();
  });

  it("protects unsaved inventory input on cancel and defaults to continuing editing", async () => {
    inventoryAPI();
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "添加服务器" }));
    const editor = within(
      await screen.findByRole("dialog", { name: "添加服务器" }),
    );
    await user.type(editor.getByLabelText("服务器名称"), "Keep my host draft");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await user.click(editor.getByRole("button", { name: /取\s*消/ }));
    const keep = await screen.findByRole("button", { name: "继续编辑" });
    await waitFor(() => expect(document.activeElement).toBe(keep));
    await user.keyboard("{Enter}");
    expect(
      (editor.getByLabelText("服务器名称") as HTMLInputElement).value,
    ).toBe("Keep my host draft");
    await user.click(editor.getByRole("button", { name: /取\s*消/ }));
    await user.click(await screen.findByRole("button", { name: "放弃修改" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    await user.click(screen.getByRole("button", { name: "添加服务器" }));
    expect(
      (screen.getByLabelText("服务器名称") as HTMLInputElement).value,
    ).toBe("");
  });

  it("continues from a newly saved server to core setup without finding it again", async () => {
    const writes = inventoryAPI();
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "添加服务器" }));
    const editor = within(
      await screen.findByRole("dialog", { name: "添加服务器" }),
    );
    await user.type(editor.getByLabelText("服务器名称"), "New London");
    await user.type(
      editor.getByLabelText("服务器连接地址"),
      "london.example.com",
    );
    await user.click(editor.getByRole("button", { name: /保\s*存/ }));
    const detail = within(
      await screen.findByRole("dialog", { name: "New London" }),
    );
    expect(detail.getByText("先添加核心，再配置监听端点")).toBeTruthy();
    await user.click(detail.getByRole("button", { name: "添加核心" }));
    const core = within(
      await screen.findByRole("dialog", { name: "添加核心实例" }),
    );
    expect(core.getByText("New London")).toBeTruthy();
    await user.click(core.getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].value.hostId).toBe(writes[0].value.id);
  });

  it("starts a new managed platform listener with VLESS principals and an explicit port", async () => {
    const core = {
      ...instances[2],
      adapterId: "routeweaver/managed-xray",
      version: "26.3.27-rw1",
    };
    const writes = inventoryAPI({ cores: [...instances.slice(0, 2), core] });
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Tokyo" }));
    await user.click(
      screen.getByRole("button", { name: "为 Tokyo secondary 添加监听端点" }),
    );
    const editor = within(
      await screen.findByRole("dialog", { name: "添加监听端点" }),
    );
    expect(editor.getByText("VLESS")).toBeTruthy();
    expect(editor.queryByText("此核心使用 VLESS 按用户分配凭据")).toBeNull();
    fireEvent.click(editor.getByLabelText("传输方式"));
    expect(
      await screen.findByText("TCP", {
        selector: "[cmdk-item] span",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByText("WebSocket", {
        selector: "[cmdk-item] span",
      }),
    ).toBeNull();
    await user.keyboard("{Escape}");
    expect(editor.queryByLabelText("用户 UUID")).toBeNull();
    expect(editor.queryByLabelText("用户名")).toBeNull();
    expect((editor.getByLabelText("端口") as HTMLInputElement).value).toBe("");
    await user.type(editor.getByLabelText("端点名称"), "Platform entry");
    await user.click(editor.getByRole("button", { name: /保\s*存/ }));
    expect(await editor.findByText("填写端口")).toBeTruthy();
    expect(writes).toHaveLength(0);
    await user.type(editor.getByLabelText("端口"), "1443");
    await user.click(editor.getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].value).toMatchObject({
      instanceId: core.id,
      authentication: "principals",
      connection: { protocol: "vless", host: "0.0.0.0", port: 1443 },
    });
    expect(writes[0].value.connection).not.toHaveProperty("uuid");
    expect(writes[0].value.connection).not.toHaveProperty("tls");
  });

  it("preserves a new draft when changing cores and applies managed credentials only explicitly", async () => {
    const core = {
      ...instances[2],
      adapterId: "routeweaver/managed-xray",
      version: "26.3.27-rw1",
    };
    const writes = inventoryAPI({ cores: [...instances.slice(0, 2), core] });
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Tokyo" }));
    await user.click(
      screen.getByRole("button", { name: "为 Tokyo primary 添加监听端点" }),
    );
    const editor = within(
      await screen.findByRole("dialog", { name: "添加监听端点" }),
    );
    await user.type(editor.getByLabelText("端点名称"), "Draft listener");
    await user.clear(editor.getByLabelText("端口"));
    await user.type(editor.getByLabelText("端口"), "5678");
    await user.type(editor.getByLabelText("用户名"), "draft-user");
    await user.type(editor.getByLabelText("密码"), "draft-password");
    fireEvent.click(editor.getByLabelText("所属核心"));
    await user.click(
      await screen.findByText("Tokyo secondary", {
        selector: "[cmdk-item] span",
      }),
    );
    expect(editor.getByText("SOCKS5")).toBeTruthy();
    expect((editor.getByLabelText("用户名") as HTMLInputElement).value).toBe(
      "draft-user",
    );
    expect((editor.getByLabelText("端口") as HTMLInputElement).value).toBe(
      "5678",
    );
    await user.click(
      editor.getByRole("button", {
        name: "改用 VLESS 用户凭据模式（替换当前认证）",
      }),
    );
    expect(editor.getByText("VLESS")).toBeTruthy();
    expect(editor.queryByLabelText("用户 UUID")).toBeNull();
    await user.click(editor.getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].value).toMatchObject({
      instanceId: core.id,
      authentication: "principals",
      connection: { protocol: "vless", port: 5678 },
    });
    expect(writes[0].value.connection).not.toHaveProperty("username");
    expect(writes[0].value.connection).not.toHaveProperty("password");
  });

  it("preserves an existing incompatible protocol instead of silently applying the creation preset", async (context) => {
    const owner = ownedClickScenario(context);
    owner.assertActive();
    const core = {
      ...instances[2],
      adapterId: "routeweaver/managed-xray",
      version: "26.3.27-rw1",
    };
    const endpoint: ManagedEndpoint = {
      id: "legacy-managed",
      name: "Legacy listener",
      instanceId: core.id,
      connection: {
        protocol: "socks",
        host: "0.0.0.0",
        port: 9876,
        username: "existing",
        password: "existing-password",
      },
    };
    const writes = inventoryAPI({
      cores: [...instances.slice(0, 2), core],
      endpoints: [endpoint],
    });
    mount();
    const user = userEvent.setup();
    const listenerTab = await screen.findByRole("tab", { name: "监听端点 1" });
    owner.assertActive();
    await user.click(listenerTab);
    owner.assertActive();
    await user.click(screen.getByRole("button", { name: /编\s*辑/ }));
    owner.assertActive();
    const editor = within(
      await screen.findByRole("dialog", { name: "编辑监听端点" }),
    );
    owner.assertActive();
    expect(editor.getByText("SOCKS5")).toBeTruthy();
    expect(
      editor.queryByRole("button", {
        name: "改用 VLESS 用户凭据模式（替换当前认证）",
      }),
    ).toBeNull();
    await user.clear(editor.getByLabelText("端点名称"));
    owner.assertActive();
    await user.type(editor.getByLabelText("端点名称"), "Renamed legacy");
    owner.assertActive();
    await user.click(editor.getByRole("button", { name: /保\s*存/ }));
    owner.assertActive();
    await waitFor(() => expect(writes).toHaveLength(1));
    owner.assertActive();
    expect(writes[0].value.connection).toEqual(endpoint.connection);
    expect(writes[0].value.authentication).toBeUndefined();
  });

  it("blocks changing connection details on an incompatible existing managed listener", async () => {
    const core = {
      ...instances[2],
      adapterId: "routeweaver/managed-xray",
      version: "26.3.27-rw1",
    };
    const endpoint: ManagedEndpoint = {
      id: "legacy-managed",
      name: "Legacy listener",
      instanceId: core.id,
      connection: {
        protocol: "socks",
        host: "0.0.0.0",
        port: 9876,
        username: "existing",
        password: "existing-password",
      },
    };
    const writes = inventoryAPI({
      cores: [...instances.slice(0, 2), core],
      endpoints: [endpoint],
    });
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "监听端点 1" }));
    await user.click(screen.getByRole("button", { name: /编\s*辑/ }));
    const editor = within(
      await screen.findByRole("dialog", { name: "编辑监听端点" }),
    );
    expect(editor.getByText(/这不代表此监听端点可部署/)).toBeTruthy();
    await user.clear(editor.getByLabelText("监听 IP"));
    await user.type(editor.getByLabelText("监听 IP"), "127.0.0.1");
    await user.click(editor.getByRole("button", { name: /保\s*存/ }));
    expect(
      await editor.findByText(
        "此托管核心的监听端点仅支持 VLESS，请明确改为 VLESS",
      ),
    ).toBeTruthy();
    expect(writes).toHaveLength(0);
    expect((editor.getByLabelText("用户名") as HTMLInputElement).value).toBe(
      "existing",
    );
  });

  it.each([
    ["routeweaver/managed-xray", "future-version"],
    ["vendor/future-core", "26.3.27-rw1"],
  ])(
    "does not guess a managed preset for %s at %s",
    async (adapterId, version) => {
      const core = { ...instances[2], adapterId, version };
      inventoryAPI({ cores: [...instances.slice(0, 2), core] });
      mount();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Tokyo" }));
      await user.click(
        screen.getByRole("button", { name: "为 Tokyo secondary 添加监听端点" }),
      );
      const editor = within(
        await screen.findByRole("dialog", { name: "添加监听端点" }),
      );
      expect(editor.getByText("SOCKS5")).toBeTruthy();
      expect(editor.getByLabelText("用户名")).toBeTruthy();
      expect(editor.queryByText("此核心使用 VLESS 按用户分配凭据")).toBeNull();
    },
  );

  it("suspends host detail while editing and restores it after cancel", async () => {
    inventoryAPI();
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Tokyo" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Tokyo" })).getByRole(
        "button",
        { name: "添加核心" },
      ),
    );
    const editor = within(
      await screen.findByRole("dialog", { name: "添加核心实例" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Tokyo" })).toBeNull(),
    );
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await user.click(editor.getByRole("button", { name: /取\s*消/ }));
    const restored = within(
      await screen.findByRole("dialog", { name: "Tokyo" }),
    );
    expect(restored.getByText("Tokyo secondary")).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "添加核心实例" })).toBeNull(),
    );
  });

  it("restores the exact host action after nested discard and then its page opener", async () => {
    const writes = inventoryAPI();
    mount();
    const user = userEvent.setup();
    const pageOpener = await screen.findByRole("button", { name: "Tokyo" });
    await user.click(pageOpener);
    const actionName = "为 Tokyo secondary 添加监听端点";
    await user.click(screen.getByRole("button", { name: actionName }));
    const editor = await screen.findByRole("dialog", { name: "添加监听端点" });
    await user.type(
      within(editor).getByLabelText("端点名称"),
      "Unsaved nested endpoint",
    );
    await user.click(within(editor).getByRole("button", { name: "关闭" }));
    let confirm = await screen.findByRole("alertdialog", {
      name: "放弃尚未保存的配置修改？",
    });
    await user.click(within(confirm).getByRole("button", { name: "继续编辑" }));
    expect(
      (within(editor).getByLabelText("端点名称") as HTMLInputElement).value,
    ).toBe("Unsaved nested endpoint");
    await user.click(within(editor).getByRole("button", { name: "关闭" }));
    confirm = await screen.findByRole("alertdialog", {
      name: "放弃尚未保存的配置修改？",
    });
    await user.click(within(confirm).getByRole("button", { name: "放弃修改" }));
    const host = await screen.findByRole("dialog", { name: "Tokyo" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(host).getByRole("button", { name: actionName }),
      ),
    );
    expect(writes).toHaveLength(0);
    await user.click(within(host).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(document.activeElement).toBe(pageOpener));
  });

  it("starts a new server with core setup before optional operations", async () => {
    const writes = inventoryAPI();
    mount();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Empty server" }),
    );
    const drawer = within(screen.getByRole("dialog", { name: "Empty server" }));
    expect(drawer.getByText("先添加核心，再配置监听端点")).toBeTruthy();
    expect(drawer.queryByText("尚未收到服务器资源数据")).toBeNull();
    expect(drawer.queryByText("先登记测试目标")).toBeNull();
    const add = drawer.getByRole("button", { name: "添加核心" });
    expect(add.getAttribute("data-variant")).toBe("default");
    await user.click(add);
    await user.click(
      within(
        await screen.findByRole("dialog", { name: "添加核心实例" }),
      ).getByRole("button", { name: /保\s*存/ }),
    );
    await waitFor(() => expect(writes[0]?.value.hostId).toBe("host-empty"));
    expect(
      await within(
        await screen.findByRole("dialog", { name: "Empty server" }),
      ).findByRole("button", { name: "为 sing-box 添加监听端点" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: "服务器 3", hidden: true })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("adds a listener directly to the chosen core without losing server context", async () => {
    const writes = inventoryAPI();
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Tokyo" }));
    const drawer = within(screen.getByRole("dialog", { name: "Tokyo" }));
    expect(drawer.getByText("Tokyo primary")).toBeTruthy();
    expect(drawer.getByText("Tokyo secondary")).toBeTruthy();
    expect(drawer.getAllByRole("button", { name: /查\s*看/ })).toHaveLength(2);
    await user.click(
      drawer.getByRole("button", { name: "为 Tokyo secondary 添加监听端点" }),
    );
    const editor = within(
      await screen.findByRole("dialog", { name: "添加监听端点" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Tokyo" })).toBeNull(),
    );
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(editor.getByText("Tokyo")).toBeTruthy();
    expect(editor.getByText("Tokyo secondary")).toBeTruthy();
    await user.type(editor.getByLabelText("端点名称"), "Secondary listener");
    await user.type(editor.getByLabelText("用户名"), "fixture");
    await user.type(editor.getByLabelText("密码"), "fixture-password");
    await user.click(editor.getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => expect(writes[0]?.value.instanceId).toBe("core-tyo-2"));
    expect(screen.getByRole("dialog", { name: "Tokyo" })).toBeTruthy();
    expect(writes[0]?.value).not.toHaveProperty("endpointHostId");
  });

  it("keeps resource configuration and connection diagnostics reachable below setup", async () => {
    inventoryAPI();
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Tokyo" }));
    const drawer = within(screen.getByRole("dialog", { name: "Tokyo" }));
    await user.click(
      drawer.getByRole("button", { name: "资源、额度与连接诊断" }),
    );
    expect(
      await drawer.findByRole("button", { name: "设置采集与额度" }),
    ).toBeTruthy();
    expect(
      drawer.getByRole("button", { name: "刷新服务器资源数据" }),
    ).toBeTruthy();
    await user.click(drawer.getByRole("tab", { name: "连接诊断" }));
    expect(
      await drawer.findByRole("button", { name: "登记测试目标" }),
    ).toBeTruthy();
    expect(
      drawer.getByRole("button", { name: "新建测试" }).hasAttribute("disabled"),
    ).toBe(true);
    await user.click(drawer.getByRole("button", { name: "技术标识" }));
    expect(drawer.getByText("服务器 ID：host-tyo")).toBeTruthy();
  });

  it("shows real resource failures when opening operations", async () => {
    inventoryAPI({ observationError: true });
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Tokyo" }));
    const drawer = within(screen.getByRole("dialog", { name: "Tokyo" }));
    await user.click(
      drawer.getByRole("button", { name: "资源、额度与连接诊断" }),
    );
    expect(await drawer.findByText("资源数据暂时不可用")).toBeTruthy();
    expect(drawer.queryByText("尚未收到服务器资源数据")).toBeNull();
  });

  it("keeps the selected server when adding its core from the server detail", async () => {
    const writes = inventoryAPI();
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Tokyo" }));
    await user.click(await screen.findByRole("button", { name: "添加核心" }));
    await user.click(
      within(
        await screen.findByRole("dialog", { name: "添加核心实例" }),
      ).getByRole("button", { name: /保\s*存/ }),
    );
    await waitFor(() => expect(writes[0]?.value.hostId).toBe("host-tyo"));
  });

  it("selects an endpoint core only from its chosen server and clears it when the server changes", async () => {
    const writes = inventoryAPI();
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "监听端点 0" }));
    await user.click(
      screen.getAllByRole("button", { name: "添加监听端点" })[0],
    );
    await user.type(screen.getByLabelText("端点名称"), "Tokyo endpoint");
    await user.type(screen.getByLabelText("用户名"), "fixture");
    await user.type(screen.getByLabelText("密码"), "fixture-password");
    fireEvent.click(screen.getByLabelText("所属服务器"));
    await user.click(
      await screen.findByText("Tokyo", {
        selector: "[cmdk-item] span",
      }),
    );
    fireEvent.click(screen.getByLabelText("所属核心"));
    expect(
      screen.queryByText(/FRA primary/, {
        selector: "[cmdk-item] span",
      }),
    ).toBeNull();
    await user.click(
      await screen.findByText(/Tokyo secondary/, {
        selector: "[cmdk-item] span",
      }),
    );
    fireEvent.click(screen.getByLabelText("所属服务器"));
    await user.click(
      await screen.findByText("Frankfurt", {
        selector: "[cmdk-item] span",
      }),
    );
    await user.click(screen.getByRole("button", { name: /保\s*存/ }));
    expect(await screen.findByText("请选择这台服务器上的核心")).toBeTruthy();
    expect(writes).toHaveLength(0);
    fireEvent.click(screen.getByLabelText("所属服务器"));
    await user.click(
      await screen.findByText("Tokyo", {
        selector: "[cmdk-item] span",
      }),
    );
    fireEvent.click(screen.getByLabelText("所属核心"));
    await user.click(
      await screen.findByText(/Tokyo secondary/, {
        selector: "[cmdk-item] span",
      }),
    );
    await user.click(screen.getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].value.instanceId).toBe("core-tyo-2");
    expect(writes[0].value).not.toHaveProperty("endpointHostId");
    expect(writes[0].value).not.toHaveProperty("hostId");
  });

  it("preserves an existing endpoint's exact core identity when several cores share a server", async () => {
    const endpoint: ManagedEndpoint = {
      id: "endpoint-legacy",
      instanceId: "core-tyo-2",
      name: "Existing endpoint",
      connection: {
        host: "0.0.0.0",
        port: 1080,
        protocol: "socks",
        username: "fixture",
        password: "fixture-password",
      },
    };
    const writes = inventoryAPI({ endpoints: [endpoint] });
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "监听端点 1" }));
    await user.click(screen.getByRole("button", { name: /编\s*辑/ }));
    const dialog = await screen.findByRole("dialog", { name: "编辑监听端点" });
    expect(
      within(dialog).getByText("Tokyo", { selector: "[role=combobox] span" }),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("Tokyo secondary", {
        selector: "[role=combobox] span",
      }),
    ).toBeTruthy();
    await user.clear(screen.getByLabelText("端点名称"));
    await user.type(screen.getByLabelText("端点名称"), "Renamed endpoint");
    await user.click(within(dialog).getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      path: "/api/managed-endpoints/endpoint-legacy",
      value: { ...endpoint, name: "Renamed endpoint" },
    });
  });

  it("renames a principal-authenticated listener without inventing shared credentials", async () => {
    const endpoint = {
      id: "endpoint-principals",
      instanceId: "core-tyo-2",
      name: "Public listener",
      authentication: "principals",
      connection: {
        host: "0.0.0.0",
        port: 443,
        protocol: "vless",
        tls: { enabled: true, serverName: "entry.example.com" },
        transport: { type: "ws", path: "/entry" },
      },
    };
    const writes = inventoryAPI({ endpoints: [endpoint] });
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "监听端点 1" }));
    await user.click(screen.getByRole("button", { name: /编\s*辑/ }));
    const dialog = await screen.findByRole("dialog", { name: "编辑监听端点" });
    await user.clear(screen.getByLabelText("端点名称"));
    await user.type(
      screen.getByLabelText("端点名称"),
      "Renamed public listener",
    );
    await user.click(within(dialog).getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      path: "/api/managed-endpoints/endpoint-principals",
      value: { ...endpoint, name: "Renamed public listener" },
    });
  });

  it("still edits a legacy VLESS UUID and preserves unopened TLS settings", async () => {
    const endpoint: ManagedEndpoint = {
      id: "endpoint-vless",
      instanceId: "core-tyo-2",
      name: "Legacy VLESS",
      connection: {
        host: "0.0.0.0",
        port: 443,
        protocol: "vless",
        uuid: "00000000-0000-4000-8000-000000000001",
        flow: "xtls-rprx-vision",
        tls: { enabled: true, serverName: "legacy.example.com" },
      },
    };
    const writes = inventoryAPI({ endpoints: [endpoint] });
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "监听端点 1" }));
    await user.click(screen.getByRole("button", { name: /编\s*辑/ }));
    const dialog = await screen.findByRole("dialog", { name: "编辑监听端点" });
    await user.clear(within(dialog).getByLabelText("用户 UUID"));
    await user.click(within(dialog).getByRole("button", { name: /保\s*存/ }));
    await waitFor(() =>
      expect(dialog.querySelector("[data-slot=field-error]")).toBeTruthy(),
    );
    expect(writes).toHaveLength(0);
    await user.type(
      within(dialog).getByLabelText("用户 UUID"),
      "00000000-0000-4000-8000-000000000002",
    );
    await user.click(within(dialog).getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      path: "/api/managed-endpoints/endpoint-vless",
      value: {
        ...endpoint,
        connection: {
          ...endpoint.connection,
          uuid: "00000000-0000-4000-8000-000000000002",
        },
      },
    });
  });

  it("keeps empty servers visible and explains how to add a core", async () => {
    const writes = inventoryAPI();
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "监听端点 0" }));
    await user.click(
      screen.getAllByRole("button", { name: "添加监听端点" })[0],
    );
    fireEvent.click(screen.getByLabelText("所属服务器"));
    await user.click(
      await screen.findByText("Empty server", {
        selector: "[cmdk-item] span",
      }),
    );
    expect(
      (screen.getByLabelText("所属核心") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      screen.getByText("这台服务器还没有核心，请先在服务器详情中添加核心。"),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /保\s*存/ }));
    expect(await screen.findByText("请选择这台服务器上的核心")).toBeTruthy();
    expect(writes).toHaveLength(0);
  });

  it("disambiguates same-named cores without merging their identities", async () => {
    inventoryAPI({
      cores: instances.map((i) =>
        i.hostId === "host-tyo" ? { ...i, name: "Tokyo Xray" } : i,
      ),
    });
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "监听端点 0" }));
    await user.click(
      screen.getAllByRole("button", { name: "添加监听端点" })[0],
    );
    fireEvent.click(screen.getByLabelText("所属服务器"));
    await user.click(
      await screen.findByText("Tokyo", {
        selector: "[cmdk-item] span",
      }),
    );
    fireEvent.click(screen.getByLabelText("所属核心"));
    expect(
      await screen.findByText("Tokyo Xray · core-tyo-1", {
        selector: "[cmdk-item] span",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText("Tokyo Xray · core-tyo-2", {
        selector: "[cmdk-item] span",
      }),
    ).toBeTruthy();
  });

  it("preserves unknown adapters and existing versions when editing a core name", async () => {
    const core = {
      ...instances[2],
      name: "Future core",
      adapterId: "vendor/future-core",
      version: "custom-7.2",
    };
    const writes = inventoryAPI({ cores: [...instances.slice(0, 2), core] });
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "核心实例 3" }));
    await user.click(screen.getByRole("button", { name: "编辑 Future core" }));
    await user.clear(screen.getByLabelText("实例名称"));
    await user.type(screen.getByLabelText("实例名称"), "Renamed future core");
    await user.click(screen.getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      path: "/api/core-instances/core-tyo-2",
      value: { ...core, name: "Renamed future core" },
    });
  });

  it("does not silently reassign an endpoint whose original core has been removed", async () => {
    const endpoint: ManagedEndpoint = {
      id: "endpoint-orphan",
      instanceId: "core-removed",
      name: "Orphan endpoint",
      connection: {
        host: "0.0.0.0",
        port: 1080,
        protocol: "socks",
        username: "fixture",
        password: "fixture-password",
      },
    };
    const writes = inventoryAPI({ endpoints: [endpoint] });
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "监听端点 1" }));
    await user.click(screen.getByRole("button", { name: /编\s*辑/ }));
    expect(
      await screen.findByText("原核心已移除，请重新选择服务器和核心。"),
    ).toBeTruthy();
    expect(
      screen.getByText("核心已移除 · core-removed", {
        selector: "[role=combobox] span",
      }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /保\s*存/ }));
    expect(
      await screen.findByText("请先选择服务器", {
        selector: "[data-slot=field-error]",
      }),
    ).toBeTruthy();
    expect(writes).toHaveLength(0);
  });
});

it.each([
  {
    kind: "hosts",
    title: "编辑服务器",
    opener: "编辑服务器 Frankfurt",
    label: "服务器名称",
    value: "Frankfurt",
  },
  {
    kind: "core-instances",
    title: "编辑核心实例",
    opener: "编辑 FRA primary",
    label: "实例名称",
    value: "FRA primary",
  },
])(
  "retains the $kind editor while its exit animation is mounted",
  async ({ kind, title, opener, label, value }) => {
    // Model the live computed-style contract absent from JSDOM while exercising
    // the actual Radix Presence lifecycle, rather than mocking the dialog.
    const computedStyle = window.getComputedStyle.bind(window);
    const styleSpy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element, pseudo) => {
        const style = computedStyle(element, pseudo);
        if (element.matches('[data-task-overlay="dialog"]'))
          Object.defineProperty(style, "animationName", {
            configurable: true,
            get: () =>
              element.getAttribute("data-state") === "closed"
                ? "inventory-exit"
                : "none",
          });
        return style;
      });
    vi.stubGlobal("CSS", { escape: (name: string) => name });
    try {
      const writes = inventoryAPI();
      mount();
      await screen.findByRole("button", { name: "编辑服务器 Frankfurt" });
      if (kind === "core-instances")
        await userEvent.click(screen.getByRole("tab", { name: "核心实例 3" }));
      await userEvent.click(screen.getByRole("button", { name: opener }));
      const dialog = await screen.findByRole("dialog", { name: title });
      await userEvent.keyboard("{Escape}");
      expect(dialog.isConnected).toBe(true);
      expect(dialog.getAttribute("data-state")).toBe("closed");
      expect(within(dialog).getByRole("heading", { name: title })).toBeTruthy();
      expect(within(dialog).getByLabelText(label)).toHaveProperty(
        "value",
        value,
      );
      expect(within(dialog).queryByLabelText("端点名称")).toBeNull();
      fireEvent.submit(within(dialog).getByLabelText(label).closest("form")!);
      const event = new Event("animationend", { bubbles: true });
      Object.defineProperty(event, "animationName", {
        value: "inventory-exit",
      });
      fireEvent(dialog, event);
      await waitFor(() => expect(dialog.isConnected).toBe(false));
      expect(writes).toHaveLength(0);
    } finally {
      styleSpy.mockRestore();
    }
  },
);

it("does not reset a reopened inventory form when an old exit ends", async () => {
  const computedStyle = window.getComputedStyle.bind(window);
  const styleSpy = vi
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element, pseudo) => {
      const style = computedStyle(element, pseudo);
      if (element.matches('[data-task-overlay="dialog"]'))
        Object.defineProperty(style, "animationName", {
          configurable: true,
          get: () =>
            element.getAttribute("data-state") === "closed"
              ? "inventory-exit"
              : "none",
        });
      return style;
    });
  vi.stubGlobal("CSS", { escape: (name: string) => name });
  const finishExit = (dialog: HTMLElement) => {
    const event = new Event("animationend", { bubbles: true });
    Object.defineProperty(event, "animationName", { value: "inventory-exit" });
    fireEvent(dialog, event);
  };
  try {
    const writes = inventoryAPI();
    mount();
    const frankfurt = await screen.findByRole("button", {
      name: "编辑服务器 Frankfurt",
    });
    const tokyo = screen.getByRole("button", { name: "编辑服务器 Tokyo" });
    await userEvent.click(frankfurt);
    const closing = await screen.findByRole("dialog", { name: "编辑服务器" });
    await userEvent.keyboard("{Escape}");
    expect(closing.getAttribute("data-state")).toBe("closed");
    // Model the owner's new-task transition while the old fading view is inert.
    fireEvent.click(tokyo);
    const reopened = await screen.findByRole("dialog", { name: "编辑服务器" });
    await waitFor(() =>
      expect(within(reopened).getByLabelText("服务器名称")).toHaveProperty(
        "value",
        "Tokyo",
      ),
    );
    finishExit(closing);
    expect(reopened.getAttribute("data-state")).toBe("open");
    expect(within(reopened).getByLabelText("服务器名称")).toHaveProperty(
      "value",
      "Tokyo",
    );
    expect(writes).toHaveLength(0);
    await userEvent.keyboard("{Escape}");
    expect(within(reopened).getByLabelText("服务器名称")).toHaveProperty(
      "value",
      "Tokyo",
    );
    finishExit(reopened);
    await waitFor(() => expect(reopened.isConnected).toBe(false));
  } finally {
    styleSpy.mockRestore();
  }
});

it("keeps enrollment expiry exact until date confirmation and blocks submission while its picker is open", async () => {
  const writes = inventoryAPI();
  mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: /核心实例/ }));
  await user.click(await screen.findByRole("button", { name: /^FRA primary/ }));
  await user.click(await screen.findByRole("button", { name: "接入 Agent" }));
  const enrollment = within(
    await screen.findByRole("dialog", { name: "接入核心实例" }),
  );
  const expiry = enrollment.getByLabelText("凭据到期时间") as HTMLInputElement;
  await waitFor(() => expect(expiry.value).not.toBe(""));
  expect(expiry.readOnly).toBe(true);
  expect(enrollment.getByText("UTC+8")).toBeTruthy();
  const originalDisplay = expiry.value;
  await user.click(expiry);
  const picker = within(
    await screen.findByRole("dialog", { name: "选择日期与时间" }),
  );
  fireEvent.change(picker.getByLabelText("时间（UTC+8）"), {
    target: { value: "12:34:56" },
  });
  expect(
    (
      enrollment.getByRole("button", {
        name: "创建接入凭据",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.submit(expiry.closest("form")!);
  expect(writes).toHaveLength(0);
  await user.click(picker.getByRole("button", { name: "取消" }));
  expect(expiry.value).toBe(originalDisplay);
  await user.click(enrollment.getByRole("button", { name: "创建接入凭据" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].path).toBe("/api/agent/enrollments");
  expect(writes[0].value.nodeId).toBe("host-fra");
  expect(writes[0].value.instanceId).toBe("core-fra-1");
  expect(String(writes[0].value.expiresAt)).toMatch(/\.\d{3}Z$/);
});

it("keeps inventory Close focus after twice canceling a dirty server draft", async () => {
  const writes = inventoryAPI();
  mount();
  await userEvent.click(await screen.findByRole("button", { name: "添加服务器" }));
  const dialog = await screen.findByRole("dialog", { name: "添加服务器" });
  const name = within(dialog).getByLabelText("服务器名称");
  fireEvent.change(name, { target: { value: "Retained server" } });
  const close = within(dialog).getByRole("button", { name: "关闭" });
  for (let attempt = 0; attempt < 2; attempt++) {
    await userEvent.click(close);
    const review = await screen.findByRole("alertdialog");
    await waitFor(() => expect(document.activeElement).toBe(within(review).getByRole("button", { name: "继续编辑" })));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect((name as HTMLInputElement).value).toBe("Retained server");
  }
  expect(writes).toEqual([]);
});
