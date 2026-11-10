// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react/pure";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PublishedRoutesPage } from "./PublishedRoutes";
import { WorkspaceHistoryContext } from "./SubscriptionContext";
import {
  createWorkspaceHistory,
  type WorkspaceHistory,
} from "./workspace-history";
import { hasUnsavedChanges } from "./navigation";
import type {
  Infrastructure,
  ManagedEndpoint,
  ServerDeployment,
} from "./types";
import type { ReactNode } from "react";

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
  authentication: "principals",
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
const navigations: WorkspaceHistory[] = [];
function mount(node: ReactNode, navigation?: WorkspaceHistory) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <WorkspaceHistoryContext.Provider
          value={navigation ? { current: navigation } : null}
        >
          {node}
        </WorkspaceHistoryContext.Provider>
      </UIProviders>
    </QueryClientProvider>,
  );
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
afterEach(async () => {
  try {
    // Sonner's exit callback outlives the toast component. Own RTL cleanup
    // explicitly so real notification removal finishes before jsdom teardown.
    // This also drains save notices already dismissed by their departing task.
    await act(async () => {
      toast.dismiss();
    });
    await waitFor(() =>
      expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(0),
    );
  } finally {
    cleanup();
    navigations.splice(0).forEach((navigation) => navigation.dispose());
    clients.splice(0).forEach((client) => client.clear());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

async function openEditor(
  extra?: Parameters<typeof mockInventory>[0],
  navigation?: WorkspaceHistory,
) {
  const requests = mockInventory(extra);
  mount(<PublishedRoutesPage />, navigation);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "编辑" }));
  const editor = within(
    await screen.findByRole("dialog", { name: "编辑 Office line" }),
  );
  return {
    requests,
    user,
    editor,
    port: editor.getByRole("spinbutton", { name: "对外端口" }),
  };
}
const tlsRefusal =
  "public VLESS entries require TLS; unencrypted entries are restricted to explicit private or loopback IPs";

it.each(["8443", "+08443", "8.443e3"])(
  "returns from in-context TLS repair preserving raw port %s and the same draft",
  async (rawPort) => {
    const { user, editor, port, requests } = await openEditor((path) =>
      path.endsWith("/preview") ? json({ error: tlsRefusal }, 422) : undefined,
    );
    fireEvent.change(editor.getByRole("textbox", { name: "线路名称" }), {
      target: { value: "Unsaved office" },
    });
    fireEvent.change(port, { target: { value: rawPort } });
    await user.click(editor.getByRole("button", { name: "检查公开线路" }));
    await user.click(
      await editor.findByRole("button", { name: "就地修复 TLS" }),
    );
    const repair = within(
      await screen.findByRole("dialog", { name: "修复公开线路 TLS" }),
    );
    expect(
      screen.queryByRole("dialog", { name: "编辑 Office line" }),
    ).toBeNull();
    expect(repair.getByText("Office path", { exact: true })).toBeTruthy();
    await user.click(repair.getByRole("button", { name: "返回公开线路" }));
    const returned = within(
      await screen.findByRole("dialog", { name: "编辑 Office line" }),
    );
    expect(
      (returned.getByRole("textbox", { name: "线路名称" }) as HTMLInputElement)
        .value,
    ).toBe("Unsaved office");
    expect(
      (
        returned.getByRole("spinbutton", {
          name: "对外端口",
        }) as HTMLInputElement
      ).value,
    ).toBe(rawPort);
    expect(
      returned.getByRole("combobox", { name: "服务器转发路径" }).textContent,
    ).toBe("Office path");
    expect(returned.queryByRole("button", { name: "保存公开线路" })).toBeNull();
    expect(location.hash).toBe("#published-routes");
    expect(
      requests
        .filter((request) => request.method !== "GET")
        .map((request) => request.path),
    ).toEqual(["/api/published-routes/preview"]);
  },
);

