// @vitest-environment jsdom
import { renderFleetSession } from "./test-support/fleet-session";
import userEvent from "@testing-library/user-event";
import { compile } from "tailwindcss";
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
  fingerprint: "a".repeat(64),
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
const uncertain = "创建结果尚未确认，批次可能已创建。请先查询该次结果。";
const legacy = "plan inputs changed; preview again before creating the batch";
async function mount(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return renderFleetSession(ui, (content) => render(
    <QueryClientProvider client={client}>
      <UIProviders>{content}</UIProviders>
    </QueryClientProvider>,
  ));
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
  await mount(
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
  await mount(
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
  await mount(
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
    deployments: [
      {
        ...inventory.deployments[0],
        ir: { ...inventory.deployments[0].ir, programs: [] },
      },
    ],
    initialDeploymentId: "path",
    message: "此转发路径暂无可选实例。核对路径中的实例配置后，可在此安排变更。",
  },
])(
  "distinguishes $name from a filter miss",
  async ({ deployments, initialDeploymentId, message }) => {
    const fetcher = vi.fn(async () => json([]));
    vi.stubGlobal("fetch", fetcher);
    await mount(
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
it.for(["success", "failure"])(
  "keeps a late path A preview $0 out of path B and retains B errors",
  async (outcome) => {
    let completeA!: (response: Response) => void;
    const pendingA = new Promise<Response>((resolve) => {
      completeA = resolve;
    });
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return body.deploymentId === "path"
        ? pendingA
        : json({ detail: "Current path B preview failed" }, 503);
    });
    vi.stubGlobal("fetch", fetcher);
    await mount(
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
    await userEvent.click(
      screen.getByRole("button", { name: "预览影响与差异" }),
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await userEvent.click(path);
    await userEvent.click(screen.getByRole("option", { name: "Other path" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "更换路径",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "选择筛选结果" }));
    expect(
      screen.getByRole("button", { name: "预览影响与差异" }),
    ).toHaveProperty("disabled", false);
    await act(async () => {
      completeA(
        outcome === "success"
          ? json(plan)
          : json({ detail: "Obsolete path A preview failed" }, 503),
      );
      await pendingA;
    });
    await waitFor(() =>
      expect([null, "false"]).toContain(
        screen
          .getByRole("button", { name: "预览影响与差异" })
          .getAttribute("aria-busy"),
      ),
    );
    expect(screen.queryByText("Obsolete path A preview failed")).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: "我已核对实例、阶段与影响范围" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "创建待执行批次" })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "预览影响与差异" }),
    );
    await screen.findByText("Current path B preview failed");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      screen
        .getByRole("checkbox", { name: "选择实例 Office core" })
        .getAttribute("data-state"),
    ).toBe("checked");
  },
);
it.for([
  { outcome: "success", bState: "pending" },
  { outcome: "failure", bState: "pending" },
  { outcome: "success", bState: "failed" },
  { outcome: "failure", bState: "failed" },
])(
  "keeps path B $bState feedback when overlapping path A returns $outcome",
  async ({ outcome, bState }) => {
    let completeA!: (response: Response) => void;
    let completeB!: (response: Response) => void;
    const pendingA = new Promise<Response>((resolve) => {
      completeA = resolve;
    });
    const pendingB = new Promise<Response>((resolve) => {
      completeB = resolve;
    });
    const requests: string[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body.deploymentId);
      return body.deploymentId === "path" ? pendingA : pendingB;
    });
    vi.stubGlobal("fetch", fetcher);
    await mount(
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
    const preview = screen.getByRole("button", { name: "预览影响与差异" });
    await userEvent.click(path);
    await userEvent.click(screen.getByRole("option", { name: "Office path" }));
    await userEvent.click(screen.getByRole("button", { name: "选择筛选结果" }));
    await userEvent.click(preview);
    await waitFor(() => expect(requests).toEqual(["path"]));
    await userEvent.click(path);
    await userEvent.click(screen.getByRole("option", { name: "Other path" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "更换路径",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "选择筛选结果" }));
    await userEvent.click(preview);
    await waitFor(() => expect(requests).toEqual(["path", "other"]));
    expect(preview.getAttribute("aria-busy")).toBe("true");
    expect(preview).toHaveProperty("disabled", true);
    const finishB = async () => {
      await act(async () => {
        completeB(json({ detail: "Current path B preview failed" }, 503));
        await pendingB;
      });
      await screen.findByText("Current path B preview failed");
    };
    if (bState === "failed") await finishB();
    // A is released only after B's request exists (and, in two cases, B's
    // error is already visible). Both responses are owned by the HTTP seam.
    await act(async () => {
      completeA(
        outcome === "success"
          ? json(plan)
          : json({ detail: "Obsolete path A preview failed" }, 503),
      );
      await pendingA;
    });
    if (bState === "pending") {
      expect(preview.getAttribute("aria-busy")).toBe("true");
      expect(preview).toHaveProperty("disabled", true);
      expect(screen.queryByText("Current path B preview failed")).toBeNull();
      await finishB();
    }
    expect(
      screen.getByText("Current path B preview failed", { exact: true }),
    ).toBeTruthy();
    expect([null, "false"]).toContain(preview.getAttribute("aria-busy"));
    expect(preview).toHaveProperty("disabled", false);
    expect(screen.queryByText("Obsolete path A preview failed")).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: "我已核对实例、阶段与影响范围" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "创建待执行批次" })).toBeNull();
    expect(path.textContent).toBe("Other path");
    expect(
      screen
        .getByRole("checkbox", { name: "选择实例 Office core" })
        .getAttribute("data-state"),
    ).toBe("checked");
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);
it("keeps an uncertain create frozen until abandonment before creating for another path", async () => {
  const fetcher = vi.fn(async (url, init) => {
    if (String(url).endsWith("/preview")) return json(plan);
    const body = JSON.parse(String(init?.body));
    return json(
      {
        detail:
          body.deploymentId === "path"
            ? "Path A creation result needs checking"
            : "Path B creation result needs checking",
      },
      503,
    );
  });
  vi.stubGlobal("fetch", fetcher);
  await mount(
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
  const bodies: unknown[] = [];
  for (const name of ["Office path", "Other path"]) {
    if (name === "Other path") {
      await userEvent.click(screen.getByRole("button", { name: "放弃本页恢复记录" }));
      const decision = await screen.findByRole("alertdialog", { name: "放弃核对这次创建？" });
      await userEvent.click(within(decision).getByRole("button", { name: "放弃恢复记录" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(sessionStorage.length).toBe(0);
    }
    await userEvent.click(path);
    await userEvent.click(screen.getByRole("option", { name }));
    if (name === "Other path") {
      await userEvent.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", {
          name: "更换路径",
        }),
      );
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(
        screen.queryByText("Path A creation result needs checking"),
      ).toBeNull();
    }
    await userEvent.click(screen.getByRole("button", { name: "选择筛选结果" }));
    await userEvent.click(
      screen.getByRole("button", { name: "预览影响与差异" }),
    );
    await userEvent.click(
      await screen.findByRole("checkbox", {
        name: "我已核对实例、阶段与影响范围",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "创建待执行批次" }),
    );
    await screen.findByText(uncertain);
    expect(screen.queryByRole("combobox", { name: "批量变更转发路径" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "选择实例 Office core" })).toBeNull();
    const record = JSON.parse(sessionStorage.getItem("routeweaver.fleet-creation.v1:fleet-test-admin")!);
    expect(record.request.deploymentId).toBe(name === "Office path" ? "path" : "other");
    bodies.push(record.request);
    expect(screen.getByRole("region", { name: "批次创建结果" }).textContent).toContain(name);
  }
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(bodies).toHaveLength(2);
});
it("labels and aligns populated filters while retaining selected targets and keyboard controls", async () => {
  const fetcher = vi.fn(async () => json([]));
  vi.stubGlobal("fetch", fetcher);
  await mount(
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
  { status: 409, code: "UNKNOWN_FUTURE_CONFLICT", expected: uncertain },
  { status: 422, code: "FLEET_REVIEW_CHANGED", expected: uncertain },
])(
  "keeps exact typed feedback and recovery for $status / $code",
  async ({ status, code, expected }, context) => {
    const scenario = ownedClickScenario(context),
      writes: unknown[] = [],
      conditions: (string | null)[] = [],
      created = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (String(url).endsWith("/preview")) return json(plan);
        writes.push(JSON.parse(String(init?.body)));
        conditions.push(new Headers(init?.headers).get("If-None-Match"));
        return json({ detail: legacy, code }, status);
      }),
    );
    await mount(
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
    expect(dialog.queryByRole("button", { name: "创建待执行批次" })).toBeNull();
    if (expected === changed) {
      expect(dialog.getByRole("checkbox", { name: "选择实例 Office core" }).getAttribute("aria-checked")).toBe("true");
      const preview = dialog.getByRole("button", { name: "预览影响与差异", description: new RegExp(changed) });
      await waitFor(() => expect(document.activeElement).toBe(preview));
      expect(sessionStorage.length).toBe(0);
      expect(dialog.queryByRole("checkbox", { name: "我已核对实例、阶段与影响范围" })).toBeNull();
    } else {
      expect(dialog.queryByRole("checkbox", { name: "选择实例 Office core" })).toBeNull();
      expect(dialog.queryByRole("button", { name: "预览影响与差异" })).toBeNull();
      const lookup = dialog.getByRole("button", { name: "查询该次结果" });
      await waitFor(() => expect(document.activeElement).toBe(lookup));
      expect(dialog.getByRole("button", { name: "用同一计划重试创建" })).toBeTruthy();
      expect(dialog.getByRole("button", { name: "放弃本页恢复记录" })).toBeTruthy();
      expect(sessionStorage.length).toBe(1);
    }
    expect(writes).toEqual([
      expect.objectContaining({
        deploymentId: "path",
        targetIds: ["core"],
        expectedFingerprint: "a".repeat(64),
      }),
    ]);
    expect(conditions).toEqual(["*"]);
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
  await mount(<FleetBatchDetail id="batch" onClose={() => {}} />);
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
    await mount(<FleetBatchDetail id="stage-feedback" onClose={() => {}} />);
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
  await mount(<FleetBatchDetail id="mixed-stages" onClose={() => {}} />);
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
  await mount(
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

it("opens a verified created batch only after an explicit progress action", async () => {
  const created = vi.fn();
  let request: Record<string, unknown> = {};
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (String(url).endsWith("/preview")) return json(plan);
    request = JSON.parse(String(init?.body));
    expect(new Headers(init?.headers).get("If-None-Match")).toBe("*");
    return json({
      ...request, actorId: "fleet-test-admin", fingerprint: "a".repeat(64),
      createdAt: "2026-11-07T12:00:00Z", status: "planned", affectedUsers: 7,
      supported: true, diagnostics: [], disruption: "May restart",
      targets: [{ instanceId: "core", stage: 0, status: "planned", attempts: [],
        nodeId: "node", name: "Office core", adapterId: "routeweaver/xray",
        coreVersion: "26.3.27", affectedRouteIds: [], affectedUsers: 7,
        supported: true, diagnostics: [], changes: [], configDiff: [] }],
    }, 201);
  }));
  await mount(<FleetPlanForm inventory={inventory} history={[]} initialDeploymentId="path"
    initialTargetIds={["core"]} onClose={() => {}} onCreated={created} />);
  await userEvent.click(screen.getByRole("button", { name: "预览影响与差异" }));
  await userEvent.click(await screen.findByRole("checkbox", { name: "我已核对实例、阶段与影响范围" }));
  await userEvent.click(screen.getByRole("button", { name: "创建待执行批次" }));
  await screen.findByText("批次已创建", { exact: true });
  expect(created).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "创建待执行批次" })).toBeNull();
  expect(sessionStorage.length).toBe(1);
  expect(request).toEqual({ id: expect.any(String), action: "configure", deploymentId: "path",
    targetIds: ["core"], stages: [["core"]], continuousService: false,
    expectedFingerprint: "a".repeat(64), leaseSeconds: 300 });
  await userEvent.click(screen.getByRole("button", { name: "查看批次进度" }));
  expect(created).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: request.id, actorId: "fleet-test-admin", status: "planned" }));
  expect(sessionStorage.length).toBe(0);
});

