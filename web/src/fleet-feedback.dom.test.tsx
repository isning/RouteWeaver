// @vitest-environment jsdom
import userEvent from "@testing-library/user-event";
import { compile } from "tailwindcss";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
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
it("asks for a saved path before exposing instance filters and execution stages", async () => {
  const fetcher = vi.fn(async () => json([]));
  vi.stubGlobal("fetch", fetcher);
  mount(
    <FleetPlanForm
      inventory={inventory}
      history={[]}
      onClose={() => {}}
      onCreated={() => {}}
    />,
  );
  expect(
    screen.getByText("先选择已保存的转发路径。", { exact: true }),
  ).toBeTruthy();
  expect(screen.queryByRole("search", { name: "筛选执行范围" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "执行顺序" })).toBeNull();
  expect(screen.queryByRole("button", { name: "选择筛选结果" })).toBeNull();
  const path = screen.getByRole("combobox", { name: "批量变更转发路径" });
  await userEvent.click(path);
  await userEvent.click(screen.getByRole("option", { name: "Office path" }));
  expect(screen.getByRole("search", { name: "筛选执行范围" })).toBeTruthy();
  expect(
    screen.getByRole("checkbox", { name: "选择实例 Office core" }),
  ).toBeTruthy();
  expect(
    screen.queryByText("先选择已保存的转发路径。", { exact: true }),
  ).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
it("recovers an empty filter result without changing selected instances or stages", async () => {
  const fetcher = vi.fn(async () => json([]));
  vi.stubGlobal("fetch", fetcher);
  mount(
    <FleetPlanForm
      inventory={{
        ...inventory,
        hosts: inventory.hosts.map((host) => ({
          ...host,
          group: "团队",
          tags: ["办公"],
        })),
      }}
      history={[]}
      initialDeploymentId="path"
      initialTargetIds={["core"]}
      onClose={() => {}}
      onCreated={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("combobox", { name: "执行顺序" }));
  await userEvent.click(
    screen.getByRole("option", { name: "自定义分组为实例指定阶段" }),
  );
  const stage = screen.getByRole("spinbutton", {
    name: "Office core 的执行阶段",
  });
  fireEvent.change(stage, { target: { value: "3" } });
  await userEvent.click(
    screen.getByRole("combobox", { name: "筛选服务器分组" }),
  );
  await userEvent.click(screen.getByRole("option", { name: "团队" }));
  await userEvent.click(
    screen.getByRole("combobox", { name: "筛选服务器标签" }),
  );
  await userEvent.click(screen.getByRole("option", { name: "办公" }));
  await userEvent.keyboard("{Escape}");
  const search = screen.getByRole("textbox", { name: "筛选批量变更实例" });
  await userEvent.type(search, "no match");
  expect(screen.getByText("没有匹配的实例", { exact: true })).toBeTruthy();
  expect(screen.getByText("已选择 1 个实例", { exact: true })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  expect(document.activeElement).toBe(search);
  expect(search).toHaveProperty("value", "");
  expect(
    screen.getByRole("combobox", { name: "筛选服务器分组" }).textContent,
  ).toBe("所有分组");
  expect(screen.queryByRole("button", { name: "移除 办公" })).toBeNull();
  expect(
    screen
      .getByRole("checkbox", { name: "选择实例 Office core" })
      .getAttribute("data-state"),
  ).toBe("checked");
  expect(
    screen.getByRole("spinbutton", { name: "Office core 的执行阶段" }),
  ).toHaveProperty("value", "3");
  expect(fetcher).not.toHaveBeenCalled();
});
it("confirms path replacement and keeps targets, stages and service choice when canceled", async () => {
  const fetcher = vi.fn(async () => json([]));
  vi.stubGlobal("fetch", fetcher);
  mount(
    <FleetPlanForm
      inventory={{
        ...inventory,
        deployments: [
          ...inventory.deployments,
          { ...inventory.deployments[0], id: "other", name: "Other path" },
        ],
      }}
      history={[]}
      onClose={() => {}}
      onCreated={() => {}}
    />,
  );
  const path = screen.getByRole("combobox", { name: "批量变更转发路径" });
  await userEvent.click(path);
  await userEvent.click(screen.getByRole("option", { name: "Office path" }));
  await userEvent.click(screen.getByRole("button", { name: "选择筛选结果" }));
  await userEvent.click(screen.getByRole("combobox", { name: "执行顺序" }));
  await userEvent.click(
    screen.getByRole("option", { name: "自定义分组为实例指定阶段" }),
  );
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Office core 的执行阶段" }),
    { target: { value: "3" } },
  );
  await userEvent.click(
    screen.getByRole("checkbox", { name: "持续运行并有限自动恢复" }),
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    await userEvent.click(path);
    await userEvent.click(screen.getByRole("option", { name: "Other path" }));
    const decision = await screen.findByRole("alertdialog", {
      name: "更换转发路径？",
    });
    expect(
      within(decision).getByText(
        "更换后将重新选择实例与执行阶段，并重新核对持续运行设置。",
        { exact: true },
      ),
    ).toBeTruthy();
    const keep = within(decision).getByRole("button", { name: "保留当前路径" });
    await waitFor(() => expect(document.activeElement).toBe(keep));
    await userEvent.click(keep);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(path));
    expect(path.textContent).toBe("Office path");
    expect(
      screen
        .getByRole("checkbox", { name: "选择实例 Office core" })
        .getAttribute("data-state"),
    ).toBe("checked");
    expect(
      screen.getByRole("spinbutton", { name: "Office core 的执行阶段" }),
    ).toHaveProperty("value", "3");
    expect(
      screen
        .getByRole("checkbox", { name: "持续运行并有限自动恢复" })
        .getAttribute("data-state"),
    ).toBe("checked");
  }
  await userEvent.click(path);
  await userEvent.click(screen.getByRole("option", { name: "Other path" }));
  await userEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "更换路径",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(path.textContent).toBe("Other path");
  expect(screen.getByText("已选择 0 个实例", { exact: true })).toBeTruthy();
  expect(
    screen.getByRole("spinbutton", { name: "Office core 的执行阶段" }),
  ).toHaveProperty("value", "1");
  expect(
    screen
      .getByRole("checkbox", { name: "持续运行并有限自动恢复" })
      .getAttribute("data-state"),
  ).toBe("unchecked");
  expect(fetcher).not.toHaveBeenCalled();
});
it.for([
  {
    name: "no saved paths",
    deployments: [],
    initialDeploymentId: "",
    message:
      "暂无已保存的转发路径。在转发路径中保存配置后，可在此安排实例变更。",
  },
  {
    name: "missing selected path",
    deployments: [],
    initialDeploymentId: "missing",
    message: "所选转发路径已不在当前列表中，请重新核对路径。",
  },
  {
    name: "saved path without instances",
    deployments: [{ ...inventory.deployments[0], ir: { ...inventory.deployments[0].ir, programs: [] } }],
    initialDeploymentId: "path",
    message: "此转发路径暂无可选实例。核对路径中的实例配置后，可在此安排变更。",
  },
])(
  "distinguishes $name from a filter miss",
  async ({ deployments, initialDeploymentId, message }) => {
    const fetcher = vi.fn(async () => json([]));
    vi.stubGlobal("fetch", fetcher);
    mount(
      <FleetPlanForm
        inventory={{ ...inventory, deployments } as Infrastructure}
        history={[]}
        initialDeploymentId={initialDeploymentId}
        onClose={() => {}}
        onCreated={() => {}}
      />,
    );
    expect(screen.getByText(message, { exact: true })).toBeTruthy();
    expect(screen.queryByRole("search", { name: "筛选执行范围" })).toBeNull();
    expect(screen.queryByRole("button", { name: "清除筛选" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "预览影响与差异" }),
    ).toHaveProperty("disabled", true);
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it("labels and aligns populated filters while retaining selected targets and keyboard controls", async () => {
  const fetcher = vi.fn(async () => json([]));
  vi.stubGlobal("fetch", fetcher);
  mount(
    <FleetPlanForm
      inventory={{
        ...inventory,
        hosts: inventory.hosts.map((host) => ({
          ...host,
          group: "团队",
          tags: ["办公"],
        })),
      }}
      history={[]}
      initialDeploymentId="path"
      initialTargetIds={["core"]}
      onClose={() => {}}
      onCreated={() => {}}
    />,
  );
  const toolbar = screen.getByRole("search", { name: "筛选执行范围" });
  const tags = within(toolbar).getByRole("combobox", {
    name: "筛选服务器标签",
  }) as HTMLButtonElement;
  await userEvent.click(tags);
  await userEvent.click(screen.getByRole("option", { name: "办公" }));
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(tags));
  const remove = within(toolbar).getByRole("button", { name: "移除 办公" });
  expect(tags.closest("label")).toBeNull();
  expect(remove.closest("label")).toBeNull();
  expect(tags.labels).toHaveLength(1);
  expect(tags.labels?.[0].textContent).toBe("服务器标签");
  const stylesheet = document.createElement("style");
  stylesheet.textContent = (
    await compile(
      "@theme { --spacing: 0.25rem; --breakpoint-sm: 40rem; } @tailwind utilities;",
    )
  ).build(
    [toolbar, ...toolbar.querySelectorAll<HTMLElement>("[class]")].flatMap(
      (node) => [...node.classList],
    ),
  );
  document.head.append(stylesheet);
  try {
    expect(getComputedStyle(toolbar).alignItems).toBe("flex-start");
  } finally {
    stylesheet.remove();
  }
  remove.focus();
  await userEvent.keyboard("{Enter}");
  expect(
    within(toolbar).queryByRole("button", { name: "移除 办公" }),
  ).toBeNull();
  expect(
    within(toolbar).getByRole("combobox", { name: "筛选服务器标签" }),
  ).toBe(tags);
  const search = within(toolbar).getByRole("textbox", {
    name: "筛选批量变更实例",
  });
  await userEvent.type(search, "Office");
  await userEvent.click(
    within(toolbar).getByRole("button", { name: "清除搜索输入" }),
  );
  expect(document.activeElement).toBe(search);
  expect(search).toHaveProperty("value", "");
  expect(
    screen
      .getByRole("checkbox", { name: "选择实例 Office core" })
      .getAttribute("data-state"),
  ).toBe("checked");
  expect(fetcher).not.toHaveBeenCalled();
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
    else {
      expect(dialog.getByText("1 个实例")).toBeTruthy();
      expect(dialog.getByText("7 位用户受影响")).toBeTruthy();
    }
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
      (_content, element) =>
        element?.tagName === "P" && !!element.textContent?.includes(copy),
    );
    expect(text.textContent).toContain(
      code === "desired_superseded_review_required"
        ? "已被后续变更替代"
        : "失败",
    );
  }
  expect(dialog.queryByText(/Raw backend detail/)).toBeNull();
  expect(
    dialog.getByText(
      (_content, element) =>
        element?.tagName === "P" &&
        /第 7 次.*Future safe detail/.test(element.textContent || ""),
    ),
  ).toBeTruthy();
  expect(
    dialog.getByText(
      (_content, element) =>
        element?.tagName === "P" &&
        /第 8 次.*future_without_detail/.test(element.textContent || ""),
    ),
  ).toBeTruthy();
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
            id: "xray-26.10.31-linux-amd64",
            adapterId: "routeweaver/xray",
            version: "26.10.31",
            platform: "linux-amd64",
            url: "https://github.com/XTLS/Xray-core/releases/download/v26.10.31/Xray-linux-64.zip",
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
    screen.findByRole("option", { name: "xray 26.10.31 linux-amd64" }),
  );
  await dialog.findByText(/不能直接沿用自定义系统 CA/);
  expect(dialog.getByText(/旧版本不能直接保存网段例外/)).toBeTruthy();
  await scenario.click(() =>
    dialog.findByRole("combobox", { name: "目标核心版本" }),
  );
  await scenario.click(() =>
    screen.findByRole("option", { name: "sing-box 1.14.4 linux-amd64" }),
  );
  expect(dialog.queryByText(/不能直接沿用自定义系统 CA/)).toBeNull();
  expect(writes).toEqual([]);
});
