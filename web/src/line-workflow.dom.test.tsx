// @vitest-environment jsdom
import { renderFleetSession } from "./test-support/fleet-session";
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
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PublishedRoutesPage } from "./PublishedRoutes";
import { FleetPlanForm } from "./Fleet";
import { ServerRoutesPage } from "./ServerRoutes";
import type { Infrastructure } from "./types";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const route = {
  id: "line",
  name: "Office line",
  deploymentId: "path",
  endpointIds: ["entry"],
  publicHost: "office.example",
  publicPort: 443,
  status: "draft",
  diagnostics: [],
};
const instance = {
  id: "core",
  hostId: "host",
  name: "Office core",
  adapterId: "routeweaver/managed-xray",
  version: "26.3.27-rw1",
};
const listener = {
  id: "entry",
  name: "Office entry",
  instanceId: "core",
  connection: { protocol: "vless", host: "0.0.0.0", port: 443 },
};
const inventory = {
  hosts: [{ id: "host", name: "Office host", address: "office.example" }],
  instances: [instance, { ...instance, id: "other", name: "Other core" }],
  endpoints: [listener],
  links: [],
  deployments: [
    {
      id: "path",
      name: "Office path",
      status: "draft",
      diagnostics: [],
      ir: {
        schemaVersion: "1.0",
        id: "path",
        topologyRevision: "r1",
        programs: [
          { instance, listener, rules: [], resources: [], egress: [] },
        ],
      },
    },
    {
      id: "other-path",
      name: "Other path",
      ir: { programs: [{ instance: { ...instance, id: "other" }, listener }] },
    },
  ],
} as Infrastructure;
const clients: QueryClient[] = [];
const effectivePolicy = {
  userId: "alice",
  status: "active",
  routeIds: ["line"],
  groupIds: [],
  quotaBytes: 0,
  onlineIpLimit: 0,
  connectionLimit: 0,
  entryRateBps: 0,
  provenance: { routes: "service:office" },
  entitlement: {
    userId: "alice",
    startsAt: "2026-10-01T00:00:00Z",
    paused: false,
    cycle: { mode: "none" },
    routeIdsOverride: null,
  },
};
async function mount(node: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return renderFleetSession(node, (content) => render(
    <QueryClientProvider client={client}>
      <UIProviders>{content}</UIProviders>
    </QueryClientProvider>,
  ));
}
function mockInventory(
  extra?: (
    path: string,
    init?: RequestInit,
  ) => Response | Promise<Response> | undefined,
) {
  const requests: { path: string; method: string; body?: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      requests.push({
        path,
        method: init?.method || "GET",
        body: init?.body && JSON.parse(init.body),
      });
      const response = extra?.(path, init);
      if (response) return response;
      if (path.endsWith("/state"))
        return json({
          users: [{ id: "alice", name: "Alice", enabled: true }],
          services: [],
          routes: [],
          publishedRoutes: [route],
        });
      if (path.endsWith("/published-routes")) return json([route]);
      if (
        path.endsWith("/resolve") ||
        path.endsWith("/published-routes/preview") ||
        path.endsWith("/published-routes/line")
      )
        return json(route);
      if (path.endsWith("/hosts")) return json(inventory.hosts);
      if (path.endsWith("/core-instances")) return json(inventory.instances);
      if (path.endsWith("/managed-endpoints")) return json(inventory.endpoints);
      if (path.endsWith("/server-deployments"))
        return json(inventory.deployments);
      if (path.endsWith("/entries")) return json([]);
      return json([]);
    }),
  );
  return requests;
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  history.replaceState(null, "", "#published-routes");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
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
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    original(element),
  );
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("explains the check dependency, expires a checked draft on edit, then returns the saved line to its next step", async () => {
  const requests = mockInventory();
  await mount(<PublishedRoutesPage />);
  await userEvent.click(await screen.findByRole("button", { name: "编辑" }));
  const editor = await screen.findByRole("dialog", {
    name: "编辑 Office line",
  });
  expect(
    within(editor).getByText(
      "先检查线路，再核对结果并保存；用户授权与服务器配置应用需分别确认。",
    ),
  ).toBeTruthy();
  expect(
    within(editor).queryByRole("button", { name: "保存公开线路" }),
  ).toBeNull();
  await userEvent.click(
    within(editor).getByRole("button", { name: "检查公开线路" }),
  );
  await within(editor).findByText("路径检查完成");
  fireEvent.change(within(editor).getByRole("textbox", { name: "线路名称" }), {
    target: { value: "Changed line" },
  });
  expect(within(editor).getByText("内容已变更，请重新检查线路。")).toBeTruthy();
  expect(
    within(editor).queryByRole("button", { name: "保存公开线路" }),
  ).toBeNull();
  await userEvent.click(
    within(editor).getByRole("button", { name: "检查公开线路" }),
  );
  await userEvent.click(
    await within(editor).findByRole("button", { name: "保存公开线路" }),
  );
  const detail = await screen.findByRole("dialog", { name: "Office line" });
  expect(
    within(detail).getByRole("heading", { name: "线路开通进度" }),
  ).toBeTruthy();
  expect(
    requests.filter((r) => r.method === "PUT").map((r) => r.body.name),
  ).toEqual(["Changed line"]);
  expect(requests.some((r) => /principals|publish$/.test(r.path))).toBe(false);
});

