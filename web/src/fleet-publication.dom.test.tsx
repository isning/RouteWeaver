// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { render, cleanup, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { FleetPage, FleetPlanForm } from "./Fleet";
import type { Infrastructure } from "./types";
const instance = {
  id: "core",
  name: "Office core",
  hostId: "host",
  adapterId: "routeweaver/xray",
  version: "26.3.27",
};
const listener = {
  id: "entry",
  instanceId: "core",
  name: "Office entry",
  connection: { protocol: "socks", host: "0.0.0.0", port: 1080 },
};
const inventory = {
  hosts: [{ id: "host", name: "Office", address: "10.0.0.1" }],
  instances: [instance],
  endpoints: [listener],
  links: [],
  deployments: [
    {
      id: "office",
      name: "Office path",
      status: "draft",
      diagnostics: [],
      ir: {
        schemaVersion: "1.0",
        id: "office",
        topologyRevision: "1",
        programs: [
          { instance, listener, egress: [], rules: [], resources: [] },
        ],
      },
    },
  ],
} as Infrastructure;
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
let client: QueryClient;
let calls: { url: string; body: unknown }[];
beforeEach(() => {
  calls = [];
  vi.stubEnv("NODE_ENV", "development");
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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    original(element),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith("/preview"))
        return json({
          fingerprint: "preview",
          supported: true,
          targets: [],
          diagnostics: [],
          affectedUsers: 0,
        });
      const keys: Record<string, unknown> = {
        hosts: inventory.hosts,
        "core-instances": inventory.instances,
        "managed-endpoints": inventory.endpoints,
        "server-deployments": inventory.deployments,
      };
      return json(keys[url.split("/").at(-1)!] || []);
    }),
  );
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function mount(node: React.ReactNode) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>{node}</UIProviders>
    </QueryClientProvider>,
  );
}
it("removes reviewed configure proof when a direct request becomes pending, retaining target input and requiring a new preview", async () => {
  function Task() {
    const [pending, setPending] = useState<string>();
    return (
      <>
        <button onClick={() => setPending("office")}>
          Observe pending direct request
        </button>
        <button onClick={() => setPending(undefined)}>
          Observe resolved receipt
        </button>
        <FleetPlanForm
          inventory={inventory}
          history={[]}
          initialDeploymentId="office"
          initialTargetIds={["core"]}
          pendingDeploymentId={pending}
          onClose={() => {}}
          onCreated={() => {}}
        />
      </>
    );
  }
  const user = userEvent.setup();
  mount(<Task />);
  await user.click(screen.getByRole("button", { name: "预览影响与差异" }));
  await user.click(
    await screen.findByRole("checkbox", {
      name: "我已核对实例、阶段与影响范围",
    }),
  );
  expect(
    (
      screen.getByRole("button", {
        name: "创建待执行批次",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  // Simulate an external direct-request update while the modal owns interaction.
  fireEvent.click(screen.getByText("Observe pending direct request"));
  expect(screen.queryByRole("button", { name: "创建待执行批次" })).toBeNull();
  expect(
    (
      screen.getByRole("button", {
        name: "预览影响与差异",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole("checkbox", {
        name: "选择实例 Office core",
      }) as HTMLInputElement
    ).getAttribute("aria-checked"),
    ).toBe("true");
  fireEvent.click(screen.getByText("Observe resolved receipt"));
  expect(
    (
      screen.getByRole("button", {
        name: "预览影响与差异",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(screen.queryByRole("button", { name: "创建待执行批次" })).toBeNull();
  expect(calls.filter((c) => c.url.endsWith("/preview"))).toHaveLength(1);
});
it("allows a deliberate stop preview while the same deployment direct configure request remains unresolved", async () => {
  const user = userEvent.setup();
  mount(
    <FleetPlanForm
      inventory={inventory}
      history={[]}
      initialDeploymentId="office"
      initialAction="stop"
      initialTargetIds={["core"]}
      pendingDeploymentId="office"
      onClose={() => {}}
      onCreated={() => {}}
    />,
  );
  await user.click(screen.getByRole("button", { name: "预览影响与差异" }));
  await screen.findByRole("checkbox", { name: "我已核对实例、阶段与影响范围" });
  expect(calls.find((c) => c.url.endsWith("/preview"))?.body).toMatchObject({
    action: "stop",
    deploymentId: "office",
  });
});
it("threads the pending target into the standalone Fleet planner rather than allowing configure through its deployment selector", async () => {
  const user = userEvent.setup();
  mount(<FleetPage pendingDeploymentId="office" />);
  await user.click(await screen.findByRole("button", { name: "计划变更" }));
  const selector = await screen.findByRole("combobox", {
    name: "批量变更转发路径",
  });
  await user.click(selector);
  const list = document.getElementById(
    selector.getAttribute("aria-controls") || "",
  );
  const popup = list?.closest<HTMLElement>("[data-slot=popover-content]");
  expect(popup).toBeTruthy();
  await user.click(
    await within(popup!).findByText("Office path", {
      selector: "[cmdk-item] span",
    }),
  );
  expect(
    await screen.findByText("此转发路径有提交结果待处理", { exact: true }),
  ).toBeTruthy();
  expect(
    (
      screen.getByRole("button", {
        name: "预览影响与差异",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    screen.getByRole("link", { name: "确认该次提交结果" }).getAttribute("href"),
  ).toBe("#routes?deployment=office");
  expect(calls.filter((c) => c.url.endsWith("/preview"))).toHaveLength(0);
});
it("keeps Stop available but disables switching its reviewed plan to Configure for the unresolved target", async () => {
  const user = userEvent.setup();
  mount(
    <FleetPlanForm
      inventory={inventory}
      history={[]}
      initialDeploymentId="office"
      initialTargetIds={["core"]}
      pendingDeploymentId="office"
      onClose={() => {}}
      onCreated={() => {}}
    />,
  );
  const action = screen.getByRole("combobox", { name: "批量操作" });
  await user.click(action);
  let list = document.getElementById(
    action.getAttribute("aria-controls") || "",
  );
  let popup = list?.closest<HTMLElement>("[data-slot=popover-content]");
  expect(popup).toBeTruthy();
  await user.click(
    await within(popup!).findByText("停止核心", {
      selector: "[cmdk-item] span",
    }),
  );
  await user.click(screen.getByRole("button", { name: "预览影响与差异" }));
  await screen.findByRole("checkbox", { name: "我已核对实例、阶段与影响范围" });
  await user.click(action);
  list = document.getElementById(action.getAttribute("aria-controls") || "");
  popup = list?.closest<HTMLElement>("[data-slot=popover-content]");
  const configure = await within(popup!).findByText("应用配置", {
    selector: "[cmdk-item] span",
  });
  expect(
    configure.closest("[cmdk-item]")?.getAttribute("aria-disabled"),
  ).toBe("true");
  expect(calls.filter((c) => c.url.endsWith("/preview"))).toHaveLength(1);
  expect(calls.find((c) => c.url.endsWith("/preview"))?.body).toMatchObject({
    action: "stop",
  });
});
