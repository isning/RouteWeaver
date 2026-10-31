// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FleetBatchDetail, FleetPlanForm } from "./Fleet";
import type { Infrastructure } from "./types";
import { ownedClickScenario } from "./test-support/owned-click-scenario";

const clients: QueryClient[] = [];
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const inventory = {
  hosts: [{ id: "host", name: "Host", address: "example.test" }],
  instances: [
    {
      id: "core",
      hostId: "host",
      name: "Office core",
      adapterId: "routeweaver/xray",
      version: "26.3.27",
    },
  ],
  endpoints: [],
  links: [],
  deployments: [
    {
      id: "path",
      name: "Office path",
      ir: { programs: [{ instance: { id: "core" } }] },
    },
  ],
} as unknown as Infrastructure;
const plan = {
  fingerprint: "reviewed-scope",
  supported: true,
  affectedUsers: 7,
  diagnostics: [],
  targets: [
    {
      instanceId: "core",
      name: "Office core",
      stage: 0,
      supported: true,
      affectedUsers: 7,
    },
  ],
};
const changed = "计划需要重新核对，尚未创建批次。请重新预览后再创建。";
const legacy = "plan inputs changed; preview again before creating the batch";
function mount(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>{ui}</UIProviders>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
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
});
afterEach(async () => {
  await act(async () => {
    cleanup();
    clients.splice(0).forEach((client) => client.clear());
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it.for([
  { status: 409, code: "FLEET_REVIEW_CHANGED", expected: changed },
  { status: 409, code: "UNKNOWN_FUTURE_CONFLICT", expected: legacy },
  { status: 422, code: "FLEET_REVIEW_CHANGED", expected: legacy },
])(
  "keeps exact typed feedback and recovery for $status / $code",
  async ({ status, code, expected }, context) => {
    const scenario = ownedClickScenario(context),
      writes: unknown[] = [],
      created = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (String(url).endsWith("/preview")) return json(plan);
        writes.push(JSON.parse(String(init?.body)));
        return json({ detail: legacy, code }, status);
      }),
    );
    mount(
      <FleetPlanForm
        inventory={inventory}
        history={[]}
        initialDeploymentId="path"
        initialTargetIds={["core"]}
        onClose={() => {}}
        onCreated={created}
      />,
    );
    const dialog = within(screen.getByRole("dialog"));
    await scenario.click(() =>
      dialog.getByRole("button", { name: "预览影响与差异" }),
    );
    await scenario.click(() =>
      dialog.findByRole("checkbox", { name: "我已核对实例、阶段与影响范围" }),
    );
    await scenario.click(() =>
      dialog.getByRole("button", { name: "创建待执行批次" }),
    );
    await dialog.findByText(expected);
    expect(dialog.getAllByText(expected)).toHaveLength(1);
    expect(
      dialog.queryByText(expected === changed ? legacy : changed),
    ).toBeNull();
    expect(
      (
        dialog.getByRole("checkbox", {
          name: "选择实例 Office core",
        }) as HTMLInputElement
      ).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      dialog.getByRole("button", {
        name: status === 409 ? "预览影响与差异" : "创建待执行批次",
        description: new RegExp(expected),
      }),
    ).toBeTruthy();
    if (status === 409)
      expect(
        dialog.queryByRole("button", { name: "创建待执行批次" }),
      ).toBeNull();
    else expect(dialog.getByText("1 个实例 · 7 位用户受影响")).toBeTruthy();
    expect(writes).toEqual([
      expect.objectContaining({
        deploymentId: "path",
        targetIds: ["core"],
        expectedFingerprint: "reviewed-scope",
      }),
    ]);
    expect(created).not.toHaveBeenCalled();
  },
);

it("explains known attempt codes before raw detail without implying superseded work was never submitted", async (context) => {
  const scenario = ownedClickScenario(context);
  const known = [
    ["review_required", "当前计划需要重新检查。请重新预览后再安排执行。"],
    [
      "authorization_or_configuration_changed",
      "配置、凭据或账号权限已变化。请重新预览新批次。",
    ],
    [
      "enrollment_changed",
      "该实例的节点授权已变化、过期或撤销。请核对授权后重新计划。",
    ],
    [
      "desired_superseded_review_required",
      "此实例已有后续变更。请核对当前实例和批次状态。",
    ],
    [
      "previous_stage_no_longer_current",
      "前一阶段的当前状态需要重新核对。请确认后再继续。",
    ],
    [
      "target_unsupported",
      "此实例无法安全执行已核对的操作。请核对支持的能力和当前版本。",
    ],
  ];
  const batch = {
    ...plan,
    id: "batch",
    action: "configure",
    deploymentId: "path",
    targetIds: ["core"],
    stages: [["core"]],
    createdAt: "2026-10-23T12:00:00Z",
    leaseSeconds: 300,
    status: "partial_failure",
    targets: [
      {
        ...plan.targets[0],
        status: "failed",
        attempts: [
          ...known.map(([code], i) => ({
            number: i + 1,
            code,
            detail: `Raw backend detail ${i + 1}`,
            status:
              code === "desired_superseded_review_required"
                ? "superseded"
                : "failed",
            queuedAt: "2026-10-23T12:00:00Z",
          })),
          {
            number: 7,
            code: "future_code",
            detail: "Future safe detail",
            status: "failed",
            queuedAt: "2026-10-23T12:00:00Z",
          },
          {
            number: 8,
            code: "future_without_detail",
            status: "failed",
            queuedAt: "2026-10-23T12:00:00Z",
          },
        ],
      },
    ],
  };
  const fetcher = vi.fn(async () => json(batch));
  vi.stubGlobal("fetch", fetcher);
  mount(<FleetBatchDetail id="batch" onClose={() => {}} />);
  const dialog = within(screen.getByRole("dialog"));
  const name = await dialog.findByText("Office core");
  const row = within(name.closest("tr")!);
  await scenario.click(() => row.getByRole("button", { name: "展开详情" }));
  for (const [code, copy] of known) {
    const text = dialog.getByText(
      (content, element) => element?.tagName === "P" && content.includes(copy),
    );
    expect(text.textContent).toContain(
      code === "desired_superseded_review_required"
        ? "已被后续变更替代"
        : "失败",
    );
  }
  expect(dialog.queryByText(/Raw backend detail/)).toBeNull();
  expect(dialog.getByText(/第 7 次.*Future safe detail/)).toBeTruthy();
  expect(dialog.getByText(/第 8 次.*future_without_detail/)).toBeTruthy();
  expect(dialog.queryByText(/尚未创建批次|未提交|安全重试/)).toBeNull();
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(fetcher.mock.calls[0]).toEqual([
    "/api/admin/fleet-batches/batch",
    expect.objectContaining({ credentials: "same-origin" }),
  ]);
});

it.each([
  ["unknown", true, "有实例结果未确认，请先查看实际运行状态。"],
  ["superseded", true, "有实例已被后续变更替代，请核对当前配置。"],
  ["unsupported", false, "有实例不支持此操作，请查看目标详情。"],
  ["future-status", true, "有实例状态无法识别，请刷新进度并核对实际运行状态。"],
  ["queued", true, "有实例已提交，等待节点确认。"],
  ["pending", true, "有实例已提交，等待节点确认。"],
] as const)(
  "does not label %s stages as wholly submitted",
  async (status, supported, expected) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          ...plan,
          id: "stage-feedback",
          action: "configure",
          deploymentId: "path",
          createdAt: "2026-10-23T12:00:00Z",
          status:
            status === "unsupported" || status === "superseded"
              ? "failed"
              : "pending",
          targets: [{ ...plan.targets[0], status, supported, attempts: [] }],
        }),
      ),
    );
    mount(<FleetBatchDetail id="stage-feedback" onClose={() => {}} />);
    expect(await screen.findByText(expected)).toBeTruthy();
    expect(
      screen.queryByText("本阶段已提交，请刷新进度并等待节点确认"),
    ).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "执行第 1 阶段",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  },
);