it("keeps same-request fleet recovery visible and keyboard-owned while resubmission is pending", async (context) => {
  const scenario = ownedClickScenario(context);
  const batch = { ...plan, id: "batch", action: "configure", deploymentId: "path", createdAt: "2026-11-11T10:00:00Z", leaseSeconds: 300, status: "planned",
    targets: [{ ...plan.targets[0], status: "planned", attempts: [], changes: [], diagnostics: [] }],
  };
  const writes: unknown[] = [];
  let resolve!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== "POST") return json(batch);
    writes.push(JSON.parse(String(init.body)));
    if (writes.length === 1) return json({ error: "服务暂时不可用" }, 503);
    return new Promise<Response>(done => { resolve = done; });
  }));
  await mount(<FleetBatchDetail id="batch" onClose={() => {}} />);
  await scenario.click(() => screen.findByRole("button", { name: "执行第 1 阶段" }));
  await scenario.click(() => screen.findByRole("button", { name: "确认执行" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  const retry = await screen.findByRole("button", { name: "重新提交同一请求" });
  await scenario.click(() => retry);
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(screen.getByRole("button", { name: "重新提交同一请求" })).toBe(retry);
  expect(retry.getAttribute("aria-busy")).toBe("true");
  expect(retry.getAttribute("aria-disabled")).toBe("true");
  expect(retry.hasAttribute("disabled")).toBe(false);
  expect(document.activeElement).toBe(retry);
  await userEvent.keyboard("{Enter}{Enter}");
  expect(writes).toHaveLength(2);
  await act(async () => resolve(json({ error: "请稍后重试" }, 503)));
  await waitFor(() => expect(retry.getAttribute("aria-busy")).not.toBe("true"));
  expect(document.activeElement).toBe(retry);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(writes).toHaveLength(3));
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[2]).toEqual(writes[0]);
  await act(async () => resolve(json(batch)));
  await waitFor(() => expect(screen.queryByRole("button", { name: "重新提交同一请求" })).toBeNull());
});


