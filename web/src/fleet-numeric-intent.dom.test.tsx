// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FleetPlanForm } from "./Fleet";
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
function planner() {
  mount(<FleetPlanForm inventory={inventory} history={[]} initialDeploymentId="office"
    initialTargetIds={["core"]} onClose={() => {}} onCreated={() => {}} />);
}
async function leaseField() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "执行策略有效期" }));
  return screen.getByRole("spinbutton", { name: "批量变更策略有效秒数" });
}
it.each(["", "0", "29", "3601", "30.5", "30.000000000000000001", "3599.999999999999999999", "1e", "-", "0x12c"])("retains invalid Fleet lease %s without requesting preview", async raw => {
  planner();
  const field = await leaseField();
  fireEvent.change(field, { target: { value: raw } });
  fireEvent.blur(field);
  expect((field as HTMLInputElement).value).toBe(raw);
  await userEvent.setup().click(screen.getByRole("button", { name: "预览影响与差异" }));
  await screen.findByText("策略有效秒数须为 30–3600 的整数，且不能留空。");
  expect(calls.filter(c => c.url.endsWith("/preview"))).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "创建待执行批次" })).toBeNull();
});
it.each([["30", 30], ["3600", 3600], ["3e2", 300], ["300.0", 300]])("creates Fleet batch with reviewed exact lease %s", async (raw, expected) => {
  planner();
  const field = await leaseField();
  fireEvent.change(field, { target: { value: raw } });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "预览影响与差异" }));
  await user.click(await screen.findByRole("checkbox", { name: "我已核对实例、阶段与影响范围" }));
  await user.click(screen.getByRole("button", { name: "创建待执行批次" }));
  await waitFor(() => expect(calls.find(c => c.url.endsWith("/fleet-batches"))?.body).toMatchObject({ leaseSeconds: expected, stages: [["core"]] }));
});
it.each(["", "0", "21", "1.5", "1.000000000000000001", "1e", "-"])("retains invalid selected custom stage %s without preview", async raw => {
  planner();
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "执行顺序" }));
  await user.click(await screen.findByText("自定义分组", { selector: "[cmdk-item] span" }));
  const field = screen.getByRole("spinbutton", { name: "Office core 的执行阶段" });
  fireEvent.change(field, { target: { value: raw } });
  fireEvent.blur(field);
  expect((field as HTMLInputElement).value).toBe(raw);
  await user.click(screen.getByRole("button", { name: "预览影响与差异" }));
  await screen.findByText("执行阶段须为 1–20 的整数，且不能留空。");
  expect(calls.filter(c => c.url.endsWith("/preview"))).toHaveLength(0);
});
it("invalidates a reviewed Fleet plan on an incomplete lease edit and requires a fresh review after repair", async () => {
  planner();
  const field = await leaseField();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "预览影响与差异" }));
  await user.click(await screen.findByRole("checkbox", { name: "我已核对实例、阶段与影响范围" }));
  fireEvent.change(field, { target: { value: "3e" } });
  expect(screen.queryByRole("button", { name: "创建待执行批次" })).toBeNull();
  fireEvent.change(field, { target: { value: "300" } });
  expect(screen.queryByRole("button", { name: "创建待执行批次" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "预览影响与差异" }));
  const create = await screen.findByRole("button", { name: "创建待执行批次" });
  expect((create as HTMLButtonElement).disabled).toBe(true);
  expect(calls.filter(c => c.url.endsWith("/preview"))).toHaveLength(2);
});

it("keeps untouched Fleet defaults at 300 seconds and stage one", async () => {
  planner();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "预览影响与差异" }));
  await user.click(await screen.findByRole("checkbox", { name: "我已核对实例、阶段与影响范围" }));
  await user.click(screen.getByRole("button", { name: "创建待执行批次" }));
  await waitFor(() => expect(calls.find(c => c.url.endsWith("/fleet-batches"))?.body).toMatchObject({ leaseSeconds: 300, stages: [["core"]] }));
});
it("repairs a fractional custom stage but still rejects a gap before exact stage one", async () => {
  planner();
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "执行顺序" }));
  await user.click(await screen.findByText("自定义分组", { selector: "[cmdk-item] span" }));
  const field = screen.getByRole("spinbutton", { name: "Office core 的执行阶段" });
  fireEvent.change(field, { target: { value: "1.5" } });
  fireEvent.change(field, { target: { value: "2" } });
  await user.click(screen.getByRole("button", { name: "预览影响与差异" }));
  await screen.findByText("阶段不能留空，请使用从 1 开始的连续阶段。");
  expect(calls.filter(c => c.url.endsWith("/preview"))).toHaveLength(0);
  fireEvent.change(field, { target: { value: "1e0" } });
  await user.click(screen.getByRole("button", { name: "预览影响与差异" }));
  await screen.findByRole("button", { name: "创建待执行批次" });
  expect(calls.find(c => c.url.endsWith("/preview"))?.body).toMatchObject({ stages: [["core"]] });
});
it("does not restore Fleet review from an older in-flight preview after a lease edit", async () => {
  let complete!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { complete = resolve; });
  vi.mocked(fetch).mockImplementation(async () => pending);
  planner();
  const field = await leaseField();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "预览影响与差异" }));
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  fireEvent.change(field, { target: { value: "3e" } });
  complete(json({ fingerprint: "older", supported: true, targets: [], diagnostics: [], affectedUsers: 0 }));
  await waitFor(() => expect(screen.getByRole("button", { name: "预览影响与差异" }).getAttribute("aria-busy")).not.toBe("true"));
  expect(screen.queryByRole("button", { name: "创建待执行批次" })).toBeNull();
  expect((field as HTMLInputElement).value).toBe("3e");
});