it.each(["stay", "edit", "navigate"] as const)(
  "focuses the returned check action before its request and respects a later %s action",
  async (nextAction) => {
    let count = 0;
    let finish!: (response: Response) => void;
    const checking = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const { user, editor, requests } = await openEditor((path) => {
      if (path.endsWith("/preview")) {
        count++;
        return count === 1 ? json({ error: tlsRefusal }, 422) : checking;
      }
    });
    await user.click(editor.getByRole("button", { name: "检查公开线路" }));
    await user.click(
      await editor.findByRole("button", { name: "就地修复 TLS" }),
    );
    const repair = within(
      await screen.findByRole("dialog", { name: "修复公开线路 TLS" }),
    );
    await user.click(repair.getByRole("button", { name: "返回并重新检查" }));
    const returned = within(
      await screen.findByRole("dialog", { name: "编辑 Office line" }),
    );
    const inspect = returned.getByRole("button", { name: "检查公开线路" });
    await waitFor(() => expect(inspect.getAttribute("aria-busy")).toBe("true"));
    expect(document.activeElement).toBe(inspect);
    expect(inspect.hasAttribute("disabled")).toBe(false);
    expect(inspect.getAttribute("aria-disabled")).toBe("true");
    expect(returned.queryByRole("button", { name: "保存公开线路" })).toBeNull();
    // Pending remains focusable, but another activation is never another check.
    await user.keyboard("{Enter}");
    expect(count).toBe(2);
    const name = returned.getByRole("textbox", { name: "线路名称" });
    if (nextAction !== "stay") {
      await user.click(name);
      if (nextAction === "edit") await user.type(name, " newer");
      else act(() => window.dispatchEvent(new HashChangeEvent("hashchange")));
    }
    await act(async () => {
      finish(json(route));
      await checking;
    });
    await waitFor(() => expect([null, "false"]).toContain(inspect.getAttribute("aria-busy")));
    expect(document.activeElement).toBe(nextAction === "stay" ? inspect : name);
    if (nextAction === "stay")
      expect(
        returned.getByRole("button", { name: "保存公开线路" }),
      ).toBeTruthy();
    else
      expect(
        returned.queryByRole("button", { name: "保存公开线路" }),
      ).toBeNull();
    expect(
      requests.filter((value) => value.path.endsWith("/preview")),
    ).toHaveLength(2);
    expect(requests.filter((value) => value.method === "PUT")).toHaveLength(0);
  },
);

it("ignores a late endpoint reveal after returning to the public-line draft", async () => {
  let finish!: (response: Response) => void;
  const reading = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const { user, editor, requests } = await openEditor((path) => {
    if (path.endsWith("/preview")) return json({ error: tlsRefusal }, 422);
    if (path.endsWith("/managed-endpoints/entry/reveal")) return reading;
  });
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await user.click(await editor.findByRole("button", { name: "就地修复 TLS" }));
  const repair = within(
    await screen.findByRole("dialog", { name: "修复公开线路 TLS" }),
  );
  await user.click(repair.getByRole("button", { name: "配置入口 TLS" }));
  await waitFor(() =>
    expect(requests.some((value) => value.path.endsWith("/entry/reveal"))).toBe(
      true,
    ),
  );
  await user.click(repair.getByRole("button", { name: "返回公开线路" }));
  await screen.findByRole("dialog", { name: "编辑 Office line" });
  await act(async () => {
    finish(json({ ...listener, revisionToken: "endpoint-r1" }));
    await reading;
  });
  expect(screen.queryByRole("dialog", { name: "编辑监听端点" })).toBeNull();
  expect(screen.queryByRole("dialog", { name: "修复公开线路 TLS" })).toBeNull();
  expect(requests.filter((value) => value.method === "PUT")).toHaveLength(0);
});

