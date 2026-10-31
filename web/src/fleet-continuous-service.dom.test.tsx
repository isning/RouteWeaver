// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { FleetPlanForm, FleetBatchDetail } from "./Fleet";
import { InstanceObservation } from "./Infrastructure";
import type { Infrastructure } from "./types";
const instance = {
  id: "core",
  name: "Core",
  hostId: "host",
  adapterId: "routeweaver/xray",
  version: "26.3.27",
};
const inventory = {
  hosts: [{ id: "host", name: "Host", address: "10.0.0.1" }],
  instances: [instance],
  endpoints: [],
  links: [],
  deployments: [
    {
      id: "path",
      name: "Path",
      status: "draft",
      diagnostics: [],
      ir: {
        schemaVersion: "1.0",
        id: "path",
        programs: [
          {
            instance,
            listener: {
              id: "entry",
              connection: { protocol: "socks", host: "0.0.0.0", port: 1080 },
            },
            egress: [],
            rules: [],
            resources: [],
          },
        ],
      },
    },
  ],
} as unknown as Infrastructure;
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
let client: QueryClient;
beforeEach(() => {
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
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
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
function form() {
  return (
    <FleetPlanForm
      inventory={inventory}
      history={[]}
      initialDeploymentId="path"
      initialTargetIds={["core"]}
      onClose={() => {}}
      onCreated={() => {}}
    />
  );
}
it("defaults to one-off operation and binds explicit continuous-service authorization to a newly reviewed plan", async () => {
  const writes: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      writes.push({ url, body });
      return json({
        ...body,
        fingerprint: "review",
        supported: true,
        targets: [],
        affectedUsers: 0,
        diagnostics: [],
      });
    }),
  );
  mount(form());
  const optIn = screen.getByRole("checkbox", {
    name: "持续运行并有限自动恢复",
  });
  expect(optIn.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "预览影响与差异" }));
  await screen.findByRole("checkbox", { name: "我已核对实例、阶段与影响范围" });
  expect(writes[0].body.continuousService).toBe(false);
  fireEvent.click(optIn);
  expect(screen.queryByRole("button", { name: "创建待执行批次" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "预览影响与差异" }));
  fireEvent.click(
    await screen.findByRole("checkbox", {
      name: "我已核对实例、阶段与影响范围",
    }),
  );
  expect(screen.getByText(/最多自动恢复 3 次/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "创建待执行批次" }));
  await waitFor(() => expect(writes).toHaveLength(3));
  expect(writes[1].body.continuousService).toBe(true);
  expect(writes[2].body.continuousService).toBe(true);
  expect(writes[2].body.expectedFingerprint).toBe("review");
});
it("distinguishes blocked continuing authorization from the last observed process state", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        instanceId: "core",
        phase: "conformant",
        serviceIntent: {
          id: "intent",
          running: true,
          status: "crash_loop_blocked",
          automaticAttempts: 3,
          leaseExpiresAt: "2027-01-01T00:00:00Z",
        },
      }),
    ),
  );
  mount(<InstanceObservation instanceId="core" />);
  await screen.findByText("自动恢复已暂停");
  expect(screen.getByText("已用自动恢复次数：3 / 3")).toBeTruthy();
  expect(screen.getByText(/重新检查并明确创建新的持续运行计划/)).toBeTruthy();
});
it("rejects a preview that does not confirm the requested continuing authorization", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        fingerprint: "old-server",
        supported: true,
        targets: [],
        affectedUsers: 0,
        diagnostics: [],
      }),
    ),
  );
  mount(form());
  fireEvent.click(
    screen.getByRole("checkbox", { name: "持续运行并有限自动恢复" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "预览影响与差异" }));
  await screen.findByText("服务未确认所选的持续运行模式，请刷新后重新预览。");
  expect(screen.queryByRole("button", { name: "创建待执行批次" })).toBeNull();
});
it("ignores a late preview after the continuing authorization is changed", async () => {
  let release!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => held),
  );
  mount(form());
  fireEvent.click(
    screen.getByRole("checkbox", { name: "持续运行并有限自动恢复" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "预览影响与差异" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  fireEvent.click(
    screen.getByRole("checkbox", { name: "持续运行并有限自动恢复" }),
  );
  await act(async () => {
    release(
      json({
        continuousService: true,
        fingerprint: "stale",
        supported: true,
        targets: [],
        affectedUsers: 0,
        diagnostics: [],
      }),
    );
    await held;
  });
  expect(screen.queryByRole("button", { name: "创建待执行批次" })).toBeNull();
});
it("drops continuing authorization when changing to stop and does not revive it when returning to start", async () => {
  const bodies: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return json({
        ...body,
        fingerprint: "review",
        supported: true,
        targets: [],
        affectedUsers: 0,
        diagnostics: [],
      });
    }),
  );
  mount(form());
  fireEvent.click(
    screen.getByRole("checkbox", { name: "持续运行并有限自动恢复" }),
  );
  fireEvent.click(screen.getByRole("combobox", { name: "批量操作" }));
  fireEvent.click(await screen.findByRole("option", { name: "停止核心" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("checkbox", { name: "持续运行并有限自动恢复" }),
    ).toBeNull(),
  );
  fireEvent.click(screen.getByRole("button", { name: "预览影响与差异" }));
  await screen.findByRole("checkbox", { name: "我已核对实例、阶段与影响范围" });
  expect(bodies[0]).not.toHaveProperty("continuousService");
  expect(screen.getByText(/执行停止时会关闭所选实例的持续授权/)).toBeTruthy();
  fireEvent.click(screen.getByRole("combobox", { name: "批量操作" }));
  fireEvent.click(await screen.findByRole("option", { name: "启动核心" }));
  expect(
    (
      await screen.findByRole("checkbox", { name: "持续运行并有限自动恢复" })
    ).getAttribute("aria-checked"),
  ).toBe("false");
  expect(screen.queryByRole("button", { name: "创建待执行批次" })).toBeNull();
});
it.each([
  ["awaiting_observation", "持续服务等待节点确认"],
  ["running", "持续服务已授权"],
  ["recovery_backoff", "自动恢复等待重试"],
  ["recovery_queued", "自动恢复已提交"],
  ["review_required", "持续服务需要重新检查"],
  ["disabled", "持续服务授权已关闭"],
  ["superseded", "持续服务授权已被后续操作替代"],
  ["future-status", "持续服务状态待确认"],
])(
  "presents authoritative continuing-service status %s separately from runtime health",
  async (status, label) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          instanceId: "core",
          phase: "unknown",
          serviceIntent: {
            id: "intent",
            running: !["disabled", "superseded"].includes(status),
            status,
            automaticAttempts: 1,
            leaseExpiresAt: "2027-01-01T00:00:00Z",
          },
        }),
      ),
    );
    mount(<InstanceObservation instanceId="core" />);
    await screen.findByText(label);
    expect(screen.getByText("已用自动恢复次数：1 / 3")).toBeTruthy();
  },
);
it("does not invent continuing authorization for a legacy/manual instance", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ instanceId: "core", phase: "conformant" })),
  );
  mount(<InstanceObservation instanceId="core" />);
  await screen.findByText("未设置持续服务授权");
  expect(screen.queryByText("持续服务已授权")).toBeNull();
});
it("discloses continuing authorization again at the actual stage-execution decision", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        id: "batch",
        action: "start",
        continuousService: true,
        createdAt: "2026-10-31T00:00:00Z",
        affectedUsers: 1,
        status: "planned",
        targets: [
          {
            instanceId: "core",
            name: "Core",
            stage: 0,
            supported: true,
            status: "planned",
            attempts: [],
          },
        ],
      }),
    ),
  );
  mount(<FleetBatchDetail id="batch" onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "执行第 1 阶段" }));
  const confirm = await screen.findByRole("alertdialog");
  expect(confirm.textContent).toContain("最多自动恢复 3 次");
  expect(confirm.textContent).toContain("权限变化");
});