it("preserves cached fleet recovery through a failed refresh while the same request is pending", async (context) => {
  const scenario = ownedClickScenario(context);
  const batch = { ...plan, id: "batch", action: "configure", deploymentId: "path", createdAt: "2026-11-11T10:00:00Z", leaseSeconds: 300, status: "planned",
    targets: [{ ...plan.targets[0], status: "planned", attempts: [], changes: [], diagnostics: [] }],
  };
  let reads = 0;
  const writes: unknown[] = [];
  let finishRefresh!: (response: Response) => void;
  let finishWrite!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      writes.push(JSON.parse(String(init.body)));
      if (writes.length === 1) return json({ error: "执行暂时不可用" }, 503);
      return new Promise<Response>(resolve => { finishWrite = resolve; });
    }
    reads++;
    if (reads <= 2) return json(batch);
    if (reads === 3) return new Promise<Response>(resolve => { finishRefresh = resolve; });
    return json({ error: "读取暂时不可用" }, 503);
  }));
  await mount(<FleetBatchDetail id="batch" onClose={() => {}} />);
  await scenario.click(() => screen.findByRole("button", { name: "执行第 1 阶段" }));
  await scenario.click(() => screen.findByRole("button", { name: "确认执行" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  const retry = await screen.findByRole("button", { name: "重新提交同一请求" });
  await scenario.click(() => screen.getByRole("button", { name: "刷新进度" }));
  await waitFor(() => expect(reads).toBe(3));
  await scenario.click(() => retry);
  await waitFor(() => expect(writes.length).toBe(2));
  await act(async () => finishRefresh(json({ error: "读取暂时不可用" }, 503)));
  await screen.findByText("批次进度刷新失败，以下为上次读取的记录。请刷新进度后再开始新的执行或目标重试。");
  expect(screen.getByText("Office core")).toBeTruthy();
  expect(screen.getByRole("button", { name: "重新提交同一请求" })).toBe(retry);
  expect(document.activeElement).toBe(retry);
  expect(retry.getAttribute("aria-busy")).toBe("true");
  expect(retry.getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByRole("button", { name: "执行第 1 阶段" }).hasAttribute("disabled")).toBe(true);
  await userEvent.keyboard("{Enter}{Enter}");
  expect(writes.length).toBe(2);
  await act(async () => finishWrite(json({ error: "执行仍不可用" }, 503)));
  await waitFor(() => expect(retry.getAttribute("aria-busy")).not.toBe("true"));
  expect(document.activeElement).toBe(retry);
  expect(screen.getByRole("button", { name: "执行第 1 阶段" }).hasAttribute("disabled")).toBe(true);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(writes.length).toBe(3));
  expect(JSON.stringify(writes[1]) === JSON.stringify(writes[0])).toBe(true);
  expect(JSON.stringify(writes[2]) === JSON.stringify(writes[0])).toBe(true);
  await act(async () => finishWrite(json({ ...batch, status: "queued", targets: [{ ...batch.targets[0], status: "queued" }] })));
  await waitFor(() => expect(screen.queryByRole("button", { name: "重新提交同一请求" })).toBeNull());
  expect(screen.getByText("Office core")).toBeTruthy();
});

