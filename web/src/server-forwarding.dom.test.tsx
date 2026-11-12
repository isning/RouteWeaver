// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmationProvider } from "@/ui-patterns/confirmations";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ServerRoutesPage } from "./ServerRoutes";
import type { MatchExpression, ServerDeployment } from "./types";

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
afterEach(() => {
  cleanup();
  location.hash = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function setup(
  conditional = false,
  change?: (deployment: ServerDeployment) => void,
) {
  const instance = {
    id: "fra-core",
    hostId: "fra",
    name: "FRA core",
    adapterId: "routeweaver/xray",
    version: "26.3.27",
  };
  const listener = {
    id: "fra-listener",
    name: "FRA listener",
    instanceId: instance.id,
    connection: {
      protocol: "socks",
      host: "0.0.0.0",
      port: 1080,
      username: "fixture",
      password: "synthetic",
    },
  };
  const deployment: ServerDeployment = {
    revisionToken: "opened-forwarding-revision",
    id: "reject",
    name: "Reject draft",
    status: "draft",
    diagnostics: [],
    ir: {
      schemaVersion: "1.0",
      id: "reject",
      topologyRevision: "1",
      programs: [
        {
          instance,
          listener,
          egress: [],
          rules: [],
          resources: [],
          defaultAction: { kind: "reject" },
        },
      ],
    },
  };
  if (conditional) {
    deployment.ir.programs[0].defaultAction = { kind: "direct" };
    deployment.ir.programs[0].connectors = [
      {
        id: "uk-out",
        connection: { ...listener.connection, host: "uk.example.invalid" },
      },
    ];
    deployment.ir.programs[0].rules = [
      {
        id: "chatgpt",
        match: { op: "domain-suffix", value: "chatgpt.com" },
        action: { kind: "forward", ref: "uk-out" },
      },
    ];
    deployment.ir.programs.push({
      instance: { ...instance, id: "uk-core", hostId: "uk" },
      listener: {
        ...listener,
        id: "uk-listener",
        instanceId: "uk-core",
        name: "UK listener",
      },
      egress: [],
      rules: [],
      resources: [],
      defaultAction: { kind: "direct" },
    });
  }
  change?.(deployment);
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      requests.push(path);
      let value: unknown = [];
      if (path.endsWith("/hosts"))
        value = [
          { id: "fra", name: "FRA", address: "fra.example.invalid" },
          { id: "uk", name: "UK", address: "uk.example.invalid" },
        ];
      else if (path.endsWith("/core-instances"))
        value = deployment.ir.programs.map((program) => program.instance);
      else if (path.endsWith("/managed-endpoints"))
        value = [
          ...deployment.ir.programs.map((program) => program.listener),
          {
            ...listener,
            id: "fra-alternate",
            name: "FRA alternate",
            connection: { ...listener.connection, port: 1081 },
          },
        ];
      else if (path.endsWith("/server-deployments")) value = [deployment];
      else if (path.endsWith("/reject/reveal")) value = deployment;
      else if (path.endsWith("/validate"))
        value = {
          valid: true,
          diagnostics: [],
          artifacts: [],
          fingerprint: "reject-checked",
          nativeChecked: false,
        };
      else if (path.endsWith("/state"))
        value = { instanceId: instance.id, phase: "unregistered" };
      return new Response(JSON.stringify(value), {
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
  return requests;
}

it("shows an explicit reject default as reject in the list, detail, review and editor without applying it", async () => {
  const user = userEvent.setup();
  const requests = setup();
  const name = await screen.findByRole("button", {
    name: "Reject draft",
  });
  expect(within(name.closest("tr")!).getByText("拒绝连接", {})).toBeTruthy();
  await user.click(name);
  const detail = screen.getByRole("dialog", {
    name: "Reject draft",
  });
  expect(within(detail).getByText("拒绝连接", {})).toBeTruthy();
  await user.click(
    within(detail).getByRole("button", { name: "查看修改并应用" }),
  );
  const review = await screen.findByRole("dialog", {
    name: "应用转发路径修改",
  });
  expect(within(review).getByText("拒绝连接", {})).toBeTruthy();
  await user.click(within(review).getByRole("button", { name: /^返\s*回$/ }));
  await user.click(
    within(detail).getByRole("button", { name: "编辑转发路径" }),
  );
  const editor = await screen.findByRole("dialog", {
    name: "编辑 Reject draft",
  });
  expect(within(editor).getByText("拒绝连接", {})).toBeTruthy();
  expect(within(editor).queryByText("作为出口直接连接目标")).toBeNull();
  expect(requests.some((path) => path.endsWith("/publish"))).toBe(false);
});

it("shows conditional forwarding without inventing an execution chain or offering order-based rewrites", async () => {
  const user = userEvent.setup();
  const requests = setup(true);
  const name = await screen.findByRole("button", {
    name: "Reject draft",
  });
  expect(
    within(name.closest("tr")!).getByText(/域名后缀.*chatgpt.com/),
  ).toBeTruthy();
  await user.click(name);
  const detail = screen.getByRole("dialog", {
    name: "Reject draft",
  });
  expect(
    within(detail).getByText(/转发至.*uk.example.invalid:1080/),
  ).toBeTruthy();
  expect(detail.querySelector(".route-detail-arrow")).toBeNull();
  await user.click(
    within(detail).getByRole("button", { name: "查看修改并应用" }),
  );
  const review = await screen.findByRole("dialog", {
    name: "应用转发路径修改",
  });
  expect(within(review).getByText(/域名后缀.*chatgpt.com/)).toBeTruthy();
  expect(
    within(review).getByText(/转发至.*uk.example.invalid:1080/),
  ).toBeTruthy();
  await user.click(within(review).getByRole("button", { name: /^返\s*回$/ }));
  await user.click(
    within(detail).getByRole("button", { name: "编辑转发路径" }),
  );
  const editor = await screen.findByRole("dialog", {
    name: "编辑 Reject draft",
  });
  expect(within(editor).getByRole("combobox", { name: /规则 1 条件类型/ }).textContent).toContain("域名后缀");
  expect((within(editor).getByRole("textbox", { name: /规则 1 条件值/ }) as HTMLInputElement).value).toBe("chatgpt.com");
  expect(
    within(editor).queryByRole("button", { name: /上移第|下移第|移除第/ }),
  ).toBeNull();
  expect(
    within(editor).queryByRole("combobox", { name: /第.*跳|下一跳/ }),
  ).toBeNull();
  expect(within(editor).queryByRole("tab", { name: "图形编辑" })).toBeNull();
  await user.click(
    within(editor).getByRole("button", { name: "编辑转发设置" }),
  );
  const json = await screen.findByRole("dialog", {
    name: "服务端配置 JSON",
  });
  expect(
    (
      within(json).getByRole("textbox", {
        name: "服务端配置 JSON 文本",
      }) as HTMLTextAreaElement
    ).value,
  ).toContain('"ref": "uk-out"');
  expect(requests.some((path) => path.endsWith("/publish"))).toBe(false);
});

it("explains same-core unavailable endpoint choices at the actual next-hop decision", async () => {
  const user = userEvent.setup();
  setup(false, (deployment) => {
    delete deployment.ir.programs[0].defaultAction;
  });
  await user.click(
    await screen.findByRole("button", {
      name: "编辑转发路径 Reject draft",
    }),
  );
  const editor = await screen.findByRole("dialog", {
    name: "编辑 Reject draft",
  });
  await user.click(within(editor).getByRole("button", { name: "第 1 跳更多操作" }));
  const ordering = screen.getByRole("menu", { name: "第 1 跳更多操作" });
  expect(within(ordering).getAllByRole("menuitem")).toHaveLength(4);
  expect(within(ordering).queryByRole("combobox")).toBeNull();
  expect(within(ordering).getByRole("menuitem", { name: "上移第 1 跳" }).getAttribute("aria-disabled")).toBe("true");
  await user.keyboard("{Escape}");
  await user.click(within(editor).getByRole("button", { name: "配置第 1 跳 FRA listener" }));
  expect(within(editor).getByRole("combobox", { name: "第 1 跳服务器" })).toBeTruthy();
  await user.click(within(editor).getByRole("button", { name: "添加下一跳" }));
  await user.click(
    within(editor).getByRole("combobox", { name: "第 2 跳服务器" }),
  );
  await user.click(
    within(
      document.querySelector("[data-slot=popover-content]") as HTMLElement,
    ).getByText("FRA", {}),
  );
  await user.click(
    within(editor).getByRole("combobox", { name: "第 2 跳端点" }),
  );
  expect(
    within(editor).getByText(
      "此端点不能插入当前位置；同一核心不能重复使用，外部代理也不能转移到另一核心。",
      {},
    ),
  ).toBeTruthy();
  expect(
    document.querySelectorAll("[cmdk-item][aria-disabled=true]").length,
  ).toBeGreaterThanOrEqual(2);
  expect(
    (
      within(editor).getByRole("button", {
        name: "保存草稿",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it("shows principal branches, connector via order and unresolved references without inventing endpoint identity or a direct fallback", async () => {
  setup(true, (deployment) => {
    const program = deployment.ir.programs[0];
    program.connectors!.push({
      id: "transit",
      connection: {
        protocol: "socks",
        host: "transit.example.invalid",
        port: 1081,
      },
    });
    program.connectors![0].via = "transit";
    program.principals = [
      {
        subjectId: "subject",
        accountId: "alice",
        routeId: "private-route",
        credentialVersion: "v1",
        credential: { uuid: "must-not-appear" },
        action: { kind: "forward", ref: "uk-out" },
      },
    ];
    program.rules[0].action = { kind: "reject" };
    program.defaultAction = { kind: "forward", ref: "missing" };
  });
  const name = await screen.findByRole("button", {
    name: "Reject draft",
  });
  const row = within(name.closest("tr")!);
  expect(row.getByText("用户入口 alice")).toBeTruthy();
  expect(row.getByText("线路 private-route")).toBeTruthy();
  expect(
    row.getByText(
      "转发至 transit.example.invalid:1081 → uk.example.invalid:1080",
      {},
    ),
  ).toBeTruthy();
  expect(row.getByText("拒绝连接", {})).toBeTruthy();
  expect(row.getByText(/连接器不可用：missing/)).toBeTruthy();
  expect(row.queryByText(/must-not-appear|synthetic/)).toBeNull();
});

it("keeps an incomplete saved condition or connector readable instead of crashing the route list", async () => {
  setup(true, (deployment) => {
    Reflect.deleteProperty(deployment.ir.programs[0].rules[0], "match");
    Reflect.deleteProperty(
      deployment.ir.programs[0].connectors![0],
      "connection",
    );
    deployment.ir.programs[1].defaultAction = { kind: "forward" };
  });
  const name = await screen.findByRole("button", { name: "Reject draft" });
  const row = within(name.closest("tr")!);
  expect(row.getByText(/未识别条件/)).toBeTruthy();
  expect(row.getByText(/目标地址未设置/)).toBeTruthy();
  expect(row.getByText(/连接器不可用：未指定/)).toBeTruthy();
});

it("marks a condition beyond the domain safety depth as an incomplete summary", async () => {
  setup(true, (deployment) => {
    let match: MatchExpression = {
      op: "domain",
      value: "hidden.example.invalid",
    };
    for (let depth = 0; depth < 130; depth++)
      match = { op: "not", children: [match] };
    deployment.ir.programs[0].rules[0].match = match;
  });
  const name = await screen.findByRole("button", { name: "Reject draft" });
  const row = within(name.closest("tr")!);
  expect(row.getByText(/条件过于复杂，摘要未展开/)).toBeTruthy();
  expect(row.queryByText(/hidden.example.invalid/)).toBeNull();
});

it("keeps route editing direct and offers batch operations from the route's contextual menu", async () => {
  const user = userEvent.setup();
  const requests = setup();
  const name = await screen.findByRole("button", { name: "Reject draft" });
  const row = within(name.closest("tr")!);
  expect(
    row.getByRole("button", { name: "编辑转发路径 Reject draft" }),
  ).toBeTruthy();
  expect(row.queryByRole("button", { name: "批量操作" })).toBeNull();
  await user.click(
    row.getByRole("button", { name: "更多转发路径操作 Reject draft" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "批量操作" }));
  expect(
    await screen.findByRole("dialog", { name: "Reject draft的计划变更" }),
  ).toBeTruthy();
  expect(requests.some((path) => path.endsWith("/publish"))).toBe(false);
});



it("retains a newer server choice when an earlier endpoint reveal resolves", async () => {
  const user = userEvent.setup();
  let originalListener!: ServerDeployment["ir"]["programs"][number]["listener"];
  setup(false, (deployment) => {
    delete deployment.ir.programs[0].defaultAction;
    originalListener = deployment.ir.programs[0].listener;
  });
  const originalFetch = globalThis.fetch;
  let release!: (response: Response) => void;
  const delayed = new Promise<Response>((resolve) => { release = resolve; });
  let requested = false;
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/managed-endpoints/fra-alternate/reveal")) {
      requested = true;
      return delayed;
    }
    return originalFetch(input, init);
  }));
  await user.click(await screen.findByRole("button", { name: "编辑转发路径 Reject draft" }));
  const editor = await screen.findByRole("dialog", { name: "编辑 Reject draft" });
  await user.click(within(editor).getByRole("button", { name: "配置第 1 跳 FRA listener" }));
  await user.click(within(editor).getByRole("combobox", { name: "第 1 跳端点" }));
  await user.click(screen.getByRole("option", { name: /FRA alternate/ }));
  await waitFor(() => expect(requested).toBe(true));
  expect(within(editor).getByRole("status").textContent).toContain("正在读取所选监听配置…");
  await user.click(within(editor).getByRole("combobox", { name: "第 1 跳服务器" }));
  await user.click(screen.getByRole("option", { name: "UK" }));
  expect(within(editor).queryByText("正在读取所选监听配置…")).toBeNull();
  await act(async () => {
    release(new Response(JSON.stringify({ ...originalListener, id: "fra-alternate", name: "FRA alternate", connection: { ...originalListener.connection, port: 1081 } }), { headers: { "Content-Type": "application/json" } }));
    await delayed;
  });
  expect(within(editor).queryByText("正在读取所选监听配置…")).toBeNull();
  expect(within(editor).getByRole("combobox", { name: "第 1 跳服务器" }).textContent).toContain("UK");
  expect(within(editor).getByRole("region", { name: "路径摘要" }).textContent).toContain("FRA listener → 目标");
  expect((within(editor).getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(true);
});