it("locks a contextual path, keeps targets deliberate, and retains scope after a rejected plan", async () => {
  const requests = mockInventory((path) =>
    path.endsWith("/preview")
      ? json({
          fingerprint: "a".repeat(64),
          supported: true,
          targets: [],
          diagnostics: [],
          affectedUsers: 0,
        })
      : path.endsWith("/admin/fleet-batches")
        ? json({ error: "Scope changed; check again", code: "FLEET_REVIEW_CHANGED" }, 409)
        : undefined,
  );
  await mount(
    <FleetPlanForm
      inventory={inventory}
      history={[]}
      initialDeploymentId="path"
      onClose={() => {}}
      onCreated={() => {}}
    />,
  );
  expect(
    screen.queryByRole("combobox", { name: "批量变更转发路径" }),
  ).toBeNull();
  expect(screen.getByText("Office path", { selector: "strong" })).toBeTruthy();
  expect(screen.queryByLabelText("选择实例 Other core")).toBeNull();
  expect(
    (
      screen.getByRole("checkbox", {
        name: "选择实例 Office core",
      }) as HTMLInputElement
    ).getAttribute("aria-checked"),
  ).toBe("false");
  expect(
    (
      screen.getByRole("button", {
        name: "预览影响与差异",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await userEvent.click(
    screen.getByRole("checkbox", { name: "选择实例 Office core" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "预览影响与差异" }));
  await userEvent.click(
    await screen.findByRole("checkbox", {
      name: "我已核对实例、阶段与影响范围",
    }),
  );
  await userEvent.click(screen.getByRole("button", { name: "创建待执行批次" }));
  await screen.findByText("计划需要重新核对，尚未创建批次。请重新预览后再创建。");
  expect(
    (
      screen.getByRole("checkbox", {
        name: "选择实例 Office core",
      }) as HTMLInputElement
    ).getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    screen.queryByRole("combobox", { name: "批量变更转发路径" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "创建待执行批次" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "预览影响与差异" }));
  await waitFor(() =>
    expect(requests.filter((r) => r.path.endsWith("/preview"))).toHaveLength(2),
  );
  expect(
    requests
      .filter((r) => r.method === "POST")
      .every(
        (r) =>
          r.body.deploymentId === "path" &&
          JSON.stringify(r.body.targetIds) === '["core"]',
      ),
  ).toBe(true);
});

it("discards a late line check after the address changes", async () => {
  let complete!: (response: Response) => void;
  mockInventory((path) =>
    path.endsWith("/preview")
      ? new Promise<Response>((resolve) => {
          complete = resolve;
        })
      : undefined,
  );
  await mount(<PublishedRoutesPage />);
  await userEvent.click(await screen.findByRole("button", { name: "编辑" }));
  const editor = screen.getByRole("dialog", { name: "编辑 Office line" });
  await userEvent.click(
    within(editor).getByRole("button", { name: "检查公开线路" }),
  );
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  fireEvent.change(
    within(editor).getByRole("textbox", { name: "对外域名或 IP" }),
    { target: { value: "changed.example" } },
  );
  complete(json(route));
  await waitFor(() =>
    expect(
      within(editor).getByRole("button", { name: "检查公开线路" }).className,
    ).not.toContain("loading"),
  );
  expect(within(editor).queryByText("路径检查完成")).toBeNull();
  expect(
    within(editor).queryByRole("button", { name: "保存公开线路" }),
  ).toBeNull();
  expect(
    (
      within(editor).getByRole("textbox", {
        name: "对外域名或 IP",
      }) as HTMLInputElement
    ).value,
  ).toBe("changed.example");
});

it("keeps unknown checks distinct from confirmed path and credentials, including failed rechecks", async () => {
  history.replaceState(null, "", "#published-routes?line=line&user=alice");
  let failed = true;
  const requests = mockInventory((path) => {
    if (/\/resolve$|\/effective-policy$|\/entries$/.test(path) && failed)
      return json({ error: "Unable to check current state" }, 503);
    if (path.endsWith("/resolve"))
      return json({
        ...route,
        status: "effective",
        effective: {
          publicHost: "office.example",
          publicPort: 443,
          endpointIds: ["entry"],
          fingerprint: "known",
        },
      });
    if (path.endsWith("/effective-policy")) return json(effectivePolicy);
    if (path.endsWith("/entries"))
      return json([
        {
          id: "grant",
          name: "Alice entry",
          routeId: "line",
          publishedRouteId: "line",
          status: "effective",
          credentialVersion: "credential",
        },
      ]);
    return undefined;
  });
  await mount(<PublishedRoutesPage />);
  const detail = await screen.findByRole("dialog", { name: "Office line" });
  await within(detail).findByText("用户授权：未知，请重新核对。");
  expect(
    within(detail).getByText("运行配置：未知，无法取得最新确认结果。"),
  ).toBeTruthy();
  expect(within(detail).getByText("独立入口：未知，请重新核对。")).toBeTruthy();
  expect(within(detail).queryByText("入口凭据已确认生效")).toBeNull();
  failed = false;
  await userEvent.click(
    within(detail).getByRole("button", { name: "重新核对进度" }),
  );
  await within(detail).findByText("入口凭据已确认生效");
  expect(within(detail).getByText("已确认生效")).toBeTruthy();
  expect(within(detail).getByText("授权来源：服务方案已不在当前清单中")).toBeTruthy();
  expect(within(detail).getByText(/获取订阅时，会按当时的授权、额度与入口状态重新检查是否可交付。/)).toBeTruthy();
  failed = true;
  await userEvent.click(
    within(detail).getByRole("button", { name: "重新核对进度" }),
  );
  await within(detail).findByText("独立入口：未知，请重新核对。");
  expect(within(detail).queryByText("入口凭据已确认生效")).toBeNull();
  expect(within(detail).queryByText("已确认生效")).toBeNull();
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});

it("returns from authorization, credentials and the path planner to the same line and user without writing", async () => {
  history.replaceState(null, "", "#published-routes?line=line&user=alice");
  // This read-only navigation fixture explicitly models a present typed row.
  // Go emits zero anchor/timezone fields even for its implicit none cycle.
  const entitlement = {
    ...effectivePolicy.entitlement,
    cycle: { mode: "none", anchor: "0001-01-01T00:00:00Z", timezone: "" },
  };
  const requests = mockInventory((path) => {
    if (path === "/api/access-policy/edit-context/entitlement/alice")
      return json({
        target: { kind: "entitlement", id: "alice" },
        record: { entitlement },
        precondition: { exists: true, revision: "opened-line-alice" },
        effective: { ...effectivePolicy, entitlement },
      });
    if (path.endsWith("/effective-policy")) return json(effectivePolicy);
    if (path.endsWith("/admission-status"))
      return json({
        onlineIps: [],
        entries: [],
        activeStreams: 0,
        maxLeaseSeconds: 300,
      });
    if (path.includes("/agent/instances/")) return json({ phase: "unknown" });
    return undefined;
  });
  let page = await mount(<PublishedRoutesPage />);
  let detail = await screen.findByRole("dialog", { name: "Office line" });
  await within(detail).findByText(/已获准使用此线路/);
  await userEvent.click(
    within(detail).getByRole("button", { name: "检查或调整用户授权" }),
  );
  const policy = await screen.findByRole("dialog", {
    name: "Alice 的服务授权",
  });
  await within(policy).findByText("当前生效授权");
  await userEvent.click(within(policy).getByRole("button", { name: "关闭" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Alice 的服务授权" }),
    ).toBeNull(),
  );
  expect(location.hash).toBe("#published-routes?line=line&user=alice");
  await userEvent.click(
    within(detail).getByRole("button", { name: "准备独立入口" }),
  );
  const principal = await screen.findByRole("dialog", {
    name: "配置「Office line」的用户入口",
  });
  expect(
    (
      within(principal).getByRole("combobox", {
        name: "用户",
      }) as HTMLInputElement
    ).disabled,
  ).toBe(true);
  await userEvent.click(within(principal).getByText("凭据与版本设置"));
  const credentialVersion = within(principal).getByRole("textbox", {
    name: "凭据版本",
  });
  fireEvent.change(credentialVersion, { target: { value: "chosen-version" } });
  await userEvent.click(
    within(principal).getByRole("button", { name: "检查此用户授权" }),
  );
  const nestedPolicy = await screen.findByRole("dialog", {
    name: "Alice 的服务授权",
  });
  await userEvent.click(
    within(nestedPolicy).getByRole("button", { name: "关闭" }),
  );
  expect((credentialVersion as HTMLInputElement).value).toBe("chosen-version");
  await userEvent.click(
    within(principal).getByRole("button", { name: /取\s*消/ }),
  );
  await userEvent.click(
    within(detail).getByRole("link", { name: "检查并应用转发路径" }),
  );
  await waitFor(() =>
    expect(location.hash).toBe("#routes?deployment=path&line=line&user=alice"),
  );
  page.unmount();
  page = await mount(<ServerRoutesPage />);
  const path = await screen.findByRole("dialog", { name: "Office path" });
  await userEvent.click(
    within(path).getByRole("button", { name: "分阶段应用修改" }),
  );
  const planner = await screen.findByRole("dialog", {
    name: "Office path的应用配置",
  });
  expect(
    within(planner).queryByRole("combobox", { name: "批量操作" }),
  ).toBeNull();
  expect(
    within(planner).queryByRole("combobox", { name: "批量变更转发路径" }),
  ).toBeNull();
  expect(
    (
      within(planner).getByRole("checkbox", {
        name: "选择实例 Office core",
      }) as HTMLInputElement
    ).getAttribute("aria-checked"),
  ).toBe("false");
  await userEvent.click(
    within(planner).getByRole("button", { name: /取\s*消/ }),
  );
  const returnedPath = await screen.findByRole("dialog", {
    name: "Office path",
  });
  await userEvent.click(
    within(returnedPath).getByRole("link", { name: "返回线路" }),
  );
  await waitFor(() =>
    expect(location.hash).toBe("#published-routes?line=line&user=alice"),
  );
  page.unmount();
  await mount(<PublishedRoutesPage />);
  detail = await screen.findByRole("dialog", { name: "Office line" });
  await within(detail).findByText(/已获准使用此线路/);
  expect(within(detail).getByText("Alice")).toBeTruthy();
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});

it.each([
  {
    override: null,
    routeIds: ["line"],
    source: "service:office",
    sourceLabel: "方案：Office plan",
    granted: true,
  },
  {
    override: [],
    routeIds: [],
    source: "individual",
    sourceLabel: "个人覆盖",
    granted: false,
  },
  {
    override: ["line"],
    routeIds: ["line"],
    source: "individual",
    sourceLabel: "个人覆盖",
    granted: true,
  },
])(
  "keeps authoritative authorization ($source / $granted) separate from a prepared credential",
  async ({ override, routeIds, source, sourceLabel, granted }) => {
    history.replaceState(null, "", "#published-routes?line=line&user=alice");
    const requests = mockInventory((path) => {
      if (path === "/api/services") return json([{ id: "office", name: "Office plan", routeIds: ["line"], quotaBytes: 0 }]);
      if (path.endsWith("/effective-policy"))
        return json({
          ...effectivePolicy,
          routeIds,
          provenance: { routes: source },
          entitlement: {
            ...effectivePolicy.entitlement,
            routeIdsOverride: override,
          },
        });
      if (path.endsWith("/entries"))
        return json([
          {
            id: "grant",
            name: "Alice entry",
            routeId: "line",
            publishedRouteId: "line",
            status: "pending-deployment",
            credentialVersion: "credential",
          },
        ]);
      return undefined;
    });
    await mount(<PublishedRoutesPage />);
    const detail = await screen.findByRole("dialog", { name: "Office line" });
    await within(detail).findByText("入口已准备，尚未确认应用");
    expect(within(detail).getByText(`授权来源：${sourceLabel}`)).toBeTruthy();
    expect(
      within(detail).getByText(
        granted ? /已获准使用此线路/ : /尚未获准使用此线路/,
      ),
    ).toBeTruthy();
    expect(within(detail).queryByText("入口凭据已确认生效")).toBeNull();
    expect(within(detail).getByText("草稿已保存，尚未确认应用")).toBeTruthy();
    await userEvent.click(
      within(detail).getByRole("button", { name: "管理此用户入口" }),
    );
    const entries = await screen.findByRole("dialog", {
      name: "Alice 的平台入口",
    });
    const allocate = within(entries).getByRole("link", {
      name: "从公开线路分配",
    });
    expect(allocate.getAttribute("href")).toBe(
      "#published-routes?line=line&user=alice",
    );
    await userEvent.click(allocate);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Alice 的平台入口" }),
      ).toBeNull(),
    );
    expect(location.hash).toBe("#published-routes?line=line&user=alice");
    expect(within(detail).getByText("Alice")).toBeTruthy();
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  },
);

it("resolves the line authorization service name from its catalog when the real state response omits services", async () => {
  history.replaceState(null, "", "#published-routes?line=line&user=alice");
  const requests = mockInventory((path) => {
    if (path === "/api/state") return json({
      nodes: [], users: [{ id: "alice", name: "Alice", enabled: true }], routes: [], revisions: [], capabilities: [],
    });
    if (path === "/api/services") return json([{ id: "office", name: "Synthetic operator access", routeIds: ["line"], quotaBytes: 0 }]);
    if (path.endsWith("/effective-policy")) return json(effectivePolicy);
    return undefined;
  });
  await mount(<PublishedRoutesPage />);
  const detail = await screen.findByRole("dialog", { name: "Office line" });
  await within(detail).findByText("已获准使用此线路");
  await within(detail).findByText("授权来源：方案：Synthetic operator access");
  expect(requests.some((request) => request.path === "/api/services")).toBe(true);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});

function catalogFixture(reply: () => Response | Promise<Response>, source = "service:office") {
  history.replaceState(null, "", "#published-routes?line=line&user=alice");
  return mockInventory((path) => {
    if (path === "/api/state") return json({ nodes: [], users: [{ id: "alice", name: "Alice", enabled: true }], routes: [], revisions: [], capabilities: [] });
    if (path === "/api/services") return reply();
    if (path.endsWith("/effective-policy")) return json({ ...effectivePolicy, provenance: { routes: source } });
    return undefined;
  });
}
const namedService = { id: "office", name: "Synthetic operator access", routeIds: ["line"], quotaBytes: 0 };

it("keeps delayed service attribution identifiable without changing the selected user or line actions", async () => {
  let resolve!: (response: Response) => void;
  const requests = catalogFixture(() => new Promise<Response>((done) => { resolve = done; }));
  await mount(<PublishedRoutesPage />);
  const detail = await screen.findByRole("dialog", { name: "Office line" });
  await within(detail).findByText("授权来源：正在核对服务方案…");
  expect(within(detail).queryByText("授权来源：服务方案已不在当前清单中")).toBeNull();
  expect(within(detail).queryByText("授权来源：方案：office")).toBeNull();
  await userEvent.click(within(detail).getByText("授权来源标识"));
  expect(within(detail).getByText("服务方案 ID：office")).toBeTruthy();
  expect((within(detail).getByRole("button", { name: "检查或调整用户授权" }) as HTMLButtonElement).disabled).toBe(false);
  expect(location.hash).toContain("user=alice");
  resolve(json([namedService]));
  await within(detail).findByText("授权来源：方案：Synthetic operator access");
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});

it.each(["failed", "missing"])("keeps %s service attribution recoverable without changing authorization", async (state) => {
  let recovered = false;
  const requests = catalogFixture(() => recovered ? json([namedService]) : state === "failed" ? json({ detail: "Synthetic catalog unavailable" }, 503) : json([]));
  await mount(<PublishedRoutesPage />);
  const detail = await screen.findByRole("dialog", { name: "Office line" });
  await within(detail).findByText(state === "failed" ? "授权来源：服务方案暂无法读取" : "授权来源：服务方案已不在当前清单中");
  expect(within(detail).getByText("已获准使用此线路")).toBeTruthy();
  await userEvent.click(within(detail).getByText("授权来源标识"));
  expect(within(detail).getByText("服务方案 ID：office")).toBeTruthy();
  recovered = true;
  await userEvent.click(within(detail).getByRole("button", { name: "重新核对授权来源" }));
  await within(detail).findByText("授权来源：方案：Synthetic operator access");
  expect(location.hash).toContain("user=alice");
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});

it("does not present a cached service name as current while its catalog refresh fails", async () => {
  let resolve!: (response: Response) => void;
  let pending = false;
  catalogFixture(() => pending ? new Promise<Response>((done) => { resolve = done; }) : json([namedService]));
  await mount(<PublishedRoutesPage />);
  const detail = await screen.findByRole("dialog", { name: "Office line" });
  await within(detail).findByText("授权来源：方案：Synthetic operator access");
  pending = true;
  await act(async () => { void clients.at(-1)!.invalidateQueries({ queryKey: ["services"] }); });
  await within(detail).findByText("授权来源：正在核对服务方案…");
  expect(within(detail).queryByText("授权来源：方案：Synthetic operator access")).toBeNull();
  resolve(json({ detail: "Synthetic catalog unavailable" }, 503));
  await within(detail).findByText("授权来源：服务方案暂无法读取");
  expect(within(detail).queryByText("授权来源：方案：Synthetic operator access")).toBeNull();
  expect(within(detail).queryByText("授权来源：服务方案已不在当前清单中")).toBeNull();
});

it("retains direct authorization attribution while the accompanying service catalog is unresolved", async () => {
  catalogFixture(() => json({ detail: "Synthetic catalog unavailable" }, 503), "service:office+direct");
  await mount(<PublishedRoutesPage />);
  const detail = await screen.findByRole("dialog", { name: "Office line" });
  await within(detail).findByText("授权来源：服务方案暂无法读取");
  expect(within(detail).getByText("另有直接授权")).toBeTruthy();
  await userEvent.click(within(detail).getByText("授权来源标识"));
  expect(within(detail).getByText("服务方案 ID：office")).toBeTruthy();
});

it.each(["ready", "delayed", "failed", "missing"])("loads the principal setup authorization catalog independently of state (%s)", async (mode) => {
  history.replaceState(null, "", "#published-routes?line=line&user=alice");
  let reply = "ready";
  let resolve!: (response: Response) => void;
  const entitlement = { ...effectivePolicy.entitlement, serviceId: "office", cycle: { mode: "none", anchor: "0001-01-01T00:00:00Z", timezone: "" } };
  const requests = mockInventory((path) => {
    if (path === "/api/state") return json({ nodes: [], users: [{ id: "alice", name: "Alice", enabled: true }], routes: [], revisions: [], capabilities: [] });
    if (path === "/api/services") return reply === "delayed" ? new Promise<Response>((done) => { resolve = done; }) : reply === "failed" ? json({ detail: "Synthetic service list failed" }, 503) : reply === "missing" ? json([]) : json([namedService]);
    if (path.endsWith("/effective-policy")) return json({ ...effectivePolicy, entitlement });
    if (path === "/api/access-policy/edit-context/entitlement/alice") return json({ target: { kind: "entitlement", id: "alice" }, record: { entitlement }, precondition: { exists: true, revision: "opened-line-alice" }, effective: { ...effectivePolicy, entitlement } });
    if (path.endsWith("/admission-status")) return json({ onlineIps: [], entries: [], activeStreams: 0, maxLeaseSeconds: 300 });
    return undefined;
  });
  await mount(<PublishedRoutesPage />);
  const detail = await screen.findByRole("dialog", { name: "Office line" });
  await within(detail).findByText("授权来源：方案：Synthetic operator access");
  reply = mode;
  await userEvent.click(within(detail).getByRole("button", { name: "准备独立入口" }));
  const principal = await screen.findByRole("dialog", { name: "配置「Office line」的用户入口" });
  await userEvent.click(within(principal).getByRole("button", { name: "检查此用户授权" }));
  const editor = await screen.findByRole("dialog", { name: "Alice 的服务授权" });
  const selected = await within(editor).findByRole("combobox", { name: /个人指定方案/ });
  if (mode === "delayed" || mode === "failed") {
    await within(editor).findByText(mode === "delayed" ? "正在读取服务方案…" : "服务方案暂无法读取");
    expect((selected as HTMLButtonElement).disabled).toBe(true);
    expect(within(editor).queryByText("所选服务方案已不在当前清单中，原选择已保留。")).toBeNull();
    reply = "ready";
    if (mode === "delayed") resolve(json([namedService]));
    else await userEvent.click(within(editor).getByRole("button", { name: "重新加载服务方案" }));
    await waitFor(() => expect((selected as HTMLButtonElement).disabled).toBe(false));
  }
  if (mode === "missing") {
    await within(editor).findByText("所选服务方案已不在当前清单中，原选择已保留。");
    expect(selected.textContent).toContain("office");
    reply = "ready";
    await userEvent.click(within(editor).getByRole("button", { name: "重新加载服务方案" }));
    await waitFor(() => expect(selected.textContent).toContain("Synthetic operator access"));
  } else expect(selected.textContent).toContain("Synthetic operator access");
  expect(location.hash).toContain("user=alice");
  await userEvent.click(within(editor).getByRole("button", { name: "关闭" }));
  await screen.findByRole("dialog", { name: "配置「Office line」的用户入口" });
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});

function editableCatalogFixture(reply: () => Response | Promise<Response>, serviceId = "office") {
  history.replaceState(null, "", "#published-routes?line=line&user=alice");
  return mockInventory((path) => {
    if (path === "/api/state") return json({ nodes: [], users: [{ id: "alice", name: "Alice", enabled: true }, { id: "bob", name: "Bob", enabled: true }], routes: [], revisions: [], capabilities: [] });
    if (path === "/api/services") return reply();
    const userId = path.endsWith("/bob") || path.includes("/bob/") ? "bob" : "alice";
    const entitlement = { ...effectivePolicy.entitlement, userId, serviceId, cycle: { mode: "none", anchor: "0001-01-01T00:00:00Z", timezone: "" } };
    const effective = { ...effectivePolicy, userId, entitlement };
    if (path.endsWith("/effective-policy")) return json(effective);
    if (path.includes("/edit-context/entitlement/")) return json({ target: { kind: "entitlement", id: userId }, record: { entitlement }, precondition: { exists: true, revision: `opened-${userId}` }, effective });
    if (path.endsWith("/admission-status")) return json({ onlineIps: [], entries: [], activeStreams: 0, maxLeaseSeconds: 300 });
    return undefined;
  });
}
async function openLinePolicy() {
  await mount(<PublishedRoutesPage />);
  const detail = await screen.findByRole("dialog", { name: "Office line" });
  await within(detail).findByText("已获准使用此线路");
  await userEvent.click(within(detail).getByRole("button", { name: "检查或调整用户授权" }));
  const editor = await screen.findByRole("dialog", { name: "Alice 的服务授权" });
  await within(editor).findByRole("combobox", { name: /个人指定方案/ });
  return { detail, editor };
}

it("clears a missing-plan warning when an already dirty draft selects an available plan", async () => {
  editableCatalogFixture(() => json([namedService]), "removed-plan");
  const { editor } = await openLinePolicy();
  await within(editor).findByText("所选服务方案已不在当前清单中，原选择已保留。");
  await userEvent.click(within(editor).getByRole("switch", { name: "暂停平台服务" }));
  await userEvent.click(within(editor).getByRole("combobox", { name: /个人指定方案/ }));
  await userEvent.click(await screen.findByRole("option", { name: "Synthetic operator access" }));
  await waitFor(() => expect(within(editor).queryByText("所选服务方案已不在当前清单中，原选择已保留。")).toBeNull());
  expect(within(editor).getByRole("switch", { name: "暂停平台服务" }).getAttribute("aria-checked")).toBe("true");
});

it("preserves unrelated dirty authorization fields across catalog failure and retry", async () => {
  let failed = false;
  const requests = editableCatalogFixture(() => failed ? json({ detail: "Synthetic catalog failure" }, 503) : json([namedService]));
  const { editor } = await openLinePolicy();
  await userEvent.click(within(editor).getByRole("switch", { name: "暂停平台服务" }));
  failed = true;
  await act(async () => { await clients.at(-1)!.invalidateQueries({ queryKey: ["services"] }); });
  await within(editor).findByText("服务方案暂无法读取");
  expect(within(editor).getByRole("switch", { name: "暂停平台服务" }).getAttribute("aria-checked")).toBe("true");
  expect((within(editor).getByRole("combobox", { name: /个人指定方案/ }) as HTMLButtonElement).disabled).toBe(true);
  failed = false;
  await userEvent.click(within(editor).getByRole("button", { name: "重新加载服务方案" }));
  await waitFor(() => expect((within(editor).getByRole("combobox", { name: /个人指定方案/ }) as HTMLButtonElement).disabled).toBe(false));
  expect(within(editor).getByRole("switch", { name: "暂停平台服务" }).getAttribute("aria-checked")).toBe("true");
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});

it("keeps the newly selected user's draft when an earlier catalog read finishes", async () => {
  let pending = false;
  let resolve!: (response: Response) => void;
  const requests = editableCatalogFixture(() => pending ? new Promise<Response>((done) => { resolve = done; }) : json([namedService]));
  const { detail, editor } = await openLinePolicy();
  pending = true;
  await act(async () => { void clients.at(-1)!.invalidateQueries({ queryKey: ["services"] }); });
  await within(editor).findByText("正在读取服务方案…");
  await userEvent.click(within(editor).getByRole("button", { name: "关闭" }));
  await userEvent.click(within(detail).getByRole("combobox", { name: "线路使用用户" }));
  await userEvent.click(await screen.findByRole("option", { name: "Bob" }));
  await waitFor(() => expect(location.hash).toContain("user=bob"));
  await userEvent.click(within(detail).getByRole("button", { name: "检查或调整用户授权" }));
  const bob = await screen.findByRole("dialog", { name: "Bob 的服务授权" });
  await userEvent.click(await within(bob).findByRole("switch", { name: "暂停平台服务" }));
  pending = false;
  await act(async () => { resolve(json([namedService])); });
  await waitFor(() => expect((within(bob).getByRole("combobox", { name: /个人指定方案/ }) as HTMLButtonElement).disabled).toBe(false));
  expect(within(bob).getByRole("switch", { name: "暂停平台服务" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByRole("dialog", { name: "Alice 的服务授权" })).toBeNull();
  expect(location.hash).toContain("user=bob");
  expect(requests.some((request) => request.path === "/api/access-policy/edit-context/entitlement/bob")).toBe(true);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});

it("identifies same-name route users before choosing whose authorization to inspect", async () => {
  history.replaceState(null, "", "#published-routes?line=line");
  const users = [{ id: "alice", name: "同名用户", enabled: true }, { id: "bob", name: "同名用户", enabled: true }, { id: "carol", name: "Carol", enabled: true }];
  const requests = mockInventory(path => {
    if (path === "/api/state") return json({ users, routes: [], revisions: [], capabilities: [] });
    if (path.endsWith("/effective-policy")) {
      const userId = path.includes("/bob/") ? "bob" : "alice";
      return json({ ...effectivePolicy, userId, entitlement: { ...effectivePolicy.entitlement, userId } });
    }
    return undefined;
  });
  await mount(<PublishedRoutesPage />);
  const detail = within(await screen.findByRole("dialog", { name: "Office line" }));
  const choice = await detail.findByRole("combobox", { name: "线路使用用户" });
  await userEvent.click(choice);
  expect(screen.getByRole("option", { name: "同名用户，账号标识：alice" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "Carol" })).toBeTruthy();
  await userEvent.click(screen.getByRole("option", { name: "同名用户，账号标识：bob" }));
  await waitFor(() => expect(location.hash).toContain("user=bob"));
  expect(choice.textContent).toContain("bob");
  expect(choice.textContent).toContain("同名用户");
  await waitFor(() => expect(requests.some(request => request.path === "/api/users/bob/effective-policy")).toBe(true));
  await userEvent.click(detail.getByRole("button", { name: "准备独立入口" }));
  const principal = within(await screen.findByRole("dialog", { name: "配置「Office line」的用户入口" }));
  const selected = await principal.findByRole("combobox", { name: "用户" });
  expect(selected.hasAttribute("disabled")).toBe(true);
  expect(selected.textContent).toContain("bob");
  expect(selected.textContent).toContain("同名用户");
  expect(requests.every(request => request.method === "GET")).toBe(true);
});