for (const refreshState of ["pending", "failed", "changed"] as const) {
  it(`rejects a fleet confirmation opened before progress refresh becomes ${refreshState}`, async (context) => {
    const scenario = ownedClickScenario(context);
    const batch = { ...plan, id: "batch", action: "configure", deploymentId: "path", createdAt: "2026-11-11T10:00:00Z", leaseSeconds: 300, status: "planned",
      targets: [{ ...plan.targets[0], status: "planned", attempts: [], changes: [], diagnostics: [] }],
    };
    let reads = 0, writes = 0;
    let finishRefresh!: (response: Response) => void;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") { writes++; return json(batch); }
      reads++;
      if (reads === 1) return json(batch);
      return new Promise<Response>(resolve => { finishRefresh = resolve; });
    }));
    await mount(<FleetBatchDetail id="batch" onClose={() => {}} />);
    await scenario.click(() => screen.findByRole("button", { name: "执行第 1 阶段" }));
    await screen.findByRole("alertdialog");
    // A returning browser tab refreshes a stale query even with a decision open.
    await act(async () => { fireEvent(window, new Event("visibilitychange")); });
    await waitFor(() => expect(reads).toBe(2));
    if (refreshState === "failed")
      await act(async () => finishRefresh(json({ error: "读取暂时不可用" }, 503)));
    if (refreshState === "changed")
      await act(async () => finishRefresh(json({ ...batch, targets: [{ ...batch.targets[0], status: "failed" }] })));
    await scenario.click(() => screen.getByRole("button", { name: "确认执行" }));
    await screen.findByText("批次进度尚未核对。请取消，刷新进度后重新确认。");
    expect(writes).toBe(0);
    await scenario.click(() => within(screen.getByRole("alertdialog")).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    const execute = screen.getByRole("button", { name: "执行第 1 阶段" });
    expect(execute.hasAttribute("disabled")).toBe(true);
    if (refreshState !== "pending") {
      await scenario.click(() => screen.getByRole("button", { name: "刷新进度" }));
      await waitFor(() => expect(reads).toBe(3));
      expect(execute.hasAttribute("disabled")).toBe(true);
    }
    await act(async () => finishRefresh(json(batch)));
    await waitFor(() => expect(execute.hasAttribute("disabled")).toBe(false));
    await scenario.click(() => execute);
    await scenario.click(() => screen.getByRole("button", { name: "确认执行" }));
    await waitFor(() => expect(writes).toBe(1));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
}
