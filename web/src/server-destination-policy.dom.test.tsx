// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ServerRoutesPage } from "./ServerRoutes";
import type { ServerDeployment, ServerProgram } from "./types";

const clients: QueryClient[] = [];
beforeEach(() => {
  history.replaceState(null, "", "/");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  const originalStyle = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    originalStyle(element),
  );
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
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openDestinationEditor(
  adapterId = "routeweaver/xray",
  version = "26.10.29",
  protocol = "vless",
  destinationPolicy?: ServerProgram["destinationPolicy"],
) {
  const instance = { id: "core", hostId: "host", adapterId, version };
  const listener = {
    id: "entry",
    instanceId: "core",
    name: "Entry",
    connection: { protocol, host: "127.0.0.1", port: 18443 },
  };
  const deployment: ServerDeployment = {
    id: "deployment",
    name: "Private service path",
    status: "draft",
    diagnostics: [],
    ir: {
      schemaVersion: "1.0",
      id: "deployment",
      topologyRevision: "v1",
      programs: [
        {
          instance,
          listener,
          egress: [],
          rules: [],
          resources: [],
          destinationPolicy,
        },
      ],
    },
  };
  const saved: ServerDeployment[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      let result: unknown = [];
      if (init?.method === "PUT") {
        const value = JSON.parse(init.body as string) as ServerDeployment;
        saved.push(value);
        result = value;
      } else if (path.endsWith("/hosts"))
        result = [{ id: "host", name: "Tokyo", address: "host.example" }];
      // Inventory may already have advanced; edit the saved program's version,
      // not whatever version happens to be current in inventory.
      else if (path.endsWith("/core-instances"))
        result = [
          {
            ...instance,
            version: adapterId === "routeweaver/xray" ? "26.10.29" : version,
          },
        ];
      else if (path.endsWith("/managed-endpoints")) result = [listener];
      else if (path.endsWith("/server-deployments")) result = [deployment];
      else if (path.endsWith("/server-deployments/deployment/reveal"))
        result = deployment;
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <ServerRoutesPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", {
      name: "编辑转发路径 Private service path",
    }),
  );
  const drawer = await screen.findByRole("dialog", {
    name: "编辑 Private service path",
  });
  await user.click(within(drawer).getByText("高级：内部目标访问例外"));
  const save = async () => {
    await user.click(within(drawer).getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    return saved[0].ir.programs[0];
  };
  return { user, drawer, save };
}

it.each(["vless", "vmess", "trojan", "shadowsocks"])(
  "saves a bounded private destination exception for current stock Xray %s",
  async (protocol) => {
    const { user, drawer, save } = await openDestinationEditor(
      "routeweaver/xray",
      "26.10.29",
      protocol,
    );
    await user.click(
      within(drawer).getByRole("combobox", {
        name: "Entry · 允许访问的内部网段",
      }),
    );
    await user.type(
      screen.getByRole("combobox", { name: "搜索选项" }),
      "127.0.0.1/32",
    );
    await user.click(screen.getByText("添加“127.0.0.1/32”"));
    await user.keyboard("{Escape}");
    const program = await save();
    expect(program.destinationPolicy).toEqual({ allowCidrs: ["127.0.0.1/32"] });
    expect(program.instance.version).toBe("26.10.29");
  },
);

it.each([
  ["routeweaver/xray", "26.3.27", "vless"],
  ["routeweaver/xray", "26.10.29", "socks"],
  ["routeweaver/sing-box", "1.14.4", "vless"],
])(
  "does not expose stock policy for unsupported saved target %s %s %s",
  async (adapter, version, protocol) => {
    const { drawer } = await openDestinationEditor(adapter, version, protocol);
    expect(
      within(drawer).queryByRole("combobox", {
        name: "Entry · 允许访问的内部网段",
      }),
    ).toBeNull();
    expect(within(drawer).queryByText(/留空保留默认限制/)).toBeNull();
  },
);

it.each([
  ["routeweaver/xray", "26.10.29"],
  ["routeweaver/managed-xray", "26.3.27-rw1"],
])(
  "removes the last explicit exception without a global allow for %s",
  async (adapter, version) => {
    const { user, drawer, save } = await openDestinationEditor(
      adapter,
      version,
      "vless",
      { allowCidrs: ["127.0.0.1/32"] },
    );
    await user.click(
      within(drawer).getByRole("button", { name: "移除 127.0.0.1/32" }),
    );
    const program = await save();
    expect(program.destinationPolicy).toBeUndefined();
    expect(program.instance.version).toBe(version);
  },
);