it("refuses a same-name endpoint whose stable identity no longer matches the selected path", async () => {
  const { user, editor, requests } = await openEditor((path) => {
    if (path.endsWith("/preview")) return json({ error: tlsRefusal }, 422);
    if (path.endsWith("/managed-endpoints/entry/reveal"))
      return json({ ...listener, id: "different-entry" });
  });
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await user.click(await editor.findByRole("button", { name: "就地修复 TLS" }));
  const repair = within(
    await screen.findByRole("dialog", { name: "修复公开线路 TLS" }),
  );
  await user.click(repair.getByRole("button", { name: "配置入口 TLS" }));
  await repair.findByText(
    "所选入口与当前路径不再匹配。请返回公开线路重新选择，当前输入已保留。",
  );
  expect(screen.queryByRole("dialog", { name: "编辑监听端点" })).toBeNull();
  expect(requests.filter((value) => value.method === "PUT")).toHaveLength(0);
});

it("does not recheck newer public-line input when a dismissed refresh finishes late", async () => {
  let refreshing = false;
  let finish!: (response: Response) => void;
  const reading = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const { user, editor, requests } = await openEditor((path) => {
    if (path.endsWith("/preview")) return json({ error: tlsRefusal }, 422);
    if (refreshing && path.endsWith("/hosts")) return reading;
  });
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await user.click(await editor.findByRole("button", { name: "就地修复 TLS" }));
  const repair = within(
    await screen.findByRole("dialog", { name: "修复公开线路 TLS" }),
  );
  refreshing = true;
  await user.click(repair.getByRole("button", { name: "返回并重新检查" }));
  await waitFor(() =>
    expect(
      requests.filter((value) => value.path.endsWith("/hosts")),
    ).toHaveLength(2),
  );
  await user.click(repair.getByRole("button", { name: "返回公开线路" }));
  const returned = within(
    await screen.findByRole("dialog", { name: "编辑 Office line" }),
  );
  const port = returned.getByRole("spinbutton", {
    name: "对外端口",
  }) as HTMLInputElement;
  fireEvent.change(port, { target: { value: "9443" } });
  await act(async () => {
    finish(json(inventory.hosts));
    await reading;
  });
  expect(port.value).toBe("9443");
  expect(
    requests.filter((value) => value.path.endsWith("/preview")),
  ).toHaveLength(1);
  expect(returned.queryByRole("button", { name: "保存公开线路" })).toBeNull();
  expect(screen.queryByRole("dialog", { name: "修复公开线路 TLS" })).toBeNull();
});