it("keeps unexecuted targets visible in mixed and waiting stages", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        ...plan,
        id: "mixed-stages",
        action: "configure",
        deploymentId: "path",
        createdAt: "2026-10-23T12:00:00Z",
        status: "pending",
        targets: [
          { ...plan.targets[0], status: "queued", attempts: [] },
          {
            ...plan.targets[0],
            instanceId: "not-started",
            name: "Not started",
            status: "planned",
            attempts: [],
          },
          {
            ...plan.targets[0],
            instanceId: "next-stage",
            name: "Next stage",
            stage: 1,
            status: "planned",
            attempts: [],
          },
        ],
      }),
    ),
  );
  mount(<FleetBatchDetail id="mixed-stages" onClose={() => {}} />);
  expect(
    await screen.findByText("有实例已提交，等待节点确认。 仍有实例尚未执行。"),
  ).toBeTruthy();
  expect(screen.getByText("等待前序阶段全部确认成功后才能执行")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "执行第 2 阶段" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it("shows stock security migration consequences only for the selected Xray release", async (context) => {
  const scenario = ownedClickScenario(context),
    writes: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).endsWith("/core-releases"))
        return json([
          {
            id: "xray-26.10.29-linux-amd64",
            adapterId: "routeweaver/xray",
            version: "26.10.29",
            platform: "linux-amd64",
            url: "https://github.com/XTLS/Xray-core/releases/download/v26.10.29/Xray-linux-64.zip",
            archiveSHA256: "a".repeat(64),
            executableSHA256: "b".repeat(64),
          },
          {
            id: "sing-box-1.14.4-linux-amd64",
            adapterId: "routeweaver/sing-box",
            version: "1.14.4",
            platform: "linux-amd64",
            url: "https://github.com/SagerNet/sing-box/releases/download/v1.14.4/sing-box-1.14.4-linux-amd64.tar.gz",
            archiveSHA256: "c".repeat(64),
            executableSHA256: "d".repeat(64),
          },
        ]);
      writes.push(init?.body);
      return json({});
    }),
  );
  mount(
    <FleetPlanForm
      inventory={inventory}
      history={[]}
      initialAction="upgrade"
      initialDeploymentId="path"
      initialTargetIds={["core"]}
      onClose={() => {}}
      onCreated={() => {}}
    />,
  );
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.queryByText(/不能直接沿用自定义系统 CA/)).toBeNull();
  await scenario.click(() =>
    dialog.findByRole("combobox", { name: "目标核心版本" }),
  );
  await scenario.click(() =>
    screen.findByRole("option", { name: "xray 26.10.29 · linux-amd64" }),
  );
  await dialog.findByText(/不能直接沿用自定义系统 CA/);
  expect(dialog.getByText(/旧版本不能直接保存网段例外/)).toBeTruthy();
  await scenario.click(() =>
    dialog.findByRole("combobox", { name: "目标核心版本" }),
  );
  await scenario.click(() =>
    screen.findByRole("option", { name: "sing-box 1.14.4 · linux-amd64" }),
  );
  expect(dialog.queryByText(/不能直接沿用自定义系统 CA/)).toBeNull();
  expect(writes).toEqual([]);
});
