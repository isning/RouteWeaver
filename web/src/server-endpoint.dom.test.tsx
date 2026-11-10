// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ServerEndpointSelect } from "./ServerEndpointSelect";
import type { Infrastructure } from "./types";

const inventory: Infrastructure = {
  hosts: [
    { id: "a", name: "Tokyo", address: "a.example" },
    { id: "b", name: "London", address: "b.example" },
  ],
  instances: [
    {
      id: "core-a",
      hostId: "a",
      adapterId: "routeweaver/sing-box",
      name: "Primary",
      version: "1",
    },
    {
      id: "core-a2",
      hostId: "a",
      adapterId: "routeweaver/sing-box",
      name: "Secondary",
      version: "1",
    },
    { id: "core-b", hostId: "b", adapterId: "routeweaver/xray", version: "1" },
  ],
  endpoints: [
    {
      id: "a1",
      name: "Entry",
      instanceId: "core-a",
      connection: { protocol: "socks", host: "0.0.0.0", port: 1080 },
    },
    {
      id: "a2",
      name: "Entry",
      instanceId: "core-a2",
      connection: { protocol: "socks", host: "0.0.0.0", port: 1080 },
    },
    {
      id: "b1",
      name: "Exit",
      instanceId: "core-b",
      connection: { protocol: "socks", host: "0.0.0.0", port: 1081 },
    },
  ],
  links: [],
  deployments: [],
};
function Editor({
  initial = "a2",
  allowed = inventory.endpoints.map((e) => e.id),
}: {
  initial?: string;
  allowed?: string[];
}) {
  const [value, setValue] = useState(initial);
  const [pending, setPending] = useState(false);
  return (
    <>
      <ServerEndpointSelect
        inventory={inventory}
        value={value}
        label="入口"
        allowedIds={allowed}
        onChange={setValue}
        onPendingChange={setPending}
      />
      <output aria-label="saved endpoint">{value}</output>
      <button disabled={pending}>Save</button>
    </>
  );
}
beforeEach(() => {
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
  try {
    cleanup();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
it("preserves the exact existing endpoint and clears incompatible selection when changing server without silently remapping", async () => {
  const user = userEvent.setup();
  render(<Editor />);
  expect(
    screen.getByRole("combobox", { name: "入口服务器" }).getAttribute("value"),
  ).not.toBe("b");
  expect(screen.getByText(/Secondary/)).toBeTruthy();
  await user.click(screen.getByRole("combobox", { name: "入口服务器" }));
  await user.click(screen.getByText("London"));
  expect(screen.queryByText(/Secondary/)).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByLabelText("saved endpoint").textContent).toBe("a2");
  await user.click(screen.getByRole("combobox", { name: "入口端点" }));
  await user.click(screen.getByRole("option", { name: /Exit socks:1081 xray/ }));
  expect(screen.getByLabelText("saved endpoint").textContent).toBe("b1");
  expect(
    (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

it("keeps two same-core endpoints distinct and does not remap when cancelling a server change", async () => {
  const user = userEvent.setup();
  render(<Editor />);
  await user.click(screen.getByRole("combobox", { name: "入口服务器" }));
  await user.click(screen.getByText("London"));
  await user.click(screen.getByRole("combobox", { name: "入口服务器" }));
  await user.click(screen.getByText("Tokyo"));
  expect(screen.getByText(/Secondary/)).toBeTruthy();
  expect(screen.getByLabelText("saved endpoint").textContent).toBe("a2");
  expect(
    (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  await user.click(screen.getByRole("combobox", { name: "入口端点" }));
  await user.click(screen.getByText(/Primary/));
  expect(screen.getByLabelText("saved endpoint").textContent).toBe("a1");
});

it("retains an unavailable current endpoint visibly without bypassing the caller's role filter", async () => {
  const user = userEvent.setup();
  render(<Editor allowed={["a1"]} />);
  expect(screen.getByRole("combobox", { name: "入口端点" }).textContent).toContain("当前不可选");
  expect(screen.getByRole("combobox", { name: "入口端点" }).textContent).toContain("Secondary");
  expect(
    (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await user.click(screen.getByRole("combobox", { name: "入口端点" }));
  await user.click(screen.getByText(/Primary/));
  expect(screen.getByLabelText("saved endpoint").textContent).toBe("a1");
});

it("preserves a deleted endpoint as unavailable, rather than substituting the first available endpoint", () => {
  render(<Editor initial="deleted" />);
  expect(screen.getByText("原端点（当前不可用）")).toBeTruthy();
  expect(screen.getByLabelText("saved endpoint").textContent).toBe("deleted");
  expect(
    (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

// Exercise the page seam as well as the reusable control: unresolved selection must
// never save the old endpoint, and selected endpoint credentials are explicitly revealed.
import { ConfirmationProvider } from "@/ui-patterns/confirmations";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ServerRoutesPage } from "./ServerRoutes";
import { compilePath } from "./infrastructure-model";
import type { ServerDeployment } from "./types";
import { waitFor, within } from "@testing-library/react";

it("blocks saving an unfinished server change and saves the explicitly selected endpoint identity", async () => {
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
  const base: ServerDeployment = {
    id: "deployment",
    name: "Office path",
    status: "draft",
    diagnostics: [],
    ir: {
      schemaVersion: "1.0",
      id: "deployment",
      topologyRevision: "v1",
      programs: [],
    },
  };
  // This page exercises a real path rewrite, unlike the version-agnostic
  // endpoint control fixtures above. Use the supported adapter versions.
  const supportedInventory = {
    ...inventory,
    instances: inventory.instances.map(instance => ({
      ...instance, version: instance.adapterId === "routeweaver/xray" ? "26.10.31" : "1.14.4",
    })),
  };
  const deployment = compilePath(base, ["a2"], supportedInventory);
  deployment.ir.programs[0].resources = [];
  const data = { ...supportedInventory, deployments: [deployment] };
  const saved: ServerDeployment[] = [];
  const reveals: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      let result: unknown = [];
      if (path.endsWith("/hosts")) result = data.hosts;
      else if (path.endsWith("/core-instances")) result = data.instances;
      else if (path.endsWith("/managed-endpoints")) result = data.endpoints;
      else if (path.endsWith("/server-deployments")) result = data.deployments;
      else if (path.endsWith("/server-deployments/deployment/reveal"))
        result = deployment;
      else if (path.endsWith("/managed-endpoints/b1/reveal")) {
        reveals.push("b1");
        result = data.endpoints[2];
      } else if (init?.method === "PUT") {
        const value = JSON.parse(init.body as string);
        saved.push(value);
        result = value;
      }
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ConfirmationProvider>
        
          <ServerRoutesPage />
        
      </ConfirmationProvider>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "编辑转发路径 Office path" }),
  );
  const drawer = await screen.findByRole("dialog", {
    name: "编辑 Office path",
  });
  await user.click(within(drawer).getByRole("button", { name: "配置第 1 跳 Entry" }));
  await user.click(
    within(drawer).getByRole("combobox", { name: "第 1 跳服务器" }),
  );
  await user.click(screen.getByText("London"));
  expect(
    (
      within(drawer).getByRole("button", {
        name: "保存草稿",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(saved).toEqual([]);
  await user.click(
    within(drawer).getByRole("combobox", { name: "第 1 跳端点" }),
  );
  await user.click(screen.getByRole("option", { name: /Exit socks:1081 xray/ }));
  await waitFor(() =>
    expect(
      (
        within(drawer).getByRole("button", {
          name: "保存草稿",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  await user.click(within(drawer).getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(reveals).toEqual(["b1"]);
  expect(saved[0].ir.programs[0].listener.id).toBe("b1");
  expect(saved[0].ir.programs[0].instance.id).toBe("core-b");
});

import { PublishedRoutesPage } from "./PublishedRoutes";
it("limits public-path selection to its deployment and blocks an unfinished server change after preview", async () => {
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
  const base: ServerDeployment = {
    id: "deployment",
    name: "Office path",
    status: "draft",
    diagnostics: [],
    ir: {
      schemaVersion: "1.0",
      id: "deployment",
      topologyRevision: "v1",
      programs: [],
    },
  };
  const deployment = compilePath(base, ["a2"], inventory);
  const route = {
    id: "public",
    name: "Office",
    deploymentId: "deployment",
    endpointIds: ["a2"],
    publicHost: "public.example",
    publicPort: 1080,
    status: "draft",
    diagnostics: [],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      const result = path.endsWith("/hosts")
        ? inventory.hosts
        : path.endsWith("/core-instances")
          ? inventory.instances
          : path.endsWith("/managed-endpoints")
            ? inventory.endpoints
            : path.endsWith("/server-deployments")
              ? [deployment]
              : path.endsWith("/published-routes")
                ? [route]
                : path.endsWith("/preview")
                  ? route
                  : [];
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ConfirmationProvider>
        
          <PublishedRoutesPage />
        
      </ConfirmationProvider>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "编辑" }));
  const drawer = await screen.findByRole("dialog", { name: "编辑 Office" });
  await user.click(
    within(drawer).getByRole("button", { name: "检查公开线路" }),
  );
  await waitFor(() =>
    expect(
      (
        within(drawer).getByRole("button", {
          name: "保存公开线路",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  await user.click(
    within(drawer).getByRole("button", {
      name: "调整公开范围（仅当需要使用路径的一部分）",
    }),
  );
  await user.click(
    within(drawer).getByRole("combobox", { name: "公开路径第 1 跳服务器" }),
  );
  await user.click(screen.getByText("London"));
  // A server choice is an edit even before its endpoint is selected. It
  // invalidates the old preview rather than retaining a stale save action.
  expect(within(drawer).queryByRole("button", { name: "保存公开线路" })).toBeNull();
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  expect(
    (
      within(drawer).getByRole("button", {
        name: "检查公开线路",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await user.click(
    within(drawer).getByRole("combobox", { name: "公开路径第 1 跳端点" }),
  );
  expect(await screen.findByText("此服务器暂无可选端点")).toBeTruthy();
  expect(screen.queryByRole("option", { name: /Exit socks/ })).toBeNull();
});

it("does not silently rebind an edited route when its inventory endpoint owner changed", () => {
  const changed = {
    ...inventory,
    endpoints: inventory.endpoints.map((endpoint) =>
      endpoint.id === "a2" ? { ...endpoint, instanceId: "core-b" } : endpoint,
    ),
  };
  const pending = vi.fn();
  render(
    <ServerEndpointSelect
      inventory={changed}
      value="a2"
      label="入口"
      allowedIds={["a2"]}
      current={{ endpoint: inventory.endpoints[1], hostId: "a" }}
      onChange={() => {
        throw new Error("must not remap");
      }}
      onPendingChange={pending}
    />,
  );
  expect(screen.getByText("Tokyo")).toBeTruthy();
  expect(screen.getByText("Entry（当前不可用）")).toBeTruthy();
  expect(pending).toHaveBeenLastCalledWith(true);
});

it("uses retained labels only in opted-in saved route editors while choices and other callers remain current", async () => {
  const user = userEvent.setup();
  const current = {
    endpoint: {
      ...inventory.endpoints[2],
      connection: { ...inventory.endpoints[2].connection, port: 1080 },
    },
    hostId: "b",
  };
  const props = {
    inventory,
    value: "b1",
    label: "入口",
    current,
    allowedIds: ["b1"],
    onChange: vi.fn(),
    onPendingChange: vi.fn(),
  };
  const view = render(<ServerEndpointSelect {...props} />);
  expect(screen.getByText("socks:1081 xray")).toBeTruthy();
  expect(screen.queryByText(/1080.*草稿/)).toBeNull();
  view.rerender(<ServerEndpointSelect {...props} displayCurrentSnapshot />);
  expect(screen.getByText("Exit（草稿）")).toBeTruthy();
  expect(screen.getByText("socks:1080 xray")).toBeTruthy();
  await user.click(screen.getByRole("combobox", { name: "入口端点" }));
  expect(screen.getByText("socks:1081 xray")).toBeTruthy();
  expect(props.onChange).not.toHaveBeenCalled();
});