it.each(["endpoint", "summary"] as const)(
  "releases a pending %s read after a canceled dirty-workspace navigation without accepting or replaying it",
  async (stage) => {
    let cancelNavigation: (() => void) | undefined;
    const navigation = createWorkspaceHistory({
      isDirty: hasUnsavedChanges,
      confirm: (_proceed, cancel) => {
        cancelNavigation = cancel;
      },
      accept: () => {
        throw new Error("Canceled navigation must not leave the draft");
      },
    });
    navigations.push(navigation);
    let delay = false;
    let finish!: (response: Response) => void;
    const reading = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const readPath =
      stage === "endpoint" ? "/managed-endpoints/entry/reveal" : "/hosts";
    const { user, editor, requests } = await openEditor((path) => {
      if (path.endsWith("/preview")) return json({ error: tlsRefusal }, 422);
      if (delay && path.endsWith(readPath)) return reading;
      if (path.endsWith("/managed-endpoints/entry/reveal"))
        return json({ ...listener, revisionToken: "endpoint-r1" });
    }, navigation);
    fireEvent.change(editor.getByRole("textbox", { name: "线路名称" }), {
      target: { value: "Unsaved office" },
    });
    await user.click(editor.getByRole("button", { name: "检查公开线路" }));
    await user.click(
      await editor.findByRole("button", { name: "就地修复 TLS" }),
    );
    const repair = within(
      await screen.findByRole("dialog", { name: "修复公开线路 TLS" }),
    );
    const action = repair.getByRole("button", {
      name: stage === "endpoint" ? "配置入口 TLS" : "返回并重新检查",
    });
    const previousReads = requests.filter((value) =>
      value.path.endsWith(readPath),
    ).length;
    delay = true;
    await user.click(action);
    await waitFor(() =>
      expect(
        requests.filter((value) => value.path.endsWith(readPath)),
      ).toHaveLength(previousReads + 1),
    );
    act(() => navigation.navigate("#servers"));
    expect(cancelNavigation).toEqual(expect.any(Function));
    await act(async () => {
      finish(
        json(
          stage === "endpoint"
            ? { ...listener, revisionToken: "endpoint-r1" }
            : inventory.hosts,
        ),
      );
      await reading;
    });
    act(() => cancelNavigation!());
    expect(location.hash).toBe("#published-routes");
    expect(action.hasAttribute("disabled")).toBe(false);
    expect(action.getAttribute("aria-busy")).not.toBe("true");
    expect(screen.queryByRole("dialog", { name: "编辑监听端点" })).toBeNull();
    expect(
      requests.filter((value) => value.path.endsWith("/preview")),
    ).toHaveLength(1);
    expect(
      requests.filter((value) => value.path.endsWith(readPath)),
    ).toHaveLength(previousReads + 1);
    expect(requests.filter((value) => value.method === "PUT")).toHaveLength(0);
    delay = false;
    await user.click(action);
    if (stage === "endpoint") {
      await screen.findByRole("dialog", { name: "编辑监听端点" });
    } else {
      const returned = within(
        await screen.findByRole("dialog", { name: "编辑 Office line" }),
      );
      await returned.findByText("公网入口需要启用 TLS", { exact: true });
      expect(
        (
          returned.getByRole("textbox", {
            name: "线路名称",
          }) as HTMLInputElement
        ).value,
      ).toBe("Unsaved office");
    }
    expect(
      requests.filter((value) => value.path.endsWith(readPath)),
    ).toHaveLength(previousReads + 2);
  },
);

it("opens the initial listener comparison alone and returns to the untouched path when the snapshot is kept", async () => {
  const { user, editor, requests } = await openEditor((path) => {
    if (path.endsWith("/preview")) return json({ error: tlsRefusal }, 422);
    if (path.endsWith("/server-deployments/path/reveal"))
      return json({ ...inventory.deployments[0], revisionToken: "path-r1" });
    if (path.endsWith("/managed-endpoints/entry/reveal"))
      return json({
        ...listener,
        revisionToken: "endpoint-r2",
        connection: {
          ...listener.connection,
          tls: { enabled: true, serverName: "office.example" },
        },
      });
  });
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await user.click(await editor.findByRole("button", { name: "就地修复 TLS" }));
  const repair = within(
    await screen.findByRole("dialog", { name: "修复公开线路 TLS" }),
  );
  await user.click(repair.getByRole("button", { name: "更新路径 TLS" }));
  const comparison = within(
    await screen.findByRole("dialog", { name: "更新 Office entry 的监听设置" }),
  );
  const adopt = comparison.getByRole("button", { name: "更新到草稿" });
  await waitFor(() => expect(adopt.hasAttribute("disabled")).toBe(false));
  // Count mounted dialogs as well as accessible ones: another initially open
  // focus scope can hide this review in Chromium even if jsdom still sees it.
  expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
  expect(screen.queryByRole("dialog", { name: "编辑 Office path" })).toBeNull();
  await user.click(comparison.getByRole("button", { name: "保留草稿" }));
  const pathEditor = within(
    await screen.findByRole("dialog", { name: "编辑 Office path" }),
  );
  expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
  expect(
    (
      pathEditor.getByRole("textbox", {
        name: "转发路径名称",
      }) as HTMLInputElement
    ).value,
  ).toBe("Office path");
  expect(pathEditor.getByText(/当前端点未启用 TLS/)).toBeTruthy();
  expect(
    pathEditor.queryByRole("textbox", { name: "证书文件路径" }),
  ).toBeNull();
  await user.click(pathEditor.getByRole("button", { name: "关闭" }));
  await screen.findByRole("dialog", { name: "修复公开线路 TLS" });
  expect(
    requests
      .filter((value) => value.method !== "GET")
      .map((value) => value.path),
  ).toEqual(["/api/published-routes/preview"]);
});

it("repairs TLS through endpoint impact review and explicit path adoption without saving or applying the public line", async () => {
  let endpoint: ManagedEndpoint = {
    ...structuredClone(listener),
    revisionToken: "endpoint-r1",
  } as ManagedEndpoint;
  let deployment: ServerDeployment = {
    ...structuredClone(inventory.deployments[0]),
    revisionToken: "path-r1",
  };
  let previewCount = 0;
  const { user, editor, port, requests } = await openEditor((path, init) => {
    if (path.endsWith("/published-routes/preview")) {
      previewCount++;
      return deployment.ir.programs[0].listener.connection.tls?.enabled
        ? json({ ...route, name: "Unsaved office", publicPort: 8443 })
        : json({ error: tlsRefusal }, 422);
    }
    if (path.endsWith("/managed-endpoints/entry/reveal")) return json(endpoint);
    if (path.endsWith("/managed-endpoints/entry/impact"))
      return json({
        endpoint: { id: "entry", name: "Office entry" },
        proposed: {
          name: "Office entry",
          instanceId: "core",
          instanceName: "Office core",
          host: "0.0.0.0",
          port: 443,
          protocol: "vless",
        },
        changedFields: ["TLS 连接设置"],
        deployments: [{ id: "path", name: "Office path" }],
        routes: [{ id: "line", name: "Office line" }],
        links: [],
        reviewToken: "reviewed-entry-r1",
      });
    if (path.endsWith("/managed-endpoints/entry") && init?.method === "PUT") {
      expect(new Headers(init.headers).get("If-Match")).toBe("endpoint-r1");
      endpoint = {
        ...JSON.parse(String(init.body)),
        revisionToken: "endpoint-r2",
      };
      return json(endpoint);
    }
    if (path.endsWith("/server-deployments/path/reveal"))
      return json(deployment);
    if (path.endsWith("/server-deployments/path") && init?.method === "PUT") {
      expect(new Headers(init.headers).get("If-Match")).toBe("path-r1");
      deployment = {
        ...JSON.parse(String(init.body)),
        revisionToken: "path-r2",
      };
      return json(deployment);
    }
    if (path.endsWith("/managed-endpoints")) return json([endpoint]);
    if (path.endsWith("/server-deployments")) {
      const summary = structuredClone(deployment);
      delete summary.ir.programs[0].tls;
      return json([summary, inventory.deployments[1]]);
    }
  });
  fireEvent.change(editor.getByRole("textbox", { name: "线路名称" }), {
    target: { value: "Unsaved office" },
  });
  fireEvent.change(port, { target: { value: "8443" } });
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await user.click(await editor.findByRole("button", { name: "就地修复 TLS" }));
  let repair = within(
    await screen.findByRole("dialog", { name: "修复公开线路 TLS" }),
  );
  await user.click(repair.getByRole("button", { name: "配置入口 TLS" }));
  const endpointEditor = within(
    await screen.findByRole("dialog", { name: "编辑监听端点" }),
  );
  expect(screen.queryByRole("dialog", { name: "修复公开线路 TLS" })).toBeNull();
  await user.click(endpointEditor.getByRole("radio", { name: "TLS" }));
  fireEvent.change(
    endpointEditor.getByRole("textbox", { name: "服务器名称（SNI）" }),
    { target: { value: "office.example" } },
  );
  await user.click(endpointEditor.getByRole("button", { name: "保存" }));
  const confirm = await screen.findByRole("button", { name: "确认保存端点" });
  expect(requests.filter((value) => value.method === "PUT")).toHaveLength(0);
  await user.click(confirm);
  repair = within(
    await screen.findByRole("dialog", { name: "修复公开线路 TLS" }),
  );
  expect(repair.getByText("监听端点已保存，路径仍使用原有快照。")).toBeTruthy();
  expect(deployment.ir.programs[0].listener.connection.tls).toBeUndefined();
  await user.click(repair.getByRole("button", { name: "更新路径 TLS" }));
  const comparison = within(
    await screen.findByRole("dialog", { name: "更新 Office entry 的监听设置" }),
  );
  const adopt = await comparison.findByRole("button", { name: "更新到草稿" });
  await waitFor(() => expect(adopt.hasAttribute("disabled")).toBe(false));
  expect(
    requests.filter(
      (value) =>
        value.path.endsWith("/server-deployments/path") &&
        value.method === "PUT",
    ),
  ).toHaveLength(0);
  await user.click(adopt);
  const pathEditor = within(
    await screen.findByRole("dialog", { name: "编辑 Office path" }),
  );
  // Deliberately synthetic UI material: no real key, certificate generation,
  // renderer validation or node application is represented by this HTTP fixture.
  fireEvent.change(
    await pathEditor.findByRole("textbox", { name: "证书 PEM" }),
    { target: { value: "fixture-certificate-material" } },
  );
  await user.click(pathEditor.getByRole("button", { name: "编辑私钥 PEM" }));
  fireEvent.change(pathEditor.getByRole("textbox", { name: "私钥 PEM" }), {
    target: { value: "fixture-private-material" },
  });
  await user.click(pathEditor.getByRole("button", { name: "保存草稿" }));
  repair = within(
    await screen.findByRole("dialog", { name: "修复公开线路 TLS" }),
  );
  expect(
    repair.getByText("转发路径已保存，公开线路尚待重新检查。"),
  ).toBeTruthy();
  expect(previewCount).toBe(1);
  expect(repair.queryByText("fixture-private-material")).toBeNull();
  await user.click(repair.getByRole("button", { name: "返回并重新检查" }));
  const returned = within(
    await screen.findByRole("dialog", { name: "编辑 Office line" }),
  );
  await returned.findByText("路径检查完成", { exact: true });
  expect(document.activeElement).toBe(
    returned.getByRole("button", { name: "检查公开线路" }),
  );
  expect(previewCount).toBe(2);
  expect(
    (returned.getByRole("textbox", { name: "线路名称" }) as HTMLInputElement)
      .value,
  ).toBe("Unsaved office");
  expect(
    (returned.getByRole("spinbutton", { name: "对外端口" }) as HTMLInputElement)
      .value,
  ).toBe("8443");
  expect(returned.queryByText("fixture-private-material")).toBeNull();
  expect(
    requests
      .filter((value) => value.method === "PUT")
      .map((value) => value.path),
  ).toEqual(["/api/managed-endpoints/entry", "/api/server-deployments/path"]);
  expect(
    requests.filter(
      (value) =>
        /apply|publish|install/.test(value.path) &&
        !value.path.includes("published-routes"),
    ),
  ).toHaveLength(0);
  const lineChecks = requests.filter((value) =>
    value.path.endsWith("/published-routes/preview"),
  );
  expect(lineChecks.at(-1)?.body).toMatchObject({
    name: "Unsaved office",
    publicPort: 8443,
    endpointIds: ["entry"],
    deploymentId: "path",
  });
  expect(JSON.stringify(lineChecks)).not.toContain("fixture-private-material");
  expect(
    JSON.stringify(clients.at(-1)?.getQueryData(["infrastructure"])),
  ).not.toContain("fixture-private-material");
  expect(location.hash).toBe("#published-routes");
});
